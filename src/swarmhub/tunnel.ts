/**
 * SwarmHub Tunnel Client
 *
 * Opens a persistent WebSocket connection to SwarmHub's proxy service,
 * enabling remote access to this OpenHive instance through SwarmHub.
 *
 * The tunnel carries multiplexed HTTP requests and WebSocket connections
 * using a binary protocol. SwarmHub authenticates users and proxies their
 * requests through this tunnel to localhost.
 *
 * Lifecycle:
 *   connector.connect() → tunnel.connect() → WebSocket open → ready
 *   SwarmHub sends REQUEST → tunnel makes local HTTP → sends RESPONSE
 *   On disconnect → exponential backoff reconnect
 */

import WebSocket from 'ws';

// ── Binary protocol constants (must match SwarmHub's src/proxy/protocol.ts) ──

const MessageType = {
  REQUEST: 0x01,
  RESPONSE_START: 0x02,
  RESPONSE_CHUNK: 0x03,
  RESPONSE_END: 0x04,
  RESPONSE_FULL: 0x05,
  WS_OPEN: 0x10,
  WS_READY: 0x11,
  WS_DATA: 0x12,
  WS_CLOSE: 0x13,
  ERROR: 0x20,
  PING: 0xf0,
  PONG: 0xf1,
} as const;

// ── Frame encoding/decoding ─────────────────────────────────────────

function encodeFrame(type: number, requestId: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const reqIdBuf = Buffer.from(requestId, 'utf8');
  const frame = Buffer.allocUnsafe(1 + 2 + reqIdBuf.length + payload.length);
  frame[0] = type;
  frame.writeUInt16BE(reqIdBuf.length, 1);
  reqIdBuf.copy(frame, 3);
  if (payload.length > 0) payload.copy(frame, 3 + reqIdBuf.length);
  return frame;
}

function decodeFrame(data: Buffer): { type: number; requestId: string; payload: Buffer } {
  if (data.length < 3) throw new Error(`Frame too short: ${data.length}`);
  const type = data[0];
  const reqIdLen = data.readUInt16BE(1);
  const requestId = data.toString('utf8', 3, 3 + reqIdLen);
  const payload = data.subarray(3 + reqIdLen);
  return { type, requestId, payload };
}

function parseJsonWithBody<T>(payload: Buffer): { meta: T; body: Buffer } {
  const nullIdx = payload.indexOf(0);
  if (nullIdx === -1) {
    return { meta: JSON.parse(payload.toString('utf8')), body: Buffer.alloc(0) };
  }
  return {
    meta: JSON.parse(payload.toString('utf8', 0, nullIdx)),
    body: payload.subarray(nullIdx + 1),
  };
}

function encodeResponseFull(
  requestId: string,
  meta: { status: number; headers: Record<string, string> },
  body: Buffer = Buffer.alloc(0),
): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const payload = Buffer.allocUnsafe(jsonBuf.length + 1 + body.length);
  jsonBuf.copy(payload, 0);
  payload[jsonBuf.length] = 0;
  if (body.length > 0) body.copy(payload, jsonBuf.length + 1);
  return encodeFrame(MessageType.RESPONSE_FULL, requestId, payload);
}

function encodeJsonFrame(type: number, requestId: string, data: unknown): Buffer {
  return encodeFrame(type, requestId, Buffer.from(JSON.stringify(data), 'utf8'));
}

// ── Tunnel Client ───────────────────────────────────────────────────

export interface TunnelConfig {
  /** WebSocket URL of SwarmHub proxy service (e.g., wss://proxy.hive.swarmkit.ai) */
  proxyUrl: string;
  /** Bridge token for authentication */
  hiveToken: string;
  /** Local OpenHive port to proxy requests to */
  localPort: number;
  /** Local host (default: 127.0.0.1) */
  localHost?: string;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const RESPONSE_FULL_THRESHOLD = 64 * 1024; // 64KB — use streaming above this

export class TunnelClient {
  private config: TunnelConfig;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private localWsConnections = new Map<string, WebSocket>();

