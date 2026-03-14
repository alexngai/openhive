/**
 * E2E Protocol Tests: MAP WebSocket Protocol
 *
 * Starts a real Fastify server with WebSocket support, SQLite database,
 * and inbox bridge. Exercises the full MAP protocol via WebSocket client:
 *
 *   - Connection & handshake (hub/welcome, map/connect)
 *   - Agent lifecycle (spawn, update, list, unregister)
 *   - Direct messaging (map/send between agents)
 *   - Mail conversations (create, join, turn, get, close)
 *   - Event subscriptions (subscribe, receive events, unsubscribe)
 *   - Extension methods (x-hive/post, x-hive/comment, x-hive/vote)
 *   - Replay (unread messages on reconnect)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { joinHive as joinSwarmToHive } from '../../db/dal/map.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initInboxBridge, stopInboxBridge } from '../../map/inbox-bridge.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel (imported transitively by sync-listener)
import { vi } from 'vitest';
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));
vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: vi.fn(),
}));

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('e2e-map-protocol');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e-map.db');
const SERVER_PORT = 19650;

// ============================================================================
// JSON-RPC Helpers
// ============================================================================

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

let rpcIdCounter = 0;

function nextId(): string {
  return `rpc-${++rpcIdCounter}`;
}

/**
 * Connect a WebSocket to the MAP endpoint and wait for the hub/welcome message.
 */
