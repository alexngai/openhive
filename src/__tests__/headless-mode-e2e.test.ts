/**
 * E2E tests for headless-mode changes.
 *
 * Covers the HTTP surface exposed to operators running OpenHive as a
 * server-only MAP sync hub:
 *   1. Admin-key bypass on /map/preauth-keys, /sync/peers, /dispatches,
 *      /admin/config (previously required admin Bearer only)
 *   2. /skill.md + /skill/:section.md fragment routes
 *   3. /.well-known/openhive.json capabilities + mode block
 *   4. mode: 'server' gating: JSON /, text /admin, filtered skill.md
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

const broadcastSpy = vi.fn();
vi.mock('../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, event: unknown) => broadcastSpy(channel, event),
  broadcast: vi.fn(),
}));

vi.mock('../realtime/swarm-events.js', () => ({
  broadcastSwarmLifecycleEvent: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { mapRoutes } from '../api/routes/map.js';
import { syncRoutes } from '../api/routes/sync.js';
import { dispatchesRoutes } from '../api/routes/dispatches.js';
import { adminRoutes } from '../api/routes/admin.js';
import { setLocalAgent } from '../api/middleware/auth.js';
import { ConfigSchema, type Config } from '../config.js';
import { renderDocument, renderFragment } from '../api/skill-fragments/index.js';
import { generateSkillMd } from '../skill.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('headless-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'headless.db');
const ADMIN_KEY = 'test-admin-key-headless';

function makeConfig(overrides?: Partial<Config>): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Headless Test', description: 'E2E test hub' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
    ...overrides,
  });
}

/**
 * Build a Fastify app that mirrors the server.ts wiring for the handlers
 * we're testing — skill.md, per-fragment routes, well-known, and the
 * server-mode root handlers. Route registration is a subset of server.ts;
 * the goal is to exercise the real request/response shape without booting
 * the whole hub.
 */
async function makeApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');

  await app.register(
    async (api) => {
      await api.register(mapRoutes, { config });
      await api.register(syncRoutes, { config });
      await api.register(dispatchesRoutes, { config });
      await api.register(adminRoutes, { config });
    },
    { prefix: '/api/v1' },
  );

  // Replicate the skill.md / /skill/:section.md / /.well-known / root handlers
  // from server.ts so the HTTP surface stays in sync with production.

  app.get('/skill.md', async (_request, reply) => {
    if (config.mode === 'server') {
      const skillMd = renderDocument(config, { audiences: ['shared', 'agent'] });
      return reply.type('text/markdown').send(skillMd);
    }
    return reply.type('text/markdown').send(generateSkillMd(config));
  });

  app.get<{ Params: { section: string } }>('/skill/:section.md', async (request, reply) => {
    const content = renderFragment(request.params.section, config);
    if (content === null) {
      return reply.status(404).type('text/plain').send(`Unknown fragment: ${request.params.section}`);
    }
    return reply.type('text/markdown').send(content + '\n');
  });

  app.get('/.well-known/openhive.json', async (_request, reply) => {
    // Mirror the real server.ts handler so the test surface and production
    // handler stay in sync. `orchestrator: false` here because the test
    // fixture doesn't spin up the dispatch orchestrator.
    return reply.send({
      version: '0.2.0',
      name: config.instance.name,
      description: config.instance.description,
      url: config.instance.url,
      mode: config.mode,
      federation: { enabled: config.federation.enabled, protocol_version: '1.0' },
      capabilities: {
        map_hub: { enabled: config.mapHub.enabled, trust_model: config.mapHub.trustModel ?? 'open' },
        dispatch: { enabled: true, orchestrator: false },
        sync: { enabled: config.federation.enabled },
        sessions: {
          trajectories: config.sessions.type !== 'none',
          storage_backend: config.sessions.type,
          chat_transports: ['acp', 'mail'],
        },
        tasks: { enabled: true, map_methods: true },
        cascade: { enabled: true },
      },
      endpoints: {
        api: '/api/v1',
        websocket: '/ws',
        skill: '/skill.md',
        skill_fragments: '/skill/{section}.md',
      },
    });
  });

  // server-mode root handlers
  if (config.mode === 'server') {
    app.get('/', async (_request, reply) =>
      reply.send({
        name: config.instance.name,
        version: '0.1.0',
        mode: 'server',
        endpoints: {
          api: '/api/v1',
          websocket: '/ws',
          skill: '/skill.md',
          wellKnown: '/.well-known/openhive.json',
        },
      }),
    );
    app.get('/admin', async (_request, reply) =>
      reply.type('text/html').send('<h1>OpenHive · server mode</h1><p>openhive admin --help</p>'),
    );
  }

  return app;
}

