/**
 * E2E: full repo REST + federation flow story.
 *
 * Steps through the user-visible lifecycle as a single narrative against a
 * real Fastify instance with the repos routes mounted. Asserts at every
 * transition that the trio of state moves coherently:
 *   1. DB state (status, metadata.visibility, etc.)
 *   2. Federation event log (resource_published / _redacted / _archived / _merged)
 *   3. Realtime broadcasts on map:repos + map:repo:<id>
 *
 * Pairs with `repos-routes.test.ts` (per-endpoint cases) — this test
 * exercises the multi-step continuity that per-endpoint tests can't catch.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as syncGroupsDAL from '../../db/dal/sync-groups.js';
import * as syncEventsDAL from '../../db/dal/sync-events.js';
import { reposRoutes } from '../../api/routes/repos.js';
import { ConfigSchema, type Config } from '../../config.js';
import { broadcastToChannel } from '../../realtime/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const mockBroadcast = vi.mocked(broadcastToChannel);

const TEST_ROOT = testRoot('repo-rest-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'repo-rest-e2e.db');

const REMOTE_URL_A = 'https://github.com/openhive-org/repo-rest-e2e-a';
const REMOTE_URL_B = 'https://github.com/openhive-org/repo-rest-e2e-b';

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function makeApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => { await api.register(reposRoutes, { config }); },
    { prefix: '/api/v1' },
  );
  return app;
}

function authHeader(apiKey: string): { Authorization: string } {
  return { Authorization: `Bearer ${apiKey}` };
}

interface BroadcastCall {
  channel: string;
  type: string;
  data: Record<string, unknown>;
}

function getBroadcasts(): BroadcastCall[] {
  return mockBroadcast.mock.calls.map((c) => ({
    channel: c[0] as string,
    type: (c[1] as { type: string }).type,
    data: (c[1] as { data: Record<string, unknown> }).data ?? {},
  }));
}

/**
 * Returns events in chronological (insertion) order. listEvents itself
 * orders by seq DESC; we reverse so assertions read like a story.
 */
function eventTypes(syncGroupId: string): string[] {
  return syncEventsDAL.listEvents(syncGroupId).map((e) => e.event_type).reverse();
}

