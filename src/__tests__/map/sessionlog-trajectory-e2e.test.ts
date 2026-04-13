/**
 * Full E2E: Sessionlog → MAP WebSocket → Trajectory Handler → Sessions API
 *
 * Exercises the complete flow using a real Fastify server with /ws/map:
 * 1. WebSocket connection survives heartbeat cycles
 * 2. cc-swarm's buildTrajectoryCheckpoint() wire format is accepted
 * 3. Trajectory handler auto-creates session resources
 * 4. Checkpoints are stored with correct data via DAL
 * 5. Stats aggregate across multiple checkpoints
 * 6. Sessions overview returns correct totals
 *
 * Real components: Fastify server, WebSocket, trajectory handler, SQLite DB, DAL
 * Mocked: broadcastToChannel (no real WebSocket clients for UI)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as trajectoryDAL from '../../db/dal/trajectory-checkpoints.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { getAllInbound, getInbound } from '../../map/connection-registry.js';
import { ConfigSchema } from '../../config.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { initializeLocalSessionStorage } from '../../sessions/storage/index.js';
import { handleTrajectoryRequest } from '../../map/trajectory-handler.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// cc-swarm real function — import from references/ (published package doesn't export src/)
// @ts-expect-error — .mjs import from references
import { buildTrajectoryCheckpoint } from '../../../references/claude-code-swarm/src/sessionlog.mjs';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

// Mock cc-swarm config for buildTrajectoryCheckpoint
vi.mock('../../../references/claude-code-swarm/src/config.mjs', () => ({
  readConfig: () => ({ sessionlog: { enabled: true, sync: 'metrics', mode: 'plugin' } }),
  resolveTeamName: () => 'e2e-team',
  resolveScope: () => 'swarm:e2e-team',
}));

// ============================================================================
// Helpers
// ============================================================================

const HEARTBEAT_MS = 500;
let rpcCounter = 0;

function nextId(): string {
  return `rpc-${++rpcCounter}`;
}

function rpc(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function waitNotification(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Notification timeout')), timeoutMs);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString());
      if (!msg.id && msg.method) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ============================================================================
// Test Suite
// ============================================================================

const TEST_ROOT = testRoot('sessionlog-traj-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'trajectory-e2e.db');
const PORT = 19680;

describe('Sessionlog Trajectory E2E: full server flow', () => {
  let app: FastifyInstance;
  let apiKey: string;
  let agentId: string;

  // Shared state across ordered tests
  let ws: WebSocket;
  let swarmId: string;
  let resourceId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    // Initialize session storage for caching tests
    const sessionsPath = path.join(TEST_ROOT, 'sessions');
    fs.mkdirSync(sessionsPath, { recursive: true });
    initializeLocalSessionStorage({ type: 'local', basePath: sessionsPath });

    const result = await agentsDAL.createAgent({ name: 'traj-e2e-agent' });
    apiKey = result.apiKey;
    agentId = result.agent.id;
    // Set local agent for auth middleware (allows unauthenticated inject calls)
    setLocalAgent(result.agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Trajectory E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      cors: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open' },
    });

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setHeartbeatInterval(HEARTBEAT_MS);
    setupMapWebSocket(app, config);
    // Register sessions API routes (same routes the frontend calls)
    await app.register(sessionsRoutes, { prefix: '/api/v1', config } as any);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    try { ws?.close(); } catch {}
    stopMapWebSocket();
    setLocalAgent(null);
    await new Promise(r => setTimeout(r, 100));
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  // ── 1. Connection ──────────────────────────────────────────────

  it('connects via WebSocket and receives hub/welcome', async () => {
    swarmId = `traj-e2e-${Date.now()}`;
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Connect timeout')), 5000);
    });

    const welcome = await waitNotification(ws);
    expect(welcome.method).toBe('hub/welcome');
    expect(welcome.params.swarm_id).toBe(swarmId);
    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);
  });

  it('survives multiple heartbeat cycles', async () => {
    // Wait for 6 heartbeat cycles
    await new Promise(r => setTimeout(r, HEARTBEAT_MS * 6 + 200));

    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);
  }, 10000);

  // ── 2. Trajectory checkpoint — auto-create ─────────────────────

  it('auto-creates session resource on first checkpoint', async () => {
    const response = await rpc(ws, 'trajectory/checkpoint', {
      checkpoint: {
        id: 'e2e-cp-001',
        session_id: 'e2e-session-001',
        agent: 'e2e-team-sidecar',
        files_touched: ['src/app.ts', 'src/config.ts'],
        checkpoints_count: 2,
        token_usage: { input_tokens: 20000, output_tokens: 6000 },
        metadata: { phase: 'active', turnId: '3' },
      },
    });

    expect(response.result).toBeDefined();
    expect(response.result.ok).toBe(true);
    expect(response.result.created).toBe(true);
    expect(response.result.resource_id).toBeDefined();
    expect(response.result.checkpoint_id).toBe('e2e-cp-001');

    resourceId = response.result.resource_id;
  });

  // ── 3. Wire format — cc-swarm buildTrajectoryCheckpoint ────────

  it('stores cc-swarm wire format checkpoint correctly', async () => {
    // Real sessionlog state → real buildTrajectoryCheckpoint → real trajectory handler
    const sessionlogState = {
      sessionID: 'e2e-session-002',
      phase: 'idle',
      turnID: 'turn-7',
      startedAt: '2026-03-25T10:00:00Z',
      stepCount: 15,
      filesTouched: ['src/server.ts', 'src/routes.ts', 'tests/server.test.ts'],
      lastCheckpointID: 'e2e-cp-002',
      turnCheckpointIDs: ['cp-a', 'cp-b', 'cp-c'],
      tokenUsage: {
        inputTokens: 45000,
        outputTokens: 12000,
        cacheCreationTokens: 2000,
        cacheReadTokens: 15000,
        apiCallCount: 30,
      },
    };

    const checkpoint = buildTrajectoryCheckpoint(sessionlogState, 'metrics', {});

    // Verify wire format shape before sending
    expect(checkpoint.agent).toBe('e2e-team-sidecar');
    expect(checkpoint.session_id).toBe('e2e-session-002');
    expect(checkpoint.files_touched).toEqual(['src/server.ts', 'src/routes.ts', 'tests/server.test.ts']);
    expect(checkpoint.token_usage.input_tokens).toBe(45000);

    const response = await rpc(ws, 'trajectory/checkpoint', {
      resource_id: resourceId, // reuse from first test
      checkpoint,
    });

    expect(response.result.ok).toBe(true);
    expect(response.result.created).toBe(false); // reused

    // Verify stored in DB
    const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(resourceId);
    const stored = checkpoints.find(c => c.checkpoint_id === 'e2e-cp-002');
    expect(stored).toBeDefined();
    expect(stored!.agent).toBe('e2e-team-sidecar');
    expect(stored!.files_touched).toEqual(['src/server.ts', 'src/routes.ts', 'tests/server.test.ts']);
    expect(stored!.checkpoints_count).toBe(3);
    expect(stored!.token_usage).toEqual({
      input_tokens: 45000,
      output_tokens: 12000,
      cache_creation_tokens: 2000,
      cache_read_tokens: 15000,
      api_call_count: 30,
    });
  });

  // ── 4. Reuse ───────────────────────────────────────────────────

  it('reuses session resource on subsequent checkpoints (same swarm)', async () => {
    const response = await rpc(ws, 'trajectory/checkpoint', {
      checkpoint: {
        id: 'e2e-cp-003',
        agent: 'e2e-team-sidecar',
        files_touched: ['README.md'],
        token_usage: { input_tokens: 3000, output_tokens: 800 },
        metadata: { phase: 'ended' },
      },
    });

    // Same swarm → same resource → created: false
    expect(response.result.ok).toBe(true);
    expect(response.result.resource_id).toBe(resourceId);
    expect(response.result.created).toBe(false);
  });

  // ── 5. Stats aggregation ───────────────────────────────────────

  it('aggregates stats across all checkpoints', () => {
    const stats = trajectoryDAL.getSessionStats(resourceId);

    expect(stats.total_checkpoints).toBe(3);
    // 20000 + 45000 + 3000 = 68000
    expect(stats.total_input_tokens).toBe(68000);
    // 6000 + 12000 + 800 = 18800
    expect(stats.total_output_tokens).toBe(18800);
    // Unique files: src/app.ts, src/config.ts, src/server.ts, src/routes.ts, tests/server.test.ts, README.md = 6
    expect(stats.total_files_touched).toBe(6);
    expect(stats.latest_agent).toBe('e2e-team-sidecar');
  });

  // ── 6. Sessions overview ───────────────────────────────────────

  it('sessions overview returns session with correct totals', () => {
    const { data: sessions } = trajectoryDAL.listAllSessions();
    const session = sessions.find(s => s.id === resourceId);

    expect(session).toBeDefined();
    expect(session!.total_checkpoints).toBe(3);
    expect(session!.total_input_tokens).toBe(68000);
    expect(session!.total_output_tokens).toBe(18800);
    expect(session!.latest_agent).toBe('e2e-team-sidecar');
  });

  // ── 7. HTTP API endpoints (what the frontend calls) ────────────

  it('GET /sessions/overview returns session via HTTP', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sessions/overview' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.total).toBeGreaterThanOrEqual(1);

    const session = body.data.find((s: any) => s.id === resourceId);
    expect(session).toBeDefined();
    expect(session.total_checkpoints).toBe(3);
    expect(session.total_input_tokens).toBe(68000);
    expect(session.total_output_tokens).toBe(18800);
    expect(session.latest_agent).toBe('e2e-team-sidecar');
  });

  it('GET /sessions/:id/trajectory-checkpoints returns checkpoints via HTTP', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/sessions/${resourceId}/trajectory-checkpoints` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.total).toBe(3);
    expect(body.data.length).toBe(3);

    // Verify wire format fields survive through the API
    const cp = body.data.find((c: any) => c.checkpoint_id === 'e2e-cp-002');
    expect(cp).toBeDefined();
    expect(cp.agent).toBe('e2e-team-sidecar');
    expect(cp.files_touched).toEqual(['src/server.ts', 'src/routes.ts', 'tests/server.test.ts']);
    expect(cp.token_usage.input_tokens).toBe(45000);
    expect(cp.token_usage.output_tokens).toBe(12000);
  });

  it('GET /sessions/:id/trajectory-stats returns stats via HTTP', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/sessions/${resourceId}/trajectory-stats` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.total_checkpoints).toBe(3);
    expect(body.total_input_tokens).toBe(68000);
    expect(body.total_output_tokens).toBe(18800);
    expect(body.total_files_touched).toBe(6);
    expect(body.latest_agent).toBe('e2e-team-sidecar');
  });

  it('GET /sessions/:id/trajectory-checkpoints returns 404 for unknown resource', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sessions/res_nonexistent/trajectory-checkpoints' });
    expect(res.statusCode).toBe(404);
  });

  // ── 8-12. Five-tier trajectory content resolution ──────────────

  // Helper: mock transcript
  const mockTranscript = [
    JSON.stringify({ type: 'user', message: { content: 'Hello, fix the bug in app.ts' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the bug.' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
  ].join('\n');

  // Helper: content handler for mock sidecar
  function attachContentHandler() {
    const handler = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'trajectory/content.request' && msg.params?.request_id) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'trajectory/content.response',
            params: {
              request_id: msg.params.request_id,
              transcript: mockTranscript,
              metadata: { source: 'test' },
              prompts: '',
              context: '',
            },
          }));
        }
      } catch { /* ignore */ }
    };
    ws.on('message', handler);
    return () => ws.removeListener('message', handler);
  }

  it('Tier 2: fetches from swarm on-demand and caches result', async () => {
    // Set canServeContent on connection
    const conn = getInbound(swarmId);
    conn!.capabilities = { trajectory: { canReport: true, canServeContent: true } };
    const cleanup = attachContentHandler();

    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/sessions/${resourceId}/events?limit=10` });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.format_id).toBe('claude_jsonl_v1');
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.map((e: any) => e.type)).toContain('user_message');

      // Verify cache was written (resource metadata should have storage.backend)
      const resource = resourcesDAL.findResourceById(resourceId);
      const meta = resource?.metadata as Record<string, unknown> | null;
      expect((meta?.storage as any)?.backend).toBe('local');
    } finally {
      cleanup();
    }
  });

  it('Tier 1: serves from fresh cache (no swarm contact)', async () => {
    // Cache was written by Tier 2 test above — resource has storage.backend = 'local'
    // Remove capability so swarm can't be contacted (proves cache is used)
    const conn = getInbound(swarmId);
    conn!.capabilities = undefined;

    const res = await app.inject({ method: 'GET', url: `/api/v1/sessions/${resourceId}/events?limit=10` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.map((e: any) => e.type)).toContain('user_message');
  });

  it('Tier 4: serves stale cache after invalidation when swarm is offline', async () => {
    // Invalidate cache by clearing storage metadata (simulates new checkpoint)
    resourcesDAL.updateResource(resourceId, {
      metadata: { format: { id: 'claude_jsonl_v1' } }, // storage cleared
    });

    // Swarm has no capability — can't fetch on-demand
    const conn = getInbound(swarmId);
    conn!.capabilities = undefined;

    // Should fall through to stale cache (file still on disk)
    const res = await app.inject({ method: 'GET', url: `/api/v1/sessions/${resourceId}/events?limit=10` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.events.length).toBeGreaterThan(0);
  });

  it('Tier 3: reads from local sessionlog transcript when available', async () => {
    // Create a new session resource with a known checkpoint ID
    const sessionId = 'local-sessionlog-test-123';
    const r = handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: `${sessionId}-step1`,
          agent: 'test-sidecar',
          metadata: { project: 'test' },
        },
      },
      { swarmId: 'swarm-local-sessionlog', agentId }, // use apiKey as agentId placeholder
    );

    // Clear any storage metadata
    resourcesDAL.updateResource(r.resource_id, { metadata: {} });

    // Create mock sessionlog state file + transcript
    const sessionlogDir = path.join(process.cwd(), '.git', 'sessionlog-sessions');
    const transcriptDir = path.join(TEST_ROOT, 'transcripts');
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    fs.mkdirSync(sessionlogDir, { recursive: true });
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(transcriptPath, mockTranscript);
    fs.writeFileSync(
      path.join(sessionlogDir, `${sessionId}.json`),
      JSON.stringify({ sessionID: sessionId, phase: 'active', transcriptPath }),
    );

    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/sessions/${r.resource_id}/events?limit=10` });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.map((e: any) => e.type)).toContain('user_message');
    } finally {
      // Clean up sessionlog state
      try { fs.unlinkSync(path.join(sessionlogDir, `${sessionId}.json`)); } catch {}
      try { fs.unlinkSync(transcriptPath); } catch {}
    }
  });

  it('Tier 5: returns empty events (200) when nothing is available', async () => {
    // Previously Tier 5 returned 503, but that blocked the UI from loading on
    // live ACP sessions where no transcript has been checkpointed yet. The
    // client falls back to ACP session/load for live replay. Empty events is
    // the correct response when no on-disk transcript exists.
    const r = handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: { id: 'tier5-orphan-001', agent: 'ghost-agent' },
      },
      { swarmId: 'swarm-tier5-offline', agentId },
    );

    // Clear metadata
    resourcesDAL.updateResource(r.resource_id, { metadata: {} });

    const res = await app.inject({ method: 'GET', url: `/api/v1/sessions/${r.resource_id}/events` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });
});
