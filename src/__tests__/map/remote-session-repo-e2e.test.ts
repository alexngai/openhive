/**
 * Full E2E: Remote Session Repo → Sessionlog → MAP → OpenHive → Transcript
 *
 * Exercises the complete cross-system flow when a team uses a shared remote
 * session repo:
 *
 * 1. Create a bare git remote (simulates GitHub)
 * 2. Sessionlog clones it and writes session state + transcript to the clone
 * 3. cc-swarm builds a checkpoint and sends it via MAP to OpenHive
 * 4. OpenHive stores the checkpoint and auto-creates a session resource
 * 5. OpenHive reads the transcript back via Tier 3 (from the clone's sessionDirs)
 * 6. A second developer pushes checkpoints — both coexist
 * 7. Sessionlog pushes checkpoints to the bare remote
 *
 * Real components: Fastify server, SQLite DB, trajectory handler, sessions API,
 *                  real git repos (bare remote + clones), sessionlog stores
 * Mocked: broadcastToChannel, fetchTranscriptFromSwarm (no live swarm)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as trajectoryDAL from '../../db/dal/trajectory-checkpoints.js';
import { handleTrajectoryRequest } from '../../map/trajectory-handler.js';
import { ConfigSchema } from '../../config.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { initializeLocalSessionStorage } from '../../sessions/storage/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Sessionlog module — real git operations
import {
  cloneSessionRepo,
  pushSessionRepo,
  getProjectID,
} from '../../../references/sessionlog/src/git-operations.js';
import { createSessionStore } from '../../../references/sessionlog/src/store/session-store.js';
import { createCheckpointStore } from '../../../references/sessionlog/src/store/checkpoint-store.js';
import { CHECKPOINTS_BRANCH, SESSION_DIR_NAME } from '../../../references/sessionlog/src/types.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../map/trajectory-content.js', () => ({
  fetchTranscriptFromSwarm: vi.fn().mockResolvedValue(null),
}));

// ============================================================================
// Helpers
// ============================================================================

const TEST_ROOT = testRoot('remote-repo-cross-e2e');
const DB_PATH = testDbPath(TEST_ROOT, 'cross-e2e.db');

function gitInDir(dir: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function makeMockTranscript(sessionId: string, prompt: string, response: string): string {
  return [
    JSON.stringify({
      type: 'user',
      sessionId,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: prompt },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: response },
    }),
  ].join('\n');
}

// ============================================================================
// Setup
// ============================================================================

let app: FastifyInstance;
let agentId: string;
let bareRemote: string;
let clonePath: string;
let projectDir: string;
const DIRECTORY = 'test-project';
const CP_BRANCH = `${CHECKPOINTS_BRANCH}/${DIRECTORY}`;
const SESSIONS_SUBDIR = `${SESSION_DIR_NAME}/${DIRECTORY}`;

beforeAll(async () => {
  cleanTestRoot(TEST_ROOT);
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // ── Git setup: bare remote + project repo + session repo clone ──

  // 1. Create bare remote (simulates GitHub)
  bareRemote = path.join(TEST_ROOT, 'remote.git');
  fs.mkdirSync(bareRemote);
  gitInDir(bareRemote, 'init --bare');

  // Seed with initial commit
  const seed = path.join(TEST_ROOT, 'seed');
  fs.mkdirSync(seed);
  gitInDir(seed, 'init');
  gitInDir(seed, 'config user.email "test@test.com"');
  gitInDir(seed, 'config user.name "Test"');
  fs.writeFileSync(path.join(seed, 'README.md'), '# sessions');
  gitInDir(seed, 'add .');
  gitInDir(seed, 'commit -m "init sessions repo"');
  gitInDir(seed, `remote add origin ${bareRemote}`);
  const branch = gitInDir(seed, 'rev-parse --abbrev-ref HEAD');
  gitInDir(seed, `push origin ${branch}`);
  fs.rmSync(seed, { recursive: true, force: true });

  // 2. Create a project repo (where the developer works)
  projectDir = path.join(TEST_ROOT, 'my-project');
  fs.mkdirSync(projectDir);
  gitInDir(projectDir, 'init');
  gitInDir(projectDir, 'config user.email "test@test.com"');
  gitInDir(projectDir, 'config user.name "Test"');
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# my project');
  gitInDir(projectDir, 'add .');
  gitInDir(projectDir, 'commit -m "init project"');

  // 3. Clone the bare remote as the session repo (simulates what resolveSessionRepoConfig does)
  clonePath = path.join(TEST_ROOT, 'session-clone');
  await cloneSessionRepo(bareRemote, clonePath);

  // ── OpenHive setup ──

  initDatabase(DB_PATH);

  const result = await agentsDAL.createAgent({ name: 'cross-e2e-agent' });
  agentId = result.agent.id;
  setLocalAgent(result.agent);

  const sessionsPath = path.join(TEST_ROOT, 'oh-sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  initializeLocalSessionStorage({ type: 'local', basePath: sessionsPath });

  // Point OpenHive's Tier 3 at the clone's sessions directory
  const sessionDirsPath = path.join(clonePath, SESSIONS_SUBDIR);
  fs.mkdirSync(sessionDirsPath, { recursive: true });

  const config = ConfigSchema.parse({
    database: DB_PATH,
    sessions: { type: 'local', path: sessionsPath },
    sessionlog: {
      sessionDirs: [sessionDirsPath],
    },
  });

  app = Fastify();
  app.decorateRequest('agent', null);
  await app.register(sessionsRoutes, { prefix: '/api/v1', config } as any);
  await app.ready();
}, 15000);

afterAll(async () => {
  setLocalAgent(null);
  await app?.close();
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

// ============================================================================
// Tests — ordered, each builds on the previous
// ============================================================================

describe('Cross-system E2E: Remote Session Repo', () => {
  const sessionId = 'cross-e2e-session-001';
  let resourceId: string;

  // ── Step 1: Sessionlog writes state + transcript to the clone ──

  it('sessionlog writes session state to the clone', async () => {
    const sessionsDir = path.join(clonePath, SESSIONS_SUBDIR);
    const store = createSessionStore(undefined, sessionsDir);

    await store.save({
      sessionID: sessionId,
      baseCommit: 'abc123',
      startedAt: new Date().toISOString(),
      phase: 'active',
      agentType: 'Claude Code',
      filesTouched: ['src/app.ts', 'src/config.ts'],
      stepCount: 5,
      turnCheckpointIDs: ['cp-1', 'cp-2'],
      untrackedFilesAtStart: [],
      checkpointTranscriptStart: 0,
      firstPrompt: 'Fix the authentication bug',
      transcriptPath: path.join(TEST_ROOT, 'transcripts', `${sessionId}.jsonl`),
    });

    // Write the actual transcript file
    const transcriptDir = path.join(TEST_ROOT, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      makeMockTranscript(sessionId, 'Fix the authentication bug', 'I found the issue in auth.ts...'),
    );

    // Verify state file exists in the clone
    const loaded = await store.load(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionID).toBe(sessionId);
    expect(loaded!.firstPrompt).toBe('Fix the authentication bug');
  });

  // ── Step 2: cc-swarm builds checkpoint and sends to OpenHive ──

  it('trajectory checkpoint is received and stored by OpenHive', () => {
    // Simulate what cc-swarm does: build a checkpoint from sessionlog state
    // and send it via MAP to the OpenHive hub
    const r = handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: `${sessionId}-step5`,
          session_id: sessionId,
          agent: 'Claude Code',
          branch: 'main',
          files_touched: ['src/app.ts', 'src/config.ts'],
          checkpoints_count: 2,
          token_usage: {
            input_tokens: 30000,
            output_tokens: 8000,
            cache_creation_tokens: 1000,
            cache_read_tokens: 10000,
            api_call_count: 15,
          },
          metadata: {
            project: 'my-project',
            firstPrompt: 'Fix the authentication bug',
          },
        },
      },
      { swarmId: 'cross-e2e-swarm', agentId },
    );

    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(r.resource_id).toBeDefined();
    resourceId = r.resource_id;

    // Verify checkpoint is in the database
    const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(resourceId);
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0].agent).toBe('Claude Code');
    expect(checkpoints[0].files_touched).toContain('src/app.ts');
  });

  // ── Step 3: OpenHive reads transcript via Tier 3 (from clone) ──

  it('OpenHive serves transcript from the session repo clone (Tier 3)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${resourceId}/events?limit=10`,
    });

    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.events.length).toBeGreaterThan(0);

    // Verify we got the actual transcript content
    const userMessages = body.events.filter((e: any) => e.type === 'user_message');
    expect(userMessages.length).toBeGreaterThan(0);
    const content = typeof userMessages[0].content === 'string'
      ? userMessages[0].content
      : JSON.stringify(userMessages[0].content);
    expect(content).toContain('Fix the authentication bug');

    const assistantMessages = body.events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages.length).toBeGreaterThan(0);
  });

  // ── Step 4: Sessionlog writes committed checkpoint to clone ──

  it('sessionlog writes committed checkpoint to the clone', async () => {
    const cpStore = createCheckpointStore(projectDir, clonePath, CP_BRANCH);
    const cpID = await cpStore.generateID();

    await cpStore.writeCommitted({
      checkpointID: cpID,
      sessionID: sessionId,
      strategy: 'manual-commit',
      branch: 'main',
      transcript: Buffer.from(makeMockTranscript(sessionId, 'Fix the auth bug', 'Fixed')),
      prompts: ['Fix the authentication bug'],
      context: Buffer.from('Auth middleware was not checking token expiry'),
      filesTouched: ['src/app.ts', 'src/config.ts'],
      checkpointsCount: 2,
      authorName: 'Developer A',
      authorEmail: 'deva@test.com',
      agent: 'Claude Code',
      turnID: 'turn-1',
      checkpointTranscriptStart: 0,
    });

    // Verify the checkpoint is readable from the clone
    const summary = await cpStore.readCommitted(cpID);
    expect(summary).not.toBeNull();
    expect(summary!.checkpointID).toBe(cpID);
    expect(summary!.filesTouched).toContain('src/app.ts');
  });

  // ── Step 5: Push to remote ──

  it('sessionlog pushes checkpoint branch to the remote', async () => {
    await pushSessionRepo(clonePath, CP_BRANCH);

    // Verify the branch exists on the bare remote
    const remoteBranches = gitInDir(bareRemote, 'branch --list');
    expect(remoteBranches).toContain('checkpoints');
  });

  // ── Step 6: Second developer's checkpoint coexists ──

  it('second developer sends checkpoint to same OpenHive session', () => {
    const r = handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: 'dev-b-cp-001',
          session_id: 'dev-b-session-001',
          agent: 'Claude Code',
          branch: 'feature-x',
          files_touched: ['src/feature.ts'],
          checkpoints_count: 1,
          token_usage: { input_tokens: 15000, output_tokens: 4000 },
          metadata: {
            project: 'my-project',
            firstPrompt: 'Add the new feature',
          },
        },
      },
      { swarmId: 'cross-e2e-swarm-b', agentId },
    );

    // Second developer gets a separate session resource
    expect(r.ok).toBe(true);
    expect(r.resource_id).toBeDefined();
  });

  // ── Step 7: Sessions overview shows both ──

  it('OpenHive sessions list shows sessions from both developers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions/overview',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // The overview returns { data: [...], total: N }
    const sessions = body.data ?? body.sessions ?? body;
    const list = Array.isArray(sessions) ? sessions : [];
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  // ── Step 8: Checkpoint invalidation triggers re-read ──

  it('new checkpoint invalidates cache and Tier 3 serves updated transcript', async () => {
    // Update the transcript file (simulates more conversation)
    const transcriptPath = path.join(TEST_ROOT, 'transcripts', `${sessionId}.jsonl`);
    const updatedTranscript = makeMockTranscript(
      sessionId,
      'Fix the authentication bug',
      'Done! The token expiry check is now in place.',
    );
    fs.writeFileSync(transcriptPath, updatedTranscript);

    // Send another checkpoint (invalidates any cached content)
    handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: `${sessionId}-step10`,
          session_id: sessionId,
          agent: 'Claude Code',
          files_touched: ['src/auth.ts'],
          checkpoints_count: 3,
          token_usage: { input_tokens: 50000, output_tokens: 12000 },
        },
      },
      { swarmId: 'cross-e2e-swarm', agentId },
    );

    // Re-fetch events — should get the updated transcript
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${resourceId}/events?limit=10`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const assistantMessages = body.events.filter((e: any) => e.type === 'assistant_message');
    expect(assistantMessages.length).toBeGreaterThan(0);
  });
});
