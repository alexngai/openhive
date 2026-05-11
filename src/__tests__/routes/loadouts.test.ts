/**
 * Route tests for /api/v1/loadouts.
 *
 * Parallel to teams.test.ts. Covers auth, validation, visibility-gated
 * reads, ownership-gated deletes, and metadata.content round-trip for the
 * standalone loadout resource type.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

const broadcastSpy = vi.fn();
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, event: unknown) => broadcastSpy(channel, event),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { loadoutsRoutes } from '../../api/routes/loadouts.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('loadouts-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'loadouts-routes.db');

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function makeApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(loadoutsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

const SAMPLE_CONTENT = {
  name: 'security-auditor',
  extends: 'code-reviewer',
  capabilities: ['file.read', 'exec.test'],
  permissions: { deny: ['Bash(git push:*)'] },
};

describe('loadouts routes', () => {
  let app: FastifyInstance;
  let owner: { id: string; apiKey: string };
  let other: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());
    const a = await agentsDAL.createAgent({ name: 'loadout-owner', description: 'owner' });
    owner = { id: a.agent.id, apiKey: a.apiKey };
    const b = await agentsDAL.createAgent({ name: 'loadout-other', description: 'other' });
    other = { id: b.agent.id, apiKey: b.apiKey };
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase()
      .prepare(`DELETE FROM syncable_resources WHERE resource_type = 'loadout'`)
      .run();
    broadcastSpy.mockClear();
  });

  describe('POST /loadouts', () => {
    it('requires auth', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/loadouts',
        payload: { name: 'x', content: SAMPLE_CONTENT },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects bad names', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: '!!!invalid', content: SAMPLE_CONTENT },
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates and broadcasts', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'security-auditor', content: SAMPLE_CONTENT },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.loadout.resource_type).toBe('loadout');
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^resource:loadout:res_/),
        expect.objectContaining({ type: 'loadout:created' }),
      );
    });
  });

  describe('GET /loadouts/:id', () => {
    it('hides private rows from non-owners', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'private-lo', content: SAMPLE_CONTENT, visibility: 'private' },
      });
      const id = JSON.parse(create.body).loadout.id;
      const res = await app.inject({
        method: 'GET', url: `/api/v1/loadouts/${id}`,
        headers: { Authorization: `Bearer ${other.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('serves public rows without auth', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'pub-lo', content: SAMPLE_CONTENT, visibility: 'public' },
      });
      const id = JSON.parse(create.body).loadout.id;
      const res = await app.inject({ method: 'GET', url: `/api/v1/loadouts/${id}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.loadout.metadata.content.name).toBe('security-auditor');
    });
  });

  describe('PATCH /loadouts/:id', () => {
    it('updates content', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'u-lo', content: SAMPLE_CONTENT },
      });
      const id = JSON.parse(create.body).loadout.id;

      const updated = await app.inject({
        method: 'PATCH', url: `/api/v1/loadouts/${id}`,
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: {
          content: { ...SAMPLE_CONTENT, prompt_addendum: 'sharpened focus' },
        },
      });
      expect(updated.statusCode).toBe(200);
      const body = JSON.parse(updated.body);
      expect(body.loadout.metadata.content.prompt_addendum).toBe('sharpened focus');
    });
  });

  describe('DELETE /loadouts/:id', () => {
    it('owner can delete', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'del-lo', content: SAMPLE_CONTENT },
      });
      const id = JSON.parse(create.body).loadout.id;
      const res = await app.inject({
        method: 'DELETE', url: `/api/v1/loadouts/${id}`,
        headers: { Authorization: `Bearer ${owner.apiKey}` },
      });
      expect(res.statusCode).toBe(204);
    });

    it('non-owner cannot delete a public loadout', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'nodel-lo', content: SAMPLE_CONTENT, visibility: 'public' },
      });
      const id = JSON.parse(create.body).loadout.id;
      const res = await app.inject({
        method: 'DELETE', url: `/api/v1/loadouts/${id}`,
        headers: { Authorization: `Bearer ${other.apiKey}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