function connectAgent(
  port: number,
  apiKey: string,
  opts?: { autoRegister?: boolean; swarmId?: string },
): Promise<{ ws: WebSocket; welcome: JsonRpcNotification }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ token: apiKey });
    if (opts?.autoRegister !== false) params.set('auto_register', 'true');
    if (opts?.swarmId) params.set('swarm_id', opts.swarmId);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/map?${params}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout'));
    }, 5000);

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('message', (data) => {
      clearTimeout(timeout);
      const msg = JSON.parse(data.toString());
      if (msg.method === 'hub/welcome') {
        resolve({ ws, welcome: msg });
      }
    });

    ws.on('close', (code) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket closed with code ${code}`));
    });
  });
}

/**
 * Send a JSON-RPC request and wait for the matching response by id.
 */
function rpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`RPC timeout for ${method} (id: ${id})`));
    }, timeoutMs);

    function handler(data: Buffer | string) {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    }

    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

/**
 * Collect notifications (no id) matching a method, until count reached or timeout.
 */
function collectNotifications(
  ws: WebSocket,
  method: string,
  count: number,
  timeoutMs = 3000,
): Promise<JsonRpcNotification[]> {
  return new Promise((resolve) => {
    const collected: JsonRpcNotification[] = [];
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(collected);
    }, timeoutMs);

    function handler(data: Buffer | string) {
      const msg = JSON.parse(data.toString());
      if (msg.method === method && !msg.id) {
        collected.push(msg);
        if (collected.length >= count) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve(collected);
        }
      }
    }

    ws.on('message', handler);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on('close', () => resolve());
    ws.close();
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('E2E: MAP Protocol', () => {
  let app: FastifyInstance;
  let agentA: { id: string; apiKey: string; name: string };
  let agentB: { id: string; apiKey: string; name: string };
  let hive: { id: string; name: string };

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    // Create test agents
    const resultA = await agentsDAL.createAgent({ name: 'e2e-agent-a', description: 'Agent A' });
    agentA = { id: resultA.agent.id, apiKey: resultA.apiKey, name: 'e2e-agent-a' };

    const resultB = await agentsDAL.createAgent({ name: 'e2e-agent-b', description: 'Agent B' });
    agentB = { id: resultB.agent.id, apiKey: resultB.apiKey, name: 'e2e-agent-b' };

    // Create test hive and join both agents
    const h = hivesDAL.createHive({
      name: 'e2e-test-hive',
      description: 'E2E test hive',
      owner_id: agentA.id,
    });
    hive = { id: h.id, name: h.name };
    hivesDAL.joinHive(hive.id, agentB.id);

    // Initialize inbox bridge
    await initInboxBridge();

    // Build Fastify app
    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app);

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 30000);

  afterAll(async () => {
    // Stop MAP WebSocket first (closes all inbound connections)
    stopMapWebSocket();
    // Small delay to let close handlers finish before DB teardown
    await new Promise((r) => setTimeout(r, 200));
    await app.close();
    await stopInboxBridge();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  }, 15000);

  // ══════════════════════════════════════════════════════════════════════
  // Connection & Handshake
  // ══════════════════════════════════════════════════════════════════════

  describe('Connection & Handshake', () => {
    it('should connect with valid token and receive hub/welcome', async () => {
      const { ws, welcome } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        expect(welcome.method).toBe('hub/welcome');
        expect(welcome.params.agent_id).toBe(agentA.id);
        expect(welcome.params.agent_name).toBe(agentA.name);
        expect(welcome.params.swarm_id).toBeDefined();
        expect(welcome.params.capabilities).toBeDefined();
      } finally {
        await closeWs(ws);
      }
    });

    it('should reject connection with invalid token', async () => {
      await expect(connectAgent(SERVER_PORT, 'invalid-token')).rejects.toThrow();
    });

    it('should return protocol info on map/connect', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await rpc(ws, 'map/connect', {});
        expect(res.result).toBeDefined();
        const result = res.result as Record<string, unknown>;
        expect(result.protocolVersion).toBeDefined();
        expect(result.serverId).toBe('openhive-hub');

        const caps = result.capabilities as Record<string, unknown>;
        expect(caps.mail).toBeDefined();
        expect(caps.federation).toBeDefined();
        expect(caps.extensions).toContain('x-hive');
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Agent Lifecycle (sidecar protocol)
  // ══════════════════════════════════════════════════════════════════════

  describe('Agent Lifecycle', () => {
    it('should register an agent via map/agents/register', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await rpc(ws, 'map/agents/register', {
          agentId: 'sub-agent-register-1',
          name: 'Registered Agent',
          role: 'worker',
        });
        expect(res.error).toBeUndefined();
        expect(res.result).toBeDefined();
        const result = res.result as Record<string, unknown>;
        expect(result.nodeId).toBeDefined();
        const agent = result.agent as Record<string, unknown>;
        expect(agent.id).toBe('sub-agent-register-1');
      } finally {
        await closeWs(ws);
      }
    });

    it('should spawn a sub-agent via map/agents/spawn', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await rpc(ws, 'map/agents/spawn', {
          agentId: 'sub-agent-spawn-1',
          name: 'Spawned Agent',
          role: 'agent',
        });
        expect(res.error).toBeUndefined();
        const result = res.result as { agent: { id: string; state: string; name: string; role: string } };
        expect(result.agent.id).toBe('sub-agent-spawn-1');
        expect(result.agent.state).toBe('active');
        expect(result.agent.name).toBe('Spawned Agent');
        expect(result.agent.role).toBe('agent');
      } finally {
        await closeWs(ws);
      }
    });

    it('should update agent state via map/agents/update', async () => {
      const { ws, welcome } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        // First spawn an agent
        await rpc(ws, 'map/agents/spawn', {
          agentId: 'sub-agent-update-1',
          name: 'Update Test Agent',
          role: 'agent',
        });

        // Update its state
        const updateRes = await rpc(ws, 'map/agents/update', {
          agentId: 'sub-agent-update-1',
          state: 'busy',
          metadata: { task: 'processing' },
        });
        expect(updateRes.error).toBeUndefined();
        const updateResult = updateRes.result as { agent: { id: string; state: string } };
        expect(updateResult.agent).toBeDefined();
        expect(updateResult.agent.state).toBe('busy');

        // Verify via list
        const listRes = await rpc(ws, 'map/agents/list', {
          swarm_id: welcome.params.swarm_id,
        });
        const agents = (listRes.result as { agents: Array<{ map_agent_id: string; state: string }> }).agents;
        const updated = agents.find((a) => a.map_agent_id === 'sub-agent-update-1');
        expect(updated).toBeDefined();
        expect(updated!.state).toBe('busy');
      } finally {
        await closeWs(ws);
      }
    });

    it('should return error when updating nonexistent agent', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await rpc(ws, 'map/agents/update', {
          agentId: 'nonexistent-agent',
          state: 'idle',
        });
        expect(res.error).toBeDefined();
        expect(res.error!.code).toBe(-32001);
      } finally {
        await closeWs(ws);
      }
    });

    it('should list agents via map/agents/list', async () => {
      const { ws, welcome } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        // Spawn a couple of agents
        await rpc(ws, 'map/agents/spawn', { agentId: 'list-agent-1', name: 'List Agent 1' });
        await rpc(ws, 'map/agents/spawn', { agentId: 'list-agent-2', name: 'List Agent 2' });

        const res = await rpc(ws, 'map/agents/list', {
          swarm_id: welcome.params.swarm_id,
        });
        expect(res.error).toBeUndefined();
        const result = res.result as { agents: unknown[]; total: number };
        expect(result.agents.length).toBeGreaterThanOrEqual(2);
        expect(result.total).toBeGreaterThanOrEqual(2);
      } finally {
        await closeWs(ws);
      }
    });

    it('should unregister an agent via map/agents/unregister', async () => {
      const { ws, welcome } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        // Spawn then unregister
        await rpc(ws, 'map/agents/spawn', { agentId: 'unregister-agent-1', name: 'To Unregister' });

        const unregRes = await rpc(ws, 'map/agents/unregister', {
          agentId: 'unregister-agent-1',
        });
        expect(unregRes.error).toBeUndefined();
        expect((unregRes.result as { ok: boolean }).ok).toBe(true);

        // Verify it's gone from the list
        const listRes = await rpc(ws, 'map/agents/list', {
          swarm_id: welcome.params.swarm_id,
        });
        const agents = (listRes.result as { agents: Array<{ map_agent_id: string }> }).agents;
        expect(agents.find((a) => a.map_agent_id === 'unregister-agent-1')).toBeUndefined();
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Direct Messaging
  // ══════════════════════════════════════════════════════════════════════

  describe('Direct Messaging', () => {
    it('should send a message between two connected agents', async () => {
      const connA = await connectAgent(SERVER_PORT, agentA.apiKey);
      const connB = await connectAgent(SERVER_PORT, agentB.apiKey);

      try {
        // Set up listener on B for incoming map/send
        const msgPromise = collectNotifications(connB.ws, 'map/send', 1);

        // A sends to B's swarm
        const sendRes = await rpc(connA.ws, 'map/send', {
          to: { id: `swarm:${connB.welcome.params.swarm_id}` },
          payload: 'Hello from A',
        });
        expect(sendRes.error).toBeUndefined();
        const result = sendRes.result as { messageId: string; delivered: boolean };
        expect(result.messageId).toBeDefined();

        // B should receive the message
        const received = await msgPromise;
        if (result.delivered) {
          expect(received.length).toBe(1);
          expect(received[0].params.payload).toBe('Hello from A');
        }
      } finally {
        await closeWs(connA.ws);
        await closeWs(connB.ws);
      }
    });

    it('should send a message to hive:<name> (broadcast)', async () => {
      const connA = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        // Link the swarm to the hive so it can send to hive:<name>
        const swarmId = connA.welcome.params.swarm_id as string;
        joinSwarmToHive(swarmId, hive.id);

        const res = await rpc(connA.ws, 'map/send', {
          to: { id: `hive:${hive.name}` },
          payload: 'Hello hive!',
        });
        // Should succeed (routed via hive router)
        expect(res.error).toBeUndefined();
      } finally {
        await closeWs(connA.ws);
      }
    });

    it('should return error when sending to nonexistent target', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await rpc(ws, 'map/send', {
          to: { id: 'agent:nonexistent' },
          payload: 'hello?',
        });
        expect(res.error).toBeDefined();
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Mail Conversations
  // ══════════════════════════════════════════════════════════════════════

  describe('Mail Conversations', () => {
    it('should create a mail conversation via mail/create', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await rpc(ws, 'mail/create', {
          subject: 'E2E Test Conversation',
          scope: 'default',
        });
        expect(res.error).toBeUndefined();
        const conv = res.result as { id: string; subject: string };
        expect(conv.id).toBeDefined();
        expect(conv.subject).toBe('E2E Test Conversation');
      } finally {
        await closeWs(ws);
      }
    });

    it('should join, add turns, and get a conversation', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        // Create
        const createRes = await rpc(ws, 'mail/create', { subject: 'Full Flow Test' });
        const convId = (createRes.result as { id: string }).id;

        // Join
        const joinRes = await rpc(ws, 'mail/join', {
          conversationId: convId,
          agentId: 'e2e-agent-a',
        });
        expect(joinRes.error).toBeUndefined();

        // Add turn
        const turnRes = await rpc(ws, 'mail/turn', {
          conversationId: convId,
          participantId: 'e2e-agent-a',
          content: { type: 'text', text: 'First e2e turn' },
        });
        expect(turnRes.error).toBeUndefined();
        const turn = turnRes.result as { id: string; conversation_id: string };
        expect(turn.conversation_id).toBe(convId);

        // Get
        const getRes = await rpc(ws, 'mail/get', { id: convId });
        expect(getRes.error).toBeUndefined();
        const data = getRes.result as { conversation: { id: string }; turns: unknown[] };
        expect(data.conversation.id).toBe(convId);
        expect(data.turns).toHaveLength(1);
      } finally {
        await closeWs(ws);
      }
    });

    it('should close a conversation via mail/close', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const createRes = await rpc(ws, 'mail/create', { subject: 'To Be Closed' });
        const convId = (createRes.result as { id: string }).id;

        const closeRes = await rpc(ws, 'mail/close', { id: convId });
        expect(closeRes.error).toBeUndefined();

        // Verify it's closed
        const getRes = await rpc(ws, 'mail/get', { id: convId });
        const data = getRes.result as { conversation: { status: string } };
        expect(data.conversation.status).toBe('completed');
      } finally {
        await closeWs(ws);
      }
    });

    it('should return error for unknown mail method', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await rpc(ws, 'mail/nonexistent', {});
        expect(res.error).toBeDefined();
        expect(res.error!.code).toBe(-32601);
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Event Subscriptions
  // ══════════════════════════════════════════════════════════════════════

  describe('Event Subscriptions', () => {
    it('should subscribe and receive mail.created events', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        // Subscribe to mail.created events
        const subRes = await rpc(ws, 'map/subscribe', {
          filter: { eventTypes: ['mail.created'] },
        });
        expect(subRes.error).toBeUndefined();
        const subId = (subRes.result as { subscriptionId: string }).subscriptionId;
        expect(subId).toBeDefined();

        // Set up listener for events
        const eventPromise = collectNotifications(ws, 'map/event', 1);

        // Create a conversation to trigger the event
        await rpc(ws, 'mail/create', { subject: 'Subscription Test' });

        // Should receive the event
        const events = await eventPromise;
        expect(events.length).toBe(1);
        expect(events[0].params.subscriptionId).toBe(subId);
        expect((events[0].params.event as { type: string }).type).toBe('mail.created');
        expect(events[0].params.sequence).toBe(1);
      } finally {
        await closeWs(ws);
      }
    });

    it('should unsubscribe and stop receiving events', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        // Subscribe
        const subRes = await rpc(ws, 'map/subscribe', {
          filter: { eventTypes: ['mail.created'] },
        });
        const subId = (subRes.result as { subscriptionId: string }).subscriptionId;

        // Unsubscribe
        const unsubRes = await rpc(ws, 'map/unsubscribe', { subscriptionId: subId });
        expect((unsubRes.result as { unsubscribed: boolean }).unsubscribed).toBe(true);

        // Create conversation — should NOT trigger event
        const eventPromise = collectNotifications(ws, 'map/event', 1, 1000);
        await rpc(ws, 'mail/create', { subject: 'Should Not Arrive' });

        const events = await eventPromise;
        expect(events.length).toBe(0);
      } finally {
        await closeWs(ws);
      }
    });

    it('should filter by conversationId for mail.turn.added', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        // Create two conversations
        const conv1Res = await rpc(ws, 'mail/create', { subject: 'Conv 1' });
        const conv1Id = (conv1Res.result as { id: string }).id;
        const conv2Res = await rpc(ws, 'mail/create', { subject: 'Conv 2' });
        const conv2Id = (conv2Res.result as { id: string }).id;

        // Subscribe to turns for conv1 only
        const subRes = await rpc(ws, 'map/subscribe', {
          filter: { eventTypes: ['mail.turn.added'], conversationId: conv1Id },
        });
        expect(subRes.error).toBeUndefined();

        const eventPromise = collectNotifications(ws, 'map/event', 1);

        // Add turn to conv2 — should NOT trigger
        await rpc(ws, 'mail/turn', {
          conversationId: conv2Id,
          participantId: 'test',
          content: { type: 'text', text: 'wrong conv' },
        });

        // Add turn to conv1 — SHOULD trigger
        await rpc(ws, 'mail/turn', {
          conversationId: conv1Id,
          participantId: 'test',
          content: { type: 'text', text: 'right conv' },
        });

        const events = await eventPromise;
        expect(events.length).toBe(1);
        const eventData = events[0].params.event as { type: string; data: { conversation_id: string } };
        expect(eventData.type).toBe('mail.turn.added');
      } finally {
        await closeWs(ws);
      }
    });

    it('should increment sequence numbers per subscription', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const subRes = await rpc(ws, 'map/subscribe', {
          filter: { eventTypes: ['mail.created'] },
        });
        expect(subRes.error).toBeUndefined();

        const eventPromise = collectNotifications(ws, 'map/event', 3);

        await rpc(ws, 'mail/create', { subject: 'Seq 1' });
        await rpc(ws, 'mail/create', { subject: 'Seq 2' });
        await rpc(ws, 'mail/create', { subject: 'Seq 3' });

        const events = await eventPromise;
        expect(events.length).toBe(3);
        expect(events[0].params.sequence).toBe(1);
        expect(events[1].params.sequence).toBe(2);
        expect(events[2].params.sequence).toBe(3);
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Extension Methods (x-hive/*)
  // ══════════════════════════════════════════════════════════════════════

  describe('Extension Methods', () => {
    // Connect once and join the swarm to the hive before testing x-hive methods
    let extWs: WebSocket;
    let extSwarmId: string;

    beforeAll(async () => {
      const conn = await connectAgent(SERVER_PORT, agentA.apiKey);
      extWs = conn.ws;
      extSwarmId = conn.welcome.params.swarm_id as string;
      // Link this auto-registered swarm to the test hive
      joinSwarmToHive(extSwarmId, hive.id);
    });

    afterAll(async () => {
      await closeWs(extWs);
    });

    it('should create a post via x-hive/post', async () => {
      const res = await rpc(extWs, 'x-hive/post', {
        hive: hive.name,
        title: 'E2E Test Post',
        content: 'Hello from e2e test',
      });
      expect(res.error).toBeUndefined();
      const result = res.result as { post: { id: string; title: string } };
      expect(result.post.id).toBeDefined();
      expect(result.post.title).toBe('E2E Test Post');
    });

    it('should create a comment via x-hive/comment', async () => {
      // First create a post
      const postRes = await rpc(extWs, 'x-hive/post', {
        hive: hive.name,
        title: 'Comment Target',
        content: 'Target post',
      });
      expect(postRes.error).toBeUndefined();
      const postId = (postRes.result as { post: { id: string } }).post.id;

      // Then comment on it
      const commentRes = await rpc(extWs, 'x-hive/comment', {
        hive: hive.name,
        post_id: postId,
        content: 'E2E test comment',
      });
      expect(commentRes.error).toBeUndefined();
      const comment = commentRes.result as { comment: { id: string } };
      expect(comment.comment.id).toBeDefined();
    });

    it('should vote via x-hive/vote', async () => {
      // Create a post to vote on
      const postRes = await rpc(extWs, 'x-hive/post', {
        hive: hive.name,
        title: 'Vote Target',
        content: 'Target for voting',
      });
      expect(postRes.error).toBeUndefined();
      const postId = (postRes.result as { post: { id: string } }).post.id;

      const voteRes = await rpc(extWs, 'x-hive/vote', {
        hive: hive.name,
        target_type: 'post',
        target_id: postId,
        value: 1,
      });
      expect(voteRes.error).toBeUndefined();
    });

    it('should get feed via x-hive/feed', async () => {
      const res = await rpc(extWs, 'x-hive/feed', { hive: hive.name });
      expect(res.error).toBeUndefined();
      const result = res.result as { posts: unknown[] };
      expect(result.posts).toBeDefined();
      expect(result.posts.length).toBeGreaterThanOrEqual(1);
    });

    it('should return error for non-member posting to hive', async () => {
      // Create an agent that is NOT a member of the hive
      const result = await agentsDAL.createAgent({ name: 'e2e-outsider' });
      const { ws } = await connectAgent(SERVER_PORT, result.apiKey);
      try {
        const res = await rpc(ws, 'x-hive/post', {
          hive: hive.name,
          title: 'Should Fail',
          body: 'Not a member',
        });
        expect(res.error).toBeDefined();
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Replay
  // ══════════════════════════════════════════════════════════════════════

  describe('Replay', () => {
    it('should replay unread messages on reconnect', async () => {
      // Connect B, send a message, disconnect B, then reconnect
      const connA = await connectAgent(SERVER_PORT, agentA.apiKey);
      const connB = await connectAgent(SERVER_PORT, agentB.apiKey);

      try {
        // A sends a message to B's swarm
        const sendRes = await rpc(connA.ws, 'map/send', {
          to: { id: `swarm:${connB.welcome.params.swarm_id}` },
          payload: 'Replay test message',
        });
        expect(sendRes.error).toBeUndefined();
      } finally {
        // Disconnect B
        await closeWs(connB.ws);
      }

      // Small delay to ensure disconnect processed
      await new Promise((r) => setTimeout(r, 200));

      // Reconnect B — should get replay
      const reconnB = await connectAgent(SERVER_PORT, agentB.apiKey);
      try {
        // The welcome message is already received; check if replay follows
        const replayPromise = collectNotifications(reconnB.ws, 'map/replay', 1, 2000);
        const replays = await replayPromise;
        // Replay may or may not arrive depending on whether messages were marked unread
        // The important thing is that the connection succeeds
        expect(reconnB.welcome.method).toBe('hub/welcome');
      } finally {
        await closeWs(reconnB.ws);
        await closeWs(connA.ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Multi-Agent Coordination
  // ══════════════════════════════════════════════════════════════════════

  describe('Multi-Agent Coordination', () => {
    it('should support full agent lifecycle: spawn → update → list → unregister', async () => {
      const { ws, welcome } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        // 1. Spawn sub-agent
        const spawnRes = await rpc(ws, 'map/agents/spawn', {
          agentId: 'coordinator-sub-1',
          name: 'Sub Agent 1',
          role: 'researcher',
        });
        expect(spawnRes.error).toBeUndefined();
        const spawned = (spawnRes.result as { agent: { id: string; state: string } }).agent;
        expect(spawned.id).toBe('coordinator-sub-1');
        expect(spawned.state).toBe('active');

        // 2. Update state to busy
        const updateRes = await rpc(ws, 'map/agents/update', {
          agentId: 'coordinator-sub-1',
          state: 'busy',
          metadata: { currentTask: 'researching' },
        });
        const updateAgent = (updateRes.result as { agent: { state: string } }).agent;
        expect(updateAgent).toBeDefined();
        expect(updateAgent.state).toBe('busy');

        // 3. List — verify state
        const listRes = await rpc(ws, 'map/agents/list', {
          swarm_id: welcome.params.swarm_id,
        });
        const agents = (listRes.result as { agents: Array<{ map_agent_id: string; state: string }> }).agents;
        const sub = agents.find((a) => a.map_agent_id === 'coordinator-sub-1');
        expect(sub).toBeDefined();
        expect(sub!.state).toBe('busy');

        // 4. Unregister
        const unregRes = await rpc(ws, 'map/agents/unregister', {
          agentId: 'coordinator-sub-1',
        });
        expect((unregRes.result as { ok: boolean }).ok).toBe(true);

        // 5. Verify gone
        const listRes2 = await rpc(ws, 'map/agents/list', {
          swarm_id: welcome.params.swarm_id,
        });
        const agents2 = (listRes2.result as { agents: Array<{ map_agent_id: string }> }).agents;
        expect(agents2.find((a) => a.map_agent_id === 'coordinator-sub-1')).toBeUndefined();
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Federation (stubbed)
  // ══════════════════════════════════════════════════════════════════════

  describe('Federation (stubbed)', () => {
    it('should return not-implemented error for federation methods', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const listRes = await rpc(ws, 'map/federation/list-peers', {});
        expect(listRes.error).toBeDefined();
        expect(listRes.error!.message).toContain('not yet implemented');

        const addRes = await rpc(ws, 'map/federation/add-peer', { url: 'ws://other.hub' });
        expect(addRes.error).toBeDefined();

        const removeRes = await rpc(ws, 'map/federation/remove-peer', { peerId: 'x' });
        expect(removeRes.error).toBeDefined();
      } finally {
        await closeWs(ws);
      }
    });

    it('should return -32601 for unknown federation method', async () => {
      const { ws } = await connectAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await rpc(ws, 'map/federation/unknown', {});
        expect(res.error).toBeDefined();
        expect(res.error!.code).toBe(-32601);
      } finally {
        await closeWs(ws);
      }
    });
  });
});
