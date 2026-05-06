/**
 * Tests for `GET /map/hosted/:id/terminal-info`.
 *
 * Covers the contract that drives the embedded terminal flow:
 *   - 404 when the hosted swarm doesn't exist
 *   - 409 NOT_RUNNING when state isn't 'running'
 *   - tui mode (default) returns the openhive hub URL (`ws://127.0.0.1:<port>/ws/map`),
 *     not the hosted swarm's assigned port (which has no MAP server bound)
 *   - shell mode returns $SHELL with an *absolute* cwd and sandbox=true
 *   - shell mode 409 NO_CWD when the hosted record has no data_dir
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as path from 'path';

const RESOLVED_TUI = '/safe/path/@openswarm/cli-darwin-arm64/openswarm';

vi.mock('../../terminal/resolve-tui.js', () => ({
  resolveOpenSwarmTuiBinary: vi.fn(() => RESOLVED_TUI),
}));

import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hostedDal from '../../swarm/dal.js';
import { swarmHostingRoutes } from '../../api/routes/swarm-hosting.js';
import { ConfigSchema, type Config } from '../../config.js';
import { resolveOpenSwarmTuiBinary } from '../../terminal/resolve-tui.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('terminal-info');
const TEST_DB = testDbPath(TEST_ROOT, 'terminal-info.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');
const HUB_PORT = 17777;

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB,
    port: HUB_PORT,
    instance: { name: 'TerminalInfo Test', description: 'route test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    swarmHosting: {
      enabled: true,
      default_provider: 'local',
      data_dir: TEST_DATA_DIR,
      port_range: [19500, 19510],
      max_swarms: 5,
      health_check_interval: 100000,
      max_health_failures: 3,
    },
  });
}

async function makeApp(
  config: Config,
  agent: { id: string; apiKey: string },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  app.addHook('preHandler', async (request: any, reply: any) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'NO_AUTH' });
    const token = auth.slice('Bearer '.length);
    if (token !== agent.apiKey) return reply.code(401).send({ error: 'BAD_AUTH' });
    request.agent = { id: agent.id };
  });
  await app.register(
    async (api) => {
      await api.register(swarmHostingRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

/**
 * Build a hosted-swarm row with a sane provision config. `dataDir` is the
 * piece the route reads — pass undefined to simulate a record with no
 * resolved data_dir (shell mode 409 case).
 */
function makeRunningSwarm(opts: {
  spawnedBy: string;
  dataDir?: string;
}) {
  const config = opts.dataDir
    ? {
        name: 't',
        adapter: 'macro-agent',
        bootstrap_token: 'unused',
        assigned_port: 19501,
        data_dir: opts.dataDir,
      }
    : undefined;
  const created = hostedDal.createHostedSwarm({
    provider: 'local',
    spawned_by: opts.spawnedBy,
    assigned_port: 19501,
    config,
  });
  return hostedDal.updateHostedSwarm(created.id, { state: 'running' })!;
}

