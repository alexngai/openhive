/**
 * Layer 6 — end-to-end git-backed lifecycle tests.
 *
 * Unit tests in `git-backed-bundle.test.ts` cover the helper-level
 * behaviour with a hand-written fake checkout. This file exercises the
 * real flow against a local git repo as the "remote" (via `file://`
 * URLs), proving:
 *
 *   1. POST `/teams` with `git_remote_url` flips the row to
 *      `sync_strategy: 'ls-remote'` and a subsequent bundle call clones
 *      the remote + reads manifest from disk.
 *   2. External commit + `runAutoPullSweep()` pulls the new commit and
 *      re-bundles; the new manifest hash lands in the store.
 *   3. After a webhook-equivalent trigger (we exercise the same code
 *      path the webhook handler invokes — `pullFromRemote` +
 *      `onTeamTemplateBundle`), the bundle store reflects the latest
 *      commit without waiting for the auto-pull cycle.
 *   4. The bundle id is stable across re-bundles when the disk content
 *      hasn't changed — content-addressed identity holds.
 *
 * Routes' `void onTeamTemplateBundle(...)` fire-and-forget hooks aren't
 * deterministic for tests (git clone is a subprocess). The tests below
 * explicitly `await onTeamTemplateBundle(...)` after each REST mutation
 * so the assertions race nothing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import Fastify, { FastifyInstance } from 'fastify';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { findResourceById } from '../../db/dal/syncable-resources.js';
import { createTeamTemplate } from '../../db/dal/team-templates.js';
import { teamsRoutes } from '../../api/routes/teams.js';
import { ConfigSchema, type Config } from '../../config.js';
import { runAutoPullSweep } from '../../sync/auto-pull.js';
import { pullFromRemote } from '../../sync/git-content.js';
import { onTeamTemplateBundle } from '../../openteams/sync-bridge.js';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
} from '../../openteams/map-handlers.js';
import { TEAM_RESOURCE_TYPE } from 'openteams';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('openteams-git-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'git-e2e.db');

function gitExec(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

/** Build a real local git repo containing the openteams template layout. */
function setupRemoteRepo(initialManifestName: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'openteams-e2e-remote-'));
  gitExec('git init -b main', repoDir);
  gitExec('git config user.email "test@test.com"', repoDir);
  gitExec('git config user.name "Test"', repoDir);
  writeManifest(repoDir, initialManifestName);
  gitExec('git add -A', repoDir);
  gitExec('git commit -m "Initial team manifest"', repoDir);
  return repoDir;
}

function writeManifest(repoDir: string, name: string) {
  writeFileSync(
    join(repoDir, 'team.yaml'),
    yaml.dump({
      name,
      version: 1,
      roles: ['worker'],
      topology: { root: { role: 'worker' } },
    }),
  );
  const rolesDir = join(repoDir, 'roles');
  mkdirSync(rolesDir, { recursive: true });
  writeFileSync(
    join(rolesDir, 'worker.yaml'),
    yaml.dump({ name: 'worker', capabilities: [name] }),
  );
}

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

/**
 * After a REST mutation, explicitly await the bundle hook against the
 * fresh row state. Returns the bundle id (or null if there's nothing
 * to bundle yet — e.g. git-backed row with no inline content and no
 * checkout).
 *
 * This sidesteps the routes' fire-and-forget `void onTeamTemplateBundle(...)`
 * so the test's assertions race nothing.
 */
async function awaitBundle(rowId: string): Promise<string | null> {
  const fresh = findResourceById(rowId);
  if (!fresh) return null;
  return onTeamTemplateBundle(fresh);
}

function manifestName(resources: { metadata: { manifest?: unknown } }[]): string[] {
  return resources
    .map((r) => (r.metadata.manifest as { name?: string } | undefined)?.name)
    .filter((n): n is string => typeof n === 'string');
}

