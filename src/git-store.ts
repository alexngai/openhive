/**
 * Unified git store ("hive store") — one local git repo holding the hub's
 * git-backed state: the hub-default task graph (.opentasks/), sessionlog
 * sessions, minimem memory banks, and skill-tree skills.
 *
 * Multi-writer discipline: several independent processes commit into this
 * repo (the opentasks daemon pathspec-scopes its commits; sessionlog writes
 * via plumbing to its own refs). Any committer added here MUST also be
 * pathspec-scoped so it never swallows another writer's staged files —
 * see startGitStoreCommitter().
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveDataDir } from './data-dir.js';
import type { Config } from './config.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;

export const STORE_SUBDIRS = ['sessionlog-sessions', 'memory', 'skills'] as const;

/**
 * Paths the hub committer owns. Never `.opentasks` — the opentasks daemon
 * commits its own graph (pathspec-scoped), and double-committing would
 * race it for no benefit.
 */
const COMMIT_PATHSPEC = ['README.md', '.gitignore', ...STORE_SUBDIRS];

/** Commit identity for hub-owned auto-commits (independent of git config). */
const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'OpenHive',
  GIT_AUTHOR_EMAIL: 'openhive@localhost',
  GIT_COMMITTER_NAME: 'OpenHive',
  GIT_COMMITTER_EMAIL: 'openhive@localhost',
};

const README_CONTENT = `# OpenHive git store

This repository is managed by an OpenHive hub (\`gitStore\` config). It holds
the hub's git-backed state in one place:

| Path | Contents | Committed by |
|---|---|---|
| \`.opentasks/\` | hub-default OpenTasks graph | opentasks daemon (enable git-sync on the \`hub/default\` task resource) |
| \`sessionlog-sessions/\` | sessionlog session state | sessionlog / hub auto-commit |
| \`memory/\` | minimem memory banks | hub auto-commit |
| \`skills/\` | skill-tree skills | hub auto-commit |

To have agents write sessions here, point their sessionlog \`sessionRepo\`
(in \`.swarm/sessionlog/settings.json\`) at this repository.

All writers use pathspec-scoped commits or git plumbing on their own refs,
so they coexist safely in this one repository.
`;

const GITIGNORE_CONTENT = `daemon.sock
*.sock
`;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string | null;
  error: string | null;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, ...GIT_IDENTITY_ENV, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: stdout?.toString() ?? '',
      stderr: stderr?.toString().slice(0, 2048) || null,
      error: null,
    };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string; code?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString();
    return {
      ok: false,
      stdout: (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString()) ?? '',
      stderr: stderr?.slice(0, 2048) ?? null,
      error:
        e.code === 'ETIMEDOUT'
          ? `Operation timed out after ${GIT_TIMEOUT_MS}ms`
          : (stderr?.trim().split('\n').slice(-1)[0] ?? e.message ?? 'git failed'),
    };
  }
}

/**
 * Resolve the store directory. `applyGitStoreDerivations` writes the
 * resolved path back into the config when the store is enabled, so the
 * fallback only matters for callers holding a hand-built config.
 */
export function resolveGitStorePath(config: Config): string {
  return path.resolve(config.gitStore.path ?? path.join(resolveDataDir(), 'hive-store'));
}

/**
 * Ensure the store exists on disk as a git repo with the standard layout.
 * Idempotent; git failures are non-fatal (warn + continue) so a missing
 * git binary degrades the store to a plain directory rather than blocking
 * hub boot — matches the taskGraph bootstrap's error posture.
 *
 * Returns the resolved store path, or null when gitStore is disabled.
 */