describe('GET /map/hosted/:id/terminal-info', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB);
    const created = await agentsDAL.createAgent({
      name: 'terminal-info-agent',
      description: 'route test',
    });
    agent = { id: created.agent.id, apiKey: created.apiKey };
    app = await makeApp(makeConfig(), agent);
  });

  afterAll(async () => {
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    vi.mocked(resolveOpenSwarmTuiBinary).mockReturnValue(RESOLVED_TUI);
  });

  it('returns 404 when the hosted swarm does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/hosted/missing/terminal-info',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('NOT_FOUND');
  });

  it('returns 409 NOT_RUNNING when state is not running', async () => {
    const created = hostedDal.createHostedSwarm({
      provider: 'local',
      spawned_by: agent.id,
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/hosted/${created.id}/terminal-info`,
      headers: { Authorization: `Bearer ${agent.apiKey}` },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('NOT_RUNNING');
  });

  describe('tui mode (default)', () => {
    it('returns hub MAP URL — never the hosted swarm assigned port', async () => {
      const swarm = makeRunningSwarm({ spawnedBy: agent.id });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${swarm.id}/terminal-info`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.mode).toBe('tui');
      expect(body.available).toBe(true);
      expect(body.command).toBe(RESOLVED_TUI);
      expect(body.endpoint).toBe(`ws://127.0.0.1:${HUB_PORT}/ws/map`);
      // The swarm's assigned port (19501) MUST NOT leak into the args — the
      // openswarm `serve` gateway has no MAP server there. Regression guard
      // for the original bug where TUI was sent to a dead port.
      expect(body.args).toEqual(['--url', `ws://127.0.0.1:${HUB_PORT}/ws/map`, '--auto-connect']);
      expect(body.args.join(' ')).not.toContain('19501');
      expect(body.sandbox).toBe(false);
    });

    it('marks available:false when the TUI binary cannot be resolved', async () => {
      vi.mocked(resolveOpenSwarmTuiBinary).mockReturnValueOnce(null);
      const swarm = makeRunningSwarm({ spawnedBy: agent.id });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${swarm.id}/terminal-info`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(false);
      expect(body.command).toBeNull();
      expect(body.args).toEqual([]);
    });
  });

  describe('tui mode for kind=claude-code', () => {
    it('returns binding=attach when SwarmManager has a live PTY session', async () => {
      // Need to update the row to kind=claude-code before exercising the
      // route — DAL helper accepts kind on create.
      const swarm = makeRunningSwarm({ spawnedBy: agent.id });
      // Override kind on the row directly (DAL doesn't expose update for kind).
      const { getDatabase } = await import('../../db/index.js');
      getDatabase().prepare('UPDATE hosted_swarms SET kind = ? WHERE id = ?').run('claude-code', swarm.id);

      // Stub a swarmManager on the fastify instance with a fake PTY session.
      const fakeSessionId = 'pty_test_session_id';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).swarmManager = {
        getClaudeCodePtySessionId: (id: string) => (id === swarm.id ? fakeSessionId : null),
      };

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${swarm.id}/terminal-info`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.mode).toBe('tui');
      expect(body.binding).toBe('attach');
      expect(body.available).toBe(true);
      expect(body.sessionId).toBe(fakeSessionId);
      expect(body.command).toBeNull();
      expect(body.args).toEqual([]);
    });

    it('returns available=false when there is no live PTY session', async () => {
      const swarm = makeRunningSwarm({ spawnedBy: agent.id });
      const { getDatabase } = await import('../../db/index.js');
      getDatabase().prepare('UPDATE hosted_swarms SET kind = ? WHERE id = ?').run('claude-code', swarm.id);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).swarmManager = {
        getClaudeCodePtySessionId: () => null,
      };

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${swarm.id}/terminal-info`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.binding).toBe('attach');
      expect(body.available).toBe(false);
      expect(body.sessionId).toBeNull();
    });
  });

  describe('shell mode', () => {
    it('returns $SHELL, absolute cwd, and sandbox=true', async () => {
      const dataDir = path.join(TEST_DATA_DIR, 'swarm-shell-test');
      const swarm = makeRunningSwarm({ spawnedBy: agent.id, dataDir });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${swarm.id}/terminal-info?mode=shell`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.mode).toBe('shell');
      expect(body.available).toBe(true);
      // command is whatever the test runner's $SHELL is — assert non-empty
      // and absolute. Falls back to /bin/bash when SHELL is unset.
      expect(body.command).toBeTruthy();
      expect(path.isAbsolute(body.command)).toBe(true);
      expect(body.cwd).toBe(path.resolve(dataDir));
      expect(path.isAbsolute(body.cwd)).toBe(true);
      expect(body.sandbox).toBe(true);
      expect(body.args).toEqual([]);
    });

    it('absolute-izes a relative data_dir before returning', async () => {
      // The DAL stores whatever manager.ts wrote (path.join, no resolve), so
      // a relative path like "data/swarms/x" can land in the row. The route
      // must surface an absolute cwd so the sandbox allow_write list and the
      // PTY cwd both line up.
      const swarm = makeRunningSwarm({
        spawnedBy: agent.id,
        dataDir: 'data/swarms/relative-x',
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${swarm.id}/terminal-info?mode=shell`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(path.isAbsolute(body.cwd)).toBe(true);
      expect(body.cwd.endsWith('data/swarms/relative-x')).toBe(true);
    });

    it('returns 409 NO_CWD when the hosted record has no resolved data_dir', async () => {
      const swarm = makeRunningSwarm({ spawnedBy: agent.id /* no dataDir */ });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/map/hosted/${swarm.id}/terminal-info?mode=shell`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('NO_CWD');
    });
  });
});
