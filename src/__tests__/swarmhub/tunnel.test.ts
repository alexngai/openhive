/**
 * Tests for the SwarmHub Tunnel Client.
 *
 * Validates binary protocol encoding, HTTP request proxying through the tunnel,
 * WebSocket proxying, reconnection logic, and connection lifecycle.
 *
 * Uses a real WebSocket server (simulating SwarmHub proxy) and a real HTTP
 * server (simulating OpenHive) — no mocks.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { TunnelClient } from '../../swarmhub/tunnel.js';

// ── Protocol helpers (mirror what SwarmHub proxy sends) ─────────────

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
};

function encodeFrame(type: number, requestId: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const reqIdBuf = Buffer.from(requestId, 'utf8');
  const frame = Buffer.allocUnsafe(1 + 2 + reqIdBuf.length + payload.length);
  frame[0] = type;
  frame.writeUInt16BE(reqIdBuf.length, 1);
  reqIdBuf.copy(frame, 3);
  if (payload.length > 0) payload.copy(frame, 3 + reqIdBuf.length);
  return frame;
}

function encodeRequest(requestId: string, meta: { method: string; path: string; headers: Record<string, string> }, body: Buffer = Buffer.alloc(0)): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const payload = Buffer.allocUnsafe(jsonBuf.length + 1 + body.length);
  jsonBuf.copy(payload, 0);
  payload[jsonBuf.length] = 0;
  if (body.length > 0) body.copy(payload, jsonBuf.length + 1);
  return encodeFrame(MessageType.REQUEST, requestId, payload);
}

function decodeFrame(data: Buffer): { type: number; requestId: string; payload: Buffer } {
  const type = data[0];
  const reqIdLen = data.readUInt16BE(1);
  const requestId = data.toString('utf8', 3, 3 + reqIdLen);
  const payload = data.subarray(3 + reqIdLen);
  return { type, requestId, payload };
}

function parseJsonWithBody<T>(payload: Buffer): { meta: T; body: Buffer } {
  const nullIdx = payload.indexOf(0);
  if (nullIdx === -1) return { meta: JSON.parse(payload.toString('utf8')), body: Buffer.alloc(0) };
  return { meta: JSON.parse(payload.toString('utf8', 0, nullIdx)), body: payload.subarray(nullIdx + 1) };
}

// ── Test infrastructure ─────────────────────────────────────────────

describe('TunnelClient', () => {
  let mockOpenHive: http.Server;
  let mockOpenHivePort: number;
  let mockOpenHiveWss: WebSocketServer;
  let mockProxy: http.Server;
  let mockProxyWss: WebSocketServer;
  let mockProxyPort: number;

  // Track connected tunnel clients on the proxy side
  let proxyClients: WebSocket[] = [];

  beforeAll(async () => {
    // Mock OpenHive HTTP server — echoes back request details
    mockOpenHive = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else if (req.url === '/large') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('A'.repeat(100_000)); // 100KB
        } else if (req.url === '/error-500') {
          res.writeHead(500);
          res.end('Internal Server Error');
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ path: req.url, method: req.method, body: body || null, headers: req.headers }));
        }
      });
    });

    // WebSocket echo server on OpenHive
    mockOpenHiveWss = new WebSocketServer({ server: mockOpenHive });
    mockOpenHiveWss.on('connection', (ws) => {
      ws.on('message', (data) => ws.send(`echo:${data}`));
    });

    await new Promise<void>((r) => mockOpenHive.listen(0, '127.0.0.1', r));
    mockOpenHivePort = (mockOpenHive.address() as any).port;

    // Mock SwarmHub Proxy WebSocket server
    mockProxy = http.createServer();
    mockProxyWss = new WebSocketServer({
      server: mockProxy,
      verifyClient: (info, cb) => {
        // Simulate bridge token auth
        const auth = info.req.headers.authorization;
        if (auth === 'Bearer valid-token') {
          cb(true);
        } else {
          cb(false, 401, 'Unauthorized');
        }
      },
    });

    mockProxyWss.on('connection', (ws) => {
      proxyClients.push(ws);
      ws.on('close', () => {
        proxyClients = proxyClients.filter((c) => c !== ws);
      });
    });

    await new Promise<void>((r) => mockProxy.listen(0, '127.0.0.1', r));
    mockProxyPort = (mockProxy.address() as any).port;
  });

  afterAll(async () => {
    // Close all lingering proxy clients
    for (const c of proxyClients) { try { c.close(); } catch {} }
    mockProxyWss.close();
    mockOpenHiveWss.close();
    await new Promise<void>((r) => { mockProxy.close(() => r()); setTimeout(r, 1000); });
    await new Promise<void>((r) => { mockOpenHive.close(() => r()); setTimeout(r, 1000); });
  }, 15_000);

  beforeEach(() => {
    proxyClients = [];
  });

  // Helper to create and connect a tunnel client
  async function createConnectedClient(): Promise<TunnelClient> {
    const client = new TunnelClient({
      proxyUrl: `ws://127.0.0.1:${mockProxyPort}`,
      hiveToken: 'valid-token',
      localPort: mockOpenHivePort,
      localHost: '127.0.0.1',
    });
    client.connect();
    await waitFor(() => client.isConnected && proxyClients.length > 0, 5000);
    return client;
  }

  // ─── Connection lifecycle ─────────────────────────────────────

  describe('connection', () => {
    let client: TunnelClient;

    afterEach(() => {
      client?.disconnect();
    });

    it('connects to the proxy server with valid token', async () => {
      client = await createConnectedClient();
      expect(client.isConnected).toBe(true);
      expect(proxyClients.length).toBe(1);
    });

    it('reports disconnected after disconnect()', async () => {
      client = await createConnectedClient();
      client.disconnect();
      await waitFor(() => !client.isConnected, 2000);
      expect(client.isConnected).toBe(false);
    });

    it('rejects connection with invalid token', async () => {
      client = new TunnelClient({
        proxyUrl: `ws://127.0.0.1:${mockProxyPort}`,
        hiveToken: 'invalid-token',
        localPort: mockOpenHivePort,
        localHost: '127.0.0.1',
      });
      client.connect();

      // Should not connect — will retry with backoff
      await new Promise((r) => setTimeout(r, 500));
      expect(client.isConnected).toBe(false);
      expect(proxyClients.length).toBe(0);
    });
  });

  // ─── HTTP request proxying ────────────────────────────────────

  describe('HTTP proxying', () => {
    let client: TunnelClient;

    beforeEach(async () => {
      client = await createConnectedClient();
    });

    afterEach(() => {
      client?.disconnect();
    });

    it('proxies a GET request to local server and returns response', async () => {
      const proxyWs = proxyClients[0];

      const response = await sendRequestAndWaitForResponse(proxyWs, 'req_1', {
        method: 'GET',
        path: '/health',
        headers: {},
      });

      expect(response.type).toBe(MessageType.RESPONSE_FULL);
      const { meta, body } = parseJsonWithBody<{ status: number; headers: Record<string, string> }>(response.payload);
      expect(meta.status).toBe(200);
      expect(JSON.parse(body.toString())).toEqual({ status: 'ok' });
    });

    it('proxies a POST request with body', async () => {
      const proxyWs = proxyClients[0];

      const response = await sendRequestAndWaitForResponse(proxyWs, 'req_2', {
        method: 'POST',
        path: '/api/data',
        headers: { 'content-type': 'application/json' },
      }, Buffer.from('{"key":"value"}'));

      const { meta, body } = parseJsonWithBody<{ status: number }>(response.payload);
      expect(meta.status).toBe(200);
      const respBody = JSON.parse(body.toString());
      expect(respBody.method).toBe('POST');
      expect(respBody.body).toBe('{"key":"value"}');
    });

    it('streams large responses using START/CHUNK/END', async () => {
      const proxyWs = proxyClients[0];

      // Request a 100KB response (above 64KB threshold)
      const frames = await sendRequestAndCollectFrames(proxyWs, 'req_large', {
        method: 'GET',
        path: '/large',
        headers: {},
      });

      // Should have RESPONSE_START, one or more RESPONSE_CHUNK, RESPONSE_END
      const types = frames.map((f) => f.type);
      expect(types[0]).toBe(MessageType.RESPONSE_START);
      expect(types[types.length - 1]).toBe(MessageType.RESPONSE_END);
      expect(types.filter((t) => t === MessageType.RESPONSE_CHUNK).length).toBeGreaterThan(0);

      // Collect body from chunks
      const chunks = frames
        .filter((f) => f.type === MessageType.RESPONSE_CHUNK)
        .map((f) => f.payload);
      const totalBody = Buffer.concat(chunks);
      expect(totalBody.length).toBe(100_000);
      expect(totalBody.toString('utf8', 0, 5)).toBe('AAAAA');
    });

    it('returns ERROR frame when local server is unreachable', async () => {
      // Create a client pointing to a non-existent port
      const badClient = new TunnelClient({
        proxyUrl: `ws://127.0.0.1:${mockProxyPort}`,
        hiveToken: 'valid-token',
        localPort: 59999, // unlikely to be in use
        localHost: '127.0.0.1',
      });
      badClient.connect();
      await waitFor(() => badClient.isConnected && proxyClients.length > 1, 5000);

      const proxyWs = proxyClients[proxyClients.length - 1];
      const response = await sendRequestAndWaitForResponse(proxyWs, 'req_err', {
        method: 'GET',
        path: '/anything',
        headers: {},
      });

      expect(response.type).toBe(MessageType.ERROR);
      const error = JSON.parse(response.payload.toString());
      expect(['TARGET_UNREACHABLE', 'INTERNAL']).toContain(error.code);
      expect(error.message).toBeDefined();

      badClient.disconnect();
    });

    it('responds to PING with PONG', async () => {
      const proxyWs = proxyClients[0];

      const pongPromise = waitForFrame(proxyWs, MessageType.PONG);
      proxyWs.send(encodeFrame(MessageType.PING, ''));
      const pong = await pongPromise;

      expect(pong.type).toBe(MessageType.PONG);
    });
  });

  // ─── WebSocket proxying ───────────────────────────────────────

  describe('WebSocket proxying', () => {
    let client: TunnelClient;

    beforeEach(async () => {
      client = await createConnectedClient();
    });

    afterEach(() => {
      client?.disconnect();
    });

    it('opens a local WebSocket and sends WS_READY', async () => {
      const proxyWs = proxyClients[0];

      const readyPromise = waitForFrame(proxyWs, MessageType.WS_READY);

      // Send WS_OPEN
      const openPayload = JSON.stringify({ path: '/ws', headers: {} });
      proxyWs.send(encodeFrame(MessageType.WS_OPEN, 'ws_1', Buffer.from(openPayload)));

      const ready = await readyPromise;
      expect(ready.type).toBe(MessageType.WS_READY);
      expect(ready.requestId).toBe('ws_1');
    });

    it('bridges data bidirectionally through WebSocket', async () => {
      const proxyWs = proxyClients[0];

      // Open WS
      const readyPromise = waitForFrame(proxyWs, MessageType.WS_READY);
      proxyWs.send(encodeFrame(MessageType.WS_OPEN, 'ws_2', Buffer.from(JSON.stringify({ path: '/ws', headers: {} }))));
      await readyPromise;

      // Send data from proxy → tunnel → local WS → echo → tunnel → proxy
      const dataPromise = waitForFrame(proxyWs, MessageType.WS_DATA);
      proxyWs.send(encodeFrame(MessageType.WS_DATA, 'ws_2', Buffer.from('hello')));

      const echoFrame = await dataPromise;
      expect(echoFrame.type).toBe(MessageType.WS_DATA);
      expect(echoFrame.requestId).toBe('ws_2');
      expect(echoFrame.payload.toString()).toBe('echo:hello');
    });

    it('propagates WS_CLOSE to local WebSocket', async () => {
      const proxyWs = proxyClients[0];

      // Open WS
      const readyPromise = waitForFrame(proxyWs, MessageType.WS_READY);
      proxyWs.send(encodeFrame(MessageType.WS_OPEN, 'ws_3', Buffer.from(JSON.stringify({ path: '/ws', headers: {} }))));
      await readyPromise;

      // Send close
      const closePayload = JSON.stringify({ code: 1000, reason: 'Normal' });
      proxyWs.send(encodeFrame(MessageType.WS_CLOSE, 'ws_3', Buffer.from(closePayload)));

      // The tunnel should close the local WS and send WS_CLOSE back
      const closeFrame = await waitForFrame(proxyWs, MessageType.WS_CLOSE, 3000);
      expect(closeFrame.requestId).toBe('ws_3');
    });
  });

  // ─── Reconnection ─────────────────────────────────────────────

  describe('reconnection', () => {
    it('reconnects after server-side disconnect', async () => {
      const client = new TunnelClient({
        proxyUrl: `ws://127.0.0.1:${mockProxyPort}`,
        hiveToken: 'valid-token',
        localPort: mockOpenHivePort,
        localHost: '127.0.0.1',
      });

      client.connect();
      await waitFor(() => client.isConnected, 5000);
      expect(proxyClients.length).toBe(1);

      // Server closes the connection
      proxyClients[0].close();
      await waitFor(() => !client.isConnected, 2000);

      // Should reconnect (backoff starts at 1s)
      await waitFor(() => client.isConnected, 5000);
      expect(proxyClients.length).toBe(1); // old one was removed, new one added

      client.disconnect();
    });
  });

  // ─── Static factory ───────────────────────────────────────────

  describe('fromEnv', () => {
    it('returns null when env vars are not set', () => {
      const saved = { ...process.env };
      delete process.env.SWARMHUB_HIVE_TOKEN;
      delete process.env.SWARMHUB_PROXY_URL;
      delete process.env.SWARMHUB_API_URL;

      expect(TunnelClient.fromEnv(3000)).toBeNull();

      Object.assign(process.env, saved);
    });

    it('creates client from SWARMHUB_PROXY_URL', () => {
      const saved = { ...process.env };
      process.env.SWARMHUB_HIVE_TOKEN = 'test-token';
      process.env.SWARMHUB_PROXY_URL = 'wss://proxy.example.com';

      const client = TunnelClient.fromEnv(3000);
      expect(client).not.toBeNull();

      Object.assign(process.env, saved);
    });

    it('derives proxy URL from SWARMHUB_API_URL', () => {
      const saved = { ...process.env };
      process.env.SWARMHUB_HIVE_TOKEN = 'test-token';
      delete process.env.SWARMHUB_PROXY_URL;
      process.env.SWARMHUB_API_URL = 'https://api.example.com';

      const client = TunnelClient.fromEnv(3000);
      expect(client).not.toBeNull();

      Object.assign(process.env, saved);
    });
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (condition()) return resolve();
    const interval = setInterval(() => {
      if (condition()) { clearInterval(interval); resolve(); }
    }, 50);
    setTimeout(() => { clearInterval(interval); reject(new Error('waitFor timeout')); }, timeoutMs);
  });
}

function waitForFrame(ws: WebSocket, type: number, timeoutMs = 5000): Promise<{ type: number; requestId: string; payload: Buffer }> {
  return new Promise((resolve, reject) => {
    const handler = (data: Buffer) => {
      const frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
      if (frame.type === type) {
        ws.off('message', handler);
        clearTimeout(timer);
        resolve(frame);
      }
    };
    ws.on('message', handler);
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for frame type 0x${type.toString(16)}`));
    }, timeoutMs);
  });
}

function sendRequestAndWaitForResponse(
  ws: WebSocket,
  requestId: string,
  meta: { method: string; path: string; headers: Record<string, string> },
  body?: Buffer,
): Promise<{ type: number; requestId: string; payload: Buffer }> {
  return new Promise((resolve, reject) => {
    const handler = (data: Buffer) => {
      const frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
      if (frame.requestId === requestId && (
        frame.type === MessageType.RESPONSE_FULL || frame.type === MessageType.ERROR
      )) {
        ws.off('message', handler);
        clearTimeout(timer);
        resolve(frame);
      }
    };
    ws.on('message', handler);
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('Response timeout'));
    }, 10_000);

    const frame = encodeRequest(requestId, meta, body);
    ws.send(frame);
  });
}

function sendRequestAndCollectFrames(
  ws: WebSocket,
  requestId: string,
  meta: { method: string; path: string; headers: Record<string, string> },
): Promise<Array<{ type: number; requestId: string; payload: Buffer }>> {
  return new Promise((resolve, reject) => {
    const frames: Array<{ type: number; requestId: string; payload: Buffer }> = [];
    const handler = (data: Buffer) => {
      const frame = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as any));
      if (frame.requestId === requestId) {
        frames.push(frame);
        if (frame.type === MessageType.RESPONSE_FULL || frame.type === MessageType.RESPONSE_END || frame.type === MessageType.ERROR) {
          ws.off('message', handler);
          clearTimeout(timer);
          resolve(frames);
        }
      }
    };
    ws.on('message', handler);
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('Collect frames timeout'));
    }, 10_000);

    const frame = encodeRequest(requestId, meta);
    ws.send(frame);
  });
}
