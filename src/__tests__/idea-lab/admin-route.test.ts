/**
 * Admin idea-lab routes — the settings-driven full setup over provisionIdeaLab.
 * Daemon-free: the setup body overrides the pack with empty objectives, so no
 * OpenTasks daemon is touched — only schedule creation + reconcile is exercised.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'fs';
import { ConfigSchema, type Config } from '../../config.js';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { ideaLabAdminRoutes } from '../../api/routes/idea-lab-admin.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('idea-lab-admin-route');
const TEST_DB = testDbPath(TEST_ROOT, 'admin-route.db');
const ADMIN_KEY = 'test-admin-key';
const HDR = { 'x-admin-key': ADMIN_KEY };

const PACK = {
  version: 1,
  graph: { name: 'idea-lab/graph' },
  ledger: { name: 'idea-lab/ledger' },
  objectives: [],
  roles: [
    { key: 'ideator', cron: '0 * * * *', prompt: 'ideator prompt' },
    { key: 'judge', cron: '0 */6 * * *', prompt: 'judge prompt' },
  ],
};

let app: FastifyInstance;

beforeAll(async () => {
  cleanTestRoot(TEST_ROOT);
  process.env.OPENHIVE_HOME = TEST_ROOT;
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  initDatabase(TEST_DB);
  await agentsDAL.createAgent({ name: 'admin-route-owner', is_admin: true });

  const config: Config = ConfigSchema.parse({
    database: TEST_DB,
    admin: { key: ADMIN_KEY, createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    mapHub: { enabled: true, trustModel: 'open' },
  });

  app = Fastify({ logger: false });
  app.decorateRequest('agent', undefined);
  await app.register(ideaLabAdminRoutes, { config });
  await app.ready();
}, 30_000);

afterAll(async () => {
  try {
    await app?.close();
  } catch {
    /* best effort */
  }
  try {
    closeDatabase();
  } catch {
    /* best effort */
  }
  cleanTestRoot(TEST_ROOT);
  delete process.env.OPENHIVE_HOME;
});

beforeEach(() => {
  getDatabase().exec('DELETE FROM schedules');
});

describe('admin idea-lab routes', () => {
  it('POST /admin/idea-lab/setup provisions the role schedules idempotently', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/admin/idea-lab/setup',
      headers: HDR,
      payload: { targetSwarmIds: ['swarm_a'], pack: PACK },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().ok).toBe(true);
    expect(first.json().schedules.created).toBe(2);
    expect(first.json().schedules.paused).toBe(0);

    const second = await app.inject({
      method: 'POST',
      url: '/admin/idea-lab/setup',
      headers: HDR,
      payload: { targetSwarmIds: ['swarm_a'], pack: PACK },
    });
    expect(second.json().schedules.created).toBe(0);
    expect(second.json().schedules.unchanged).toBe(2);
  });

  it('GET reports status; teardown pauses the schedules', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/idea-lab/setup',
      headers: HDR,
      payload: { targetSwarmIds: ['swarm_a'], pack: PACK },
    });

    const status = await app.inject({ method: 'GET', url: '/admin/idea-lab', headers: HDR });
    expect(status.statusCode).toBe(200);
    expect(status.json().loaded).toBe(true);
    expect(status.json().paused).toBe(false);
    expect(status.json().roles).toHaveLength(2);

    const teardown = await app.inject({ method: 'POST', url: '/admin/idea-lab/teardown', headers: HDR });
    expect(teardown.statusCode).toBe(200);
    expect(teardown.json().paused).toBe(2);

    const after = await app.inject({ method: 'GET', url: '/admin/idea-lab', headers: HDR });
    expect(after.json().paused).toBe(true);
  });

  it('rejects an invalid pack with 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/idea-lab/setup',
      headers: HDR,
      payload: { pack: { version: 1, graph: { name: 'g' }, ledger: { name: 'l' }, roles: [] } },
    });
    expect(res.statusCode).toBe(422);
  });

  it('requires the admin key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/idea-lab/setup',
      payload: { targetSwarmIds: [], pack: PACK },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
  });
});