describe('Headless-mode E2E', () => {
  let adminAgent: { id: string; apiKey: string };
  let regularAgent: { id: string; apiKey: string };

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const admin = await agentsDAL.createAgent({
      name: 'headless-admin',
      description: 'admin for headless e2e',
      is_admin: true,
    });
    const regular = await agentsDAL.createAgent({
      name: 'headless-regular',
      description: 'regular agent for headless e2e',
      is_admin: false,
    });
    adminAgent = { id: admin.agent.id, apiKey: admin.apiKey };
    regularAgent = { id: regular.agent.id, apiKey: regular.apiKey };
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
    getDatabase().prepare('DELETE FROM map_preauth_keys').run();
    broadcastSpy.mockClear();
  });

  // ==========================================================================
  // 1. Skill docs + fragments
  // ==========================================================================
  describe('GET /skill.md', () => {
    it('returns full skill doc in default (full) mode', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({ method: 'GET', url: '/skill.md' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/markdown/);
      expect(res.payload).toContain('## Quick Start');
      expect(res.payload).toContain('### Posts');
      expect(res.payload).toContain('## MAP Protocol (Agents)');
      expect(res.payload).toContain('map/tasks/create');
      await app.close();
    });

    it('omits social sections in server mode', async () => {
      const app = await makeApp(makeConfig({ mode: 'server' }));
      const res = await app.inject({ method: 'GET', url: '/skill.md' });
      expect(res.statusCode).toBe(200);
      expect(res.payload).not.toContain('## Quick Start');
      expect(res.payload).not.toContain('### Posts');
      expect(res.payload).toContain('## MAP Protocol (Agents)');
      expect(res.payload).toContain('## Dispatch Orchestrator');
      await app.close();
    });
  });

  describe('GET /skill/:section.md', () => {
    it('returns a single fragment', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({ method: 'GET', url: '/skill/map.md' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/markdown/);
      expect(res.payload).toContain('## MAP Protocol (Agents)');
      // Should NOT include other fragments
      expect(res.payload).not.toContain('## Dispatch Orchestrator');
      expect(res.payload).not.toContain('## Quick Start');
      await app.close();
    });

    it('404s on unknown fragment', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({ method: 'GET', url: '/skill/does-not-exist.md' });
      expect(res.statusCode).toBe(404);
      expect(res.payload).toContain('Unknown fragment');
      await app.close();
    });
  });

  // ==========================================================================
  // 2. Well-known capabilities
  // ==========================================================================
  describe('GET /.well-known/openhive.json', () => {
    it('exposes capabilities block and mode', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({ method: 'GET', url: '/.well-known/openhive.json' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);

      expect(body.mode).toBe('full');
      expect(body.capabilities).toBeDefined();
      expect(body.capabilities.map_hub).toBeDefined();
      expect(body.capabilities.map_hub.enabled).toBe(true);
      expect(body.capabilities.map_hub.trust_model).toBe('open');
      expect(body.capabilities.dispatch.enabled).toBe(true);
      // orchestrator is runtime-gated — the test fixture doesn't start one,
      // so it must be false. Production reports the actual running state.
      expect(body.capabilities.dispatch.orchestrator).toBe(false);
      expect(body.capabilities.sessions.chat_transports).toEqual(['acp', 'mail']);
      expect(body.capabilities.sessions.trajectories).toBe(true); // default: local storage
      expect(body.capabilities.tasks.enabled).toBe(true);
      expect(body.endpoints.skill_fragments).toBe('/skill/{section}.md');
      await app.close();
    });

    it("advertises mode: 'server' when running headless", async () => {
      const app = await makeApp(makeConfig({ mode: 'server' }));
      const res = await app.inject({ method: 'GET', url: '/.well-known/openhive.json' });
      const body = JSON.parse(res.payload);
      expect(body.mode).toBe('server');
      await app.close();
    });
  });

  // ==========================================================================
  // 3. Mode flag: server mode root handlers
  // ==========================================================================
  describe("mode: 'server' root handlers", () => {
    it('GET / returns JSON pointer (not HTML)', async () => {
      const app = await makeApp(makeConfig({ mode: 'server' }));
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const body = JSON.parse(res.payload);
      expect(body.mode).toBe('server');
      expect(body.endpoints.api).toBe('/api/v1');
      expect(body.endpoints.skill).toBe('/skill.md');
      await app.close();
    });

    it('GET /admin returns "use the CLI" page', async () => {
      const app = await makeApp(makeConfig({ mode: 'server' }));
      const res = await app.inject({ method: 'GET', url: '/admin' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.payload).toContain('openhive admin --help');
      await app.close();
    });
  });

  // ==========================================================================
  // 4. Admin-key bypass on MAP preauth routes
  // ==========================================================================
  describe('/map/preauth-keys admin-key bypass', () => {
    it('accepts X-Admin-Key for POST (creates a key)', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { uses: 3 },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.key).toBeDefined();
      expect(body.uses_left).toBe(3);
      await app.close();
    });

    it('rejects wrong X-Admin-Key', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        headers: { 'x-admin-key': 'wrong-key' },
        payload: { uses: 1 },
      });
      // Falls through to authMiddleware which (in local mode) auto-auths as
      // local agent; then requireAdmin fails because local agent isn't admin.
      // In any case — should not succeed.
      expect(res.statusCode).not.toBe(201);
      await app.close();
    });

    it('accepts admin-agent Bearer token too', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        headers: { authorization: `Bearer ${adminAgent.apiKey}` },
        payload: { uses: 1 },
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });

    it('rejects non-admin Bearer token', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        headers: { authorization: `Bearer ${regularAgent.apiKey}` },
        payload: { uses: 1 },
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('GET + DELETE round-trip with X-Admin-Key', async () => {
      const app = await makeApp(makeConfig());
      // Create
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { uses: 1 },
      });
      const { id } = JSON.parse(created.payload);

      // List
      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/map/preauth-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(listed.statusCode).toBe(200);
      const list = JSON.parse(listed.payload);
      expect(list.data.some((k: { id: string }) => k.id === id)).toBe(true);

      // Delete
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/map/preauth-keys/${id}`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(deleted.statusCode).toBe(204);
      await app.close();
    });
  });

  // ==========================================================================
  // 5. Admin-key bypass on /sync/peers
  // ==========================================================================
  describe('/sync/peers admin-key bypass', () => {
    it('GET accepts X-Admin-Key', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sync/peers',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toBeInstanceOf(Array);
      await app.close();
    });

    it('GET rejects wrong admin key when no bearer', async () => {
      const app = await makeApp(makeConfig({ auth: { mode: 'swarmhub' } }));
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/sync/peers',
        headers: { 'x-admin-key': 'wrong' },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('POST mutation requires valid admin key', async () => {
      const app = await makeApp(makeConfig({ auth: { mode: 'swarmhub' } }));
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/peers',
        headers: { 'x-admin-key': 'wrong' },
        payload: { peer_endpoint: 'https://example.com', sync_group_id: 'fake' },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      await app.close();
    });
  });

  // ==========================================================================
  // 6. Admin-key bypass on /dispatches
  // ==========================================================================
  describe('/dispatches admin-key bypass', () => {
    it('GET /dispatches accepts X-Admin-Key', async () => {
      const app = await makeApp(makeConfig({ auth: { mode: 'swarmhub' } }));
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toBeInstanceOf(Array);
      await app.close();
    });

    it('POST /dispatches/:id/cancel accepts X-Admin-Key', async () => {
      const app = await makeApp(makeConfig({ auth: { mode: 'swarmhub' } }));

      // Seed a queued dispatch
      const created = dispatchesDAL.createDispatch({
        spec_id: 'test-spec',
        spec_resource_id: 'test-resource',
        spec_captured_at: new Date().toISOString(),
        target_swarm_id: 'test-swarm',
        initiator_type: 'user',
        initiator_id: adminAgent.id,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/dispatches/${created.id}/cancel`,
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.dispatch.status).toBe('cancelled');
      await app.close();
    });

    it('rejects with wrong admin key AND no bearer', async () => {
      const app = await makeApp(makeConfig({ auth: { mode: 'swarmhub' } }));
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dispatches',
        headers: { 'x-admin-key': 'wrong' },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  // ==========================================================================
  // 6.5. Strict admin-auth regression (1a): local-auth auto-agent must NOT
  //      silently upgrade an unauthenticated request to admin.
  // ==========================================================================
  describe('strict admin-auth (local-auth auto-agent does NOT grant admin)', () => {
    it('POST /map/preauth-keys with no headers → 401 even when local admin set', async () => {
      // Simulate the production local-auth path: setLocalAgent(admin). Prior
      // to the strict-auth fix, a bare `curl -XPOST /api/v1/map/preauth-keys`
      // would succeed because authMiddleware auto-populates request.agent
      // and requireAdmin passes.
      setLocalAgent({ id: adminAgent.id, name: 'local', is_admin: true } as Parameters<typeof setLocalAgent>[0]);
      try {
        const app = await makeApp(makeConfig());
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/map/preauth-keys',
          payload: { uses: 1 },
        });
        expect(res.statusCode).toBe(401);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('Unauthorized');
        await app.close();
      } finally {
        setLocalAgent(null);
      }
    });

    it('GET /admin/config falls through to authOrAdminKey (lenient — any authenticated agent can read)', async () => {
      // This endpoint uses the softer `authOrAdminKey` middleware because
      // settings UIs historically relied on any authenticated agent being
      // able to read the (redacted) config. Confirms the separation
      // between `createAdminAuth` (strict) and `createAuthOrAdminKey`.
      setLocalAgent({ id: adminAgent.id, name: 'local', is_admin: true } as Parameters<typeof setLocalAgent>[0]);
      try {
        const app = await makeApp(makeConfig());
        const res = await app.inject({ method: 'GET', url: '/api/v1/admin/config' });
        expect(res.statusCode).toBe(200);
        await app.close();
      } finally {
        setLocalAgent(null);
      }
    });

    it('PATCH /admin/config with no headers → 401 (strict — mutation requires admin)', async () => {
      setLocalAgent({ id: adminAgent.id, name: 'local', is_admin: true } as Parameters<typeof setLocalAgent>[0]);
      try {
        const app = await makeApp(makeConfig());
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/v1/admin/config',
          payload: { instance: { name: 'Unauthorized Rename' } },
        });
        expect(res.statusCode).toBe(401);
        await app.close();
      } finally {
        setLocalAgent(null);
      }
    });

    it('GET /admin/agents with no headers → 401 even when local admin set', async () => {
      setLocalAgent({ id: adminAgent.id, name: 'local', is_admin: true } as Parameters<typeof setLocalAgent>[0]);
      try {
        const app = await makeApp(makeConfig());
        const res = await app.inject({ method: 'GET', url: '/api/v1/admin/agents' });
        expect(res.statusCode).toBe(401);
        await app.close();
      } finally {
        setLocalAgent(null);
      }
    });

    it('wrong X-Admin-Key + valid admin Bearer → accepted (Bearer path works)', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        headers: {
          'x-admin-key': 'deliberately-wrong',
          authorization: `Bearer ${adminAgent.apiKey}`,
        },
        payload: { uses: 1 },
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });

    it('valid X-Admin-Key alone → accepted (admin-key path works)', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { uses: 1 },
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });

    it('admin-key compare is length-strict (prefix of valid key rejected)', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        headers: { 'x-admin-key': ADMIN_KEY.slice(0, -1) },
        payload: { uses: 1 },
      });
      // Wrong key → falls through to Bearer requirement → no Bearer → 401
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  // ==========================================================================
  // 6.6. Escape hatch: admin.trustLocalMode flips back to auto-auth in local mode
  // ==========================================================================
  describe('admin.trustLocalMode escape hatch', () => {
    it('POST /map/preauth-keys with no headers → 201 when trustLocalMode=true + local admin', async () => {
      // Simulate the trusted-single-operator localhost deployment
      setLocalAgent({ id: adminAgent.id, name: 'local', is_admin: true } as Parameters<typeof setLocalAgent>[0]);
      try {
        const app = await makeApp(makeConfig({
          admin: { createOnStartup: false, key: ADMIN_KEY, trustLocalMode: true },
        }));
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/map/preauth-keys',
          payload: { uses: 1 },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.payload);
        expect(body.key).toMatch(/^ohpak_/);
        await app.close();
      } finally {
        setLocalAgent(null);
      }
    });

    it('PATCH /admin/config with no headers → 200 when trustLocalMode=true', async () => {
      setLocalAgent({ id: adminAgent.id, name: 'local', is_admin: true } as Parameters<typeof setLocalAgent>[0]);
      try {
        const config = makeConfig({
          admin: { createOnStartup: false, key: ADMIN_KEY, trustLocalMode: true },
        });
        const app = await makeApp(config);
        const res = await app.inject({
          method: 'PATCH',
          url: '/api/v1/admin/config',
          payload: { instance: { description: 'updated-no-creds' } },
        });
        expect(res.statusCode).toBe(200);
        expect(config.instance.description).toBe('updated-no-creds');
        await app.close();
      } finally {
        setLocalAgent(null);
      }
    });

    it('trustLocalMode is IGNORED when auth.mode !== "local" (non-local mode still strict)', async () => {
      // Even if the flag is on, swarmhub/token mode has no auto-auth agent
      // to trust — strict behavior must apply.
      const app = await makeApp(makeConfig({
        auth: { mode: 'swarmhub' },
        admin: { createOnStartup: false, key: ADMIN_KEY, trustLocalMode: true },
      }));
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        payload: { uses: 1 },
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('non-admin local agent still fails even with trustLocalMode=true', async () => {
      // Safety belt: the flag trusts the local agent, but it still needs
      // is_admin=true. A non-admin local agent shouldn't accidentally pass
      // the bypass.
      setLocalAgent({ id: regularAgent.id, name: 'local-regular', is_admin: false } as Parameters<typeof setLocalAgent>[0]);
      try {
        const app = await makeApp(makeConfig({
          admin: { createOnStartup: false, key: ADMIN_KEY, trustLocalMode: true },
        }));
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/map/preauth-keys',
          payload: { uses: 1 },
        });
        expect(res.statusCode).toBe(403);
        await app.close();
      } finally {
        setLocalAgent(null);
      }
    });

    it('admin key still wins even when trustLocalMode=true', async () => {
      // Flag doesn't disable the admin-key path — it just adds an alternate
      // credential. Valid admin key should still succeed.
      const app = await makeApp(makeConfig({
        admin: { createOnStartup: false, key: ADMIN_KEY, trustLocalMode: true },
      }));
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/map/preauth-keys',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { uses: 1 },
      });
      expect(res.statusCode).toBe(201);
      await app.close();
    });
  });

  // ==========================================================================
  // 7. Admin-key bypass on /admin/config
  // ==========================================================================
  describe('/admin/config admin-key bypass', () => {
    it('GET accepts X-Admin-Key', async () => {
      const app = await makeApp(makeConfig());
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/config',
        headers: { 'x-admin-key': ADMIN_KEY },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.instance).toBeDefined();
      await app.close();
    });

    it('PATCH accepts X-Admin-Key', async () => {
      const config = makeConfig();
      const app = await makeApp(config);
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/config',
        headers: { 'x-admin-key': ADMIN_KEY },
        payload: { instance: { name: 'Renamed Hub' } },
      });
      expect(res.statusCode).toBe(200);
      expect(config.instance.name).toBe('Renamed Hub');
      await app.close();
    });
  });
});
