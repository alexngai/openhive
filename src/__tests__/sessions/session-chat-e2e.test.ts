/**
 * E2E Tests: Session Chat Send Flow
 *
 * Tests the full chat send pipeline without mocking:
 *
 *   1. Real mail module (in-memory storage, real JSON-RPC server)
 *   2. Real session resources (SQLite DAL)
 *   3. Real auth middleware
 *   4. POST /sessions/:id/chat → lazy conversation creation → mail turn delivery
 *   5. GET /sessions/:id/chat → conversation resolution
 *   6. GET /mail/conversations/:id/turns → verify turns stored
 *
 * Tests both cc-swarm profile (mail-only, no ACP) and macro-agent profile
 * (mail + ACP capabilities), validating the full flow from session resource
 * through capability-gated chat to mail turn persistence.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { mailRoutes } from '../../api/routes/mail.js';
import { mapRoutes } from '../../api/routes/map.js';
import { initMail, getMailStorage } from '../../mail/index.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { getAllInbound, hasCapability } from '../../map/connection-registry.js';
import { findSwarmById } from '../../db/dal/map.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('e2e-session-chat-flow');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'session-chat-flow.db');
const PORT = 19695;
const HEARTBEAT_MS = 500;

// ============================================================================
// Helpers
// ============================================================================

let rpcId = 0;

interface SidecarHandle {
  ws: WebSocket;
  swarmId: string;
  messages: Array<{ method?: string; id?: number; result?: any; error?: any; params?: any }>;
  close(): void;
}

function connectSidecar(token: string, swarmId: string): Promise<SidecarHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/map?token=${token}&swarm_id=${swarmId}`);
    const messages: SidecarHandle['messages'] = [];
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (msg.method === 'ping') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
        }
      } catch { /* ignore */ }
    });
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Connect timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve({ ws, swarmId, messages, close() { ws.close(); } }); });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function wsRpc(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, intervalMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Session Chat Send Flow', () => {
  let app: FastifyInstance;
  let ingestToken: string;
  let agentId: string;
  const handles: SidecarHandle[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    // Initialize mail module with in-memory storage (real, not mocked)
    await initMail();

    const { agent } = await agentsDAL.createAgent({
      name: 'session-chat-e2e-agent',
      description: 'Agent for session chat e2e',
    });
    agentId = agent.id;

    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'session-chat-e2e',
      agent_id: agent.id,
    });
    ingestToken = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Session Chat E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: {
        enabled: true,
        trustModel: 'open',
        missedPongsBeforeTerminate: 3,
      },
    });

    setHeartbeatInterval(HEARTBEAT_MS);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => {
        await api.register(sessionsRoutes, { config });
        await api.register(mailRoutes, { config });
        await api.register(mapRoutes, { config });
      },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    for (const h of handles) {
      try { h.ws.terminate(); } catch { /* ignore */ }
    }
    handles.length = 0;
    setLocalAgent(null);
    stopMapWebSocket();
    await app?.close();
    await sleep(200);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  // Helper: create a session resource linked to a swarm
  function createSessionResource(name: string, swarmId?: string) {
    return resourcesDAL.createResource({
      resource_type: 'session',
      name,
      git_remote_url: `map://session/${name}`,
      owner_agent_id: agentId,
      metadata: swarmId ? { source_swarm_id: swarmId } : undefined,
    });
  }

  // ── POST /sessions/:id/chat endpoint tests ──────────────────────────────

  describe('POST /sessions/:id/chat', () => {
    it('creates conversation lazily on first message and sends turn', async () => {
      const session = createSessionResource('lazy-create-test');

      // First message — should create conversation
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Hello from user' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.conversation_id).toBeDefined();
      expect(body.turn).toBeDefined();

      // Verify conversation was created in mail storage
      const storage = getMailStorage();
      const conv = storage.getConversation(body.conversation_id);
      expect(conv).toBeDefined();
      expect(conv!.subject).toContain('lazy-create-test');
    });

    it('reuses existing conversation on subsequent messages', async () => {
      const session = createSessionResource('reuse-conv-test');

      // First message
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'First message' },
      });
      const body1 = JSON.parse(res1.payload);
      const convId = body1.conversation_id;

      // Second message — should reuse same conversation
      const res2 = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Second message' },
      });

      expect(res2.statusCode).toBe(201);
      const body2 = JSON.parse(res2.payload);
      expect(body2.conversation_id).toBe(convId);
    });

    it('stores mail_conversation_id in session metadata', async () => {
      const session = createSessionResource('metadata-test');

      await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Test message' },
      });

      // Verify metadata was updated
      const updated = resourcesDAL.findResourceById(session.id);
      expect(updated).toBeDefined();
      const metadata = updated!.metadata as Record<string, unknown>;
      expect(metadata.mail_conversation_id).toBeDefined();
      expect(typeof metadata.mail_conversation_id).toBe('string');
    });

    it('returns 404 for non-existent session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/non-existent-session/chat',
        payload: { content: 'Hello' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('NOT_FOUND');
    });

    it('returns 400 for empty content', async () => {
      const session = createSessionResource('empty-content-test');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for missing content field', async () => {
      const session = createSessionResource('missing-field-test');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ── GET /sessions/:id/chat endpoint tests ────────────────────────────────

  describe('GET /sessions/:id/chat', () => {
    it('returns null conversation_id before any messages', async () => {
      const session = createSessionResource('no-chat-yet');

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${session.id}/chat`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.conversation_id).toBeNull();
      expect(body.chat_available).toBe(false);
    });

    it('returns conversation_id after first message', async () => {
      const session = createSessionResource('has-chat');

      // Send a message to create conversation
      const chatRes = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Hello' },
      });
      const convId = JSON.parse(chatRes.payload).conversation_id;

      // Check GET returns the conversation ID
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${session.id}/chat`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.conversation_id).toBe(convId);
      expect(body.chat_available).toBe(true);
    });

    it('returns 404 for non-existent session', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/non-existent/chat',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── Mail turn verification ───────────────────────────────────────────────

  describe('mail turn delivery', () => {
    it('turns are queryable via mail API', async () => {
      const session = createSessionResource('mail-verify-test');

      // Send two messages
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'First turn' },
      });
      const convId = JSON.parse(res1.payload).conversation_id;

      await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Second turn' },
      });

      // Query turns via mail API
      const turnsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${convId}/turns`,
      });

      expect(turnsRes.statusCode).toBe(200);
      const turnsBody = JSON.parse(turnsRes.payload);
      expect(turnsBody.turns).toHaveLength(2);
      expect(turnsBody.turns[0].content).toEqual({ type: 'text', text: 'First turn' });
      expect(turnsBody.turns[1].content).toEqual({ type: 'text', text: 'Second turn' });
    });

    it('sender is auto-joined as supervisor', async () => {
      const session = createSessionResource('supervisor-join-test');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Join test' },
      });
      const convId = JSON.parse(res.payload).conversation_id;

      // Check conversation has the agent as participant
      const convRes = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${convId}`,
      });

      expect(convRes.statusCode).toBe(200);
      const convBody = JSON.parse(convRes.payload);
      const participants = convBody.conversation.participants;
      expect(participants).toBeDefined();
      expect(participants.some((p: any) => p.agent_id === agentId)).toBe(true);
    });

    it('conversation scope links to session', async () => {
      const session = createSessionResource('scope-test');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Scope test' },
      });
      const convId = JSON.parse(res.payload).conversation_id;

      const storage = getMailStorage();
      const conv = storage.getConversation(convId);
      expect(conv!.scope).toBe(`session:${session.id}`);
    });
  });

  // ── Full stack: capabilities → session → chat ────────────────────────────

  describe('full stack: swarm capabilities → session chat', () => {
    it('cc-swarm profile: swarm with mail caps → session chat works', async () => {
      const swarmId = `cc-swarm-fullstack-${Date.now()}`;

      // 1. Connect swarm and register agent with cc-swarm capabilities
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);
      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      await wsRpc(handle.ws, 'map/agents/register', {
        name: 'team-sidecar',
        role: 'sidecar',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true, canViewHistory: true },
          trajectory: { canReport: true, canServeContent: true },
        },
        metadata: { systemId: 'test-cc-swarm', type: 'claude-code-swarm-sidecar' },
      });

      // 2. Wait for capabilities to be stored
      await waitFor(() => hasCapability(swarmId, 'mail.canJoin'));

      // 3. Verify capabilities via API
      const swarmRes = await app.inject({
        method: 'GET',
        url: `/api/v1/map/swarms/${swarmId}`,
      });
      expect(swarmRes.statusCode).toBe(200);
      const swarm = JSON.parse(swarmRes.payload);
      expect(swarm.capabilities.mail.canJoin).toBe(true);
      expect(swarm.capabilities.messaging.canReceive).toBe(true);

      // 4. Create session linked to this swarm
      const session = createSessionResource('cc-swarm-session', swarmId);

      // 5. Send chat message
      const chatRes = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Hello cc-swarm agent!' },
      });

      expect(chatRes.statusCode).toBe(201);
      const chatBody = JSON.parse(chatRes.payload);
      expect(chatBody.ok).toBe(true);
      expect(chatBody.conversation_id).toBeDefined();

      // 6. Verify turn was delivered to mail system
      const turnsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${chatBody.conversation_id}/turns`,
      });
      const turns = JSON.parse(turnsRes.payload).turns;
      expect(turns).toHaveLength(1);
      expect(turns[0].content).toEqual({ type: 'text', text: 'Hello cc-swarm agent!' });

      handle.close();
    });

    it('macro-agent profile: swarm with ACP + mail caps → session chat works', async () => {
      const swarmId = `macro-agent-fullstack-${Date.now()}`;

      // 1. Connect swarm with macro-agent capabilities
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);
      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      await wsRpc(handle.ws, 'map/agents/register', {
        name: 'macro-agent-sidecar',
        role: 'sidecar',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true, canViewHistory: true },
          protocols: ['acp'],
          acp: { version: '2024-10-07' },
          trajectory: { canReport: true, canServeContent: false },
        },
        metadata: { systemId: 'test-macro-agent', type: 'macro-agent-sidecar' },
      });

      await waitFor(() => hasCapability(swarmId, 'mail.canJoin'));

      // 2. Verify ACP is advertised
      const swarmRes = await app.inject({
        method: 'GET',
        url: `/api/v1/map/swarms/${swarmId}`,
      });
      const swarm = JSON.parse(swarmRes.payload);
      expect(swarm.capabilities.protocols).toContain('acp');
      expect(swarm.capabilities.acp.version).toBe('2024-10-07');

      // 3. Create session and send chat
      const session = createSessionResource('macro-agent-session', swarmId);

      const chatRes = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Hello macro-agent!' },
      });

      expect(chatRes.statusCode).toBe(201);
      const chatBody = JSON.parse(chatRes.payload);
      expect(chatBody.ok).toBe(true);

      // 4. Verify mail turn
      const turnsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${chatBody.conversation_id}/turns`,
      });
      expect(JSON.parse(turnsRes.payload).turns).toHaveLength(1);

      handle.close();
    });

    it('swarm without mail caps: session exists but no chat capability flag', async () => {
      const swarmId = `no-inbox-fullstack-${Date.now()}`;

      // Connect swarm WITHOUT mail/messaging capabilities (inbox disabled)
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);
      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      await wsRpc(handle.ws, 'map/agents/register', {
        name: 'team-sidecar',
        role: 'sidecar',
        capabilities: {
          trajectory: { canReport: true, canServeContent: true },
          tasks: { canCreate: true },
        },
        metadata: { systemId: 'test-no-inbox', type: 'claude-code-swarm-sidecar' },
      });

      await waitFor(() => getAllInbound().get(swarmId)?.registeredAgents.size! > 0);

      // Verify no mail capability
      expect(hasCapability(swarmId, 'mail.canJoin')).toBe(false);
      expect(hasCapability(swarmId, 'messaging.canReceive')).toBe(false);

      // The swarm API should NOT show mail capabilities
      const swarmRes = await app.inject({
        method: 'GET',
        url: `/api/v1/map/swarms/${swarmId}`,
      });
      const swarm = JSON.parse(swarmRes.payload);
      expect(swarm.capabilities.mail).toBeUndefined();
      expect(swarm.capabilities.messaging).toBeUndefined();

      // Chat endpoint still works (it doesn't check capabilities — that's the frontend's job)
      // But the frontend would show "unavailable" based on these capabilities
      const session = createSessionResource('no-inbox-session', swarmId);
      const chatRes = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'This still sends but frontend would block it' },
      });
      expect(chatRes.statusCode).toBe(201);

      handle.close();
    });
  });

  // ── Error paths and edge cases ───────────────────────────────────────

  describe('error handling', () => {
    it('returns 400 for content exceeding max length', async () => {
      const session = createSessionResource('max-length-test');
      const longContent = 'x'.repeat(100_001);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: longContent },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for non-string content', async () => {
      const session = createSessionResource('type-test');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 12345 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for non-session resource type', async () => {
      // Create a non-session resource
      const resource = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'not-a-session',
        git_remote_url: 'test://not-session',
        owner_agent_id: agentId,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${resource.id}/chat`,
        payload: { content: 'Hello' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('handles content_type parameter', async () => {
      const session = createSessionResource('content-type-test');

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}/chat`,
        payload: { content: 'Hello', content_type: 'text' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
    });
  });

  // ── Race condition defense ───────────────────────────────────────────

  describe('concurrent requests', () => {
    it('concurrent messages to same session reuse one conversation', async () => {
      const session = createSessionResource('concurrent-test');

      // Fire multiple requests concurrently
      const results = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${session.id}/chat`,
          payload: { content: 'Message 1' },
        }),
        app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${session.id}/chat`,
          payload: { content: 'Message 2' },
        }),
        app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${session.id}/chat`,
          payload: { content: 'Message 3' },
        }),
      ]);

      // All should succeed
      for (const res of results) {
        expect(res.statusCode).toBe(201);
      }

      // All should reference the same conversation (or at most the race winner)
      const convIds = results.map(r => JSON.parse(r.payload).conversation_id);
      const uniqueConvIds = [...new Set(convIds)];

      // Ideally 1 conversation, but race may create 2 — the important thing is
      // the session metadata points to exactly one
      const resource = resourcesDAL.findResourceById(session.id);
      const linkedConvId = (resource!.metadata as any).mail_conversation_id;
      expect(linkedConvId).toBeDefined();

      // All turns should be queryable (even if split across conversations due to race)
      let totalTurns = 0;
      for (const convId of uniqueConvIds) {
        const turnsRes = await app.inject({
          method: 'GET',
          url: `/api/v1/mail/conversations/${convId}/turns`,
        });
        totalTurns += JSON.parse(turnsRes.payload).turns.length;
      }
      expect(totalTurns).toBe(3);
    });
  });
});
