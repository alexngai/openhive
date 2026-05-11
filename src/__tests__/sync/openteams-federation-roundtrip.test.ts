/**
 * End-to-end federation round-trip — gap B (single-process variant).
 *
 * The Layer 1 outbound tests verify that POST/PATCH/DELETE on /teams +
 * /loadouts emit `resource_published/updated/unpublished` events into
 * `hive_events`. The inbound tests verify that hand-constructed payloads
 * round-trip through the materializer. This file closes the seam between
 * them: capture the *actual* event payload the route emitted, then feed
 * it back through `materializeEvent` (as a peer hub would on pull) and
 * assert the materialized row matches the source content.
 *
 * Avoids the cost of two Fastify processes by sharing one database +
 * one materializer repo — the wire format is what gets exercised end to
 * end, which is the gap the L1 single-hub tests left open.
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
import { materializeEvent } from '../../sync/materializer.js';
import { getMaterializerRepo } from '../../sync/materializer-repo.js';
import { teamsRoutes } from '../../api/routes/teams.js';
import { loadoutsRoutes } from '../../api/routes/loadouts.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { HiveEvent } from '../../sync/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('openteams-federation-roundtrip');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'roundtrip.db');

const SAMPLE_TEAM = {
  manifest: {
    name: 'fed-team',
    version: 1 as const,
    roles: ['root', 'worker'],
    topology: {
      root: { role: 'root' },
      spawn_rules: { root: ['worker'], worker: [] },
    },
  },
  roles: {
    root: { name: 'root', capabilities: ['plan'] },
    worker: { name: 'worker', capabilities: ['exec'] },
  },
};

const SAMPLE_LOADOUT = {
  name: 'fed-lo',
  capabilities: ['file.read'],
  permissions: { deny: ['Bash(git push:*)'] },
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
      await api.register(loadoutsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

/**
 * Reconstruct a HiveEvent from the row that the route's sync hook wrote
 * to `hive_events`. This is the same JSON-RPC payload a peer hub would
 * receive over the mesh pull.
 */
