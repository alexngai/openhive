import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { initializeLocalSessionStorage } from '../../sessions/storage/index.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('sessions-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'sessions-routes-test.db');
const TEST_STORAGE_PATH = path.join(TEST_ROOT, 'sessions-storage');

function cleanTestData() {
  cleanTestRoot(TEST_ROOT);
}

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

  await app.register(
    async (api) => {
      await api.register(sessionsRoutes, { config });
    },
    { prefix: '/api/v1' }
  );

  return app;
}

// Sample Claude session content (matches actual Claude Code session.jsonl format)
const CLAUDE_SESSION_CONTENT = `{"type":"user","sessionId":"ses_abc123","cwd":"/home/user/project","timestamp":"2024-01-15T10:00:00Z","uuid":"msg_001","message":{"role":"user","content":"Hello, Claude!"}}
{"type":"assistant","sessionId":"ses_abc123","timestamp":"2024-01-15T10:00:01Z","uuid":"msg_002","message":{"role":"assistant","content":[{"type":"text","text":"Hello! How can I help you today?"},{"type":"tool_use","id":"tool_001","name":"Read","input":{"file_path":"/test.txt"}}],"stop_reason":"tool_use"}}
{"type":"result","sessionId":"ses_abc123","timestamp":"2024-01-15T10:00:02Z","uuid":"result_001","tool_use_id":"tool_001","result":"File contents here"}
{"type":"assistant","sessionId":"ses_abc123","timestamp":"2024-01-15T10:00:03Z","uuid":"msg_003","message":{"role":"assistant","content":"The file contains: File contents here","stop_reason":"end_turn"}}
{"type":"summary","sessionId":"ses_abc123","timestamp":"2024-01-15T10:00:04Z","input_tokens":100,"output_tokens":50,"cost_usd":0.001}`;

// Sample Codex session content
const CODEX_SESSION_CONTENT = `{"id":"ses_123","model":"codex","rollout_id":"roll_001","ts":"2024-01-15T10:00:00Z"}
{"event":"item.user_message","data":{"id":"msg_001","text":"Run the build"},"ts":"2024-01-15T10:00:01Z"}
{"event":"item.assistant_message","data":{"id":"msg_002","text":"I'll run the build now."},"ts":"2024-01-15T10:00:02Z"}
{"event":"item.command_execution","data":{"id":"cmd_001","command":"npm run build","output":"Build complete"},"ts":"2024-01-15T10:00:03Z"}`;

// ============================================================================
// Tests
// ============================================================================

