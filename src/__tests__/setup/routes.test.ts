/**
 * Setup + doctor admin API (GET /admin/setup, POST /admin/setup/:id,
 * GET /admin/doctor). Follows the admin-config.test.ts pattern: a bare
 * Fastify app with the route module and an X-Admin-Key.
 *
 * The routes resolve their data dir via resolveDataDir(), so the test
 * pins OPENHIVE_HOME to a temp dir for its duration.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import Fastify, { FastifyInstance } from 'fastify';
import { closeDatabase } from '../../db/index.js';
import { setupRoutes } from '../../api/routes/setup.js';
import { ConfigSchema, type Config } from '../../config.js';
import { dataDirPaths } from '../../data-dir.js';
import { readConfigFile } from '../../config-persistence.js';
import { testRoot, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('setup-routes');
const ADMIN_KEY = 'test-admin-key-for-setup';
const TEST_PORT = 7913;

function createTestConfig(): Config {
  return ConfigSchema.parse({
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    mapHub: { iamSecret: 'test-iam-secret-setup', trustModel: 'open' },
  });
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    async (api) => {
      await api.register(setupRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('Setup API', () => {
  let app: FastifyInstance;
  let prevHome: string | undefined;

  beforeAll(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    prevHome = process.env.OPENHIVE_HOME;
    process.env.OPENHIVE_HOME = TEST_ROOT;
    app = await createTestApp(createTestConfig());
  });

  afterAll(async () => {
    await app.close();
    if (prevHome === undefined) delete process.env.OPENHIVE_HOME;
    else process.env.OPENHIVE_HOME = prevHome;
    try {
      closeDatabase();
    } catch {
      /* not open */
    }
    cleanTestRoot(TEST_ROOT);
  });

  it('rejects without admin key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/setup' });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
  });

  it('GET /admin/setup lists sections with status and fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/setup',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sections: Array<{ id: string; status: { state: string }; fields: unknown[] }>;
    };
    const ids = body.sections.map((s) => s.id);
    expect(ids).toContain('core');
    expect(ids).toContain('git-store');
    expect(ids).toContain('swarm-hosting');
    // Fresh temp home → core incomplete
    expect(body.sections.find((s) => s.id === 'core')?.status.state).toBe('incomplete');
  });

  it('POST /admin/setup/core applies and persists config', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/setup/core',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { answers: { name: 'RouteTest', port: TEST_PORT } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; status?: { state: string } };
    expect(body.ok).toBe(true);
    expect(body.status?.state).toBe('complete');

    const written = readConfigFile(dataDirPaths(TEST_ROOT).config);
    expect(written.port).toBe(TEST_PORT);
    expect((written.instance as Record<string, unknown>).name).toBe('RouteTest');
  });

  it('POST /admin/setup/:id 404s on unknown section', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/setup/nope',
      headers: { 'x-admin-key': ADMIN_KEY },
      payload: { answers: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /admin/doctor returns the check list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/doctor',
      headers: { 'x-admin-key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      results: Array<{ section: string; name: string; status: string }>;
    };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.some((r) => r.section === 'prereqs')).toBe(true);
    // Shape matches the SwarmKitDoctor/DoctorPanel contract
    for (const r of body.results) {
      expect(['pass', 'warn', 'fail']).toContain(r.status);
    }
  });
});
