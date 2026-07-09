/**
 * Mail API Routes Tests
 *
 * Tests the REST proxy routes for the MAP mail module.
 * Uses an in-memory agent-inbox instance (no SQLite dependency).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { createAgent } from '../../db/dal/agents.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { mailRoutes } from '../../api/routes/mail.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('mail-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'mail-routes-test.db');

// Mock the mail module with in-memory agent-inbox components
import { InMemoryStorage, MailJsonRpcServer, MessageRouter, TraceabilityLayer } from 'agent-inbox';
import { EventEmitter } from 'node:events';

let mockStorage: InstanceType<typeof InMemoryStorage>;
let mockJsonRpc: InstanceType<typeof MailJsonRpcServer>;
let mockEvents: EventEmitter;

vi.mock('../../mail/index.js', () => ({
  getMailStorage: () => mockStorage,
  getMailJsonRpc: () => mockJsonRpc,
}));

// Mock broadcastToChannel
vi.mock('../../realtime/index.js', () => ({ broadcastToChannel: vi.fn() }));

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test OpenHive', description: 'Test instance' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorateRequest('agent');

  await app.register(
    async (api) => {
      await api.register(mailRoutes, { config });
    },
    { prefix: '/api/v1' }
  );

  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe('Mail API Routes', () => {
  let app: FastifyInstance;
  let config: Config;
  let humanAgentId: string;
  let adminAgent: Parameters<typeof setLocalAgent>[0];
  let nonAdminAgent: Parameters<typeof setLocalAgent>[0];

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    config = createTestConfig();

    // The human operator authenticates as an ADMIN — the mail routes exist for
    // hub-wide human observability, which is the admin path. Per-agent access is
    // exercised separately in the "conversation access control" block below.
    const { agent } = await createAgent({ name: 'test-human', description: 'Test human user', is_admin: true });
    humanAgentId = agent.id;
    adminAgent = { ...agent, is_admin: true };
    setLocalAgent(adminAgent);

    // A non-admin agent for the per-conversation access gate.
    const { agent: member } = await createAgent({ name: 'test-agent', description: 'Non-admin agent' });
    nonAdminAgent = { ...member, is_admin: false };

    app = await createTestApp(config);
  });

  afterAll(async () => {
    setLocalAgent(null);
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    // Fresh storage for each test
    mockEvents = new EventEmitter();
    mockStorage = new InMemoryStorage();
    const router = new MessageRouter(mockStorage, mockEvents, 'default');
    new TraceabilityLayer(mockStorage, mockEvents);
    mockJsonRpc = new MailJsonRpcServer(mockStorage, router, mockEvents);
  });

  // ── Per-conversation access control (tenant isolation) ──
  describe('conversation access control (non-admin agents)', () => {
    beforeEach(() => setLocalAgent(nonAdminAgent));
    afterEach(() => setLocalAgent(adminAgent));

    async function makeConv(scope: string): Promise<string> {
      const res = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: 'mk', method: 'mail/create',
        params: { subject: `conv-${scope}`, scope },
      });
      return (res.result as any).id;
    }

    it('403s a non-admin, non-participant on a private conversation', async () => {
      const id = await makeConv('default');
      for (const path of [
        `/api/v1/mail/conversations/${id}`,
        `/api/v1/mail/conversations/${id}/turns`,
        `/api/v1/mail/conversations/${id}/threads`,
      ]) {
        const res = await app.inject({ method: 'GET', url: path });
        expect(res.statusCode, path).toBe(403);
      }
    });

    it('allows a non-admin to read a hub-visible discussion scope', async () => {
      const id = await makeConv('spec-thread');
      const res = await app.inject({ method: 'GET', url: `/api/v1/mail/conversations/${id}` });
      expect(res.statusCode).toBe(200);
    });

    it('allows a non-admin participant to read a private conversation', async () => {
      const id = await makeConv('default');
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: 'j', method: 'mail/join',
        params: { conversationId: id, agentId: nonAdminAgent!.id, role: 'participant' },
      });
      const res = await app.inject({ method: 'GET', url: `/api/v1/mail/conversations/${id}` });
      expect(res.statusCode).toBe(200);
    });

    it('list hides private conversations from non-participants but shows shared ones', async () => {
      await makeConv('default');
      await makeConv('spec-thread');
      const res = await app.inject({ method: 'GET', url: '/api/v1/mail/conversations' });
      expect(res.statusCode).toBe(200);
      const scopes = JSON.parse(res.body).conversations.map((c: any) => c.scope);
      expect(scopes).toContain('spec-thread');
      expect(scopes).not.toContain('default');
    });
  });

  // ── GET /mail/conversations ──

  describe('GET /mail/conversations', () => {
    it('returns empty list when no conversations exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/mail/conversations',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.conversations).toEqual([]);
    });

    it('returns all conversations', async () => {
      // Create conversations via JSON-RPC
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Test conv 1' },
      });
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/create',
        params: { subject: 'Test conv 2' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/mail/conversations',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.conversations).toHaveLength(2);
    });

    it('filters by status', async () => {
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Active conv' },
      });

      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/create',
        params: { subject: 'Completed conv' },
      });
      // Close the second one
      const list = mockStorage.listConversations();
      const secondConv = list.find(c => c.subject === 'Completed conv')!;
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/close',
        params: { id: secondConv.id },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/mail/conversations?status=active',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0].status).toBe('active');
    });

    it('sorts by most recently updated first', async () => {
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Older' },
      });

      // Small delay so timestamps differ
      await new Promise(r => setTimeout(r, 10));

      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/create',
        params: { subject: 'Newer' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/mail/conversations',
      });

      const body = JSON.parse(res.body);
      expect(body.conversations[0].subject).toBe('Newer');
      expect(body.conversations[1].subject).toBe('Older');
    });
  });

  // ── GET /mail/conversations/:id ──

  describe('GET /mail/conversations/:id', () => {
    it('returns conversation with turns and threads', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Detail test' },
      });
      const convId = (createRes.result as any).id;

      // Add a participant and a turn
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId,
          participantId: 'agent-1',
          contentType: 'text',
          content: { type: 'text', text: 'Hello' },
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${convId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.conversation.id).toBe(convId);
      expect(body.conversation.subject).toBe('Detail test');
      expect(body.conversation.participants).toHaveLength(1);
      expect(body.turns).toHaveLength(1);
      expect(body.turns[0].content.text).toBe('Hello');
      expect(body.threads).toEqual([]);
      expect(body.turn_count).toBe(1);
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/mail/conversations/nonexistent',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('NOT_FOUND');
    });
  });

  // ── GET /mail/conversations/:id/turns ──

  describe('GET /mail/conversations/:id/turns', () => {
    it('returns turns for a conversation', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Turns test' },
      });
      const convId = (createRes.result as any).id;

      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });

      // Add multiple turns
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId,
          participantId: 'agent-1',
          contentType: 'text',
          content: { type: 'text', text: 'Turn 1' },
        },
      });
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/turn',
        params: {
          conversationId: convId,
          participantId: 'agent-1',
          contentType: 'event',
          content: { type: 'event', event: 'status_change' },
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${convId}/turns`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.turns).toHaveLength(2);
    });

    it('filters turns by content_type', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Filter test' },
      });
      const convId = (createRes.result as any).id;

      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'agent-1',
          contentType: 'text', content: { type: 'text', text: 'Hi' },
        },
      });
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'agent-1',
          contentType: 'event', content: { type: 'event', event: 'joined' },
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${convId}/turns?content_type=text`,
      });

      const body = JSON.parse(res.body);
      expect(body.turns).toHaveLength(1);
      expect(body.turns[0].content_type).toBe('text');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/mail/conversations/nonexistent/turns',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── GET /mail/conversations/:id/threads ──

  describe('GET /mail/conversations/:id/threads', () => {
    it('returns threads for a conversation', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Threads test' },
      });
      const convId = (createRes.result as any).id;

      // Add a turn and create a thread from it
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });
      const turnRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'agent-1',
          contentType: 'text', content: { type: 'text', text: 'Root turn' },
        },
      });
      const turnId = (turnRes.result as any).id;

      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/thread/create',
        params: {
          conversationId: convId,
          rootTurnId: turnId,
          subject: 'Side discussion',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${convId}/threads`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0].subject).toBe('Side discussion');
      expect(body.threads[0].root_turn_id).toBe(turnId);
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/mail/conversations/nonexistent/threads',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── POST /mail/conversations/:id/join ──

  describe('POST /mail/conversations/:id/join', () => {
    it('joins a conversation as supervisor', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Join test' },
      });
      const convId = (createRes.result as any).id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/join`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);

      // Verify the participant was added
      const conv = mockStorage.getConversation(convId);
      expect(conv!.participants).toHaveLength(1);
      expect(conv!.participants[0].agent_id).toBe(humanAgentId);
    });

    it('is idempotent with custom role param', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Custom role test' },
      });
      const convId = (createRes.result as any).id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/join`,
        payload: { role: 'observer' },
      });

      expect(res.statusCode).toBe(200);

      const conv = mockStorage.getConversation(convId);
      expect(conv!.participants).toHaveLength(1);
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mail/conversations/nonexistent/join',
        payload: {},
      });

      expect(res.statusCode).toBe(404);
    });

    it('is idempotent — joining twice does not duplicate', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Idempotent join' },
      });
      const convId = (createRes.result as any).id;

      await app.inject({ method: 'POST', url: `/api/v1/mail/conversations/${convId}/join`, payload: {} });
      await app.inject({ method: 'POST', url: `/api/v1/mail/conversations/${convId}/join`, payload: {} });

      const conv = mockStorage.getConversation(convId);
      expect(conv!.participants).toHaveLength(1);
    });
  });

  // ── POST /mail/conversations/:id/turns ──

  describe('POST /mail/conversations/:id/turns', () => {
    it('sends a text turn as supervisor', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Send turn test' },
      });
      const convId = (createRes.result as any).id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/turns`,
        payload: {
          content: { type: 'text', text: 'Supervisor message' },
          content_type: 'text',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.participant_id).toBe(humanAgentId);
      expect(body.content.text).toBe('Supervisor message');
      expect(body.content_type).toBe('text');
    });

    it('auto-joins conversation on first turn', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Auto-join test' },
      });
      const convId = (createRes.result as any).id;

      // Send turn without explicitly joining first
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/turns`,
        payload: {
          content: { type: 'text', text: 'Hello from human' },
        },
      });

      expect(res.statusCode).toBe(201);

      // Verify auto-joined
      const conv = mockStorage.getConversation(convId);
      expect(conv!.participants.some(p => p.agent_id === humanAgentId)).toBe(true);
    });

    it('sends a JSON data turn', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Data turn test' },
      });
      const convId = (createRes.result as any).id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/turns`,
        payload: {
          content: { type: 'data', data: { key: 'value' } },
          content_type: 'data',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.content_type).toBe('data');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mail/conversations/nonexistent/turns',
        payload: {
          content: { type: 'text', text: 'Should fail' },
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('supports thread_id and in_reply_to', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Thread turn test' },
      });
      const convId = (createRes.result as any).id;

      // Create a turn to reply to
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });
      const turnRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'agent-1',
          contentType: 'text', content: { type: 'text', text: 'Original' },
        },
      });
      const turnId = (turnRes.result as any).id;

      // Create a thread
      const threadRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/thread/create',
        params: { conversationId: convId, rootTurnId: turnId },
      });
      const threadId = (threadRes.result as any).id;

      // Send a reply in the thread
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/turns`,
        payload: {
          content: { type: 'text', text: 'Thread reply' },
          content_type: 'text',
          thread_id: threadId,
          in_reply_to: turnId,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.thread_id).toBe(threadId);
      expect(body.in_reply_to).toBe(turnId);
    });
  });

  // ── POST /mail/conversations/:id/participants (generic invite) ──

  describe('POST /mail/conversations/:id/participants', () => {
    it('invites an agent into a conversation', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Invite test' },
      });
      const convId = (createRes.result as any).id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/participants`,
        payload: { agent_id: 'codex-1', role: 'reviewer' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.agent_id).toBe('codex-1');

      const conv = mockStorage.getConversation(convId);
      const invited = conv!.participants.find((p) => p.agent_id === 'codex-1');
      expect(invited).toBeDefined();
      expect(invited!.role).toBe('reviewer');
    });

    it('is idempotent — inviting twice does not duplicate', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Idempotent invite' },
      });
      const convId = (createRes.result as any).id;

      await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/participants`,
        payload: { agent_id: 'codex-1' },
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/participants`,
        payload: { agent_id: 'codex-1' },
      });

      const conv = mockStorage.getConversation(convId);
      expect(conv!.participants.filter((p) => p.agent_id === 'codex-1')).toHaveLength(1);
    });

    it('defaults role to participant when omitted', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Default role' },
      });
      const convId = (createRes.result as any).id;

      await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/participants`,
        payload: { agent_id: 'agent-x' },
      });

      const conv = mockStorage.getConversation(convId);
      const p = conv!.participants.find((x) => x.agent_id === 'agent-x');
      expect(p!.role).toBe('participant');
    });

    it('returns 400 when agent_id is missing', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Missing agent' },
      });
      const convId = (createRes.result as any).id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/participants`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for a non-existent conversation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mail/conversations/nonexistent/participants',
        payload: { agent_id: 'codex-1' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Multi-participant conversations ──

  describe('Multi-participant conversations', () => {
    it('shows all participants from agents and human supervisor', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Multi-party' },
      });
      const convId = (createRes.result as any).id;

      // Two agents join
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-alpha' },
      });
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-beta' },
      });

      // Human joins via REST
      await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/join`,
        payload: {},
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${convId}`,
      });

      const body = JSON.parse(res.body);
      expect(body.conversation.participants).toHaveLength(3);
      const ids = body.conversation.participants.map((p: any) => p.agent_id);
      expect(ids).toContain('agent-alpha');
      expect(ids).toContain('agent-beta');
      expect(ids).toContain(humanAgentId);
    });

    it('interleaves agent and human turns chronologically', async () => {
      const createRes = await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Interleaved' },
      });
      const convId = (createRes.result as any).id;

      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });

      // Agent sends first
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'agent-1',
          contentType: 'text', content: { type: 'text', text: 'Agent says hi' },
        },
      });

      // Human sends second
      await app.inject({
        method: 'POST',
        url: `/api/v1/mail/conversations/${convId}/turns`,
        payload: { content: { type: 'text', text: 'Human responds' } },
      });

      // Agent sends third
      await mockJsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'agent-1',
          contentType: 'text', content: { type: 'text', text: 'Agent acknowledges' },
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/mail/conversations/${convId}/turns`,
      });

      const body = JSON.parse(res.body);
      expect(body.turns).toHaveLength(3);
      expect(body.turns[0].participant_id).toBe('agent-1');
      expect(body.turns[1].participant_id).toBe(humanAgentId);
      expect(body.turns[2].participant_id).toBe('agent-1');
    });
  });
});
