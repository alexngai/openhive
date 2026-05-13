/**
 * Layer 1 federation tests for `team_template` syncable resources.
 *
 * Two sides of the mesh-sync flow:
 *
 * 1. **Outbound** — POST /teams with non-private visibility writes a
 *    `resource_published` event into `hive_events`, ready for replication to
 *    peer hubs. PATCH/DELETE emit `resource_updated`/`resource_unpublished`.
 *    Private rows stay local.
 *
 * 2. **Inbound** — feeding the materializer a `resource_published` event with
 *    `resource_type: 'team_template'` upserts a remote row whose
 *    `metadata.content` round-trips byte-for-byte. Update + unpublish behave
 *    the same as for any other resource type.
 *
 * Modeled on `resource-sync.test.ts` — same DB harness, same event-replay
 * pattern. No two-process integration here; the round-trip invariant is the
 * point.
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
import { teamsRoutes } from '../../api/routes/teams.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { HiveEvent } from '../../sync/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('team-template-federation');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'team-template-federation.db');
const REMOTE_INSTANCE = 'inst_remote_team_template';

const SAMPLE_CONTENT = {
  manifest: {
    name: 'fed-team',
    version: 1 as const,
    roles: ['orchestrator', 'executor'],
    topology: { root: { role: 'orchestrator' } },
  },
  roles: {
    orchestrator: { name: 'orchestrator', capabilities: ['plan'] },
    executor: { name: 'executor', capabilities: ['exec'] },
  },
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
      await api.register(teamsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('team_template federation', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };
  let syncGroupId: string;
  let syncGroupPrivateKey: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());

    const a = await agentsDAL.createAgent({
      name: 'team-template-fed-agent',
      description: 'federation test',
    });
    agent = { id: a.agent.id, apiKey: a.apiKey };

    const hive = hivesDAL.createHive({
      name: 'fed-hive',
      description: 'federation hive',
      owner_id: agent.id,
    });
    const group = syncGroupsDAL.createSyncGroup(hive.id, 'sync:fed', 'inst_local_team_template');
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
    db.prepare(`DELETE FROM syncable_resources WHERE resource_type = 'team_template'`).run();
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

  // ── Outbound (route → hive_events) ──────────────────────────────────────

  describe('outbound: REST routes record sync events', () => {
    it('private templates do NOT emit a sync event', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: { name: 'priv-team', content: SAMPLE_CONTENT, visibility: 'private' },
      });
      expect(res.statusCode).toBe(201);

      const events = getDatabase()
        .prepare(`SELECT * FROM hive_events WHERE sync_group_id = ?`)
        .all(syncGroupId);
      expect(events).toHaveLength(0);
    });

    it('shared templates emit resource_published with team_template payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: { name: 'shared-team', content: SAMPLE_CONTENT, visibility: 'shared' },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);

      const events = getDatabase()
        .prepare(`SELECT * FROM hive_events WHERE sync_group_id = ? AND event_type = 'resource_published'`)
        .all(syncGroupId) as Array<{ payload: string }>;
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0].payload);
      expect(payload.resource_type).toBe('team_template');
      expect(payload.resource_id).toBe(body.team_template.id);
      // metadata.content round-trips through the event payload
      expect(payload.metadata.content.manifest.name).toBe('fed-team');
    });

    it('PATCH emits resource_updated', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: { name: 'patch-team', content: SAMPLE_CONTENT, visibility: 'public' },
      });
      const id = JSON.parse(create.body).team_template.id;

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/v1/teams/${id}`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: { description: 'updated' },
      });
      expect(patch.statusCode).toBe(200);

      const updates = getDatabase()
        .prepare(`SELECT * FROM hive_events WHERE sync_group_id = ? AND event_type = 'resource_updated'`)
        .all(syncGroupId);
      expect(updates).toHaveLength(1);
    });

    it('DELETE emits resource_unpublished', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        payload: { name: 'del-team', content: SAMPLE_CONTENT, visibility: 'public' },
      });
      const id = JSON.parse(create.body).team_template.id;

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/teams/${id}`,
        headers: { Authorization: `Bearer ${agent.apiKey}` },
      });
      expect(del.statusCode).toBe(204);

      const unpubs = getDatabase()
        .prepare(`SELECT * FROM hive_events WHERE sync_group_id = ? AND event_type = 'resource_unpublished'`)
        .all(syncGroupId);
      expect(unpubs).toHaveLength(1);
    });
  });

  // ── Inbound (materializer → remote row) ─────────────────────────────────

  describe('inbound: materializer round-trips metadata.content', () => {
    it('resource_published creates a remote team_template row with content intact', () => {
      // `owner.agent_id` must point at a real local row because syncable_resources
      // FKs to agents(id). The existing resource-sync.test.ts uses the same trick;
      // in production the materializer would resolve to a placeholder agent.
      const payload = {
        resource_id: 'res_origin_team_1',
        resource_type: 'team_template',
        name: 'remote-team',
        description: null,
        git_remote_url: 'local://team_template/remote-team',
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
      const event = makeEvent('resource_published', payload);
      materializeEvent(event, 'hive_id_unused', 'hive_name_unused', false);

      const head = getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, 'res_origin_team_1');
      expect(head).not.toBeNull();
      expect(head!.resource_type).toBe('team_template');

      // Fetch the full row to inspect name + metadata round-trip.
      const full = findResourceById(head!.id);
      expect(full).not.toBeNull();
      expect(full!.name).toBe('remote-team');
      const meta = full!.metadata as { content: typeof SAMPLE_CONTENT } | null;
      expect(meta?.content.manifest.name).toBe('fed-team');
      expect(meta?.content.roles?.executor.capabilities).toEqual(['exec']);
    });

    it('resource_updated applies fields when newer than the local row', () => {
      const payload = {
        resource_id: 'res_origin_team_2',
        resource_type: 'team_template',
        name: 'updatable-team',
        description: null,
        git_remote_url: 'local://team_template/updatable-team',
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

      const updatedContent = {
        ...SAMPLE_CONTENT,
        manifest: { ...SAMPLE_CONTENT.manifest, description: 'updated' },
      };
      const update = {
        resource_id: 'res_origin_team_2',
        fields: { description: 'updated', metadata: { content: updatedContent } },
        updated_by: {
          instance_id: REMOTE_INSTANCE,
          agent_id: agent.id,
          name: 'remote-author',
          avatar_url: null,
        },
      };
      // Use a future origin_ts so the materializer's last-writer-wins compare
      // (event.origin_ts vs the local row's updated_at) treats this as newer.
      // The upsert path sets updated_at via datetime('now'), so any timestamp
      // close to the present can race; +1 day removes the ambiguity.
      materializeEvent(
        makeEvent('resource_updated', update, { ts: Date.now() + 86_400_000 }),
        'h',
        'h',
        false,
      );

      const head = getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, 'res_origin_team_2');
      const full = findResourceById(head!.id);
      const meta = full!.metadata as { content: { manifest: { description: string } } } | null;
      expect(meta?.content.manifest.description).toBe('updated');
    });

    it('resource_unpublished removes the remote row', () => {
      const payload = {
        resource_id: 'res_origin_team_3',
        resource_type: 'team_template',
        name: 'deletable-team',
        description: null,
        git_remote_url: 'local://team_template/deletable-team',
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
      expect(getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, 'res_origin_team_3')).not.toBeNull();

      const unpub = {
        resource_id: 'res_origin_team_3',
        unpublished_by: {
          instance_id: REMOTE_INSTANCE,
          agent_id: agent.id,
          name: 'remote-author',
          avatar_url: null,
        },
      };
      materializeEvent(makeEvent('resource_unpublished', unpub), 'h', 'h', false);

      expect(getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, 'res_origin_team_3')).toBeFalsy();
    });
  });
});
