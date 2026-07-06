/**
 * POST /idea-lab/load — the runtime mechanism that loads the checked-in preset
 * into dispatch schedules (replacing the old global-config boot path). Also
 * covers GET /idea-lab (status) and POST /idea-lab/unload (pause).
 *
 * Daemon-free: the load body overrides the pack with empty objectives, so no
 * OpenTasks daemon is touched — only schedule creation + reconcile is exercised.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'fs';
import { ConfigSchema, type Config } from '../../config.js';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { ideaLabRoutes } from '../../api/routes/idea-lab.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('idea-lab-load-route');
const TEST_DB = testDbPath(TEST_ROOT, 'load-route.db');
const ADMIN_KEY = 'test-admin-key';
const HDR = { 'x-admin-key': ADMIN_KEY };

// Daemon-free pack: no objectives → no OpenTasks daemon interaction.
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
  process.env.OPENHIVE_HOME = TEST_ROOT; // resolveDataDir() reads this
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  initDatabase(TEST_DB);
  await agentsDAL.createAgent({ name: 'load-route-owner', is_admin: true });

  const config: Config = ConfigSchema.parse({
    database: TEST_DB,
    admin: { key: ADMIN_KEY, createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    mapHub: { enabled: true, trustModel: 'open' },
  });

  app = Fastify({ logger: false });
  app.decorateRequest('agent', undefined);
  await app.register(ideaLabRoutes, { config });
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
  const db = getDatabase();
  db.exec('DELETE FROM schedules');
});

describe('POST /idea-lab/load', () => {
  it('loads the preset into dispatch schedules and is idempotent', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/idea-lab/load',
      headers: HDR,
      payload: { targetSwarmIds: ['swarm_a'], pack: PACK },
    });
    expect(first.statusCode).toBe(200);
    const s1 = first.json();
    expect(s1.ok).toBe(true);
    expect(s1.schedules.created).toBe(2);
    expect(s1.schedules.paused).toBe(0);

    // Idempotent — re-load creates nothing new.
    const second = await app.inject({
      method: 'POST',
      url: '/idea-lab/load',
      headers: HDR,
      payload: { targetSwarmIds: ['swarm_a'], pack: PACK },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().schedules.created).toBe(0);
    expect(second.json().schedules.unchanged).toBe(2);
  });

  it('GET /idea-lab reports the loaded roles; unload pauses them', async () => {
    await app.inject({
      method: 'POST',
      url: '/idea-lab/load',
      headers: HDR,
      payload: { targetSwarmIds: ['swarm_a'], pack: PACK },
    });

    const status = await app.inject({ method: 'GET', url: '/idea-lab', headers: HDR });
    expect(status.statusCode).toBe(200);
    const st = status.json();
    expect(st.loaded).toBe(true);
    expect(st.paused).toBe(false);
    expect(st.roles).toHaveLength(2);
    expect(st.roles.map((r: { idealab_key: string }) => r.idealab_key).sort()).toEqual([
      'role:ideator',
      'role:judge',
    ]);

    const unload = await app.inject({ method: 'POST', url: '/idea-lab/unload', headers: HDR });
    expect(unload.statusCode).toBe(200);
    expect(unload.json().paused).toBe(2);

    const after = await app.inject({ method: 'GET', url: '/idea-lab', headers: HDR });
    expect(after.json().paused).toBe(true);
  });

  it('rejects an invalid pack with 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/idea-lab/load',
      headers: HDR,
      payload: { pack: { version: 1, graph: { name: 'g' }, ledger: { name: 'l' }, roles: [] } },
    });
    expect(res.statusCode).toBe(422);
  });

  it('requires the admin key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/idea-lab/load',
      payload: { targetSwarmIds: [], pack: PACK },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
  });
});
