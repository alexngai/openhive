/**
 * Tests for `POST /map/hosted/:id/hook/:event`.
 *
 * Lifecycle callback fired by spawned TUI agents (Claude Code's Stop,
 * UserPromptSubmit, Notification hooks via the `--settings` payload
 * openhive injects at spawn). Auth verifies a Bearer token against the
 * row's `bootstrap_token_hash` — the same onboard credential cc-swarm
 * dials back with. The route fans out:
 *   - Stop / Notification  → `hosted_tui.turn_ended`
 *   - UserPromptSubmit     → `hosted_tui.turn_started`
 * on the `global` WS channel, keyed by hosted_swarm_id so the threads
 * panel lights up the attention dot for the right row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as path from 'path';
import { createHash } from 'node:crypto';

const broadcastSpy = vi.fn();
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, event: unknown) => broadcastSpy(channel, event),
}));

import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hostedDal from '../../swarm/dal.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('swarm-hosting-hook');
const TEST_DB = testDbPath(TEST_ROOT, 'swarm-hosting-hook.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB,
    port: 17888,
    instance: { name: 'Hook Test', description: 'route test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      data_dir: TEST_DATA_DIR,
      port_range: [19600, 19610],
      max_swarms: 5,
      health_check_interval: 100000,
      max_health_failures: 3,
    },
  });
}

async function makeApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  // The hook route does NOT require auth-middleware (it auths via the
  // Bearer token against bootstrap_token_hash, not the user session).
  // Make sure no global auth hook breaks the test app.
  await app.register(
    async (api) => {
      await api.register(swarmHostingRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

function makeHostedWithToken(spawnedBy: string, token: string) {
  const hash = createHash('sha256').update(token).digest('hex');
  return hostedDal.createHostedSwarm({
    provider: 'local',
    spawned_by: spawnedBy,
    kind: 'claude-code',
    bootstrap_token_hash: hash,
  });
}

describe('POST /map/hosted/:id/hook/:event', () => {
  let app: FastifyInstance;
  let agentId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB);
    const created = await agentsDAL.createAgent({
      name: 'hook-route-agent',
      description: 'route test',
    });
    agentId = created.agent.id;
    app = await makeApp(makeConfig());
  });

  afterAll(async () => {
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    broadcastSpy.mockClear();
  });

  it('returns 404 when the hosted swarm does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/map/hosted/missing/hook/stop',
      headers: { authorization: 'Bearer anything' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('NOT_FOUND');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const hosted = makeHostedWithToken(agentId, 'tok-missing-auth');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hosted.id}/hook/stop`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('UNAUTHORIZED');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token does not match the bootstrap hash', async () => {
    const hosted = makeHostedWithToken(agentId, 'tok-correct');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hosted.id}/hook/stop`,
      headers: { authorization: 'Bearer tok-wrong' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('UNAUTHORIZED');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when the row has no bootstrap_token_hash on file', async () => {
    // Rows created without an onboard token shouldn't accept any bearer.
    // Defends the property that a missing hash isn't a wildcard.
    const hosted = hostedDal.createHostedSwarm({
      provider: 'local',
      spawned_by: agentId,
      kind: 'claude-code',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hosted.id}/hook/stop`,
      headers: { authorization: 'Bearer tok-any' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('Stop hook broadcasts hosted_tui.turn_ended with the hosted_swarm_id payload', async () => {
    const token = 'tok-stop';
    const hosted = makeHostedWithToken(agentId, token);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hosted.id}/hook/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        session_id: 'sess-123',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/work',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [channel, event] = broadcastSpy.mock.calls[0];
    expect(channel).toBe('global');
    expect(event).toEqual({
      type: 'hosted_tui.turn_ended',
      data: {
        hosted_swarm_id: hosted.id,
        swarm_id: hosted.swarm_id,
        event: 'stop',
        session_id: 'sess-123',
        transcript_path: '/tmp/transcript.jsonl',
        cwd: '/tmp/work',
      },
    });
  });

  it('Notification hook also broadcasts hosted_tui.turn_ended (same dot, different trigger)', async () => {
    const token = 'tok-notif';
    const hosted = makeHostedWithToken(agentId, token);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hosted.id}/hook/notification`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy.mock.calls[0][1].type).toBe('hosted_tui.turn_ended');
    expect(broadcastSpy.mock.calls[0][1].data.event).toBe('notification');
  });

  it('UserPromptSubmit hook broadcasts hosted_tui.turn_started (clears the dot)', async () => {
    const token = 'tok-prompt';
    const hosted = makeHostedWithToken(agentId, token);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hosted.id}/hook/prompt-submit`,
      headers: { authorization: `Bearer ${token}` },
      payload: { session_id: 'sess-prompt' },
    });
    expect(res.statusCode).toBe(204);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const event = broadcastSpy.mock.calls[0][1];
    expect(event.type).toBe('hosted_tui.turn_started');
    expect(event.data).toEqual({
      hosted_swarm_id: hosted.id,
      swarm_id: hosted.swarm_id,
      event: 'prompt-submit',
    });
  });

  it('unknown events authenticate + 204 but do not broadcast (forward-compat)', async () => {
    // Lets us add new claude hook events on the agent side without
    // having to 4xx during rollout.
    const token = 'tok-unknown';
    const hosted = makeHostedWithToken(agentId, token);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hosted.id}/hook/something-future`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('ignores non-string payload fields rather than reflecting them blindly', async () => {
    // Regression guard against a malicious agent stuffing nested objects
    // into `session_id` etc. The route extracts only the typed
    // primitives it cares about.
    const token = 'tok-typed';
    const hosted = makeHostedWithToken(agentId, token);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/hosted/${hosted.id}/hook/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        session_id: { evil: 'object' },
        transcript_path: 42,
        cwd: ['array'],
      },
    });
    expect(res.statusCode).toBe(204);
    const event = broadcastSpy.mock.calls[0][1];
    expect(event.data.session_id).toBeUndefined();
    expect(event.data.transcript_path).toBeUndefined();
    expect(event.data.cwd).toBeUndefined();
  });
});