function readMostRecentEvent(syncGroupId: string, eventType: string): HiveEvent {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM hive_events
       WHERE sync_group_id = ? AND event_type = ?
       ORDER BY received_at DESC LIMIT 1`,
    )
    .get(syncGroupId, eventType) as HiveEvent;
  expect(row).toBeDefined();
  return row;
}

/**
 * Rewrite an event as if it came from a peer hub. Two changes:
 *
 *   1. `origin_instance_id` becomes a non-local instance id, so the
 *      materializer treats it as a fresh upsert.
 *   2. `payload.owner.agent_id` is rewritten to a peer-author id so the
 *      remote materialized row doesn't collide with the local one on the
 *      `UNIQUE(owner_agent_id, resource_type, name)` constraint.
 *
 * Returns a new event with the rewritten payload re-stringified.
 */
function rewriteAsRemoteEvent(
  event: HiveEvent,
  remoteInstance: string,
  peerAuthorId: string,
): HiveEvent {
  const parsed = JSON.parse(event.payload) as {
    owner?: { agent_id?: string; instance_id?: string };
    updated_by?: { agent_id?: string; instance_id?: string };
  };
  if (parsed.owner) {
    parsed.owner = {
      ...parsed.owner,
      agent_id: peerAuthorId,
      instance_id: remoteInstance,
    };
  }
  if (parsed.updated_by) {
    parsed.updated_by = {
      ...parsed.updated_by,
      agent_id: peerAuthorId,
      instance_id: remoteInstance,
    };
  }
  return {
    ...event,
    origin_instance_id: remoteInstance,
    is_local: 0,
    payload: JSON.stringify(parsed),
  };
}

describe('openteams federation round-trip (POST → event → materialize)', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };
  let peerAuthorId: string;
  let syncGroupId: string;
  const REMOTE_INSTANCE = 'inst_peer_hub';

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());
    const a = await agentsDAL.createAgent({
      name: 'roundtrip-agent',
      description: 'federation round-trip',
    });
    agent = { id: a.agent.id, apiKey: a.apiKey };

    // Peer author — represents the author on the remote hub. Used to keep
    // the materialized remote row out of the local row's UNIQUE constraint.
    const peer = await agentsDAL.createAgent({
      name: 'peer-author',
      description: 'remote hub author stand-in',
    });
    peerAuthorId = peer.agent.id;

    const hive = hivesDAL.createHive({
      name: 'roundtrip-hive',
      description: 'federation hive',
      owner_id: agent.id,
    });
    const group = syncGroupsDAL.createSyncGroup(hive.id, 'sync:roundtrip', 'inst_local');
    syncGroupId = group.id;
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare(`DELETE FROM syncable_resources WHERE resource_type IN ('team_template', 'loadout')`).run();
    db.prepare(`DELETE FROM hive_events WHERE sync_group_id = ?`).run(syncGroupId);
  });

  it('team_template POST → captured event → materialized on peer with content intact', async () => {
    // Hub A: POST a public team_template.
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: { name: 'fed-team', content: SAMPLE_TEAM, visibility: 'public' },
    });
    expect(create.statusCode).toBe(201);
    const originLocalId = JSON.parse(create.body).team_template.id;

    // Capture the event that the L1 sync hook wrote — this is the wire payload.
    const event = readMostRecentEvent(syncGroupId, 'resource_published');
    const remoteEvent = rewriteAsRemoteEvent(event, REMOTE_INSTANCE, peerAuthorId);

    // Hub B: replay it. The materializer must accept the route's emitted
    // shape and produce a fresh remote row with metadata.content intact.
    materializeEvent(remoteEvent, 'hive_id_unused', 'hive_name_unused', false);

    const payload = JSON.parse(event.payload) as { resource_id: string };
    const remote = getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, payload.resource_id);
    expect(remote).not.toBeNull();
    // The new row is a separate local id, not equal to the origin.
    expect(remote!.id).not.toBe(originLocalId);

    // metadata.content survives the wire (route → hive_events.payload → materializer)
    const full = findResourceById(remote!.id);
    const meta = full!.metadata as { content: typeof SAMPLE_TEAM } | null;
    expect(meta?.content.manifest.name).toBe('fed-team');
    expect(meta?.content.roles?.worker.capabilities).toEqual(['exec']);
  });

  it('loadout POST → captured event → materialized on peer with permissions intact', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/loadouts',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: { name: 'fed-lo', content: SAMPLE_LOADOUT, visibility: 'public' },
    });
    expect(create.statusCode).toBe(201);

    const event = readMostRecentEvent(syncGroupId, 'resource_published');
    materializeEvent(
      rewriteAsRemoteEvent(event, REMOTE_INSTANCE, peerAuthorId),
      'h',
      'h',
      false,
    );

    const payload = JSON.parse(event.payload) as { resource_id: string };
    const remote = getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, payload.resource_id);
    const full = findResourceById(remote!.id);
    const meta = full!.metadata as { content: typeof SAMPLE_LOADOUT } | null;
    expect(meta?.content.permissions?.deny).toEqual(['Bash(git push:*)']);
  });

  it('PATCH → captured update event → materialized changes apply on peer', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: { name: 'patch-team', content: SAMPLE_TEAM, visibility: 'public' },
    });
    const id = JSON.parse(create.body).team_template.id;
    const publish = readMostRecentEvent(syncGroupId, 'resource_published');
    materializeEvent(rewriteAsRemoteEvent(publish, REMOTE_INSTANCE, peerAuthorId), 'h', 'h', false);

    // Now patch.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/teams/${id}`,
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: { description: 'updated via patch' },
    });

    const update = readMostRecentEvent(syncGroupId, 'resource_updated');
    // Bump origin_ts so last-writer-wins picks the update over the initial publish.
    const rewritten = rewriteAsRemoteEvent(update, REMOTE_INSTANCE, peerAuthorId);
    const remoteUpdate: HiveEvent = {
      ...rewritten,
      origin_ts: Date.now() + 86_400_000,
    };
    materializeEvent(remoteUpdate, 'h', 'h', false);

    const payload = JSON.parse(publish.payload) as { resource_id: string };
    const remote = getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, payload.resource_id);
    const full = findResourceById(remote!.id);
    expect(full!.description).toBe('updated via patch');
  });

  it('DELETE → captured unpublish event → remote row removed', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: { Authorization: `Bearer ${agent.apiKey}` },
      payload: { name: 'del-team', content: SAMPLE_TEAM, visibility: 'public' },
    });
    const id = JSON.parse(create.body).team_template.id;
    const publish = readMostRecentEvent(syncGroupId, 'resource_published');
    materializeEvent(rewriteAsRemoteEvent(publish, REMOTE_INSTANCE, peerAuthorId), 'h', 'h', false);

    const payload = JSON.parse(publish.payload) as { resource_id: string };
    expect(getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, payload.resource_id))
      .not.toBeNull();

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${id}`,
      headers: { Authorization: `Bearer ${agent.apiKey}` },
    });
    const unpub = readMostRecentEvent(syncGroupId, 'resource_unpublished');
    materializeEvent(rewriteAsRemoteEvent(unpub, REMOTE_INSTANCE, peerAuthorId), 'h', 'h', false);

    expect(getMaterializerRepo().findResourceByOrigin(REMOTE_INSTANCE, payload.resource_id))
      .toBeFalsy();
  });
});
