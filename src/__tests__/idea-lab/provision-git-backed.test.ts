/**
 * provisionIdeaLab git-backed lab-graph registration.
 *
 * When `gitRemote` is set, the lab graph must be registered as a STANDARD
 * git-synced task resource — `git_remote_url` = the remote, `metadata.git_sync`
 * enabled, and the on-disk opentasks config.json carrying the `sync.git` block
 * (via the shared applyGitSyncConfig). When unset, it must stay hub-local so
 * regular opentasks flows are unaffected. Both are asserted here.
 *
 * Daemon-free (empty objectives) — only resource registration + git setup are
 * exercised. Short /tmp root for git + opentasks paths.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { findResourceById } from '../../db/dal/syncable-resources.js';
import { readAppliedGitSyncConfig } from '../../swarmkit/git-sync-config.js';
import { provisionIdeaLab, parseIdeaLabPack } from '../../idea-lab/index.js';

const ROOT = path.join('/tmp', `il-gb-${process.pid}`);
const DB_PATH = path.join(ROOT, 'il-gb.db');
const silent = { info: () => {}, warn: () => {} };

const PACK = parseIdeaLabPack({
  version: 1,
  graph: { name: 'idea-lab/graph' },
  ledger: { name: 'idea-lab/ledger' },
  objectives: [],
  roles: [{ key: 'ideator', cron: '0 * * * *', prompt: 'ideator prompt' }],
});

beforeAll(async () => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* fresh */
  }
  fs.mkdirSync(ROOT, { recursive: true });
  initDatabase(DB_PATH);
  await agentsDAL.createAgent({ name: 'il-gb-owner', is_admin: true });
}, 30_000);

afterAll(() => {
  try {
    closeDatabase();
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  const db = getDatabase();
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM schedules');
  try {
    db.exec('DELETE FROM resource_subscriptions');
  } catch {
    /* table name may differ */
  }
  db.exec('DELETE FROM syncable_resources');
  db.pragma('foreign_keys = ON');
});

describe('provisionIdeaLab git-backed lab graph', () => {
  it('registers the lab graph as a git-synced task resource, idempotently', async () => {
    const dataDir = path.join(ROOT, 'git');
    const remote = path.join(ROOT, 'lab-remote.git');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });

    const first = await provisionIdeaLab({
      dataDir,
      pack: PACK,
      gitRemote: remote,
      targetSwarmIds: [],
      logger: silent,
    });
    expect(first.ok).toBe(true);
    expect(first.graph?.created).toBe(true);
    // The only expected warning is the paused-no-targets note; git setup must not warn.
    expect(first.warnings.find((w) => w.includes('git-sync setup'))).toBeUndefined();

    // Resource row is git-backed.
    const res = findResourceById(first.graph!.resourceId)!;
    expect(res.git_remote_url).toBe(remote);
    const meta = res.metadata as Record<string, unknown>;
    expect(meta.opentasks).toBe(true);
    expect(meta.idea_lab).toBe(true);
    expect((meta.git_sync as Record<string, unknown>).enabled).toBe(true);
    expect((meta.git_sync as Record<string, unknown>).remote).toBe('origin');

    // Working root is a git repo pointing at the remote.
    const graphRoot = path.join(dataDir, 'idea-lab');
    expect(fs.existsSync(path.join(graphRoot, '.git'))).toBe(true);
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: graphRoot,
      stdio: 'pipe',
    })
      .toString()
      .trim();
    expect(origin).toBe(remote);

    // opentasks daemon config carries the sync.git block.
    const applied = readAppliedGitSyncConfig(graphRoot);
    expect(applied?.enabled).toBe(true);
    expect(applied?.autoPush).toBe(true);
    expect(applied?.pullOnStartup).toBe(true);

    // Idempotent: second run re-registers the same resource, no duplicate.
    const second = await provisionIdeaLab({
      dataDir,
      pack: PACK,
      gitRemote: remote,
      targetSwarmIds: [],
      logger: silent,
    });
    expect(second.graph?.created).toBe(false);
    expect(second.graph?.resourceId).toBe(first.graph!.resourceId);
  });

  it('stays hub-local when no gitRemote is set (regular flows unaffected)', async () => {
    const dataDir = path.join(ROOT, 'local');
    const res0 = await provisionIdeaLab({
      dataDir,
      pack: PACK,
      targetSwarmIds: [],
      logger: silent,
    });
    const res = findResourceById(res0.graph!.resourceId)!;
    const graphDir = path.join(dataDir, 'idea-lab', '.opentasks');

    // Local graph: git_remote_url is the local dir, no git_sync metadata,
    // and no git repo was initialized.
    expect(res.git_remote_url).toBe(graphDir);
    const meta = res.metadata as Record<string, unknown>;
    expect(meta.opentasks).toBe(true);
    expect(meta.git_sync).toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, 'idea-lab', '.git'))).toBe(false);
  });
});