  constructor(config: TunnelConfig) {
    this.config = config;
  }

  /**
   * Create a tunnel client from environment variables.
   * Returns null if required vars are not set.
   */
  static fromEnv(localPort: number): TunnelClient | null {
    const hiveToken = process.env.SWARMHUB_HIVE_TOKEN;
    const proxyUrl = process.env.SWARMHUB_PROXY_URL;

    // If no explicit proxy URL, derive from API URL
    const apiUrl = process.env.SWARMHUB_API_URL;
    const effectiveProxyUrl = proxyUrl || (apiUrl ? apiUrl.replace('https://', 'wss://').replace('http://', 'ws://') : null);

    if (!hiveToken || !effectiveProxyUrl) return null;

    return new TunnelClient({
      proxyUrl: effectiveProxyUrl,
      hiveToken,
      localPort,
    });
  }

  /** Start the tunnel connection. Reconnects automatically on disconnect. */
  connect(): void {
    if (this.active) return;
    this.active = true;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  /** Stop the tunnel and all reconnection attempts. */
  disconnect(): void {
    this.active = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Tunnel client shutting down');
      this.ws = null;
    }
    // Close all proxied WebSocket connections
    for (const localWs of this.localWsConnections.values()) {
      try { localWs.close(); } catch {}
    }
    this.localWsConnections.clear();
  }

  get isConnected(): boolean {
    return this.ws != null && this.ws.readyState === WebSocket.OPEN;
  }

  // ─── Connection management ──────────────────────────────────────

  private doConnect(): void {
    const tunnelUrl = `${this.config.proxyUrl}/internal/hive/tunnel`;
    console.log(`[tunnel] Connecting to ${tunnelUrl}`);

    this.ws = new WebSocket(tunnelUrl, {
      headers: { authorization: `Bearer ${this.config.hiveToken}` },
    });

    this.ws.binaryType = 'nodebuffer';

    this.ws.on('open', () => {
      console.log('[tunnel] Connected to SwarmHub proxy');
      this.reconnectAttempts = 0;
    });

    this.ws.on('message', (data: Buffer) => {
      this.handleMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[tunnel] Disconnected (code=${code}, reason=${reason?.toString() ?? ''})`);
      this.ws = null;
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[tunnel] WebSocket error: ${err.message}`);
      // close event will fire after error
    });
  }

