/**
 * Sessionlog session-repo status probe.
 *
 * Reads the merged sessionlog config (settings.json + settings.local.json),
 * resolves the clone path the same way sessionlog does, and runs non-blocking
 * git queries to report back what the UI needs to show.
 *
 * All queries are bounded by a short timeout; missing clones, unreachable
 * remotes, and unresolved branches are soft-failures that return null/false
 * rather than throwing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readConfig, readLocalConfig, resolveDescriptors, findDescriptor } from './config-io.js';

const execFileAsync = promisify(execFile);

const LS_REMOTE_TIMEOUT_MS = 5_000;
const GIT_STATE_TIMEOUT_MS = 3_000;

// ─── Types ──────────────────────────────────────────────────

export type SessionRepoStatus =
  | { state: 'not-configured' }
  | {
      state: 'configured';
      /** Git remote URL from settings.json */
      remote: string;
      /** Resolved local clone path (explicit localPath or auto-clone default) */
      clonePath: string;
      /** Whether localPath was explicitly set (vs. derived from remote) */
      clonePathExplicit: boolean;
      /** Whether the clone exists on disk */
      cloneExists: boolean;
      /** Last time a fetch completed (ISO timestamp; null if never fetched or missing) */
      lastFetchedAt: string | null;
      /** Whether git ls-remote succeeded within the timeout */
      remoteReachable: boolean | null;
      /** Checkpoints branch name if directory is configured; null otherwise */
      checkpointsBranch: string | null;
      /** Commits in local ahead of origin on the checkpoints branch */
      ahead: number | null;
      /** Commits on origin not yet in local */
      behind: number | null;
      /** Whether sessionRepo.autoPush is enabled */
      autoPush: boolean;
      /** Error message from the most recent failing git op, if any */
      lastError: string | null;
    };

// ─── Resolution ─────────────────────────────────────────────

/**
 * Match sessionlog's auto-clone path derivation
 * (~/.sessionlog/repos/<sha256(remote)[:12]>/).
 */
function autoClonePath(remote: string): string {
  const hash = crypto.createHash('sha256').update(remote).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.sessionlog', 'repos', hash);
}

interface ResolvedRepoConfig {
  remote: string;
  clonePath: string;
  clonePathExplicit: boolean;
  directory: string | null;
  autoPush: boolean;
}

/**
 * Resolve sessionlog's session-repo settings from disk.
 * Returns null when no session repo is configured.
 */
function resolveConfig(projectRoot: string, usePrefix: boolean): ResolvedRepoConfig | null {
  const descriptors = resolveDescriptors('sessionlog', projectRoot, usePrefix);
  const desc = findDescriptor(descriptors, 'project');
  if (!desc) return null;

  const project = readConfig(desc);
  const local = readLocalConfig(desc);

  // Pull sessionRepo from merged view (local wins)
  const mergedRepo = {
    ...(project.sessionRepo as Record<string, unknown> | undefined ?? {}),
    ...(local.sessionRepo as Record<string, unknown> | undefined ?? {}),
  };

  const remote = typeof mergedRepo.remote === 'string' ? mergedRepo.remote : '';
  if (!remote) return null;

  const explicitLocal = typeof mergedRepo.localPath === 'string' && mergedRepo.localPath.length > 0
    ? mergedRepo.localPath
    : null;
  const directory = typeof mergedRepo.directory === 'string' && mergedRepo.directory.length > 0
    ? mergedRepo.directory
    : null;
  const autoPush = mergedRepo.autoPush === true;

  return {
    remote,
    clonePath: explicitLocal ?? autoClonePath(remote),
    clonePathExplicit: explicitLocal !== null,
    directory,
    autoPush,
  };
}

// ─── Git queries ────────────────────────────────────────────

async function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.toString().trim();
}

async function lsRemoteReachable(remote: string): Promise<boolean | null> {
  try {
    await execFileAsync('git', ['ls-remote', '--heads', '--exit-code', remote], {
      timeout: LS_REMOTE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return true;
  } catch {
    // Either unreachable or auth missing or timeout — can't distinguish cheaply.
    return false;
  }
}

function fetchHeadMtime(clonePath: string): string | null {
  const fetchHead = path.join(clonePath, '.git', 'FETCH_HEAD');
  try {
    const stat = fs.statSync(fetchHead);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

async function aheadBehind(clonePath: string, branch: string): Promise<{ ahead: number | null; behind: number | null; err: string | null }> {
  try {
    // Left-right count of commits on each side of the fork point.
    const out = await runGit(
      ['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`],
      clonePath,
      GIT_STATE_TIMEOUT_MS,
    );
    const [aheadStr, behindStr] = out.split(/\s+/);
    const ahead = Number(aheadStr);
    const behind = Number(behindStr);
    if (Number.isNaN(ahead) || Number.isNaN(behind)) {
      return { ahead: null, behind: null, err: null };
    }
    return { ahead, behind, err: null };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString();
    return { ahead: null, behind: null, err: stderr?.trim() ?? e.message ?? null };
  }
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Probe session-repo status for a project.
 * Returns { state: 'not-configured' } when sessionRepo.remote is unset.
 * Otherwise returns a fully-populated status with best-effort git state.
 */
export async function probeSessionRepoStatus(
  projectRoot: string,
  usePrefix: boolean,
): Promise<SessionRepoStatus> {
  const cfg = resolveConfig(projectRoot, usePrefix);
  if (!cfg) return { state: 'not-configured' };

  const cloneExists = fs.existsSync(path.join(cfg.clonePath, '.git'));
  const lastFetchedAt = cloneExists ? fetchHeadMtime(cfg.clonePath) : null;
  const checkpointsBranch = cfg.directory ? `sessionlog/checkpoints/v1/${cfg.directory}` : null;

  // Run remote reachability + ahead/behind concurrently.
  const [remoteReachable, branchState] = await Promise.all([
    lsRemoteReachable(cfg.remote),
    cloneExists && checkpointsBranch
      ? aheadBehind(cfg.clonePath, checkpointsBranch)
      : Promise.resolve({ ahead: null as number | null, behind: null as number | null, err: null as string | null }),
  ]);

  return {
    state: 'configured',
    remote: cfg.remote,
    clonePath: cfg.clonePath,
    clonePathExplicit: cfg.clonePathExplicit,
    cloneExists,
    lastFetchedAt,
    remoteReachable,
    checkpointsBranch,
    ahead: branchState.ahead,
    behind: branchState.behind,
    autoPush: cfg.autoPush,
    lastError: branchState.err,
  };
}
