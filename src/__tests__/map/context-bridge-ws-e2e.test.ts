/**
 * E2E Test: Context-Bridge → Hub → WS Broadcast
 *
 * Exercises the full bridge-to-frontend path for an agent-authored context:
 *
 *   opentasks MAP event bridge (agent-side)
 *     → emitContextCreated → connection.send({ scope }, { type: 'context.created', context })
 *     → MAP WS (real WebSocket to /ws/map)
 *     → ws-map.ts notification interceptor
 *     → isMapContextEvent → handleMapContextEvent
 *     → resource_id resolved via getDefaultTaskGraph
 *     → if metadata.kind === 'spec':
 *         broadcastToChannel('map:tasks', { type: 'spec.created', data: { spec, resource_id, initiator } })
 *     → /ws observer receives spec.* broadcast on the map:tasks channel
 *
 * The bridge is kind-agnostic — it emits context.* for every context graph
 * node. The hub is where spec classification happens: kind=spec contexts
 * are re-broadcast as spec.created/spec.updated (matching the existing
 * `useSpecsRealtime` contract), plain contexts are dropped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { setupWebSocket, stopHeartbeat } from '../../realtime/index.js';
import {
  getAllInbound,
  setDefaultTaskGraph,
  unregisterInbound,
} from '../../map/connection-registry.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { createMAPEventBridge, type MAPConnection } from 'opentasks';

const TEST_ROOT = testRoot('context-bridge-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'context-bridge.db');
const SERVER_PORT = 19684;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function collectMessages(ws: WebSocket): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => {
    try {
      messages.push(JSON.parse(data.toString()));
    } catch {
      /* ignore non-JSON */
    }
  });
  return messages;
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = messages.find(predicate);
    if (found) return found;
    await sleep(50);
  }
  return null;
}

async function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`WS timeout: ${url}`)), 4000);
  });
  return ws;
}

