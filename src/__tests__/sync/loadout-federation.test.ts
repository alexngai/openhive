/**
 * Layer 1 federation tests for `loadout` syncable resources.
 *
 * Parallel to `team-template-federation.test.ts`. Covers both sides of the
 * mesh-sync flow: REST routes recording events into `hive_events`, and the
 * materializer rebuilding the remote row with `metadata.content` intact.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as syncGroupsDAL from '../../db/dal/sync-groups.js';
import { findResourceById } from '../../db/dal/syncable-resources.js';
import { signEvent } from '../../sync/crypto.js';
import { materializeEvent } from '../../sync/materializer.js';
import { getMaterializerRepo } from '../../sync/materializer-repo.js';
import { loadoutsRoutes } from '../../api/routes/loadouts.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { HiveEvent } from '../../sync/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('loadout-federation');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'loadout-federation.db');
const REMOTE_INSTANCE = 'inst_remote_loadout';

const SAMPLE_CONTENT = {
  name: 'fed-loadout',
  capabilities: ['file.read', 'exec.test'],
  permissions: { deny: ['Bash(git push:*)'] },
  prompt_addendum: 'Be thorough.',
};

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

describe('loadout federation', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };
  let syncGroupId: string;
  let syncGroupPrivateKey: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());

    const a = await agentsDAL.createAgent({
      name: 'loadout-fed-agent',
      description: 'federation test',
    });
    agent = { id: a.agent.id, apiKey: a.apiKey };

    const hive = hivesDAL.createHive({
      name: 'loadout-fed-hive',
      description: 'federation hive',
      owner_id: agent.id,
    });
    const group = syncGroupsDAL.createSyncGroup(hive.id, 'sync:loadout-fed', 'inst_local_loadout');
    syncGroupId = group.id;
    syncGroupPrivateKey = group.instance_signing_key_private;
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare(`DELETE FROM syncable_resources WHERE resource_type = 'loadout'`).run();
    db.prepare(`DELETE FROM hive_events WHERE sync_group_id = ?`).run(syncGroupId);
  });

  function makeEvent(eventType: string, payload: unknown, opts?: { ts?: number }): HiveEvent {
    const payloadStr = JSON.stringify(payload);
    return {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sync_group_id: syncGroupId,
      seq: 1,
      event_type: eventType as HiveEvent['event_type'],
      origin_instance_id: REMOTE_INSTANCE,
      origin_ts: opts?.ts ?? Date.now(),
      payload: payloadStr,
      signature: signEvent(payloadStr, syncGroupPrivateKey),
      received_at: new Date().toISOString(),
      is_local: 0,
    };
  }

  // ── Outbound ────────────────────────────────────────────────────────────

  describe('outbound: REST routes record sync events', () => {
    it('private loadouts do NOT emit a sync event', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: { name: 'priv-lo', content: SAMPLE_CONTENT, visibility: 'private' },
      });
      expect(res.statusCode).toBe(201);
      const events = getDatabase()
        .prepare(`SELECT * FROM hive_events WHERE sync_group_id = ?`)
        .all(syncGroupId);
      expect(events).toHaveLength(0);
    });

    it('shared loadouts emit resource_published with loadout payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: { name: 'shared-lo', content: SAMPLE_CONTENT, visibility: 'shared' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      const events = getDatabase()
        .prepare(`SELECT * FROM hive_events WHERE sync_group_id = ? AND event_type = 'resource_published'`)
        .all(syncGroupId) as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0].payload);
      expect(payload.resource_type).toBe('loadout');
      expect(payload.resource_id).toBe(body.loadout.id);
      expect(payload.metadata.content.name).toBe('fed-loadout');
    });

    it('PATCH emits resource_updated, DELETE emits resource_unpublished', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/loadouts',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: { name: 'lifecycle-lo', content: SAMPLE_CONTENT, visibility: 'public' },
      });
      const id = JSON.parse(create.body).loadout.id;

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/v1/loadouts/${id}`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: { description: 'updated' },
      });
      expect(patch.statusCode).toBe(200);
      expect(
        getDatabase()
          .prepare(`SELECT COUNT(*) as n FROM hive_events WHERE event_type = 'resource_updated'`)
          .get() as { n: number },
      ).toEqual({ n: 1 });

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/loadouts/${id}`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(del.statusCode).toBe(204);
      expect(
        getDatabase()
          .prepare(`SELECT COUNT(*) as n FROM hive_events WHERE event_type = 'resource_unpublished'`)
          .get() as { n: number },
      ).toEqual({ n: 1 });
    });
  });

  // ── Inbound ─────────────────────────────────────────────────────────────

  describe('inbound: materializer round-trips metadata.content', () => {
    it('resource_published creates a remote loadout row with content intact', () => {
      // owner.agent_id must satisfy the syncable_resources → agents FK.
      const payload = {
        resource_id: 'res_origin_lo_1',
        resource_type: 'loadout',
        name: 'remote-lo',
        description: null,
        git_remote_url: 'local://loadout/remote-lo',
        visibility: 'shared',
        owner: {
          instance_id: REMOTE_INSTANCE,
          agent_id: agent.id,
          name: 'remote-author',
          avatar_url: null,
        },
        tags: [],
        metadata: { content: SAMPLE_CONTENT },
      };
      materializeEvent(makeEvent('resource_published', payload), 'h', 'h', false);

      const head = getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, 'res_origin_lo_1');
      expect(head).not.toBeNull();
      expect(head!.resource_type).toBe('loadout');

      const full = findResourceById(head!.id);
      const meta = full!.metadata as { content: typeof SAMPLE_CONTENT } | null;
      expect(meta?.content.name).toBe('fed-loadout');
      expect(meta?.content.permissions?.deny).toEqual(['Bash(git push:*)']);
      expect(meta?.content.prompt_addendum).toBe('Be thorough.');
    });

    it('resource_unpublished removes the remote row', () => {
      const payload = {
        resource_id: 'res_origin_lo_2',
        resource_type: 'loadout',
        name: 'deletable-lo',
        description: null,
        git_remote_url: 'local://loadout/deletable-lo',
        visibility: 'shared',
        owner: {
          instance_id: REMOTE_INSTANCE,
          agent_id: agent.id,
          name: 'remote-author',
          avatar_url: null,
        },
        tags: [],
        metadata: { content: SAMPLE_CONTENT },
      };
      materializeEvent(makeEvent('resource_published', payload), 'h', 'h', false);
      expect(getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, 'res_origin_lo_2')).not.toBeNull();

      const unpub = {
        resource_id: 'res_origin_lo_2',
        unpublished_by: {
          instance_id: REMOTE_INSTANCE,
          agent_id: agent.id,
          name: 'remote-author',
          avatar_url: null,
        },
      };
      materializeEvent(makeEvent('resource_unpublished', unpub), 'h', 'h', false);
      expect(getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, 'res_origin_lo_2')).toBeFalsy();
    });
  });
});
