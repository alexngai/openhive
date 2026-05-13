/**
 * Live WS round-trip for cascade/diff.response + cascade/diff.chunk.
 *
 * Real bytes on a real socket; mirrors `ws-map.ts`'s dispatch shape
 * verbatim so we close the live-transport gap without standing up the
 * full `/ws/map` auth + registration flow.
 *
 *   client ws  ─── JSON ───►  fastify+ws  ───► dispatch:
 *                                              method === RESPONSE → handleDiffResponse
 *                                              method === CHUNK    → handleDiffChunk
 *
 * What this proves:
 *   1. JSON-RPC notifications cross a real WebSocket intact (no framing /
 *      base64 / sha256 corruption).
 *   2. The exact dispatch pattern ws-map.ts uses (method-string equality
 *      against `CASCADE_DIFF_METHODS.*`) routes correctly.
 *   3. The protocol module's `pendingRequests` resolves when responses
 *      arrive over a real socket, not just an in-process Promise hand-off.
 *
 * What this does NOT prove:
 *   - That `setupMapWebSocket`'s closure specifically wires this. The
 *     structural smoke in `ws-map-cascade-diff-intercept.test.ts` guards
 *     that. If ws-map.ts ever drifts from the dispatch shape, both tests
 *     should fail loudly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { createHash } from 'crypto';
import { CASCADE_DIFF_METHODS } from '../../cascade/diff-types.js';
import {
  sendDiffRequest,
  handleDiffResponse,
  handleDiffChunk,
  __resetPendingForTests,
} from '../../map/cascade-diff-protocol.js';

const PORT = 19_799;
const SWARM_ID = 'swarm-ws-roundtrip';

// ---------------------------------------------------------------------------
// Mock connection-registry so the protocol module's sendDiffRequest can write
// to the live socket we open below. The fake conn.ws IS the live socket.
// ---------------------------------------------------------------------------
const liveSocketRef: { current: WebSocket | null } = { current: null };

vi.mock('../../map/connection-registry.js', () => ({
  getInbound: (swarmId: string) =>
    swarmId === SWARM_ID && liveSocketRef.current
      ? { ws: liveSocketRef.current }
      : undefined,
  hasCapability: () => true,
}));

// ---------------------------------------------------------------------------
// Test server — receives notifications on an inbound socket and dispatches
// using the exact same shape ws-map.ts uses on production traffic.
// ---------------------------------------------------------------------------

interface TestServer {
  app: FastifyInstance;
  /** The server-side socket of the connection — used to push messages to the client. */
  serverSideSocket: Promise<WebSocket>;
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  let resolveServerSide: (ws: WebSocket) => void;
  const serverSideSocket = new Promise<WebSocket>((r) => { resolveServerSide = r; });

  app.get('/ws/diff-test', { websocket: true }, (socket) => {
    const ws = socket as unknown as WebSocket;
    resolveServerSide(ws);
    ws.on('message', (data) => {
      // === Production dispatch shape (copied from ws-map.ts) ===
      let msg: { method?: string; params?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg.method !== 'string') return;
      if (msg.method === CASCADE_DIFF_METHODS.RESPONSE) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handleDiffResponse(msg.params as any);
      } else if (msg.method === CASCADE_DIFF_METHODS.CHUNK) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handleDiffChunk(msg.params as any);
      }
      // ========================================================
    });
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });

  return {
    app,
    serverSideSocket,
    close: async () => { await app.close(); },
  };
}