describe('E2E: context bridge → hub → map:tasks broadcast', { timeout: 30_000 }, () => {
  let app: FastifyInstance;
  let apiKey: string;
  let ingestToken: string;
  let resourceId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const { agent, apiKey: key } = await agentsDAL.createAgent({
      name: 'context-bridge-e2e-agent',
      description: 'Context bridge e2e',
    });
    apiKey = key;

    const ik = createIngestKey(agent.id, { label: 'ctx-e2e', agent_id: agent.id });
    ingestToken = ik.plaintext_key;

    // Register a task-shaped resource so `getDefaultTaskGraph` can resolve
    // the context event back to an OpenHive resource_id.
    const resource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'context-bridge-e2e-graph',
      git_remote_url: '/tmp/context-bridge-e2e',
      visibility: 'shared',
      owner_agent_id: agent.id,
      sync_strategy: 'local',
      local_path: '/tmp/context-bridge-e2e',
      metadata: { opentasks: true, location_hash: 'context-bridge-e2e' },
    });
    resourceId = resource.id;

    const config = ConfigSchema.parse({
      port: SERVER_PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Context Bridge E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open' },
    });

    app = Fastify({ logger: false });
    await app.register(websocket);
    setupWebSocket(app);
    setupMapWebSocket(app, config);
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
    void apiKey; // retained for future REST assertions
  }, 15_000);

  afterAll(async () => {
    stopMapWebSocket();
    stopHeartbeat();
    await app?.close();
    await sleep(100);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  }, 10_000);

  async function connectSwarm(swarmId: string): Promise<WebSocket> {
    const ws = await openWs(
      `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}&swarm_id=${swarmId}`,
    );
    // Wait for the hub/welcome frame so registerInbound has completed
    await waitFor(() => getAllInbound().has(swarmId), 4000);
    return ws;
  }

  async function connectObserver(): Promise<{
    ws: WebSocket;
    messages: Array<Record<string, unknown>>;
  }> {
    const ws = await openWs(`ws://127.0.0.1:${SERVER_PORT}/ws?token=${ingestToken}`);
    const messages = collectMessages(ws);
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['map:tasks'] }));
    await waitForMessage(messages, (m) => {
      const d = m.data as Record<string, unknown> | undefined;
      return m.type === 'agent_online' && Array.isArray(d?.subscribed);
    });
    return { ws, messages };
  }

  it('kind=spec context.created is re-broadcast as spec.created on map:tasks', async () => {
    const swarmId = 'e2e-ctx-spec-created';
    const swarmWs = await connectSwarm(swarmId);
    setDefaultTaskGraph(swarmId, { resource_id: resourceId, location_hash: 'context-bridge-e2e' });

    const { ws: observer, messages } = await connectObserver();

    // Same wire shape emitted by opentasks' map-event-bridge via connection.send
    swarmWs.send(
      JSON.stringify({
        payload: {
          type: 'context.created',
          context: {
            id: 'ctx-e2e-1',
            title: 'Auth refactor',
            priority: 2,
            metadata: { kind: 'spec' },
          },
        },
      }),
    );

    const hit = await waitForMessage(
      messages,
      (m) => m.type === 'spec.created' && m.channel === 'map:tasks',
    );
    expect(hit).not.toBeNull();
    const data = hit!.data as Record<string, unknown>;
    expect(data.resource_id).toBe(resourceId);
    expect(data.initiator).toMatchObject({ type: 'agent' });
    expect(data.spec).toMatchObject({
      id: 'ctx-e2e-1',
      title: 'Auth refactor',
      priority: 2,
      metadata: { kind: 'spec' },
    });

    observer.close();
    swarmWs.close();
    unregisterInbound(swarmId);
  });

  it('kind=spec context.updated is re-broadcast as spec.updated', async () => {
    const swarmId = 'e2e-ctx-spec-updated';
    const swarmWs = await connectSwarm(swarmId);
    setDefaultTaskGraph(swarmId, { resource_id: resourceId, location_hash: 'context-bridge-e2e' });

    const { ws: observer, messages } = await connectObserver();

    swarmWs.send(
      JSON.stringify({
        payload: {
          type: 'context.updated',
          context: {
            id: 'ctx-e2e-2',
            title: 'New title',
            archived: true,
            metadata: { kind: 'spec' },
          },
        },
      }),
    );

    const hit = await waitForMessage(
      messages,
      (m) => m.type === 'spec.updated' && m.channel === 'map:tasks',
    );
    expect(hit).not.toBeNull();
    const data = hit!.data as Record<string, unknown>;
    expect(data.spec).toMatchObject({
      id: 'ctx-e2e-2',
      title: 'New title',
      archived: true,
      metadata: { kind: 'spec' },
    });
    expect(data.resource_id).toBe(resourceId);

    observer.close();
    swarmWs.close();
    unregisterInbound(swarmId);
  });

  it('plain context (no kind=spec marker) produces no broadcast', async () => {
    const swarmId = 'e2e-ctx-plain';
    const swarmWs = await connectSwarm(swarmId);
    setDefaultTaskGraph(swarmId, { resource_id: resourceId, location_hash: 'context-bridge-e2e' });

    const { ws: observer, messages } = await connectObserver();

    swarmWs.send(
      JSON.stringify({
        payload: {
          type: 'context.created',
          context: {
            id: 'ctx-plain-e2e',
            title: 'Just a note',
            metadata: { tags: ['note'] },
          },
        },
      }),
    );

    await sleep(300);

    const specHit = messages.find(
      (m) => typeof m.type === 'string' && (m.type as string).startsWith('spec.'),
    );
    expect(specHit).toBeUndefined();

    observer.close();
    swarmWs.close();
    unregisterInbound(swarmId);
  });

  it('drops context events from swarms without a default task graph', async () => {
    const swarmId = 'e2e-ctx-no-graph';
    const swarmWs = await connectSwarm(swarmId);
    // Deliberately NOT calling setDefaultTaskGraph.

    const { ws: observer, messages } = await connectObserver();

    swarmWs.send(
      JSON.stringify({
        payload: {
          type: 'context.created',
          context: {
            id: 'orphan-1',
            title: 'No graph',
            metadata: { kind: 'spec' },
          },
        },
      }),
    );

    await sleep(300);

    const hit = messages.find(
      (m) => m.type === 'spec.created' && m.channel === 'map:tasks',
    );
    expect(hit).toBeUndefined();

    observer.close();
    swarmWs.close();
    unregisterInbound(swarmId);
  });

  it('real createMAPEventBridge drives the broadcast end-to-end', async () => {
    const swarmId = 'e2e-ctx-real-bridge';
    const swarmWs = await connectSwarm(swarmId);
    setDefaultTaskGraph(swarmId, { resource_id: resourceId, location_hash: 'context-bridge-e2e' });

    const { ws: observer, messages } = await connectObserver();

    // Minimal MAPConnection wrapping bridge events into the hub's expected
    // notification shape. Exercises createMAPEventBridge's true wire output
    // — if the bridge's event envelope drifts from what the hub accepts,
    // this test breaks.
    const connection: MAPConnection = {
      async send(_to, payload) {
        swarmWs.send(JSON.stringify({ payload }));
      },
    };

    const bridge = createMAPEventBridge({
      connection,
      scope: 'swarm:context-bridge-e2e',
      agentId: 'agent-bridge-runner',
    });

    bridge.emitContextCreated({
      id: 'ctx-bridge-real-1',
      title: 'Wired through the bridge',
      content: 'Body content',
      priority: 1,
      archived: false,
      metadata: { kind: 'spec' },
    });

    const hit = await waitForMessage(
      messages,
      (m) => m.type === 'spec.created' && m.channel === 'map:tasks',
    );
    expect(hit).not.toBeNull();
    const data = hit!.data as Record<string, unknown>;
    expect(data.spec).toMatchObject({
      id: 'ctx-bridge-real-1',
      title: 'Wired through the bridge',
      content: 'Body content',
      priority: 1,
      archived: false,
      metadata: { kind: 'spec' },
    });
    expect(data.resource_id).toBe(resourceId);
    expect(data.initiator).toMatchObject({ type: 'agent' });

    bridge.stop();
    observer.close();
    swarmWs.close();
    unregisterInbound(swarmId);
  });

  it('real bridge with plain context produces no spec broadcast', async () => {
    const swarmId = 'e2e-ctx-real-plain';
    const swarmWs = await connectSwarm(swarmId);
    setDefaultTaskGraph(swarmId, { resource_id: resourceId, location_hash: 'context-bridge-e2e' });

    const { ws: observer, messages } = await connectObserver();

    const connection: MAPConnection = {
      async send(_to, payload) {
        swarmWs.send(JSON.stringify({ payload }));
      },
    };

    const bridge = createMAPEventBridge({
      connection,
      scope: 'swarm:context-bridge-e2e',
      agentId: 'agent-bridge-runner',
    });

    // No kind marker → hub drops
    bridge.emitContextCreated({
      id: 'ctx-plain-real-1',
      title: 'Just a plain context',
    });

    await sleep(300);

    const specHit = messages.find(
      (m) => typeof m.type === 'string' && (m.type as string).startsWith('spec.'),
    );
    expect(specHit).toBeUndefined();

    bridge.stop();
    observer.close();
    swarmWs.close();
    unregisterInbound(swarmId);
  });

  it('does not confuse task events with context/spec events', async () => {
    const swarmId = 'e2e-ctx-task-mix';
    const swarmWs = await connectSwarm(swarmId);
    setDefaultTaskGraph(swarmId, { resource_id: resourceId, location_hash: 'context-bridge-e2e' });

    const { ws: observer, messages } = await connectObserver();

    swarmWs.send(
      JSON.stringify({
        payload: {
          type: 'task.created',
          task: { id: 'task-mix-1', title: 'Not a context', status: 'open' },
        },
      }),
    );

    await sleep(200);

    const specHit = messages.find(
      (m) => typeof m.type === 'string' && (m.type as string).startsWith('spec.'),
    );
    expect(specHit).toBeUndefined();

    observer.close();
    swarmWs.close();
    unregisterInbound(swarmId);
  });
});