export async function ensureGitStore(config: Config): Promise<string | null> {
  if (!config.gitStore.enabled) return null;
  const storePath = resolveGitStorePath(config);

  fs.mkdirSync(storePath, { recursive: true });
  for (const sub of STORE_SUBDIRS) {
    fs.mkdirSync(path.join(storePath, sub), { recursive: true });
  }

  if (!fs.existsSync(path.join(storePath, '.git'))) {
    const init = await runGit(['init'], storePath);
    if (!init.ok) {
      console.warn(`[git-store] git init failed at ${storePath}: ${init.error}`);
      return storePath;
    }
    if (!fs.existsSync(path.join(storePath, 'README.md'))) {
      fs.writeFileSync(path.join(storePath, 'README.md'), README_CONTENT);
    }
    if (!fs.existsSync(path.join(storePath, '.gitignore'))) {
      fs.writeFileSync(path.join(storePath, '.gitignore'), GITIGNORE_CONTENT);
    }
    // Safe to stage everything: at init time the hub owns the repo exclusively.
    await runGit(['add', '-A'], storePath);
    const commit = await runGit(['commit', '-m', 'hive-store: initialize'], storePath);
    if (!commit.ok) {
      console.warn(`[git-store] initial commit failed: ${commit.error}`);
    } else {
      console.log(`[git-store] Initialized hive store at ${storePath}`);
    }
  }

  const remote = config.gitStore.remote;
  if (remote) {
    const current = await runGit(['remote', 'get-url', 'origin'], storePath);
    if (!current.ok) {
      const add = await runGit(['remote', 'add', 'origin', remote], storePath);
      if (!add.ok) console.warn(`[git-store] remote add failed: ${add.error}`);
    } else if (current.stdout.trim() !== remote) {
      const set = await runGit(['remote', 'set-url', 'origin', remote], storePath);
      if (!set.ok) console.warn(`[git-store] remote set-url failed: ${set.error}`);
    }
  }

  return storePath;
}

/**
 * Parse `git status --porcelain -z` output into the affected file paths.
 * Rename/copy entries carry a second NUL-separated origin path — include
 * it too, so a pathspec-scoped commit captures the deletion side.
 */
function parseDirtyPaths(porcelainZ: string): string[] {
  const tokens = porcelainZ.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    paths.push(entry.slice(3));
    const status = entry[0];
    if (status === 'R' || status === 'C') {
      i++;
      paths.push(tokens[i]);
    }
  }
  return paths;
}

/**
 * One committer tick: commit dirty files under the hub-owned pathspec,
 * then optionally push. Exported for tests; production use goes through
 * startGitStoreCommitter().
 */
export async function commitStoreChanges(
  storePath: string,
  opts: { push: boolean },
): Promise<{ committed: boolean }> {
  const status = await runGit(
    ['status', '--porcelain', '-z', '--', ...COMMIT_PATHSPEC],
    storePath,
  );
  if (!status.ok) {
    console.warn(`[git-store] status failed: ${status.error}`);
    return { committed: false };
  }
  // Commit the exact dirty files, not the directory pathspec: `git commit
  // -- <dir>` errors when a dir contains no files known to git (e.g. an
  // empty sessionlog-sessions/), and explicit paths keep the commit scoped
  // to changes observed THIS tick — files another writer stages while we
  // run are untouched.
  const dirtyPaths = parseDirtyPaths(status.stdout);
  if (dirtyPaths.length === 0) return { committed: false };

  const add = await runGit(['add', '--', ...dirtyPaths], storePath);
  if (!add.ok) {
    // Likely index.lock contention with another writer — next tick retries.
    console.warn(`[git-store] add failed (will retry): ${add.error}`);
    return { committed: false };
  }
  const commit = await runGit(
    ['commit', '-m', 'hive-store: auto-commit', '--', ...dirtyPaths],
    storePath,
  );
  if (!commit.ok) {
    console.warn(`[git-store] commit failed (will retry): ${commit.error}`);
    return { committed: false };
  }

  if (opts.push) {
    const push = await runGit(['push', 'origin', 'HEAD'], storePath);
    if (!push.ok) {
      // Mirrors opentasks' push recovery: rebase onto the remote, retry once.
      await runGit(['pull', '--rebase', 'origin'], storePath);
      const retry = await runGit(['push', 'origin', 'HEAD'], storePath);
      if (!retry.ok) {
        console.warn(`[git-store] push failed after rebase: ${retry.error}`);
      }
    }
  }
  return { committed: true };
}

/**
 * Start the interval committer for the hub-owned pathspec. Returns a stop
 * function. Ticks never overlap (in-flight guard); failures are logged and
 * retried on the next tick.
 */
export function startGitStoreCommitter(config: Config): () => void {
  const storePath = resolveGitStorePath(config);
  const push = Boolean(config.gitStore.autoPush && config.gitStore.remote);
  let inFlight = false;

  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    commitStoreChanges(storePath, { push })
      .catch((err) => {
        console.warn(`[git-store] committer tick failed: ${(err as Error).message}`);
      })
      .finally(() => {
        inFlight = false;
      });
  }, config.gitStore.commitIntervalMs);
  timer.unref();

  return () => clearInterval(timer);
}
