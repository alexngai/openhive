/**
 * Repo Bridge
 *
 * Auto-registers projects in SwarmCraft's project registry when swarms
 * report project paths via trajectory checkpoints. Also hydrates from
 * historical swarm metadata on startup.
 *
 * Auto-analyzes the CWD project (where the OpenHive server runs).
 * Other discovered projects are registered passively for manual selection.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mapHubEvents } from '../map/service.js';
import { listSwarms } from '../db/dal/map.js';

interface RepoBridgeHandle {
  teardown(): void;
}

interface ProjectStore {
  getByPath(path: string): Promise<{ id: string; status: string } | null>;
  create(data: { id: string; name: string; path: string; gitUrl?: string; branch?: string; commitHash?: string }): Promise<unknown>;
  update(id: string, data: Record<string, unknown>): Promise<unknown>;
}

interface PipelineService {
  startAnalysis(repoPath: string): string;
  isReady(): boolean;
}

export async function setupRepoBridge(
  pipelineService: PipelineService,
  projectStore?: ProjectStore,
): Promise<RepoBridgeHandle> {
  const registeredPaths = new Set<string>();
  let cwdAnalyzed = false;

  const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  function on(event: string, fn: (...args: unknown[]) => void) {
    mapHubEvents.on(event, fn);
    listeners.push({ event, fn });
  }

  const cwdPath = process.cwd();

  /** Check if a project path matches or is under the CWD */
  function isCwdProject(projectPath: string): boolean {
    const resolved = path.resolve(projectPath);
    const resolvedCwd = path.resolve(cwdPath);
    return resolved === resolvedCwd || resolved.startsWith(resolvedCwd + '/');
  }

  /** Register a project path. Only analyzes if shouldAnalyze is true. */
  async function tryRegister(
    projectPath: string,
    gitRemoteUrl?: string,
    branch?: string,
    commitHash?: string,
    shouldAnalyze = false,
  ): Promise<void> {
    const isLocal = (() => {
      try { return fs.existsSync(projectPath) && fs.statSync(projectPath).isDirectory(); } catch { return false; }
    })();

    // For remote projects, update branch/commit on every checkpoint
    if (!isLocal && projectStore && (branch || commitHash)) {
      try {
        const existing = await projectStore.getByPath(projectPath);
        if (existing) {
          await projectStore.update(existing.id, { branch, commitHash });
        }
      } catch { /* best effort */ }
    }

    // Skip if already registered (dedup)
    if (registeredPaths.has(projectPath)) return;
    registeredPaths.add(projectPath);

    // Must be either local or have a git URL
    if (!isLocal && !gitRemoteUrl) return;

    const projectName = path.basename(projectPath);

    // Register in project store
    if (projectStore) {
      try {
        const existing = await projectStore.getByPath(projectPath);
        if (!existing) {
          const id = `proj-${projectPath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40)}`;
          await projectStore.create({ id, name: projectName, path: projectPath, gitUrl: gitRemoteUrl, branch, commitHash });
          console.log(`[swarmcraft-bridge] Registered project: ${projectName}${branch ? ` (${branch})` : ''}${gitRemoteUrl ? ` git: ${gitRemoteUrl}` : ''}`);
        }
      } catch (err) {
        console.warn(`[swarmcraft-bridge] Failed to register project ${projectPath}: ${(err as Error).message}`);
      }
    }

    // Only analyze if explicitly requested (CWD project)
    if (shouldAnalyze && !cwdAnalyzed && !pipelineService.isReady()) {
      cwdAnalyzed = true;

      if (isLocal) {
        try {
          const jobId = pipelineService.startAnalysis(projectPath);
          console.log(`[swarmcraft-bridge] Auto-analyzing CWD project at ${projectPath} (job: ${jobId})`);
        } catch (err) {
          console.warn(`[swarmcraft-bridge] Auto-analyze failed: ${(err as Error).message}`);
          cwdAnalyzed = false;
        }
      } else if (gitRemoteUrl) {
        cloneAndAnalyze(gitRemoteUrl, projectName, branch, pipelineService).catch(err => {
          console.warn(`[swarmcraft-bridge] Clone + analyze failed: ${(err as Error).message}`);
          cwdAnalyzed = false;
        });
      }
    }
  }

  // ── Startup hydration ────────────────────────────────────────────────
  try {
    const { data: allSwarms } = listSwarms({ limit: 500 });
    for (const swarm of allSwarms) {
      const meta = swarm.metadata as Record<string, unknown> | null;
      const projectPath = meta?.projectPath as string | undefined;
      const gitRemoteUrl = meta?.gitRemoteUrl as string | undefined;
      const branch = meta?.branch as string | undefined;
      const gitCommitHash = meta?.gitCommitHash as string | undefined;
      if (projectPath) {
        // Auto-analyze only if this project matches the CWD
        const shouldAnalyze = isCwdProject(projectPath);
        await tryRegister(projectPath, gitRemoteUrl, branch, gitCommitHash, shouldAnalyze);
      }
    }
  } catch (err) {
    console.warn(`[swarmcraft-bridge] Repo hydration failed: ${(err as Error).message}`);
  }

  // If no swarm matched CWD, analyze CWD directly
  if (!cwdAnalyzed && !pipelineService.isReady()) {
    try {
      const hasPackageJson = fs.existsSync(path.join(cwdPath, 'package.json'));
      const hasSrc = fs.existsSync(path.join(cwdPath, 'src'));
      if (hasPackageJson || hasSrc) {
        cwdAnalyzed = true;
        const jobId = pipelineService.startAnalysis(cwdPath);
        console.log(`[swarmcraft-bridge] Auto-analyzing CWD project at ${cwdPath} (job: ${jobId})`);
      }
    } catch (err) {
      console.warn(`[swarmcraft-bridge] CWD analysis failed: ${(err as Error).message}`);
    }
  }

  // ── Real-time events ─────────────────────────────────────────────────
  on('trajectory_checkpoint', async (e: unknown) => {
    const ev = e as { projectPath?: string; gitRemoteUrl?: string; branch?: string; gitCommitHash?: string };
    if (ev.projectPath) {
      await tryRegister(ev.projectPath, ev.gitRemoteUrl, ev.branch, ev.gitCommitHash);
    }
  });

  return {
    teardown() {
      for (const { event, fn } of listeners) {
        mapHubEvents.removeListener(event, fn);
      }
    },
  };
}

// ── Git clone helper ──────────────────────────────────────────────────

async function cloneAndAnalyze(
  gitUrl: string,
  projectName: string,
  branch: string | undefined,
  pipelineService: PipelineService,
): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), `sc-clone-${projectName}-${Date.now()}`);

  try {
    const branchLabel = branch ? ` (branch: ${branch})` : '';
    console.log(`[swarmcraft-bridge] Cloning ${gitUrl}${branchLabel} to ${tmpDir}...`);

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const cloneArgs = ['clone', '--depth=1'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(gitUrl, tmpDir);

    await execFileAsync('git', cloneArgs, { timeout: 120_000 });

    const jobId = pipelineService.startAnalysis(tmpDir);
    console.log(`[swarmcraft-bridge] Analyzing cloned repo ${projectName} (job: ${jobId})`);

    // Clean up after a delay (give analysis time to read files)
    setTimeout(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log(`[swarmcraft-bridge] Cleaned up temp clone: ${tmpDir}`);
      } catch { /* best effort */ }
    }, 5 * 60 * 1000);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}