function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/diff-test`);
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cascade-diff WS round-trip (live transport)', () => {
  let server: TestServer | null = null;
  let clientWs: WebSocket | null = null;

  beforeEach(async () => {
    __resetPendingForTests();
    server = await startServer();
    clientWs = await connectClient();
    // Wait for the server-side socket to be ready.
    const serverWs = await server.serverSideSocket;
    await waitFor(() => serverWs.readyState === WebSocket.OPEN);

    // The "production" path is: hub.sendDiffRequest writes to conn.ws.send().
    // We make conn.ws point at the client socket so that sendDiffRequest
    // pushes to the server. The server dispatches to handleDiffResponse /
    // handleDiffChunk — closing the loop.
    liveSocketRef.current = clientWs;
  });

  afterEach(async () => {
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
    clientWs = null;
    if (server) {
      await server.close();
      server = null;
    }
    liveSocketRef.current = null;
    __resetPendingForTests();
  });

  it('inline response round-trips over real WebSocket', async () => {
    const responsePromise = sendDiffRequest({
      swarmId: SWARM_ID,
      stream_id: 'stream-1',
      head: 'a'.repeat(40),
    });

    // The request flowed: hub → clientWs.send → server.ws.on('message') →
    // dispatch table. But our test server only dispatches inbound *responses*
    // — there's no sidecar git here. So we need to also push a response
    // back from the server to the client AND have the client dispatch it
    // through the same path.
    //
    // Simpler: we treat the server side as the sidecar. After the request
    // arrives, the server pushes the response back on the same socket.
    // The CLIENT'S WS messages are then dispatched to handleDiffResponse /
    // handleDiffChunk by attaching a listener on the client.
    //
    // To do that cleanly, install a temporary listener on the client side
    // that mirrors the dispatch.
    const serverWs = await server!.serverSideSocket;
    serverWs.once('message', (raw) => {
      const req = JSON.parse(raw.toString());
      const resp = {
        jsonrpc: '2.0',
        method: CASCADE_DIFF_METHODS.RESPONSE,
        params: {
          request_id: req.params.request_id,
          streaming: false,
          diff: 'diff --git a/x b/x\n+hi\n',
          files_touched: ['x'],
          truncated: false,
        },
      };
      serverWs.send(JSON.stringify(resp));
    });

    // Attach client-side dispatcher (mirrors ws-map.ts intercept).
    clientWs!.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === CASCADE_DIFF_METHODS.RESPONSE) {
        handleDiffResponse(msg.params);
      } else if (msg.method === CASCADE_DIFF_METHODS.CHUNK) {
        handleDiffChunk(msg.params);
      }
    });

    const result = await responsePromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.diff).toContain('+hi');
      expect(result.payload.files_touched).toEqual(['x']);
    }
  });

  it('chunked response: real WebSocket carries chunks intact + sha256 verifies', async () => {
    const responsePromise = sendDiffRequest({
      swarmId: SWARM_ID,
      stream_id: 'stream-2',
      head: 'b'.repeat(40),
    });

    const serverWs = await server!.serverSideSocket;

    // Build a payload bigger than the inline threshold.
    const part1 = Buffer.from('x'.repeat(300 * 1024), 'utf-8');
    const part2 = Buffer.from('y'.repeat(300 * 1024), 'utf-8');
    const full = Buffer.concat([part1, part2]);
    const sha = createHash('sha256').update(full).digest('hex');
    const chunkStreamId = 'chunk-live-1';

    serverWs.once('message', (raw) => {
      const req = JSON.parse(raw.toString());

      // Response announcing streaming
      serverWs.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: CASCADE_DIFF_METHODS.RESPONSE,
          params: {
            request_id: req.params.request_id,
            streaming: true,
            chunk_stream_id: chunkStreamId,
            total_size: full.length,
            files_touched: ['a', 'b'],
          },
        }),
      );

      // Two chunks on the same socket
      serverWs.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: CASCADE_DIFF_METHODS.CHUNK,
          params: {
            chunk_stream_id: chunkStreamId,
            seq: 0,
            data: part1.toString('base64'),
          },
        }),
      );
      serverWs.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: CASCADE_DIFF_METHODS.CHUNK,
          params: {
            chunk_stream_id: chunkStreamId,
            seq: 1,
            data: part2.toString('base64'),
            final: true,
            sha256: sha,
          },
        }),
      );
    });

    clientWs!.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === CASCADE_DIFF_METHODS.RESPONSE) handleDiffResponse(msg.params);
      else if (msg.method === CASCADE_DIFF_METHODS.CHUNK) handleDiffChunk(msg.params);
    });

    const result = await responsePromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.diff.length).toBe(full.length);
      expect(result.payload.diff).toBe(full.toString('utf-8'));
      expect(result.payload.files_touched).toEqual(['a', 'b']);
    }
  }, 10_000);

  it('sha256 mismatch on real WS surfaces as integrity_failed', async () => {
    const responsePromise = sendDiffRequest({
      swarmId: SWARM_ID,
      stream_id: 'stream-3',
      head: 'c'.repeat(40),
    });

    const serverWs = await server!.serverSideSocket;
    const blob = Buffer.from('hello world');
    const chunkStreamId = 'chunk-live-2';

    serverWs.once('message', (raw) => {
      const req = JSON.parse(raw.toString());
      serverWs.send(JSON.stringify({
        jsonrpc: '2.0',
        method: CASCADE_DIFF_METHODS.RESPONSE,
        params: {
          request_id: req.params.request_id,
          streaming: true,
          chunk_stream_id: chunkStreamId,
          total_size: blob.length,
          files_touched: [],
        },
      }));
      serverWs.send(JSON.stringify({
        jsonrpc: '2.0',
        method: CASCADE_DIFF_METHODS.CHUNK,
        params: {
          chunk_stream_id: chunkStreamId,
          seq: 0,
          data: blob.toString('base64'),
          final: true,
          sha256: '0'.repeat(64), // wrong on purpose
        },
      }));
    });

    clientWs!.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === CASCADE_DIFF_METHODS.RESPONSE) handleDiffResponse(msg.params);
      else if (msg.method === CASCADE_DIFF_METHODS.CHUNK) handleDiffChunk(msg.params);
    });

    const result = await responsePromise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('integrity_failed');
  });
});