  private scheduleReconnect(): void {
    if (!this.active) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    console.log(`[tunnel] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.doConnect();
    }, delay);
  }

  // ─── Message handling ───────────────────────────────────────────

  private handleMessage(data: Buffer): void {
    try {
      const frame = decodeFrame(data);

      switch (frame.type) {
        case MessageType.PING:
          this.send(encodeFrame(MessageType.PONG, ''));
          break;

        case MessageType.REQUEST:
          this.handleHttpRequest(frame.requestId, frame.payload);
          break;

        case MessageType.WS_OPEN:
          this.handleWsOpen(frame.requestId, frame.payload);
          break;

        case MessageType.WS_DATA:
          this.handleWsData(frame.requestId, frame.payload);
          break;

        case MessageType.WS_CLOSE:
          this.handleWsClose(frame.requestId, frame.payload);
          break;

        default:
          // Unknown message type — ignore
          break;
      }
    } catch (err) {
      console.error(`[tunnel] Error handling message: ${(err as Error).message}`);
    }
  }

  // ─── HTTP request proxying ──────────────────────────────────────

  private async handleHttpRequest(requestId: string, payload: Buffer): Promise<void> {
    const { meta, body } = parseJsonWithBody<{
      method: string;
      path: string;
      headers: Record<string, string>;
    }>(payload);

    const host = this.config.localHost ?? '127.0.0.1';
    const url = `http://${host}:${this.config.localPort}${meta.path}`;

    try {
      const fetchHeaders: Record<string, string> = { ...meta.headers };
      // Set host header for local server
      fetchHeaders['host'] = `${host}:${this.config.localPort}`;

      const init: RequestInit = {
        method: meta.method,
        headers: fetchHeaders,
        signal: AbortSignal.timeout(30_000),
      };

      if (body.length > 0 && meta.method !== 'GET' && meta.method !== 'HEAD') {
        init.body = body;
      }

      const response = await fetch(url, init);
      const respBody = Buffer.from(await response.arrayBuffer());

      // Collect response headers
      const respHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        respHeaders[key] = value;
      });

      if (respBody.length <= RESPONSE_FULL_THRESHOLD) {
        // Small response — send as single RESPONSE_FULL frame
        const frame = encodeResponseFull(
          requestId,
          { status: response.status, headers: respHeaders },
          respBody,
        );
        this.send(frame);
      } else {
        // Large response — stream as START/CHUNK/END
        this.send(encodeJsonFrame(MessageType.RESPONSE_START, requestId, {
          status: response.status,
          headers: respHeaders,
        }));

        // Send in 32KB chunks
        const CHUNK_SIZE = 32 * 1024;
        for (let offset = 0; offset < respBody.length; offset += CHUNK_SIZE) {
          const chunk = respBody.subarray(offset, Math.min(offset + CHUNK_SIZE, respBody.length));
          this.send(encodeFrame(MessageType.RESPONSE_CHUNK, requestId, chunk));
        }

        this.send(encodeFrame(MessageType.RESPONSE_END, requestId));
      }
    } catch (err) {
      const message = (err as Error).message;
      const code = message.includes('ECONNREFUSED') ? 'TARGET_UNREACHABLE' : 'INTERNAL';
      this.send(encodeJsonFrame(MessageType.ERROR, requestId, { code, message }));
    }
  }

  // ─── WebSocket proxying ─────────────────────────────────────────

  private handleWsOpen(requestId: string, payload: Buffer): void {
    const { path, headers } = JSON.parse(payload.toString('utf8')) as {
      path: string;
      headers: Record<string, string>;
    };

    const host = this.config.localHost ?? '127.0.0.1';
    const wsUrl = `ws://${host}:${this.config.localPort}${path}`;

    const localWs = new WebSocket(wsUrl, { headers });

    localWs.on('open', () => {
      this.localWsConnections.set(requestId, localWs);
      this.send(encodeFrame(MessageType.WS_READY, requestId));
    });

    localWs.on('message', (data: Buffer) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      this.send(encodeFrame(MessageType.WS_DATA, requestId, buf));
    });

    localWs.on('close', (code, reason) => {
      this.localWsConnections.delete(requestId);
      this.send(encodeJsonFrame(MessageType.WS_CLOSE, requestId, {
        code: code ?? 1000,
        reason: reason?.toString() ?? '',
      }));
    });

    localWs.on('error', (err) => {
      console.error(`[tunnel] Local WS error for ${requestId}: ${err.message}`);
      this.localWsConnections.delete(requestId);
      this.send(encodeJsonFrame(MessageType.ERROR, requestId, {
        code: 'TARGET_UNREACHABLE',
        message: err.message,
      }));
    });
  }

  private handleWsData(requestId: string, payload: Buffer): void {
    const localWs = this.localWsConnections.get(requestId);
    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(payload);
    }
  }

  private handleWsClose(requestId: string, payload: Buffer): void {
    const localWs = this.localWsConnections.get(requestId);
    if (localWs) {
      try {
        const { code, reason } = JSON.parse(payload.toString('utf8'));
        localWs.close(code, reason);
      } catch {
        localWs.close();
      }
      this.localWsConnections.delete(requestId);
    }
  }

  // ─── Send helper ────────────────────────────────────────────────

  private send(data: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data, (err) => {
        if (err) {
          console.error(`[tunnel] Send error: ${err.message}`);
        }
      });
    }
  }
}
