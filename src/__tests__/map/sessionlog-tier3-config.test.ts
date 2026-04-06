/**
 * Tests for configurable Tier 3 sessionlog transcript lookup.
 *
 * Verifies that readLocalSessionlogTranscript searches configured
 * sessionlog.sessionDirs before falling back to .git/sessionlog-sessions/.
 *
 * Real components: Fastify server, SQLite DB, trajectory handler, sessions route
 * Mocked: broadcastToChannel, fetchTranscriptFromSwarm
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { handleTrajectoryRequest } from '../../map/trajectory-handler.js';
import { ConfigSchema } from '../../config.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { initializeLocalSessionStorage } from '../../sessions/storage/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../map/trajectory-content.js', () => ({
  fetchTranscriptFromSwarm: vi.fn().mockResolvedValue(null),
}));

// ============================================================================
// Setup
// ============================================================================

const TEST_ROOT = testRoot('tier3-config');
const DB_PATH = testDbPath(TEST_ROOT, 'tier3-config.db');

let app: FastifyInstance;
let agentId: string;
let customSessionDir: string;

const mockTranscript = [
  JSON.stringify({
    type: 'user',
    sessionId: 'test-123',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'Hello from custom dir' },
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 'test-123',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: 'Hi there' },
  }),
].join('\n');

beforeAll(async () => {
  cleanTestRoot(TEST_ROOT);
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // Create a custom sessionlog directory (simulates separate session repo)
  customSessionDir = path.join(TEST_ROOT, 'external-sessions', 'project-abc123');
  fs.mkdirSync(customSessionDir, { recursive: true });

  initDatabase(DB_PATH);

  const result = await agentsDAL.createAgent({ name: 'tier3-test-agent' });
  agentId = result.agent.id;
  setLocalAgent(result.agent);

  const sessionsPath = path.join(TEST_ROOT, 'sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  initializeLocalSessionStorage({ type: 'local', basePath: sessionsPath });

  const config = ConfigSchema.parse({
    database: DB_PATH,
    sessions: { type: 'local', path: sessionsPath },
    sessionlog: {
      sessionDirs: [customSessionDir],
    },
  });

  app = Fastify();
  app.decorateRequest('agent');
  await app.register(sessionsRoutes, { prefix: '/api/v1', config } as any);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

// ============================================================================
// Tests
// ============================================================================

describe('Tier 3: configurable sessionlog lookup', () => {
  it('reads transcript from configured sessionDirs', async () => {
    const sessionId = 'custom-dir-session-456';

    // Create a checkpoint so we have a session resource
    const r = handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: `${sessionId}-step1`,
          agent: 'test-agent',
          metadata: { project: 'custom-test' },
        },
      },
      { swarmId: 'swarm-custom', agentId },
    );

    // Write mock sessionlog state file in the custom directory
    const transcriptDir = path.join(TEST_ROOT, 'transcripts');
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(transcriptPath, mockTranscript);
    fs.writeFileSync(
      path.join(customSessionDir, `${sessionId}.json`),
      JSON.stringify({ sessionID: sessionId, phase: 'active', transcriptPath }),
    );

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${r.resource_id}/events?limit=10`,
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.map((e: any) => e.type)).toContain('user_message');
    } finally {
      try { fs.unlinkSync(path.join(customSessionDir, `${sessionId}.json`)); } catch {}
      try { fs.unlinkSync(transcriptPath); } catch {}
    }
  });

  it('falls back to .git/sessionlog-sessions/ when not found in configured dirs', async () => {
    const sessionId = 'fallback-session-789';

    const r = handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: `${sessionId}-step1`,
          agent: 'test-agent',
          metadata: { project: 'fallback-test' },
        },
      },
      { swarmId: 'swarm-fallback', agentId },
    );

    // Write transcript in the default .git/sessionlog-sessions/ location
    const defaultDir = path.join(process.cwd(), '.git', 'sessionlog-sessions');
    const transcriptDir = path.join(TEST_ROOT, 'transcripts-fallback');
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    fs.mkdirSync(defaultDir, { recursive: true });
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(transcriptPath, mockTranscript);
    fs.writeFileSync(
      path.join(defaultDir, `${sessionId}.json`),
      JSON.stringify({ sessionID: sessionId, phase: 'active', transcriptPath }),
    );

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${r.resource_id}/events?limit=10`,
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.events.length).toBeGreaterThan(0);
    } finally {
      try { fs.unlinkSync(path.join(defaultDir, `${sessionId}.json`)); } catch {}
      try { fs.unlinkSync(transcriptPath); } catch {}
    }
  });

  it('prefers configured sessionDirs over default .git/ location', async () => {
    const sessionId = 'priority-session-101';

    const r = handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: `${sessionId}-step1`,
          agent: 'test-agent',
          metadata: { project: 'priority-test' },
        },
      },
      { swarmId: 'swarm-priority', agentId },
    );

    // Write DIFFERENT transcripts in both locations
    const customTranscript = [
      JSON.stringify({
        type: 'user',
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'From custom dir' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: 'Custom response' },
      }),
    ].join('\n');

    const defaultTranscript = [
      JSON.stringify({
        type: 'user',
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'From default dir' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: sessionId,
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: 'Default response' },
      }),
    ].join('\n');

    const customTranscriptPath = path.join(TEST_ROOT, 'transcripts-custom', `${sessionId}.jsonl`);
    const defaultTranscriptPath = path.join(TEST_ROOT, 'transcripts-default', `${sessionId}.jsonl`);
    const defaultDir = path.join(process.cwd(), '.git', 'sessionlog-sessions');

    fs.mkdirSync(path.dirname(customTranscriptPath), { recursive: true });
    fs.mkdirSync(path.dirname(defaultTranscriptPath), { recursive: true });
    fs.mkdirSync(defaultDir, { recursive: true });

    fs.writeFileSync(customTranscriptPath, customTranscript);
    fs.writeFileSync(defaultTranscriptPath, defaultTranscript);

    // Custom dir state points to custom transcript
    fs.writeFileSync(
      path.join(customSessionDir, `${sessionId}.json`),
      JSON.stringify({ sessionID: sessionId, phase: 'active', transcriptPath: customTranscriptPath }),
    );
    // Default dir state points to default transcript
    fs.writeFileSync(
      path.join(defaultDir, `${sessionId}.json`),
      JSON.stringify({ sessionID: sessionId, phase: 'active', transcriptPath: defaultTranscriptPath }),
    );

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${r.resource_id}/events?limit=10`,
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      // Should find "From custom dir" (configured path searched first)
      const userMessages = body.events.filter((e: any) => e.type === 'user_message');
      expect(userMessages.length).toBeGreaterThan(0);
      // Content may be a string or array of content blocks
      const content = userMessages[0].content;
      const contentStr = typeof content === 'string'
        ? content
        : JSON.stringify(content);
      expect(contentStr).toContain('From custom dir');
    } finally {
      try { fs.unlinkSync(path.join(customSessionDir, `${sessionId}.json`)); } catch {}
      try { fs.unlinkSync(path.join(defaultDir, `${sessionId}.json`)); } catch {}
      try { fs.unlinkSync(customTranscriptPath); } catch {}
      try { fs.unlinkSync(defaultTranscriptPath); } catch {}
    }
  });

  it('returns 503 when session state not found in any location', async () => {
    const r = handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: 'orphan-no-state-001',
          agent: 'ghost',
        },
      },
      { swarmId: 'swarm-ghost', agentId },
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${r.resource_id}/events?limit=10`,
    });
    expect(res.statusCode).toBe(503);
  });

  it('resolves sessionlog from resource projectPath metadata', async () => {
    const sessionId = 'projectpath-session-202';

    // Simulate an agent running in a different project directory.
    // The checkpoint includes projectPath pointing to that directory.
    const projectDir = path.join(TEST_ROOT, 'fake-project');
    const projectSessionlogDir = path.join(projectDir, '.git', 'sessionlog-sessions');
    const transcriptDir = path.join(TEST_ROOT, 'transcripts-projectpath');
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    fs.mkdirSync(projectSessionlogDir, { recursive: true });
    fs.mkdirSync(transcriptDir, { recursive: true });

    // Write sessionlog state + transcript in the project's .git/ directory
    fs.writeFileSync(transcriptPath, mockTranscript);
    fs.writeFileSync(
      path.join(projectSessionlogDir, `${sessionId}.json`),
      JSON.stringify({ sessionID: sessionId, phase: 'active', transcriptPath }),
    );

    // Create checkpoint with projectPath in metadata
    const r = handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: `${sessionId}-step1`,
          agent: 'test-agent',
          metadata: { project: 'fake-project', projectPath: projectDir },
        },
      },
      { swarmId: 'swarm-projectpath', agentId },
    );

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/${r.resource_id}/events?limit=10`,
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.map((e: any) => e.type)).toContain('user_message');
    } finally {
      try { fs.unlinkSync(path.join(projectSessionlogDir, `${sessionId}.json`)); } catch {}
      try { fs.unlinkSync(transcriptPath); } catch {}
    }
  });
});