describe('E2E: repo REST full lifecycle story', () => {
  let app: FastifyInstance;
  let owner: { id: string; apiKey: string };
  let syncGroupId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());

    const { agent, apiKey } = await agentsDAL.createAgent({ name: 'rest-e2e-owner' });
    owner = { id: agent.id, apiKey };

    const hive = hivesDAL.createHive({ name: 'rest-e2e-hive', description: '', owner_id: owner.id });
    const sg = syncGroupsDAL.createSyncGroup(hive.id, 'sync:rest-e2e', 'inst_local');
    syncGroupId = sg.id;
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare(`DELETE FROM syncable_resources WHERE resource_type = 'repo'`).run();
    db.prepare('DELETE FROM hive_events').run();
    mockBroadcast.mockClear();
  });

  it('full flow: register federated → list → patch metadata → downgrade → re-promote → archive → unarchive', async () => {
    // ── 1. Register a federated repo ───────────────────────────────────────
    const create = await app.inject({
      method: 'POST', url: '/api/v1/repos',
      headers: authHeader(owner.apiKey),
      payload: {
        remote_url: REMOTE_URL_A,
        default_branch: 'main',
        description: 'first revision',
        visibility: 'federated',
      },
    });
    expect(create.statusCode).toBe(201);
    const repo = create.json().repo;
    expect(repo.status).toBe('active');
    expect(repo.metadata.visibility).toBe('federated');

    // Federation: published event landed on the sync group.
    expect(eventTypes(syncGroupId)).toEqual(['resource_published']);

    // ── 2. List filters work ───────────────────────────────────────────────
    const fedList = await app.inject({
      method: 'GET', url: '/api/v1/repos?visibility=federated',
      headers: authHeader(owner.apiKey),
    });
    expect(fedList.json().total).toBe(1);
    expect(fedList.json().data[0].id).toBe(repo.id);

    const localList = await app.inject({
      method: 'GET', url: '/api/v1/repos?visibility=hub_local',
      headers: authHeader(owner.apiKey),
    });
    expect(localList.json().total).toBe(0);

    // ── 3. Patch federated metadata (description) ─────────────────────────
    mockBroadcast.mockClear();
    const editPayload = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(owner.apiKey),
      payload: { description: 'second revision' },
    });
    expect(editPayload.statusCode).toBe(200);
    expect(editPayload.json().repo.description).toBe('second revision');

    // Federation: metadata-only update on a federated repo emits
    // resource_updated (not _published) so peers refresh the row.
    expect(eventTypes(syncGroupId)).toEqual(['resource_published', 'resource_updated']);
    // No realtime visibility change, so no repo_visibility_changed broadcast.
    expect(getBroadcasts().filter((b) => b.type === 'repo_visibility_changed')).toHaveLength(0);

    // ── 4. Downgrade visibility federated → hub_local ─────────────────────
    mockBroadcast.mockClear();
    const downgrade = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(owner.apiKey),
      payload: { visibility: 'hub_local' },
    });
    expect(downgrade.statusCode).toBe(200);
    expect(downgrade.json().repo.metadata.visibility).toBe('hub_local');

    // Federation: redaction event is what peers act on.
    expect(eventTypes(syncGroupId)).toEqual(['resource_published', 'resource_updated', 'resource_redacted']);

    // Realtime: visibility change broadcast on both fan-out channels.
    const visBroadcasts = getBroadcasts().filter((b) => b.type === 'repo_visibility_changed');
    expect(visBroadcasts.map((b) => b.channel).sort()).toEqual(
      ['map:repo:' + repo.id, 'map:repos'].sort(),
    );

    // ── 5. Re-promote hub_local → federated ───────────────────────────────
    mockBroadcast.mockClear();
    const repromote = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(owner.apiKey),
      payload: { visibility: 'federated' },
    });
    expect(repromote.statusCode).toBe(200);

    // Federation: a fresh resource_published event (not _redacted).
    expect(eventTypes(syncGroupId)).toEqual([
      'resource_published',
      'resource_updated',
      'resource_redacted',
      'resource_published',
    ]);

    // ── 6. Archive ────────────────────────────────────────────────────────
    mockBroadcast.mockClear();
    const archived = await app.inject({
      method: 'POST', url: `/api/v1/repos/${repo.id}/archive`,
      headers: authHeader(owner.apiKey),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().repo.status).toBe('archived');

    // Federation: archived event recorded (because repo is federated).
    expect(eventTypes(syncGroupId)).toContain('resource_archived');

    // Realtime: repo_archived broadcast on both channels.
    const archBroadcasts = getBroadcasts().filter((b) => b.type === 'repo_archived');
    expect(archBroadcasts.map((b) => b.channel).sort()).toEqual(
      ['map:repo:' + repo.id, 'map:repos'].sort(),
    );

    // Default list (status=active) should hide archived repos.
    const activeList = await app.inject({
      method: 'GET', url: '/api/v1/repos?status=active',
      headers: authHeader(owner.apiKey),
    });
    expect(activeList.json().total).toBe(0);

    const archivedList = await app.inject({
      method: 'GET', url: '/api/v1/repos?status=archived',
      headers: authHeader(owner.apiKey),
    });
    expect(archivedList.json().total).toBe(1);

    // ── 7. Unarchive ──────────────────────────────────────────────────────
    const unarchived = await app.inject({
      method: 'POST', url: `/api/v1/repos/${repo.id}/unarchive`,
      headers: authHeader(owner.apiKey),
    });
    expect(unarchived.statusCode).toBe(200);
    expect(unarchived.json().repo.status).toBe('active');
  });

  it('merge flow: source becomes forwarding tombstone, target untouched, federation event records canonical pointer', async () => {
    // Two federated repos
    const a = (await app.inject({
      method: 'POST', url: '/api/v1/repos',
      headers: authHeader(owner.apiKey),
      payload: { remote_url: REMOTE_URL_A, visibility: 'federated' },
    })).json().repo;
    const b = (await app.inject({
      method: 'POST', url: '/api/v1/repos',
      headers: authHeader(owner.apiKey),
      payload: { remote_url: REMOTE_URL_B, visibility: 'federated' },
    })).json().repo;

    expect(eventTypes(syncGroupId).filter((t) => t === 'resource_published')).toHaveLength(2);

    // Merge a → b (a is the duplicate)
    const merged = await app.inject({
      method: 'POST', url: `/api/v1/repos/${a.id}/merge`,
      headers: authHeader(owner.apiKey),
      payload: { into: b.id },
    });
    expect(merged.statusCode).toBe(200);
    const body = merged.json();
    expect(body.source.status).toBe('merged_into');
    expect(body.source.metadata.merged_into_canonical_url).toBe(b.git_remote_url);
    // Target row is unchanged
    expect(body.target.status).toBe('active');
    expect(body.target.id).toBe(b.id);

    // Federation: merge event records the source→target pointer.
    const mergeEvents = syncEventsDAL.listEvents(syncGroupId)
      .filter((e) => e.event_type === 'resource_merged');
    expect(mergeEvents).toHaveLength(1);
    const payload = JSON.parse(mergeEvents[0].payload as string);
    expect(payload.source_canonical_url).toBe(a.git_remote_url);
    expect(payload.target_canonical_url).toBe(b.git_remote_url);

    // Subsequent /repos list with default status=active should hide the source
    // (it's now merged_into) but still show the target.
    const list = await app.inject({
      method: 'GET', url: '/api/v1/repos?status=active',
      headers: authHeader(owner.apiKey),
    });
    expect(list.json().data.map((r: { id: string }) => r.id)).toEqual([b.id]);

    // The source row is still readable for tombstone-resolution.
    const sourceGet = await app.inject({
      method: 'GET', url: `/api/v1/repos/${a.id}`,
      headers: authHeader(owner.apiKey),
    });
    expect(sourceGet.statusCode).toBe(200);
    expect(sourceGet.json().repo.status).toBe('merged_into');
  });
});
