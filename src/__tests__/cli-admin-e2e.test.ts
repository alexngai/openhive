/**
 * E2E tests for `openhive admin *` CLI subcommands.
 *
 * Spins up a Fastify app on a real port (so fetch works across the CLI ↔
 * hub boundary), then exercises `createAdminClient()` against it —
 * this is the client library every admin subcommand uses, so proving it
 * resolves auth + makes HTTP calls correctly covers the CLI's behavior.
 *
 * Commander argv parsing + help-text correctness live in cli.test.ts
 * (which shells out to the built CLI). Fastify-level request/response
 * correctness lives in headless-mode-e2e.test.ts.
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
import { ConfigSchema, type Config } from '../config.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';
import { createAdminClient } from '../cli/admin-client.js';

const TEST_ROOT = testRoot('cli-admin-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'cli-admin.db');
const ADMIN_KEY = 'cli-e2e-admin-key';

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'CLI Test Hub', description: 'CLI E2E' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
  });
}

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
  return app;
}

describe('CLI admin E2E', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    // Seed an admin + regular agent so admin.ts has data to list.
    await agentsDAL.createAgent({
      name: 'cli-admin',
      description: 'admin for CLI E2E',
      is_admin: true,
    });
    await agentsDAL.createAgent({
      name: 'cli-regular',
      description: 'regular for CLI E2E',
      is_admin: false,
    });

    app = await makeApp(makeConfig());
    // Listen on an ephemeral port
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind ephemeral port');
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM map_preauth_keys').run();
    broadcastSpy.mockClear();
  });

  describe('createAdminClient', () => {
    it('resolves server URL + admin key from constructor args', async () => {
      const client = createAdminClient({ server: baseUrl, adminKey: ADMIN_KEY });
      expect(client.baseUrl).toBe(baseUrl);

      const result = await client.post<{ id: string; key: string; uses_left: number }>(
        '/api/v1/map/preauth-keys',
        { uses: 2 },
      );
      expect(result.id).toBeDefined();
      expect(result.key).toMatch(/^ohpak_/);
      expect(result.uses_left).toBe(2);
    });

    it('reads admin key from HIVE_ADMIN_KEY env var', async () => {
      const originalEnv = process.env.HIVE_ADMIN_KEY;
      process.env.HIVE_ADMIN_KEY = ADMIN_KEY;
      try {
        const client = createAdminClient({ server: baseUrl });
        const result = await client.get<{ data: unknown[] }>('/api/v1/map/preauth-keys');
        expect(result.data).toBeInstanceOf(Array);
      } finally {
        if (originalEnv === undefined) delete process.env.HIVE_ADMIN_KEY;
        else process.env.HIVE_ADMIN_KEY = originalEnv;
      }
    });

    it('throws when no admin key can be found', () => {
      const originalHive = process.env.HIVE_ADMIN_KEY;
      const originalOpenhive = process.env.OPENHIVE_ADMIN_KEY;
      delete process.env.HIVE_ADMIN_KEY;
      delete process.env.OPENHIVE_ADMIN_KEY;
      // Point to a data dir that has no config so file resolution also misses
      const emptyDataDir = `${TEST_ROOT}/empty-data-dir`;
      try {
        expect(() => createAdminClient({ server: baseUrl, dataDir: emptyDataDir })).toThrow(/admin key/i);
      } finally {
        if (originalHive !== undefined) process.env.HIVE_ADMIN_KEY = originalHive;
        if (originalOpenhive !== undefined) process.env.OPENHIVE_ADMIN_KEY = originalOpenhive;
      }
    });

    it('surfaces server error messages on non-2xx responses', async () => {
      const client = createAdminClient({ server: baseUrl, adminKey: 'wrong-key' });
      await expect(client.post('/api/v1/map/preauth-keys', { uses: 1 })).rejects.toThrow(
        /40[13]/,
      );
    });

    it('round-trips create → list → delete for preauth keys', async () => {
      const client = createAdminClient({ server: baseUrl, adminKey: ADMIN_KEY });
      const created = await client.post<{ id: string }>('/api/v1/map/preauth-keys', { uses: 1 });
      const listed = await client.get<{ data: Array<{ id: string }> }>('/api/v1/map/preauth-keys');
      expect(listed.data.some((k) => k.id === created.id)).toBe(true);
      await client.del(`/api/v1/map/preauth-keys/${created.id}`);
      const listedAfter = await client.get<{ data: Array<{ id: string }> }>('/api/v1/map/preauth-keys');
      expect(listedAfter.data.some((k) => k.id === created.id)).toBe(false);
    });

    it('lists agents through the admin surface', async () => {
      const client = createAdminClient({ server: baseUrl, adminKey: ADMIN_KEY });
      const result = await client.get<{ data: Array<{ name: string }>; total: number }>(
        '/api/v1/admin/agents',
      );
      expect(result.total).toBeGreaterThanOrEqual(2);
      expect(result.data.some((a) => a.name === 'cli-admin')).toBe(true);
      expect(result.data.some((a) => a.name === 'cli-regular')).toBe(true);
    });

    it('get + patch + get round-trip on admin config', async () => {
      const client = createAdminClient({ server: baseUrl, adminKey: ADMIN_KEY });
      const before = await client.get<{ instance: { description: string } }>('/api/v1/admin/config');
      expect(before.instance.description).toBe('CLI E2E');

      await client.patch('/api/v1/admin/config', {
        instance: { description: 'Renamed via CLI' },
      });

      const after = await client.get<{ instance: { description: string } }>('/api/v1/admin/config');
      expect(after.instance.description).toBe('Renamed via CLI');
    });

    it('lists sync peers via admin-key auth', async () => {
      const client = createAdminClient({ server: baseUrl, adminKey: ADMIN_KEY });
      const result = await client.get<{ data: unknown[] }>('/api/v1/sync/peers');
      expect(result.data).toBeInstanceOf(Array);
    });

    it('lists dispatches via admin-key auth', async () => {
      const client = createAdminClient({ server: baseUrl, adminKey: ADMIN_KEY });
      const result = await client.get<{ data: unknown[]; total: number }>('/api/v1/dispatches');
      expect(result.data).toBeInstanceOf(Array);
      expect(typeof result.total).toBe('number');
    });

    it('cancels a dispatch and records cancelled_by.id = "admin-key"', async () => {
      // Seed a queued dispatch
      const seeded = dispatchesDAL.createDispatch({
        spec_id: 'cli-cancel-spec',
        spec_resource_id: 'cli-cancel-resource',
        spec_captured_at: new Date().toISOString(),
        target_swarm_id: 'cli-cancel-swarm',
        initiator_type: 'user',
        initiator_id: 'cli-admin',
      });

      const client = createAdminClient({ server: baseUrl, adminKey: ADMIN_KEY });
      const result = await client.post<{ dispatch: { id: string; status: string } }>(
        `/api/v1/dispatches/${seeded.id}/cancel`,
      );
      expect(result.dispatch.id).toBe(seeded.id);
      expect(result.dispatch.status).toBe('cancelled');

      // Verify the broadcast payload captured the operator identity
      expect(broadcastSpy).toHaveBeenCalledWith(
        'map:dispatches',
        expect.objectContaining({
          type: 'dispatch.cancelled',
          data: expect.objectContaining({
            cancelled_by: expect.objectContaining({ type: 'operator', id: 'admin-key' }),
          }),
        }),
      );
    });
  });
});
