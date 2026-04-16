/**
 * WebSocket round-trip test for cascade events.
 *
 * Closes the last unverified seam: hub broadcast → WS transport → browser-
 * shaped consumer. Per-side tests exist (cascade-handler emits the right
 * WS message; useCascadeRealtime subscribes + invalidates on the right
 * event types). This test boots a real Fastify server with the real
 * realtime handler, opens an actual `ws` client, and verifies that a
 * cascade event fired through `handleCascadeRequest` reaches the subscriber
 * within a bounded latency window.
 *
 * Scope: transport only. Doesn't exercise React Query invalidation (that's
 * a jsdom test's job) or macro-agent emission (covered by
 * live-emission-e2e.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { setupWebSocket, stopHeartbeat } from '../../realtime/index.js';
import {
  handleCascadeRequest,
  CASCADE_METHODS,
} from '../../map/cascade-handler.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('cascade-ws-roundtrip');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'ws-roundtrip.db');
const PORT = 19701;
const SWARM_ID = 'swarm-ws-roundtrip';
const MAX_LATENCY_MS = 500;

interface ParsedEvent {
  type: string;
  channel?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

function connectWS(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS connection timeout'));
    }, 5000);
    ws.once('message', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function subscribe(ws: WebSocket, channels: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Subscribe ack timeout')), 2000);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as ParsedEvent;
      if (msg.data && 'subscribed' in msg.data) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve();
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'subscribe', channels }));
  });
}

function waitForEvent(
  ws: WebSocket,
  eventType: string,
  timeoutMs: number,
): Promise<{ event: ParsedEvent; elapsedMs: number } | null> {
  const start = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(null);
    }, timeoutMs);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as ParsedEvent;
      if (msg.type === eventType) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve({ event: msg, elapsedMs: Date.now() - start });
      }
    };
    ws.on('message', handler);
  });
}

describe('E2E: Cascade WS round-trip', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupWebSocket(app);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    stopHeartbeat();
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('delivers stream.committed to a resource:task:* subscriber under 500ms', async () => {
    const taskResourceId = 'res-ws-rt-1';
    const taskNodeId = 'node-ws-rt-1';
    const streamId = 'stream-ws-rt-1';

    const ws = await connectWS();
    try {
      await subscribe(ws, [`resource:task:${taskResourceId}`]);

      // Seed the stream projection with task binding so the handler
      // broadcasts to the task channel.
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        {
          stream_id: streamId,
          name: 'ws-rt-stream',
          agent_id: 'agent-ws',
          metadata: {
            task_ref: { resource_id: taskResourceId, node_id: taskNodeId },
          },
        },
        { swarmId: SWARM_ID, agentId: 'agent-ws' },
      );

      const received = waitForEvent(ws, 'cascade:stream_committed', 2000);

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_COMMITTED,
        {
          stream_id: streamId,
          commit_hash: 'abc123def456',
          change_id: 'c-abc123de',
          agent_id: 'agent-ws',
          message_summary: 'feat: ws roundtrip',
          files_touched: ['src/ws.ts'],
          metadata: {
            task_ref: { resource_id: taskResourceId, node_id: taskNodeId },
          },
        },
        { swarmId: SWARM_ID, agentId: 'agent-ws' },
      );

      const result = await received;
      expect(result).not.toBeNull();
      expect(result!.elapsedMs).toBeLessThan(MAX_LATENCY_MS);
      expect(result!.event.channel).toBe(`resource:task:${taskResourceId}`);
      expect(result!.event.data).toMatchObject({
        stream_id: streamId,
        commit_hash: 'abc123def456',
        source_swarm_id: SWARM_ID,
      });
    } finally {
      ws.close();
    }
  });

  it('delivers stream.merged to a global subscriber', async () => {
    const streamId = 'stream-ws-rt-2';

    const ws = await connectWS();
    try {
      await subscribe(ws, ['global']);

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: streamId, name: 'src-stream', agent_id: 'a' },
        { swarmId: SWARM_ID, agentId: 'a' },
      );
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        { stream_id: 'target-ws-rt-2', name: 'tgt-stream', agent_id: 'a' },
        { swarmId: SWARM_ID, agentId: 'a' },
      );

      const received = waitForEvent(ws, 'cascade:stream_merged', 2000);

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_MERGED,
        {
          source_stream_id: streamId,
          target_stream_id: 'target-ws-rt-2',
          merge_commit: 'mrg000',
          agent_id: 'a',
          strategy: 'merge-commit',
        },
        { swarmId: SWARM_ID, agentId: 'a' },
      );

      const result = await received;
      expect(result).not.toBeNull();
      expect(result!.elapsedMs).toBeLessThan(MAX_LATENCY_MS);
      expect(result!.event.channel).toBe('global');
      expect(result!.event.data).toMatchObject({
        source_stream_id: streamId,
        target_stream_id: 'target-ws-rt-2',
        merge_commit: 'mrg000',
      });
    } finally {
      ws.close();
    }
  });

  it('does not deliver to unsubscribed clients', async () => {
    const taskResourceId = 'res-ws-rt-3';
    const streamId = 'stream-ws-rt-3';

    // Client A subscribes to task channel; client B subscribes to nothing.
    const wsA = await connectWS();
    const wsB = await connectWS();
    try {
      await subscribe(wsA, [`resource:task:${taskResourceId}`]);

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_OPENED,
        {
          stream_id: streamId,
          name: 's',
          agent_id: 'a',
          metadata: { task_ref: { resource_id: taskResourceId, node_id: 'n' } },
        },
        { swarmId: SWARM_ID, agentId: 'a' },
      );

      const receivedA = waitForEvent(wsA, 'cascade:stream_abandoned', 1500);
      const receivedB = waitForEvent(wsB, 'cascade:stream_abandoned', 1500);

      handleCascadeRequest(
        CASCADE_METHODS.STREAM_ABANDONED,
        { stream_id: streamId, reason: 'ws-roundtrip-test' },
        { swarmId: SWARM_ID, agentId: 'a' },
      );

      const [a, b] = await Promise.all([receivedA, receivedB]);
      expect(a).not.toBeNull();
      expect(b).toBeNull();
    } finally {
      wsA.close();
      wsB.close();
    }
  });
});