describe('Session Routes', () => {
  let app: FastifyInstance;
  let config: Config;
  let ownerAgent: { id: string; apiKey: string };
  let collaboratorAgent: { id: string; apiKey: string };
  let observerAgent: { id: string; apiKey: string };

  beforeAll(async () => {
    cleanTestData();
    initDatabase(TEST_DB_PATH);

    // Initialize session storage
    initializeLocalSessionStorage({
      type: 'local',
      basePath: TEST_STORAGE_PATH,
    });

    // Create test agents
    const ownerResult = await agentsDAL.createAgent({
      name: 'session-owner',
      description: 'Session owner agent',
    });
    ownerAgent = { id: ownerResult.agent.id, apiKey: ownerResult.apiKey };

    const collaboratorResult = await agentsDAL.createAgent({
      name: 'session-collaborator',
      description: 'Session collaborator agent',
    });
    collaboratorAgent = { id: collaboratorResult.agent.id, apiKey: collaboratorResult.apiKey };

    const observerResult = await agentsDAL.createAgent({
      name: 'session-observer',
      description: 'Session observer agent',
    });
    observerAgent = { id: observerResult.agent.id, apiKey: observerResult.apiKey };

    config = createTestConfig();
    app = await createTestApp(config);
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestData();
  });

  // ============================================================================
  // Format Registry Tests
  // ============================================================================

  describe('GET /sessions/formats', () => {
    it('should list supported formats', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/formats',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.builtin).toBeDefined();
      expect(Array.isArray(body.builtin)).toBe(true);
      expect(body.builtin.some((f: { id: string }) => f.id === 'claude_jsonl_v1')).toBe(true);
      expect(body.builtin.some((f: { id: string }) => f.id === 'codex_jsonl_v1')).toBe(true);
      expect(body.builtin.some((f: { id: string }) => f.id === 'raw')).toBe(true);
    });
  });

  describe('POST /sessions/detect-format', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        payload: { content: CLAUDE_SESSION_CONTENT },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should detect Claude format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: { content: CLAUDE_SESSION_CONTENT },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.format_id).toBe('claude_jsonl_v1');
      expect(body.confidence).toBe('high');
      expect(body.index).toBeDefined();
      expect(body.index.messageCount).toBeGreaterThan(0);
    });

    it('should detect Codex format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: { content: CODEX_SESSION_CONTENT },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.format_id).toBe('codex_jsonl_v1');
    });

    it('should fall back to raw for unknown format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: { content: 'just some plain text\nwith multiple lines' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.format_id).toBe('raw');
      expect(body.confidence).toBe('low');
    });

    it('should require content', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/detect-format',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ============================================================================
  // Session Upload Tests
  // ============================================================================

  describe('POST /sessions/upload', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        payload: {
          name: 'Test Session',
          content: CLAUDE_SESSION_CONTENT,
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should upload session with auto-detected format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'My Claude Session',
          description: 'A test session',
          content: CLAUDE_SESSION_CONTENT,
          storage_backend: 'local',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();

      expect(body.id).toBeDefined();
      expect(body.name).toBe('My Claude Session');
      expect(body.session).toBeDefined();
      expect(body.session.format_id).toBe('claude_jsonl_v1');
      expect(body.session.format_detected).toBe(true);
      expect(body.session.storage_backend).toBe('local');
    });

    it('should upload session with explicit format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Explicit Format Session',
          content: CODEX_SESSION_CONTENT,
          format_id: 'codex_jsonl_v1',
          storage_backend: 'local',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();

      expect(body.session.format_id).toBe('codex_jsonl_v1');
      expect(body.session.format_detected).toBe(false);
    });

    it('should upload session with tags', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Tagged Session',
          content: CLAUDE_SESSION_CONTENT,
          tags: ['testing', 'demo'],
          storage_backend: 'local',
        },
      });

      expect(response.statusCode).toBe(201);
    });

    it('should require content', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'No Content Session',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should require name', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          content: CLAUDE_SESSION_CONTENT,
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ============================================================================
  // Session Content Tests
  // ============================================================================

  describe('Session Content Endpoints', () => {
    let sessionId: string;

    beforeAll(async () => {
      // Create a session to test with
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Content Test Session',
          content: CLAUDE_SESSION_CONTENT,
          storage_backend: 'local',
        },
      });

      sessionId = response.json().id;
    });

    describe('GET /sessions/:id/content', () => {
      it('should get session content', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${sessionId}/content`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('application/x-ndjson');
        expect(response.body).toContain('Hello, Claude!');
      });

      it('should deny access to unauthorized user', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${sessionId}/content`,
          headers: {
            authorization: `Bearer ${observerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(403);
      });

      it('should return 404 for non-existent session', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/sessions/nonexistent-id/content',
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(404);
      });
    });

    describe('GET /sessions/:id/events', () => {
      it('should get session events in ACP format', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${sessionId}/events`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(body.format_id).toBeDefined();
        expect(body.total).toBeGreaterThan(0);
        expect(Array.isArray(body.events)).toBe(true);
        expect(body.events[0]).toHaveProperty('type');
        expect(body.events[0]).toHaveProperty('timestamp');
      });

      it('should support pagination', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${sessionId}/events?limit=2&offset=0`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(body.limit).toBe(2);
        expect(body.offset).toBe(0);
        expect(body.events.length).toBeLessThanOrEqual(2);
      });
    });
  });

  // ============================================================================
  // Participants Tests
  // ============================================================================

  describe('Session Participants', () => {
    let sessionId: string;

    beforeAll(async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Participants Test Session',
          content: CLAUDE_SESSION_CONTENT,
          storage_backend: 'local',
        },
      });

      sessionId = response.json().id;
    });

    describe('GET /sessions/:id/participants', () => {
      it('should list participants (owner by default)', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${sessionId}/participants`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(Array.isArray(body.participants)).toBe(true);
        expect(body.participants.length).toBe(1);
        expect(body.participants[0].agent_id).toBe(ownerAgent.id);
        expect(body.participants[0].role).toBe('owner');
      });
    });

    describe('POST /sessions/:id/participants', () => {
      it('should add collaborator', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionId}/participants`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
          payload: {
            agent_id: collaboratorAgent.id,
            role: 'collaborator',
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();

        expect(body.agent_id).toBe(collaboratorAgent.id);
        expect(body.role).toBe('collaborator');
      });

      it('should add observer', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionId}/participants`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
          payload: {
            agent_id: observerAgent.id,
            role: 'observer',
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();

        expect(body.role).toBe('observer');
      });

      it('should prevent duplicate participants', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionId}/participants`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
          payload: {
            agent_id: collaboratorAgent.id,
            role: 'observer',
          },
        });

        expect(response.statusCode).toBe(409);
      });

      it('should deny non-owner from adding participants', async () => {
        const newAgentResult = await agentsDAL.createAgent({
          name: 'random-agent',
          description: 'Random agent',
        });

        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionId}/participants`,
          headers: {
            authorization: `Bearer ${collaboratorAgent.apiKey}`,
          },
          payload: {
            agent_id: newAgentResult.agent.id,
            role: 'observer',
          },
        });

        // Collaborator doesn't have modify permission
        expect(response.statusCode).toBe(403);
      });
    });

    describe('PATCH /sessions/:id/cursor', () => {
      it('should update participant cursor', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/sessions/${sessionId}/cursor`,
          headers: {
            authorization: `Bearer ${collaboratorAgent.apiKey}`,
          },
          payload: {
            event_index: 5,
            event_id: 'evt_005',
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(body.success).toBe(true);
        expect(body.event_index).toBe(5);
      });

      it('should return 404 if not a participant', async () => {
        const nonParticipant = await agentsDAL.createAgent({
          name: 'non-participant',
          description: 'Not a participant',
        });

        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/sessions/${sessionId}/cursor`,
          headers: {
            authorization: `Bearer ${nonParticipant.apiKey}`,
          },
          payload: {
            event_index: 3,
          },
        });

        expect(response.statusCode).toBe(404);
      });
    });
  });

  // ============================================================================
  // Checkpoints Tests
  // ============================================================================

  describe('Session Checkpoints', () => {
    let sessionId: string;

    beforeAll(async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Checkpoints Test Session',
          content: CLAUDE_SESSION_CONTENT,
          storage_backend: 'local',
        },
      });

      sessionId = response.json().id;
    });

    describe('POST /sessions/:id/checkpoints', () => {
      it('should create checkpoint', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionId}/checkpoints`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
          payload: {
            name: 'After Setup',
            description: 'Checkpoint after initial setup',
            event_index: 10,
            event_id: 'evt_010',
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();

        expect(body.id).toBeDefined();
        expect(body.id).toMatch(/^chk_/);
        expect(body.name).toBe('After Setup');
        expect(body.event_index).toBe(10);
      });

      it('should deny unauthorized user from creating checkpoint', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionId}/checkpoints`,
          headers: {
            authorization: `Bearer ${observerAgent.apiKey}`,
          },
          payload: {
            name: 'Unauthorized Checkpoint',
            event_index: 5,
          },
        });

        expect(response.statusCode).toBe(403);
      });
    });

    describe('GET /sessions/:id/checkpoints', () => {
      it('should list checkpoints', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${sessionId}/checkpoints`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(Array.isArray(body.checkpoints)).toBe(true);
        expect(body.checkpoints.length).toBeGreaterThan(0);
      });
    });
  });

  // ============================================================================
  // Forks Tests
  // ============================================================================

  describe('Session Forks', () => {
    let parentSessionId: string;
    let childSessionId: string;

    beforeAll(async () => {
      // Create parent session
      const parentResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Parent Session',
          content: CLAUDE_SESSION_CONTENT,
          storage_backend: 'local',
        },
      });

      parentSessionId = parentResponse.json().id;

      // Create child session (fork)
      const childResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Child Session (Fork)',
          content: CLAUDE_SESSION_CONTENT,
          storage_backend: 'local',
          fork_from: {
            session_id: parentSessionId,
            event_index: 5,
            reason: 'Testing fork functionality',
          },
        },
      });

      childSessionId = childResponse.json().id;
    });

    describe('POST /sessions/upload with fork_from', () => {
      it('should create session with fork relationship', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/sessions/upload',
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
          payload: {
            name: 'Another Fork',
            content: CLAUDE_SESSION_CONTENT,
            storage_backend: 'local',
            fork_from: {
              session_id: parentSessionId,
              event_index: 3,
            },
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();

        expect(body.session.forked_from).toBeDefined();
        expect(body.session.forked_from.session_id).toBe(parentSessionId);
        expect(body.session.forked_from.event_index).toBe(3);
        expect(body.session.forked_from.fork_id).toMatch(/^fork_/);
      });

      it('should reject fork from non-existent session', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/sessions/upload',
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
          payload: {
            name: 'Bad Fork',
            content: CLAUDE_SESSION_CONTENT,
            storage_backend: 'local',
            fork_from: {
              session_id: 'nonexistent-session-id',
              event_index: 0,
            },
          },
        });

        expect(response.statusCode).toBe(400);
      });
    });

    describe('GET /sessions/:id/forks', () => {
      it('should list child forks of a session', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${parentSessionId}/forks`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(body.forked_from).toBeNull(); // Parent has no parent
        expect(Array.isArray(body.forks)).toBe(true);
        expect(body.forks.length).toBeGreaterThan(0);
      });

      it('should show parent fork info for child session', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${childSessionId}/forks`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(body.forked_from).not.toBeNull();
        expect(body.forked_from.parent_session_id).toBe(parentSessionId);
      });
    });

    describe('GET /sessions/:id/lineage', () => {
      it('should return lineage chain', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${childSessionId}/lineage`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(body.session_id).toBe(childSessionId);
        expect(Array.isArray(body.ancestors)).toBe(true);
        expect(body.ancestors.length).toBe(1);
        expect(body.ancestors[0].id).toBe(parentSessionId);
        expect(body.depth).toBe(1);
      });

      it('should return empty lineage for root session', async () => {
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/sessions/${parentSessionId}/lineage`,
          headers: {
            authorization: `Bearer ${ownerAgent.apiKey}`,
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();

        expect(body.ancestors).toHaveLength(0);
        expect(body.depth).toBe(0);
      });
    });
  });

  // ============================================================================
  // Query Tests
  // ============================================================================

  describe('GET /sessions/query', () => {
    beforeAll(async () => {
      // Create additional sessions for query testing
      await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Query Test Session 1',
          description: 'First query test',
          content: CLAUDE_SESSION_CONTENT,
          storage_backend: 'local',
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Query Test Session 2',
          description: 'Second query test',
          content: CODEX_SESSION_CONTENT,
          storage_backend: 'local',
        },
      });
    });

    it('should query all accessible sessions', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/query',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(Array.isArray(body.data)).toBe(true);
      expect(body.total).toBeGreaterThan(0);
      expect(body.limit).toBeDefined();
      expect(body.offset).toBeDefined();
    });

    it('should filter by format_id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/query?format_id=claude_jsonl_v1',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      body.data.forEach((session: { metadata: { format: { id: string } } }) => {
        expect(session.metadata?.format?.id).toBe('claude_jsonl_v1');
      });
    });

    it('should filter by search term', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/query?search=Query%20Test',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.data.length).toBeGreaterThan(0);
      body.data.forEach((session: { name: string }) => {
        expect(session.name.toLowerCase()).toContain('query test');
      });
    });

    it('should support pagination', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/query?limit=2&offset=0',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
      expect(body.data.length).toBeLessThanOrEqual(2);
    });

    it('should filter by min_messages', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/query?min_messages=1',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      body.data.forEach((session: { metadata: { index: { messageCount: number } } }) => {
        if (session.metadata?.index?.messageCount !== undefined) {
          expect(session.metadata.index.messageCount).toBeGreaterThanOrEqual(1);
        }
      });
    });

    it('should filter by has_tool_calls', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/query?has_tool_calls=true',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      body.data.forEach((session: { metadata: { index: { toolCallCount: number } } }) => {
        if (session.metadata?.index?.toolCallCount !== undefined) {
          expect(session.metadata.index.toolCallCount).toBeGreaterThan(0);
        }
      });
    });
  });

  // ============================================================================
  // Edge Cases and Error Handling
  // ============================================================================

  describe('Error Handling', () => {
    it('should handle invalid session ID gracefully', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/invalid-id-12345/content',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should reject malformed JSON in upload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
          'content-type': 'application/json',
        },
        payload: 'not valid json{{{',
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should enforce name length limits', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'x'.repeat(200), // Exceeds 100 char limit
          content: CLAUDE_SESSION_CONTENT,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should enforce tag limits', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/upload',
        headers: {
          authorization: `Bearer ${ownerAgent.apiKey}`,
        },
        payload: {
          name: 'Too Many Tags',
          content: CLAUDE_SESSION_CONTENT,
          tags: Array.from({ length: 20 }, (_, i) => `tag${i}`), // Exceeds 10 tag limit
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
