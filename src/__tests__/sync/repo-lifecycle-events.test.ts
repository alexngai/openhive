/**
 * Slice 5b — `RESOURCE_MESH_EVENTS` receivers (redacted / archived / merged).
 *
 * Verifies the materializer correctly handles the three new mesh lifecycle
 * events. Resources are looked up by `(resource_type, canonical_url)` —
 * unlike `resource_published` events which key on origin id, lifecycle
 * events propagate across hubs the receiver may have learned about from
 * a different origin (or via gossip).
 *
 * Coverage:
 *   - resource_redacted → status='redacted_remote', metadata.visibility patched
 *   - resource_archived → status='archived', metadata.archived_at recorded
 *   - resource_merged   → status='merged_into', metadata.merged_into_canonical_url
 *   - Lookup misses (no local row for the canonical_url) are silent no-ops
 *   - Producer hooks (onRepoRedacted/Archived/Merged) gate on visibility
 *     and emit events with the right shape
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as syncGroupsDAL from '../../db/dal/sync-groups.js';
import * as syncEventsDAL from '../../db/dal/sync-events.js';
import * as repos from '../../db/dal/repos.js';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { onRepoRedacted, onRepoArchived, onRepoMerged } from '../../sync/resource-hooks.js';
import { materializeEvent } from '../../sync/materializer.js';
import type { HiveEvent } from '../../sync/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));
import { broadcastToChannel } from '../../realtime/index.js';
const mockBroadcast = vi.mocked(broadcastToChannel);

const TEST_ROOT = testRoot('repo-lifecycle');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'repo-lifecycle.db');

const REMOTE_INSTANCE = 'inst_peer_hub';
const LOCAL_INSTANCE = 'inst_local_hub';

describe('Slice 5b — repo lifecycle events', () => {
  let ownerId: string;
  let hiveId: string;
  let syncGroupId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'lifecycle-owner',
      description: 'Owner for lifecycle event tests',
    });
    ownerId = agent.id;

    const hive = hivesDAL.createHive({
      name: 'lifecycle-hive',
      description: 'Hive for lifecycle event tests',
      owner_id: ownerId,
    });
    hiveId = hive.id;

    const syncGroup = syncGroupsDAL.createSyncGroup(hiveId, 'sync:lifecycle', LOCAL_INSTANCE);
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
    mockBroadcast.mockClear();
  });

  function makeLifecycleEvent(eventType: string, payload: object): HiveEvent {
    return {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sync_group_id: syncGroupId,
      seq: 1,
      event_type: eventType as HiveEvent['event_type'],
      origin_instance_id: REMOTE_INSTANCE,
      origin_ts: Date.now(),
      payload: JSON.stringify(payload),
      signature: 'unverified',
      received_at: new Date().toISOString(),
      is_local: 0,
    };
  }

  function seedFederatedRepo(canonicalUrl: string) {
    const identity = canonicalizeRepoUrl(canonicalUrl);
    return repos.upsertRepoByCanonicalUrl(identity, {
      origin: 'user_defined',
      visibility: 'federated',
      owner_agent_id: ownerId,
    });
  }

  // ── Receiver-side ──────────────────────────────────────────────────────────

  it('resource_redacted marks status=redacted_remote and patches metadata.visibility', () => {
    const url = 'https://github.com/peer/redact-me';
    seedFederatedRepo(url);

    materializeEvent(
      makeLifecycleEvent('resource_redacted', {
        resource_type: 'repo',
        canonical_url: url,
        new_visibility: 'hub_local',
        redacted_at: '2026-05-06T12:00:00Z',
        origin_hub_id: REMOTE_INSTANCE,
      }),
      hiveId, 'lifecycle-hive', false,
    );

    const db = getDatabase();
    const row = db.prepare(
      `SELECT status, metadata FROM syncable_resources WHERE resource_type = 'repo' AND git_remote_url = ?`,
    ).get(url) as { status: string; metadata: string };
    expect(row.status).toBe('redacted_remote');
    const meta = JSON.parse(row.metadata);
    expect(meta.visibility).toBe('hub_local');
    expect(meta.redacted_at).toBe('2026-05-06T12:00:00Z');
    expect(meta.redacted_by).toBe(REMOTE_INSTANCE);

    const redactCalls = mockBroadcast.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'resource_redacted',
    );
    expect(redactCalls).toHaveLength(1);
  });

  it('resource_archived marks status=archived and stamps archived_at', () => {
    const url = 'https://github.com/peer/archive-me';
    seedFederatedRepo(url);

    materializeEvent(
      makeLifecycleEvent('resource_archived', {
        resource_type: 'repo',
        canonical_url: url,
        archived_at: '2026-05-06T13:00:00Z',
        origin_hub_id: REMOTE_INSTANCE,
      }),
      hiveId, 'lifecycle-hive', false,
    );

    const db = getDatabase();
    const row = db.prepare(
      `SELECT status, metadata FROM syncable_resources WHERE resource_type = 'repo' AND git_remote_url = ?`,
    ).get(url) as { status: string; metadata: string };
    expect(row.status).toBe('archived');
    const meta = JSON.parse(row.metadata);
    expect(meta.archived_at).toBe('2026-05-06T13:00:00Z');
    expect(meta.archived_by).toBe(REMOTE_INSTANCE);
  });

  it('resource_merged marks status=merged_into and records the forwarding pointer', () => {
    const sourceUrl = 'https://github.com/peer/source-repo';
    const targetUrl = 'https://github.com/peer/target-repo';
    seedFederatedRepo(sourceUrl);
    seedFederatedRepo(targetUrl);

    materializeEvent(
      makeLifecycleEvent('resource_merged', {
        resource_type: 'repo',
        source_canonical_url: sourceUrl,
        target_canonical_url: targetUrl,
        merged_at: '2026-05-06T14:00:00Z',
        origin_hub_id: REMOTE_INSTANCE,
      }),
      hiveId, 'lifecycle-hive', false,
    );

    const source = repos.findRepoByCanonicalUrl(sourceUrl)!;
    const db = getDatabase();
    const row = db.prepare(
      `SELECT status, metadata FROM syncable_resources WHERE id = ?`,
    ).get(source.id) as { status: string; metadata: string };
    expect(row.status).toBe('merged_into');
    const meta = JSON.parse(row.metadata);
    expect(meta.merged_into_canonical_url).toBe(targetUrl);
    expect(meta.merged_at).toBe('2026-05-06T14:00:00Z');

    // Target row is unchanged
    const target = repos.findRepoByCanonicalUrl(targetUrl)!;
    expect(target.metadata).not.toMatchObject({ merged_into_canonical_url: expect.anything() });
  });

  it('lifecycle event for unknown canonical_url is a silent no-op', () => {
    materializeEvent(
      makeLifecycleEvent('resource_archived', {
        resource_type: 'repo',
        canonical_url: 'https://github.com/peer/never-seen',
        archived_at: '2026-05-06T15:00:00Z',
        origin_hub_id: REMOTE_INSTANCE,
      }),
      hiveId, 'lifecycle-hive', false,
    );

    expect(repos.listRepos()).toHaveLength(0);
    const archivedCalls = mockBroadcast.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'resource_archived',
    );
    expect(archivedCalls).toHaveLength(0);
  });

  // ── Producer-side ──────────────────────────────────────────────────────────

  it('onRepoRedacted skips when oldVisibility was not federated', () => {
    const url = 'https://github.com/local/never-federated';
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl(url), {
      origin: 'agent_declared',
      visibility: 'hub_local',
      owner_agent_id: ownerId,
    });

    onRepoRedacted(repo, 'hub_local', 'private');

    const events = syncEventsDAL.listEvents(syncGroupId);
    expect(events.filter((e) => e.event_type === 'resource_redacted')).toHaveLength(0);
  });

  it('onRepoRedacted records resource_redacted for federated→hub_local transitions', () => {
    const url = 'https://github.com/local/redacting';
    const repo = seedFederatedRepo(url);

    onRepoRedacted(repo, 'federated', 'hub_local');

    const events = syncEventsDAL.listEvents(syncGroupId)
      .filter((e) => e.event_type === 'resource_redacted');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload as string);
    expect(payload.resource_type).toBe('repo');
    expect(payload.canonical_url).toBe(url);
    expect(payload.new_visibility).toBe('hub_local');
    expect(payload.origin_hub_id).toBeTruthy();
  });

  it('onRepoArchived records resource_archived only for federated repos', () => {
    const url = 'https://github.com/local/archiving';
    const repo = seedFederatedRepo(url);

    onRepoArchived(repo);

    const events = syncEventsDAL.listEvents(syncGroupId)
      .filter((e) => e.event_type === 'resource_archived');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload as string);
    expect(payload.canonical_url).toBe(url);
  });

  it('onRepoMerged records resource_merged with the forwarding pointer', () => {
    const source = seedFederatedRepo('https://github.com/local/source');
    const targetUrl = 'https://github.com/local/target';

    onRepoMerged(source, targetUrl);

    const events = syncEventsDAL.listEvents(syncGroupId)
      .filter((e) => e.event_type === 'resource_merged');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload as string);
    expect(payload.source_canonical_url).toBe('https://github.com/local/source');
    expect(payload.target_canonical_url).toBe(targetUrl);
  });

  // ── was_ever_federated: redacted-then-archived/merged ────────────────────
  // Once a repo was federated, peers retain a tombstone. Subsequent archive
  // or merge events MUST still fire so peers can update their tombstones,
  // even if the local visibility has since narrowed to hub_local/private.

  it('onRepoArchived fires for a previously-federated repo that was redacted', () => {
    // Create as federated, then locally redact (simulate prior PATCH +
    // metadata patch that downgraded + stamped redacted_at).
    const repo = seedFederatedRepo('https://github.com/local/redacted-archive');
    const meta = (repo.metadata ?? {}) as Record<string, unknown>;
    meta.visibility = 'hub_local';
    meta.redacted_at = '2026-05-06T10:00:00Z';
    getDatabase().prepare(
      `UPDATE syncable_resources SET metadata = ? WHERE id = ?`,
    ).run(JSON.stringify(meta), repo.id);

    const refreshed = repos.findRepoById(repo.id)!;
    onRepoArchived(refreshed);

    const events = syncEventsDAL.listEvents(syncGroupId)
      .filter((e) => e.event_type === 'resource_archived');
    expect(events).toHaveLength(1);
  });

  it('onRepoMerged fires for a previously-federated repo that was redacted', () => {
    const repo = seedFederatedRepo('https://github.com/local/redacted-merge');
    const meta = (repo.metadata ?? {}) as Record<string, unknown>;
    meta.visibility = 'hub_local';
    meta.redacted_at = '2026-05-06T10:00:00Z';
    getDatabase().prepare(
      `UPDATE syncable_resources SET metadata = ? WHERE id = ?`,
    ).run(JSON.stringify(meta), repo.id);

    const refreshed = repos.findRepoById(repo.id)!;
    onRepoMerged(refreshed, 'https://github.com/local/target-after-redact');

    const events = syncEventsDAL.listEvents(syncGroupId)
      .filter((e) => e.event_type === 'resource_merged');
    expect(events).toHaveLength(1);
  });

  it('onRepoArchived still skips repos that were never federated', () => {
    // Sanity: gating on "ever federated" should not relax to firing on
    // private-only repos.
    const url = 'https://github.com/local/always-private';
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl(url), {
      origin: 'agent_declared',
      visibility: 'private',
      owner_agent_id: ownerId,
    });

    onRepoArchived(repo);

    const events = syncEventsDAL.listEvents(syncGroupId)
      .filter((e) => e.event_type === 'resource_archived');
    expect(events).toHaveLength(0);
  });

  // ── Receiver canonicalization (CRITICAL guard) ───────────────────────────
  // Producer + receiver must agree on canonical URL even if a peer ships a
  // non-canonical form (e.g. with `.git` suffix, mixed case, trailing slash).

  it('materializeResourcePublished re-canonicalizes the URL on the receiver for repos', () => {
    const denormalizedUrl = 'git@github.com:Peer/Skewed.git'; // mixed case + .git
    const expectedCanonical = canonicalizeRepoUrl(denormalizedUrl).canonicalUrl;

    materializeEvent(
      {
        id: `evt_canon_${Date.now()}`,
        sync_group_id: syncGroupId,
        seq: 99,
        event_type: 'resource_published',
        origin_instance_id: REMOTE_INSTANCE,
        origin_ts: Date.now(),
        payload: JSON.stringify({
          resource_id: 'rr_peer_skewed',
          resource_type: 'repo',
          name: 'skewed',
          description: null,
          git_remote_url: denormalizedUrl,
          visibility: 'shared',
          owner: { instance_id: REMOTE_INSTANCE, agent_id: ownerId, name: 'p', avatar_url: null },
          tags: [],
          metadata: { name: 'skewed', origin: 'user_defined', visibility: 'federated' },
        }),
        signature: 'unverified',
        received_at: new Date().toISOString(),
        is_local: 0,
      } as HiveEvent,
      hiveId, 'lifecycle-hive', false,
    );

    // Local row is stored with the canonical URL, not the wire form.
    const row = repos.findRepoByCanonicalUrl(expectedCanonical);
    expect(row).not.toBeNull();
    expect(row!.git_remote_url).toBe(expectedCanonical);

    // A subsequent lifecycle event keyed on the canonical URL hits the row.
    materializeEvent(
      makeLifecycleEvent('resource_archived', {
        resource_type: 'repo',
        canonical_url: expectedCanonical,
        archived_at: '2026-05-06T16:00:00Z',
        origin_hub_id: REMOTE_INSTANCE,
      }),
      hiveId, 'lifecycle-hive', false,
    );

    const db = getDatabase();
    const after = db.prepare(`SELECT status FROM syncable_resources WHERE id = ?`).get(row!.id) as { status: string };
    expect(after.status).toBe('archived');
  });
});