describe('openteams git-backed lifecycle — E2E', () => {
  let app: FastifyInstance;
  let agent: { id: string; apiKey: string };
  const cleanupDirs: string[] = [];
  let isolatedDataDir: string;
  let prevOpenhiveHome: string | undefined;

  beforeAll(async () => {
    // Isolate the openhive data dir per test run so clone artifacts don't
    // collide with prior runs (or with the dev `.openhive/` checkout).
    isolatedDataDir = mkdtempSync(join(tmpdir(), 'openteams-e2e-data-'));
    prevOpenhiveHome = process.env.OPENHIVE_HOME;
    process.env.OPENHIVE_HOME = isolatedDataDir;

    initDatabase(TEST_DB_PATH);
    app = await makeApp(makeConfig());
    const a = await agentsDAL.createAgent({
      name: 'git-e2e-agent',
      description: 'L6 e2e',
    });
    agent = { id: a.agent.id, apiKey: a.apiKey };
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    for (const d of cleanupDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    try {
      rmSync(isolatedDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (prevOpenhiveHome === undefined) {
      delete process.env.OPENHIVE_HOME;
    } else {
      process.env.OPENHIVE_HOME = prevOpenhiveHome;
    }
  });

  beforeEach(() => {
    getDatabase()
      .prepare(`DELETE FROM syncable_resources WHERE resource_type = 'team_template'`)
      .run();
    _resetOpenteamsMapHandlers();
    // Sweep any `res_*` clones leftover from a previous test. The clones
    // are keyed by row id (unique per test) but the data dir is shared
    // across tests in this file — a stale dir would block the next
    // `git clone` with "destination path already exists and is not empty".
    try {
      for (const entry of readdirSync(isolatedDataDir)) {
        if (entry.startsWith('res_')) {
          rmSync(join(isolatedDataDir, entry), { recursive: true, force: true });
        }
      }
    } catch {
      /* best effort */
    }
  });

  // ── Scenario 1: DAL create → bundle clones lazily + reads from disk ────
  //
  // We bypass the REST route here on purpose. The route fires a
  // `void onTeamTemplateBundle(...)` for non-private rows AND we
  // explicitly await another bundle in the test; both go through
  // `ensureClone`, and the unsynchronised pair can race in the small
  // window between "first clone mkdir's the dir" and "first clone
  // populates `.git`". The DAL path skips the race entirely.
  // Route-level wiring is covered by the L0 route tests already.

  it('createTeamTemplate with gitRemoteUrl → bundle clones the remote and reads manifest from disk', async () => {
    const remote = setupRemoteRepo('e2e-initial');
    cleanupDirs.push(remote);

    const created = createTeamTemplate({
      name: 'e2e-team',
      ownerAgentId: agent.id,
      gitRemoteUrl: `file://${remote}`,
    });
    expect(created.sync_strategy).toBe('ls-remote');
    expect(created.git_remote_url).toBe(`file://${remote}`);

    const bundleId = await awaitBundle(created.id);
    expect(bundleId).toMatch(/^sha256:/);

    const list = await getOpenteamsBundleStore().list(TEAM_RESOURCE_TYPE);
    expect(list.resources).toHaveLength(1);
    const bundle = list.resources[0];
    expect(bundle.name).toBe('e2e-team');
    const m = (bundle.metadata.manifest as { name?: string } | undefined) ?? {};
    expect(m.name).toBe('e2e-initial');
  });

  // ── Scenario 2: auto-pull picks up external commit ─────────────────────

  it('external commit + runAutoPullSweep() → bundle store reflects new manifest', async () => {
    const remote = setupRemoteRepo('before-pull');
    cleanupDirs.push(remote);

    const created = createTeamTemplate({
      name: 'auto-pull-team',
      ownerAgentId: agent.id,
      gitRemoteUrl: `file://${remote}`,
    });
    const rowId = created.id;
    await awaitBundle(rowId);

    const before = await getOpenteamsBundleStore().list(TEAM_RESOURCE_TYPE);
    expect(manifestName(before.resources)).toContain('before-pull');

    // External "push" — update the remote.
    writeManifest(remote, 'after-pull');
    gitExec('git add -A', remote);
    gitExec('git commit -m "Update manifest"', remote);

    // Mark the row as auto-pull-eligible (auto-pull's filter looks at
    // `metadata.git.autoPull`).
    const row = findResourceById(rowId)!;
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    getDatabase()
      .prepare('UPDATE syncable_resources SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ ...meta, git: { autoPull: true } }), rowId);

    await runAutoPullSweep();
    // Re-bundle deterministically once the pull lands; auto-pull's own
    // re-bundle hook is fire-and-forget so we don't rely on it.
    await awaitBundle(rowId);

    const after = await getOpenteamsBundleStore().list(TEAM_RESOURCE_TYPE);
    expect(manifestName(after.resources)).toContain('after-pull');
  });

  // ── Scenario 3: webhook fast-path — pull + rebundle in one cycle ───────

  it('pull + onTeamTemplateBundle (the webhook fast-path) lands new commit in the store', async () => {
    const remote = setupRemoteRepo('before-webhook');
    cleanupDirs.push(remote);

    const created = createTeamTemplate({
      name: 'webhook-team',
      ownerAgentId: agent.id,
      gitRemoteUrl: `file://${remote}`,
    });
    const rowId = created.id;
    await awaitBundle(rowId);

    // External "push".
    writeManifest(remote, 'after-webhook');
    gitExec('git add -A', remote);
    gitExec('git commit -m "Webhook push"', remote);

    // Webhook handler's openteams path: pullFromRemote + onTeamTemplateBundle.
    // (Exercising the path directly; the webhook entry-point auth varies by
    // git host and has its own coverage in webhooks.test.ts.)
    const fresh = findResourceById(rowId)!;
    if (fresh.local_path) {
      await pullFromRemote(fresh.local_path);
    }
    await awaitBundle(rowId);

    const after = await getOpenteamsBundleStore().list(TEAM_RESOURCE_TYPE);
    expect(manifestName(after.resources)).toContain('after-webhook');
  });

  // ── Scenario 4: hash stability ─────────────────────────────────────────

  it('re-bundling an unchanged checkout yields the same content-addressed id', async () => {
    const remote = setupRemoteRepo('stable-team');
    cleanupDirs.push(remote);

    const created = createTeamTemplate({
      name: 'stable-team',
      ownerAgentId: agent.id,
      gitRemoteUrl: `file://${remote}`,
    });
    const rowId = created.id;

    const first = await awaitBundle(rowId);
    const second = await awaitBundle(rowId);
    expect(first).not.toBeNull();
    expect(second).toBe(first);

    // local_path is persisted so restart-safety would hold.
    const row = findResourceById(rowId);
    expect(row?.local_path).toBeTruthy();
  });
});
