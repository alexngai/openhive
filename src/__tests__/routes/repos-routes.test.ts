/**
 * Slice 4 — Repo REST routes.
 *
 * Covers:
 *   GET    /repos                  — list with filters
 *   POST   /repos                  — user_defined creation, fires onRepoPublished if federated
 *   GET    /repos/:id              — visibility-scoped read
 *   PATCH  /repos/:id              — visibility transitions fire the right hook
 *   POST   /repos/:id/archive      — fires onRepoArchived
 *   POST   /repos/:id/unarchive
 *   GET    /repos/:id/workspaces   — active bindings
 *   POST   /repos/:source_id/merge — fires onRepoMerged
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
import * as repos from '../../db/dal/repos.js';
import { broadcastToChannel } from '../../realtime/index.js';
import { canonicalizeRepoUrl } from 'agent-workspace/kinds/repo';
import { reposRoutes } from '../../api/routes/repos.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('repos-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'repos-routes.db');

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

const mockBroadcast = vi.mocked(broadcastToChannel);

describe('Repos REST routes', () => {
  let app: FastifyInstance;
  let owner: { id: string; apiKey: string };
  let other: { id: string; apiKey: string };
  let admin: { id: string; apiKey: string };
  let syncGroupId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());

    const a = await agentsDAL.createAgent({ name: 'owner' });
    owner = { id: a.agent.id, apiKey: a.apiKey };
    const b = await agentsDAL.createAgent({ name: 'other' });
    other = { id: b.agent.id, apiKey: b.apiKey };
    const c = await agentsDAL.createAgent({ name: 'site-admin', is_admin: true });
    admin = { id: c.agent.id, apiKey: c.apiKey };

    // Sync group for federation hooks to record events into.
    const hive = hivesDAL.createHive({ name: 'route-hive', description: 't', owner_id: owner.id });
    const sg = syncGroupsDAL.createSyncGroup(hive.id, 'sync:route', 'inst_local');
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

  // ── POST /repos ──────────────────────────────────────────────────────────

  it('POST /repos canonicalizes and persists, fires onRepoPublished only when federated', async () => {
    const res1 = await app.inject({
      method: 'POST', url: '/api/v1/repos',
      headers: authHeader(owner.apiKey),
      payload: {
        remote_url: 'git@github.com:Foo/Bar.git',  // canonicalize → https://github.com/foo/bar
        default_branch: 'main',
        visibility: 'hub_local',
      },
    });
    expect(res1.statusCode).toBe(201);
    const body1 = res1.json();
    expect(body1.repo.git_remote_url).toBe('https://github.com/foo/bar');
    expect(body1.repo.metadata.visibility).toBe('hub_local');
    // Response should surface the status column the V51 migration added.
    expect(body1.repo.status).toBe('active');

    // hub_local = no federation event
    expect(syncEventsDAL.listEvents(syncGroupId).filter((e) => e.event_type === 'resource_published')).toHaveLength(0);

    const res2 = await app.inject({
      method: 'POST', url: '/api/v1/repos',
      headers: authHeader(owner.apiKey),
      payload: { remote_url: 'https://github.com/foo/baz', visibility: 'federated' },
    });
    expect(res2.statusCode).toBe(201);

    // federated = published event recorded
    expect(syncEventsDAL.listEvents(syncGroupId).filter((e) => e.event_type === 'resource_published')).toHaveLength(1);
  });

  it('POST /repos returns 409 on duplicate canonical URL', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/repos',
      headers: authHeader(owner.apiKey),
      payload: { remote_url: 'https://github.com/foo/dup', visibility: 'hub_local' },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/repos',
      headers: authHeader(owner.apiKey),
      payload: { remote_url: 'git@github.com:Foo/Dup.git', visibility: 'hub_local' },  // canonicalizes to same
    });
    expect(res.statusCode).toBe(409);
  });

  // ── GET /repos ───────────────────────────────────────────────────────────

  it('GET /repos hides private repos from non-owners', async () => {
    repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/private'), {
      origin: 'user_defined', visibility: 'private', owner_agent_id: owner.id,
    });
    repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/public'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });

    // Owner sees both
    const ownerRes = await app.inject({
      method: 'GET', url: '/api/v1/repos', headers: authHeader(owner.apiKey),
    });
    expect(ownerRes.json().total).toBe(2);

    // Other agent sees only the public one
    const otherRes = await app.inject({
      method: 'GET', url: '/api/v1/repos', headers: authHeader(other.apiKey),
    });
    expect(otherRes.json().total).toBe(1);
    expect(otherRes.json().data[0].git_remote_url).toBe('https://github.com/foo/public');
  });

  it('GET /repos honors origin + visibility filters', async () => {
    repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/u1'), {
      origin: 'user_defined', visibility: 'federated', owner_agent_id: owner.id,
    });
    repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/a1'), {
      origin: 'agent_declared', visibility: 'hub_local', owner_agent_id: owner.id,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/repos?origin=user_defined',
      headers: authHeader(owner.apiKey),
    });
    expect(res.json().total).toBe(1);
    expect(res.json().data[0].git_remote_url).toBe('https://github.com/foo/u1');
  });

  // ── PATCH /repos/:id (visibility transitions) ────────────────────────────

  it('PATCH /repos/:id federated → hub_local fires onRepoRedacted', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/redactme'), {
      origin: 'user_defined', visibility: 'federated', owner_agent_id: owner.id,
    });

    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(owner.apiKey),
      payload: { visibility: 'hub_local' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo.metadata.visibility).toBe('hub_local');

    const events = syncEventsDAL.listEvents(syncGroupId).filter((e) => e.event_type === 'resource_redacted');
    expect(events).toHaveLength(1);
  });

  it('PATCH /repos/:id hub_local → federated fires onRepoPublished', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/promoteme'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });

    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(owner.apiKey),
      payload: { visibility: 'federated' },
    });
    expect(res.statusCode).toBe(200);

    const events = syncEventsDAL.listEvents(syncGroupId).filter((e) => e.event_type === 'resource_published');
    expect(events).toHaveLength(1);
  });

  it('PATCH /repos/:id federated → federated metadata change fires onRepoUpdated', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/refresh'), {
      origin: 'user_defined', visibility: 'federated', owner_agent_id: owner.id,
    });

    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(owner.apiKey),
      payload: { default_branch: 'develop' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo.metadata.default_branch).toBe('develop');

    const events = syncEventsDAL.listEvents(syncGroupId).filter((e) => e.event_type === 'resource_updated');
    expect(events).toHaveLength(1);
  });

  it('PATCH /repos/:id 403s for non-owner', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/nope'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(other.apiKey),
      payload: { default_branch: 'main' },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Archive ──────────────────────────────────────────────────────────────

  it('POST /repos/:id/archive flips status, fires onRepoArchived for federated repos', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/archive'), {
      origin: 'user_defined', visibility: 'federated', owner_agent_id: owner.id,
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/repos/${repo.id}/archive`,
      headers: authHeader(owner.apiKey),
    });
    expect(res.statusCode).toBe(200);

    // Response body must surface status — protects against the cached
    // prepared-statement issue where SELECT * misses columns added in
    // a later ALTER TABLE if the backend wasn't restarted post-migration.
    expect(res.json().repo.status).toBe('archived');

    const db = getDatabase();
    const row = db.prepare(`SELECT status FROM syncable_resources WHERE id = ?`).get(repo.id) as { status: string };
    expect(row.status).toBe('archived');

    expect(syncEventsDAL.listEvents(syncGroupId).filter((e) => e.event_type === 'resource_archived')).toHaveLength(1);
  });

  it('POST /repos/:id/unarchive resets status to active', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/unarchive'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });
    getDatabase().prepare(`UPDATE syncable_resources SET status = 'archived' WHERE id = ?`).run(repo.id);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/repos/${repo.id}/unarchive`,
      headers: authHeader(owner.apiKey),
    });
    expect(res.statusCode).toBe(200);

    const row = getDatabase().prepare(`SELECT status FROM syncable_resources WHERE id = ?`).get(repo.id) as { status: string };
    expect(row.status).toBe('active');
  });

  // ── Merge ────────────────────────────────────────────────────────────────

  it('POST /repos/:source_id/merge marks source merged_into, fires onRepoMerged', async () => {
    const source = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/source'), {
      origin: 'user_defined', visibility: 'federated', owner_agent_id: owner.id,
    });
    const target = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/target'), {
      origin: 'user_defined', visibility: 'federated', owner_agent_id: owner.id,
    });

    const res = await app.inject({
      method: 'POST', url: `/api/v1/repos/${source.id}/merge`,
      headers: authHeader(owner.apiKey),
      payload: { into: target.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source.metadata.merged_into_canonical_url).toBe('https://github.com/foo/target');

    const row = getDatabase().prepare(`SELECT status FROM syncable_resources WHERE id = ?`).get(source.id) as { status: string };
    expect(row.status).toBe('merged_into');

    expect(syncEventsDAL.listEvents(syncGroupId).filter((e) => e.event_type === 'resource_merged')).toHaveLength(1);
  });

  it('POST /repos/:source_id/merge rejects self-merge', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/selfmerge'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/repos/${repo.id}/merge`,
      headers: authHeader(owner.apiKey),
      payload: { into: repo.id },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Existence-leak guard: 404 for non-owner private repos ───────────────

  it('PATCH on a private repo by non-owner returns 404 (not 403, to hide existence)', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/private'), {
      origin: 'user_defined', visibility: 'private', owner_agent_id: owner.id,
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(other.apiKey),
      payload: { default_branch: 'main' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('Archive on a private repo by non-owner returns 404', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/private-archive'), {
      origin: 'user_defined', visibility: 'private', owner_agent_id: owner.id,
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/repos/${repo.id}/archive`,
      headers: authHeader(other.apiKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH on a hub_local repo by non-owner still returns 403 (visible but unauthorized)', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/hub-only'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(other.apiKey),
      payload: { default_branch: 'main' },
    });
    expect(res.statusCode).toBe(403);
  });

  // ── Admin override ──────────────────────────────────────────────────────

  it('Admin can PATCH a repo owned by someone else', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/admin-override'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(admin.apiKey),
      payload: { description: 'admin edit' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo.description).toBe('admin edit');
  });

  it('Admin can archive a repo owned by someone else', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/admin-archive'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });
    const res = await app.inject({
      method: 'POST', url: `/api/v1/repos/${repo.id}/archive`,
      headers: authHeader(admin.apiKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo.status).toBe('archived');
  });

  it('Admin can see and edit a private repo they do not own', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/admin-private'), {
      origin: 'user_defined', visibility: 'private', owner_agent_id: owner.id,
    });
    const get = await app.inject({
      method: 'GET', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(admin.apiKey),
    });
    expect(get.statusCode).toBe(200);

    const patch = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(admin.apiKey),
      payload: { description: 'admin moderation' },
    });
    expect(patch.statusCode).toBe(200);
  });

  // ── repo_updated broadcast (UI invalidation) ────────────────────────────

  it('PATCH /repos/:id always broadcasts repo_updated to map:repos and map:repo:<id>', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/broadcast-test'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });
    mockBroadcast.mockClear();

    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/repos/${repo.id}`,
      headers: authHeader(owner.apiKey),
      payload: { description: 'just metadata' },
    });
    expect(res.statusCode).toBe(200);

    const updated = mockBroadcast.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'repo_updated',
    );
    // Fanned out to BOTH the fleet and per-repo channel.
    expect(updated.map((c) => c[0]).sort()).toEqual([`map:repo:${repo.id}`, 'map:repos'].sort());
  });

  it('Unarchive broadcasts repo_updated', async () => {
    const repo = repos.upsertRepoByCanonicalUrl(canonicalizeRepoUrl('https://github.com/foo/unarchive-broadcast'), {
      origin: 'user_defined', visibility: 'hub_local', owner_agent_id: owner.id,
    });
    getDatabase().prepare(`UPDATE syncable_resources SET status = 'archived' WHERE id = ?`).run(repo.id);
    mockBroadcast.mockClear();

    await app.inject({
      method: 'POST', url: `/api/v1/repos/${repo.id}/unarchive`,
      headers: authHeader(owner.apiKey),
    });

    const updated = mockBroadcast.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'repo_updated',
    );
    expect(updated).toHaveLength(2);
  });
});
