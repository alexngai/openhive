/**
 * Slice 5a — repo federation through the existing mesh sync materializer.
 *
 * Verifies the producer + consumer halves end-to-end:
 *   Producer:
 *     - `onRepoPublished` skips silently for `'private' | 'hub_local'` repos
 *     - `onRepoPublished` records a `resource_published` sync event for
 *       `'federated'` repos with `resource_type: 'repo'` and column-level
 *       `visibility: 'shared'` (federation tier rides in metadata)
 *     - `onRepoUpdated` records `resource_updated` only for federated repos
 *   Consumer (materializer):
 *     - A `resource_published` event with `resource_type: 'repo'` is
 *       materialized into `syncable_resources` with metadata.visibility
 *       preserved (CHECK constraint on the visibility column is satisfied
 *       by the wire-level 'shared')
 *     - A `resource_updated` event refreshes name/description/metadata on
 *       the materialized row (last-writer-wins by ts)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as syncGroupsDAL from '../../db/dal/sync-groups.js';
import * as syncEventsDAL from '../../db/dal/sync-events.js';
import * as repos from '../../db/dal/repos.js';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { onRepoPublished, onRepoUpdated } from '../../sync/resource-hooks.js';
import { materializeEvent } from '../../sync/materializer.js';
import type { HiveEvent } from '../../sync/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('repo-federation');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'repo-federation.db');

const REMOTE_INSTANCE = 'inst_peer_hub';
const LOCAL_INSTANCE = 'inst_local_hub';

describe('Slice 5a — repo federation', () => {
  let ownerId: string;
  let hiveId: string;
  let syncGroupId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'repo-fed-owner',
      description: 'Owner for repo federation tests',
    });
    ownerId = agent.id;

    const hive = hivesDAL.createHive({
      name: 'repo-fed-hive',
      description: 'Hive for repo federation tests',
      owner_id: ownerId,
    });
    hiveId = hive.id;

    const syncGroup = syncGroupsDAL.createSyncGroup(hiveId, 'sync:repo-fed', LOCAL_INSTANCE);
    syncGroupId = syncGroup.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare(`DELETE FROM syncable_resources WHERE resource_type = 'repo'`).run();
    db.prepare('DELETE FROM hive_events').run();
  });

  // ── Producer side ──────────────────────────────────────────────────────────

  it('onRepoPublished skips for hub_local repos (no event recorded)', () => {
    const identity = canonicalizeRepoUrl('https://github.com/org/local-repo');
    const repo = repos.upsertRepoByCanonicalUrl(identity, {
      origin: 'agent_declared',
      visibility: 'hub_local',
      owner_agent_id: ownerId,
    });

    onRepoPublished(repo);

    const events = syncEventsDAL.listEvents(syncGroupId);
    expect(events).toHaveLength(0);
  });

  it('onRepoPublished records resource_published for federated repos', () => {
    const identity = canonicalizeRepoUrl('https://github.com/org/federated-repo');
    const repo = repos.upsertRepoByCanonicalUrl(identity, {
      origin: 'user_defined',
      visibility: 'federated',
      owner_agent_id: ownerId,
      default_branch: 'main',
    });

    onRepoPublished(repo);

    const events = syncEventsDAL.listEvents(syncGroupId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('resource_published');

    const payload = JSON.parse(events[0].payload as string);
    expect(payload.resource_type).toBe('repo');
    expect(payload.git_remote_url).toBe('https://github.com/org/federated-repo');
    // Column-level visibility is 'shared' (CHECK domain); federation tier
    // lives in metadata.visibility.
    expect(payload.visibility).toBe('shared');
    expect(payload.metadata.visibility).toBe('federated');
    expect(payload.metadata.default_branch).toBe('main');
  });

  it('onRepoUpdated records resource_updated for federated repos', () => {
    const identity = canonicalizeRepoUrl('https://github.com/org/updated-repo');
    const repo = repos.upsertRepoByCanonicalUrl(identity, {
      origin: 'user_defined',
      visibility: 'federated',
      owner_agent_id: ownerId,
    });

    onRepoUpdated(repo);

    const events = syncEventsDAL.listEvents(syncGroupId);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('resource_updated');

    const payload = JSON.parse(events[0].payload as string);
    expect(payload.resource_id).toBe(repo.id);
    expect(payload.fields.metadata.visibility).toBe('federated');
  });

  // ── Consumer side (materializer round-trip) ────────────────────────────────

  it('peer materializes a federated repo resource_published event', () => {
    // Simulate event arriving from peer hub
    const remoteResourceId = 'repo_peer_001';
    const eventPayload = {
      resource_id: remoteResourceId,
      resource_type: 'repo' as const,
      name: 'peer-repo',
      description: null,
      git_remote_url: 'https://github.com/peer/widget',
      visibility: 'shared' as const,
      owner: {
        instance_id: REMOTE_INSTANCE,
        // Use the local agent id as wire owner — the existing materializer
        // uses author.agent_id directly as owner_agent_id (FK to local agents),
        // so cross-hub federation requires shared agent ids today. See
        // resource-sync.test.ts for the same pattern.
        agent_id: ownerId,
        name: 'peer-owner',
        avatar_url: null,
      },
      tags: [],
      metadata: {
        name: 'widget',
        origin: 'user_defined',
        visibility: 'federated',
        default_branch: 'main',
      },
    };

    const event: HiveEvent = {
      id: `evt_${Date.now()}`,
      sync_group_id: syncGroupId,
      seq: 1,
      event_type: 'resource_published',
      origin_instance_id: REMOTE_INSTANCE,
      origin_ts: Date.now(),
      payload: JSON.stringify(eventPayload),
      signature: 'unverified',
      received_at: new Date().toISOString(),
      is_local: 0,
    };

    materializeEvent(event, hiveId, 'repo-fed-hive', false);

    // The peer's repo now exists locally with metadata intact.
    const local = repos.findRepoByCanonicalUrl('https://github.com/peer/widget');
    expect(local).not.toBeNull();
    expect(local!.metadata).toMatchObject({
      origin: 'user_defined',
      visibility: 'federated',
      default_branch: 'main',
    });
    // Column-level visibility was 'shared' (wire) — written through CHECK.
    expect(local!.visibility).toBe('shared');
  });

  it('peer materializes a resource_updated event refreshing repo metadata', () => {
    // Seed a federated repo from a prior `published` event.
    // Update event must have origin_ts >= published row's updated_at (which
    // SQL `datetime('now')` floors to seconds), so we space the synthetic
    // timestamps comfortably across that boundary.
    const baseTs = Date.now();
    const eventBase = (seqOffset: number, eventType: string, payload: object): HiveEvent => ({
      id: `evt_${seqOffset}_${baseTs}`,
      sync_group_id: syncGroupId,
      seq: seqOffset + 1,
      event_type: eventType as HiveEvent['event_type'],
      origin_instance_id: REMOTE_INSTANCE,
      // The materializer's last-writer-wins check parses the row's SQL
      // `datetime('now')` updated_at via JS `new Date(...)` which treats
      // the timezone-less text as local time. On a host in UTC-N this
      // shifts existing_ts +Nh into the future. Use a 24h gap so the
      // synthetic update event's origin_ts comfortably exceeds any TZ
      // offset (max realistic offset is 14h).
      origin_ts: baseTs + seqOffset * 86_400_000,
      payload: JSON.stringify(payload),
      signature: 'unverified',
      received_at: new Date().toISOString(),
      is_local: 0,
    });

    materializeEvent(
      eventBase(0, 'resource_published', {
        resource_id: 'repo_peer_002',
        resource_type: 'repo',
        name: 'gadget-v1',
        description: null,
        git_remote_url: 'https://github.com/peer/gadget',
        visibility: 'shared',
        owner: { instance_id: REMOTE_INSTANCE, agent_id: ownerId, name: 'p', avatar_url: null },
        tags: [],
        metadata: { name: 'gadget', origin: 'user_defined', visibility: 'federated' },
      }),
      hiveId, 'repo-fed-hive', false,
    );

    // Apply a metadata update (e.g., default_branch added)
    materializeEvent(
      eventBase(1, 'resource_updated', {
        resource_id: 'repo_peer_002',
        fields: {
          name: 'gadget-v2',
          metadata: {
            name: 'gadget',
            origin: 'user_defined',
            visibility: 'federated',
            default_branch: 'develop',
          },
        },
        updated_by: { instance_id: REMOTE_INSTANCE, agent_id: ownerId, name: 'p', avatar_url: null },
      }),
      hiveId, 'repo-fed-hive', false,
    );

    const local = repos.findRepoByCanonicalUrl('https://github.com/peer/gadget')!;
    expect(local.name).toBe('gadget-v2');
    expect(local.metadata).toMatchObject({ default_branch: 'develop' });
  });
});
