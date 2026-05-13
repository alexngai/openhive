/**
 * Route tests for /api/v1/teams (team_template CRUD).
 *
 * Covers auth, validation, visibility-gated reads, ownership-gated deletes,
 * and the metadata.content round-trip. Layer-1 sync-hook wiring lands in a
 * later slice and gets its own coverage.
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
import { teamsRoutes } from '../../api/routes/teams.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('teams-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'teams-routes.db');

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
      await api.register(teamsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

const SAMPLE_CONTENT = {
  manifest: {
    name: 'gsd-mini',
    version: 1 as const,
    roles: ['orchestrator', 'executor'],
    topology: { root: { role: 'orchestrator' } },
  },
  roles: {
    orchestrator: { name: 'orchestrator' },
    executor: { name: 'executor' },
  },
};

describe('teams routes', () => {
  let app: FastifyInstance;
  let owner: { id: string; apiKey: string };
  let other: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());
    const a = await agentsDAL.createAgent({ name: 'team-owner', description: 'owner' });
    owner = { id: a.agent.id, apiKey: a.apiKey };
    const b = await agentsDAL.createAgent({ name: 'team-other', description: 'other' });
    other = { id: b.agent.id, apiKey: b.apiKey };
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase()
      .prepare(`DELETE FROM syncable_resources WHERE resource_type = 'team_template'`)
      .run();
    broadcastSpy.mockClear();
  });

  describe('POST /teams', () => {
    it('requires auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        payload: { name: 'x', content: SAMPLE_CONTENT },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects malformed content', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'bad', content: { manifest: { name: 'x' } } }, // missing version + roles
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates and broadcasts on success', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'gsd-mini', content: SAMPLE_CONTENT, visibility: 'shared' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.team_template.resource_type).toBe('team_template');
      expect(body.team_template.visibility).toBe('shared');
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^resource:team_template:res_/),
        expect.objectContaining({ type: 'team_template:created' }),
      );
    });

    it('returns 409 on duplicate (owner, name)', async () => {
      const payload = { name: 'dup', content: SAMPLE_CONTENT };
      const a = await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload,
      });
      expect(a.statusCode).toBe(201);
      const b = await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload,
      });
      expect(b.statusCode).toBe(409);
    });
  });

  describe('GET /teams/:id', () => {
    it('returns 404 for private templates the caller does not own', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'private-one', content: SAMPLE_CONTENT, visibility: 'private' },
      });
      const id = JSON.parse(create.body).team_template.id;
      const res = await app.inject({
        method: 'GET', url: `/api/v1/teams/${id}`,
        headers: { Authorization: `Bearer ${other.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 200 to the owner', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'mine', content: SAMPLE_CONTENT },
      });
      const id = JSON.parse(create.body).team_template.id;
      const res = await app.inject({
        method: 'GET', url: `/api/v1/teams/${id}`,
        headers: { Authorization: `Bearer ${owner.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.team_template.metadata.content.manifest.name).toBe('gsd-mini');
    });

    it('returns 200 to anyone for public templates', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'pub', content: SAMPLE_CONTENT, visibility: 'public' },
      });
      const id = JSON.parse(create.body).team_template.id;
      // No auth header at all.
      const res = await app.inject({ method: 'GET', url: `/api/v1/teams/${id}` });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /teams (list)', () => {
    it('lists owned templates only when owned=true', async () => {
      await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'a', content: SAMPLE_CONTENT },
      });
      await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${other.apiKey}` },
        payload: { name: 'b', content: SAMPLE_CONTENT, visibility: 'public' },
      });
      const res = await app.inject({
        method: 'GET', url: '/api/v1/teams?owned=true',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.total).toBe(1);
      expect(body.data[0].name).toBe('a');
    });
  });

  describe('PATCH /teams/:id', () => {
    it('updates the content and broadcasts', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'u', content: SAMPLE_CONTENT },
      });
      const id = JSON.parse(create.body).team_template.id;
      broadcastSpy.mockClear();

      const updated = await app.inject({
        method: 'PATCH', url: `/api/v1/teams/${id}`,
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { description: 'new desc' },
      });
      expect(updated.statusCode).toBe(200);
      const body = JSON.parse(updated.body);
      expect(body.team_template.description).toBe('new desc');
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'team_template:updated' }),
      );
    });

    it('forbids non-owner edits', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'noedit', content: SAMPLE_CONTENT },
      });
      const id = JSON.parse(create.body).team_template.id;
      const res = await app.inject({
        method: 'PATCH', url: `/api/v1/teams/${id}`,
        headers: { Authorization: `Bearer ${other.apiKey}` },
        payload: { description: 'pwned' },
      });
      // Private + non-owner returns 404 (existence hidden) which is fine;
      // shared/public would return 403. canAccessResource gates both paths.
      expect([403, 404]).toContain(res.statusCode);
    });
  });

  describe('DELETE /teams/:id', () => {
    it('deletes when called by owner', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'del', content: SAMPLE_CONTENT },
      });
      const id = JSON.parse(create.body).team_template.id;
      const res = await app.inject({
        method: 'DELETE', url: `/api/v1/teams/${id}`,
        headers: { Authorization: `Bearer ${owner.apiKey}` },
      });
      expect(res.statusCode).toBe(204);
      // Verify gone.
      const followup = await app.inject({
        method: 'GET', url: `/api/v1/teams/${id}`,
        headers: { Authorization: `Bearer ${owner.apiKey}` },
      });
      expect(followup.statusCode).toBe(404);
    });

    it('refuses non-owner delete', async () => {
      const create = await app.inject({
        method: 'POST', url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${owner.apiKey}` },
        payload: { name: 'nodel', content: SAMPLE_CONTENT, visibility: 'public' },
      });
      const id = JSON.parse(create.body).team_template.id;
      const res = await app.inject({
        method: 'DELETE', url: `/api/v1/teams/${id}`,
        headers: { Authorization: `Bearer ${other.apiKey}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
