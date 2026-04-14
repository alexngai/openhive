/**
 * Interactive session-repo actions for the openhive admin UI.
 *
 * Shells out to git on the resolved clone path. Openhive doesn't replace
 * sessionlog's autonomous behavior (fire-and-forget fetch + autoPush);
 * these are user-triggered actions for when the user wants to force a
 * sync or diagnose an issue.
 *
 * Each action runs with a bounded timeout and returns the refreshed
 * status object so the UI can update without a second fetch.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  probeSessionRepoStatus,
  type SessionRepoStatus,
} from './sessionlog-repo-status.js';
import { readConfig, readLocalConfig, resolveDescriptors, findDescriptor } from './config-io.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 120_000;

// ─── Types ──────────────────────────────────────────────────

export interface RepoActionResult {
  ok: boolean;
  /** Short error message on failure, null on success. */
  error: string | null;
  /** Excerpt from stderr (first 2KB) for diagnostics. */
  stderr: string | null;
  /** Refreshed status after the action (always included). */
  status: SessionRepoStatus;
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Run git in a given cwd with a timeout and normalized output.
 */
async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; stderr: string | null; error: string | null }> {
  try {
    const { stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stderr: stderr?.toString().slice(0, 2048) || null, error: null };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string; code?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString();
    return {
      ok: false,
      stderr: stderr?.slice(0, 2048) ?? null,
      error: e.code === 'ETIMEDOUT'
        ? `Operation timed out after ${timeoutMs}ms`
        : (stderr?.trim().split('\n').slice(-1)[0] ?? e.message ?? 'git failed'),
    };
  }
}

/**
 * Read the merged sessionRepo config.
 * Returns null when no remote is configured.
 */
function resolveRepoConfig(projectRoot: string, usePrefix: boolean): {
  remote: string;
  clonePath: string;
  directory: string | null;
} | null {
  const descriptors = resolveDescriptors('sessionlog', projectRoot, usePrefix);
  const desc = findDescriptor(descriptors, 'project');
  if (!desc) return null;

  const project = readConfig(desc);
  const local = readLocalConfig(desc);
  const merged = {
    ...(project.sessionRepo as Record<string, unknown> | undefined ?? {}),
    ...(local.sessionRepo as Record<string, unknown> | undefined ?? {}),
  };

  const remote = typeof merged.remote === 'string' ? merged.remote : '';
  if (!remote) return null;

  // Must match sessionlog-repo-status' auto-clone derivation.
  const explicit = typeof merged.localPath === 'string' && merged.localPath.length > 0
    ? merged.localPath
    : null;
  const clonePath = explicit ?? autoClonePath(remote);
  const directory = typeof merged.directory === 'string' && merged.directory.length > 0
    ? merged.directory
    : null;

  return { remote, clonePath, directory };
}

function autoClonePath(remote: string): string {
  const hash = crypto.createHash('sha256').update(remote).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.sessionlog', 'repos', hash);
}

// ─── Actions ────────────────────────────────────────────────

export async function fetchRepo(projectRoot: string, usePrefix: boolean): Promise<RepoActionResult> {
  const cfg = resolveRepoConfig(projectRoot, usePrefix);
  if (!cfg) {
    return missingConfigResult(await probeSessionRepoStatus(projectRoot, usePrefix));
  }
  if (!fs.existsSync(path.join(cfg.clonePath, '.git'))) {
    return {
      ok: false,
      error: 'Clone does not exist — use clone first',
      stderr: null,
      status: await probeSessionRepoStatus(projectRoot, usePrefix),
    };
  }
  const result = await runGit(['fetch', 'origin'], cfg.clonePath, GIT_TIMEOUT_MS);
  return {
    ...result,
    status: await probeSessionRepoStatus(projectRoot, usePrefix),
  };
}

export async function pushRepo(projectRoot: string, usePrefix: boolean): Promise<RepoActionResult> {
  const cfg = resolveRepoConfig(projectRoot, usePrefix);
  if (!cfg) {
    return missingConfigResult(await probeSessionRepoStatus(projectRoot, usePrefix));
  }
  if (!cfg.directory) {
    return {
      ok: false,
      error: 'sessionRepo.directory is not set — cannot derive checkpoints branch',
      stderr: null,
      status: await probeSessionRepoStatus(projectRoot, usePrefix),
    };
  }
  if (!fs.existsSync(path.join(cfg.clonePath, '.git'))) {
    return {
      ok: false,
      error: 'Clone does not exist — use clone first',
      stderr: null,
      status: await probeSessionRepoStatus(projectRoot, usePrefix),
    };
  }
  const branch = `sessionlog/checkpoints/v1/${cfg.directory}`;
  const result = await runGit(['push', 'origin', branch], cfg.clonePath, GIT_TIMEOUT_MS);
  return {
    ...result,
    status: await probeSessionRepoStatus(projectRoot, usePrefix),
  };
}

export async function cloneRepo(projectRoot: string, usePrefix: boolean): Promise<RepoActionResult> {
  const cfg = resolveRepoConfig(projectRoot, usePrefix);
  if (!cfg) {
    return missingConfigResult(await probeSessionRepoStatus(projectRoot, usePrefix));
  }
  if (fs.existsSync(path.join(cfg.clonePath, '.git'))) {
    return {
      ok: false,
      error: 'Clone already exists at ' + cfg.clonePath,
      stderr: null,
      status: await probeSessionRepoStatus(projectRoot, usePrefix),
    };
  }
  fs.mkdirSync(cfg.clonePath, { recursive: true });
  const result = await runGit(
    ['clone', cfg.remote, cfg.clonePath],
    path.dirname(cfg.clonePath),
    CLONE_TIMEOUT_MS,
  );
  return {
    ...result,
    status: await probeSessionRepoStatus(projectRoot, usePrefix),
  };
}

function missingConfigResult(status: SessionRepoStatus): RepoActionResult {
  return {
    ok: false,
    error: 'sessionRepo.remote is not configured',
    stderr: null,
    status,
  };
}
