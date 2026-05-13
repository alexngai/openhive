/**
 * Layer 6 — git-backed openteams content tests.
 *
 * Covers:
 *   - Creating a team_template / loadout with `git_remote_url` flips
 *     `sync_strategy` to `'ls-remote'` (vs default `'metadata'`).
 *   - `git_remote_url` value is preserved on the row, not replaced with
 *     the `local://` fallback.
 *   - Inline `content` is still accepted alongside `git_remote_url` (acts
 *     as a fallback until the first clone lands).
 *   - The row-aware bundling helper prefers the disk checkout when the
 *     row is git-backed AND the checkout exists; falls back to
 *     `metadata.content` otherwise.
 *
 * We don't actually clone a real remote in these tests — that's
 * exercised end-to-end by manual smokes. The disk-preference path is
 * exercised by initializing a small fake clone directory and pointing
 * the row's `local_path` at it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createTeamTemplate } from '../../db/dal/team-templates.js';
import { createLoadout } from '../../db/dal/loadouts.js';
import { findResourceById, updateLocalPath } from '../../db/dal/syncable-resources.js';
import {
  bundleLoadoutFromRow,
  bundleTeamTemplateFromRow,
} from '../../openteams/internal/bundle-content.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('openteams-git-backed-bundle');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'git-backed.db');

const TEAM_CONTENT = {
  manifest: {
    name: 'git-team',
    version: 1 as const,
    roles: ['root'],
    topology: { root: { role: 'root' } },
  },
  roles: { root: { name: 'root', capabilities: ['plan'] } },
};

const LOADOUT_CONTENT = {
  name: 'git-lo',
  capabilities: ['file.read'],
  prompt_addendum: 'careful',
};

describe('openteams git-backed content (Layer 6)', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'git-backed-owner',
      description: 'Layer 6 tests',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase()
      .prepare(`DELETE FROM syncable_resources WHERE resource_type IN ('team_template', 'loadout')`)
      .run();
  });

  // ── DAL branching ──────────────────────────────────────────────────────

  it('createTeamTemplate without gitRemoteUrl defaults to local:// + metadata strategy', () => {
    const row = createTeamTemplate({
      name: 'inline-team',
      content: TEAM_CONTENT,
      ownerAgentId: agentId,
    });
    expect(row.git_remote_url).toBe('local://team_template/inline-team');
    expect(row.sync_strategy).toBe('metadata');
  });

  it('createTeamTemplate with gitRemoteUrl flips to ls-remote and preserves the remote URL', () => {
    const row = createTeamTemplate({
      name: 'git-team',
      content: TEAM_CONTENT,
      ownerAgentId: agentId,
      gitRemoteUrl: 'https://example.invalid/owner/openteams.git',
    });
    expect(row.git_remote_url).toBe('https://example.invalid/owner/openteams.git');
    expect(row.sync_strategy).toBe('ls-remote');
    // Inline content is still persisted as a fallback.
    expect((row.metadata as Record<string, unknown>).content).toBeDefined();
  });

  it('createLoadout with gitRemoteUrl follows the same shape', () => {
    const row = createLoadout({
      name: 'git-lo',
      content: LOADOUT_CONTENT,
      ownerAgentId: agentId,
      gitRemoteUrl: 'https://example.invalid/owner/loadouts.git',
    });
    expect(row.git_remote_url).toBe('https://example.invalid/owner/loadouts.git');
    expect(row.sync_strategy).toBe('ls-remote');
  });

  it('content is optional when gitRemoteUrl is supplied (deferred to first pull)', () => {
    const row = createTeamTemplate({
      name: 'no-inline',
      ownerAgentId: agentId,
      gitRemoteUrl: 'https://example.invalid/owner/openteams.git',
    });
    expect(row.git_remote_url).toBe('https://example.invalid/owner/openteams.git');
    // metadata has no content key yet; row is valid awaiting first pull.
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    expect(meta.content).toBeUndefined();
  });

  // ── Bundling preference: disk over metadata when git-backed ───────────

  it('bundleTeamTemplateFromRow reads YAML from the local checkout when the row is git-backed and cloned', async () => {
    // Stand up a fake checkout on disk that matches openteams's layout.
    const cloneDir = mkdtempSync(join(tmpdir(), 'openteams-fake-clone-'));
    writeFileSync(
      join(cloneDir, 'team.yaml'),
      yaml.dump({
        name: 'on-disk-team',
        version: 1,
        roles: ['worker'],
        topology: { root: { role: 'worker' } },
      }),
    );
    const rolesDir = join(cloneDir, 'roles');
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(
      join(rolesDir, 'worker.yaml'),
      yaml.dump({ name: 'worker', capabilities: ['build'] }),
    );

    try {
      // Inline content is intentionally DIFFERENT from the on-disk YAML so
      // we can prove the disk wins. If inline-content won, the bundle's
      // hash would correspond to "git-team" not "on-disk-team".
      const row = createTeamTemplate({
        name: 'mismatch-team',
        content: TEAM_CONTENT, // inline = "git-team", roles=[root]
        ownerAgentId: agentId,
        gitRemoteUrl: 'https://example.invalid/owner/openteams.git',
      });
      // Simulate that the lazy clone has happened.
      updateLocalPath(row.id, cloneDir);
      const fresh = findResourceById(row.id)!;

      const bundle = await bundleTeamTemplateFromRow(fresh);
      expect(bundle).not.toBeNull();
      // Bundle content reflects the on-disk YAML, not the inline blob.
      const manifest = (bundle!.metadata.manifest as { name?: string } | undefined) ?? {};
      expect(manifest.name).toBe('on-disk-team');
      // Bundle id is content-addressed; same disk content → same id deterministically.
      expect(bundle!.id).toMatch(/^sha256:/);
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it('bundleTeamTemplateFromRow falls back to metadata.content when not git-backed', async () => {
    const row = createTeamTemplate({
      name: 'inline-only',
      content: TEAM_CONTENT,
      ownerAgentId: agentId,
    });
    const fresh = findResourceById(row.id)!;
    const bundle = await bundleTeamTemplateFromRow(fresh);
    expect(bundle).not.toBeNull();
    const manifest = (bundle!.metadata.manifest as { name?: string } | undefined) ?? {};
    expect(manifest.name).toBe('git-team');
  });

  it('bundleLoadoutFromRow round-trips inline content for non-git rows', async () => {
    const row = createLoadout({
      name: 'inline-lo',
      content: LOADOUT_CONTENT,
      ownerAgentId: agentId,
    });
    const fresh = findResourceById(row.id)!;
    const bundle = await bundleLoadoutFromRow(fresh);
    expect(bundle).not.toBeNull();
    expect(bundle!.id).toMatch(/^sha256:/);
  });

  it('bundle helpers return null for git-backed rows with no checkout AND no inline content', async () => {
    const row = createTeamTemplate({
      name: 'pending-pull',
      ownerAgentId: agentId,
      gitRemoteUrl: 'https://example.invalid/owner/openteams.git',
    });
    const fresh = findResourceById(row.id)!;
    // No local_path → ensureClone would actually try the network. Instead
    // we exercise the metadata-fallback shape: the row has no content yet,
    // so the fallback branch is taken and returns null cleanly.
    // (When the row IS cloned, the disk path is exercised by the test
    // above; when it ISN'T cloned and no fallback exists, return null.)
    // We strip the ls-remote strategy temporarily so the helper takes the
    // metadata path without invoking ensureClone.
    getDatabase()
      .prepare(`UPDATE syncable_resources SET sync_strategy = 'metadata' WHERE id = ?`)
      .run(fresh.id);
    const stripped = findResourceById(fresh.id)!;
    const bundle = await bundleTeamTemplateFromRow(stripped);
    expect(bundle).toBeNull();
  });
});
