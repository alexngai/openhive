/**
 * Tests for GET /admin/git-sync-status.
 *
 * The route returns filesystem paths for git-backed resources, so it must use
 * the same strict admin gate as the rest of the /admin surface.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { adminRoutes } from '../../api/routes/admin.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('admin-git-sync-status');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'admin-git-sync-status.db');
const ADMIN_KEY = 'test-admin-key-git-sync-status';

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Git Sync Status Test', description: 'Test instance' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(adminRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('GET /admin/git-sync-status', () => {
  let app: FastifyInstance;
  let normalAgent: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await createTestApp(createTestConfig());

    const created = await agentsDAL.createAgent({
      name: 'git-sync-status-non-admin',
      description: 'Non-admin agent',
    });
    normalAgent = { id: created.agent.id, apiKey: created.apiKey };

    resourcesDAL.createResource({
      resource_type: 'task',
      name: 'private-git-backed-task',
      git_remote_url: 'https://example.com/private.git',
      visibility: 'private',
      owner_agent_id: normalAgent.id,
      sync_strategy: 'local',
      local_path: '/tmp/private-git-backed-task',
      metadata: { sync: { git: { autoPull: true } } },
    });
  });

  afterAll(async () => {
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('rejects a non-admin authenticated agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/git-sync-status',
      headers: { Authorization: `Bearer ${normalAgent.apiKey}` },
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns git-backed resource status with the admin key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/git-sync-status',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]).toMatchObject({
      name: 'private-git-backed-task',
      local_path: '/tmp/private-git-backed-task',
      autoPull: true,
    });
  });
});
