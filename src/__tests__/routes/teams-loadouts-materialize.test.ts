/**
 * Route-level tests for the materialize endpoints:
 *   POST /teams/:id/roles/:role/loadout/materialize
 *   POST /loadouts/:id/materialize
 *
 * Both are UI preview surfaces — they go through the same resolver path
 * dispatch uses, but expose it over HTTP for the OpenHive frontend.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import { teamsRoutes } from '../../api/routes/teams.js';
import { loadoutsRoutes } from '../../api/routes/loadouts.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const TEST_ROOT = testRoot('teams-loadouts-materialize-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'teams-loadouts-materialize.db');

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
      await api.register(loadoutsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

function reviewerLoadoutContent(): LoadoutContent {
  return {
    name: 'reviewer',
    capabilities: ['file.read'],
    permissions: { allow: ['Read(**)'] },
    prompt_addendum: '## Reviewer\n\nFocus on correctness.',
    mcp_servers: [{ name: 'ast-grep', command: 'npx', args: ['ast-grep-mcp'] }],
  };
}

function teamWithReviewer(): TeamTemplateContent {
  return {
    manifest: {
      name: 'demo',
      version: 1,
      roles: ['reviewer'],
      topology: { root: { role: 'reviewer' } },
    },
    roles: { reviewer: { loadout: reviewerLoadoutContent() } },
    loadouts: {},
    prompts: {},
  };
}

describe('Materialize routes', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());
    const { agent: a, apiKey } = await agentsDAL.createAgent({
      name: 'materialize-route-agent',
    });
    agent = { id: a.id, apiKey };
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    _resetCacheForTest();
    getDatabase().prepare('DELETE FROM syncable_resources').run();
  });

  // --------------------------------------------------------------------
  // POST /teams/:id/roles/:role/loadout/materialize
  // --------------------------------------------------------------------

  describe('POST /teams/:id/roles/:role/loadout/materialize', () => {
    it('returns 200 with materialized body for an authorized owner', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'demo',
        content: teamWithReviewer(),
        ownerAgentId: agent.id,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${tmpl.id}/roles/reviewer/loadout/materialize`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { materialized: { capabilities: string[]; promptAddendum: string } };
      expect(body.materialized.capabilities).toEqual(expect.arrayContaining(['file.read']));
      expect(body.materialized.promptAddendum).toContain('Focus on correctness');
    });

    it('returns 404 for unknown team template id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/teams/res_nonexistent/roles/reviewer/loadout/materialize',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for unknown role', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'demo',
        content: teamWithReviewer(),
        ownerAgentId: agent.id,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${tmpl.id}/roles/ghost/loadout/materialize`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for private team template viewed without auth', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'private-demo',
        content: teamWithReviewer(),
        ownerAgentId: agent.id,
        // visibility defaults to 'private'
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/teams/${tmpl.id}/roles/reviewer/loadout/materialize`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // --------------------------------------------------------------------
  // POST /loadouts/:id/materialize
  // --------------------------------------------------------------------

  describe('POST /loadouts/:id/materialize', () => {
    it('returns 200 with materialized body for an authorized owner', async () => {
      const ldt = loadoutsDAL.createLoadout({
        name: 'reviewer',
        content: reviewerLoadoutContent(),
        ownerAgentId: agent.id,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loadouts/${ldt.id}/materialize`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        materialized: {
          capabilities: string[];
          promptAddendum: string;
          mcpProviders: Array<{ name: string }>;
        };
      };
      expect(body.materialized.capabilities).toEqual(expect.arrayContaining(['file.read']));
      expect(body.materialized.promptAddendum).toContain('Focus on correctness');
      expect(body.materialized.mcpProviders.find((p) => p.name === 'ast-grep')).toBeTruthy();
    });

    it('returns 404 for unknown loadout id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loadouts/res_nonexistent/materialize',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for private loadout viewed without auth', async () => {
      const ldt = loadoutsDAL.createLoadout({
        name: 'private-reviewer',
        content: reviewerLoadoutContent(),
        ownerAgentId: agent.id,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/loadouts/${ldt.id}/materialize`,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
