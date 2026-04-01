/**
 * Repo Bridge
 *
 * Auto-triggers SwarmCraft code analysis when swarms report project paths
 * via trajectory checkpoints. Also hydrates from historical swarm metadata
 * on startup so previously connected swarms' repos are analyzed too.
 * Only analyzes local paths that exist on disk.
 */

import fs from 'node:fs';
import { mapHubEvents } from '../map/service.js';
import { listSwarms } from '../db/dal/map.js';

interface RepoBridgeHandle {
  teardown(): void;
}

interface PipelineService {
  startAnalysis(repoPath: string): string;
  isReady(): boolean;
}

export async function setupRepoBridge(
  pipelineService: PipelineService,
): Promise<RepoBridgeHandle> {
  const analyzedPaths = new Set<string>();
  const pendingPaths = new Set<string>();

  const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  function on(event: string, fn: (...args: unknown[]) => void) {
    mapHubEvents.on(event, fn);
    listeners.push({ event, fn });
  }

  /** Try to analyze a local repo path. Returns true if analysis was triggered. */
  function tryAnalyze(projectPath: string): boolean {
    if (analyzedPaths.has(projectPath) || pendingPaths.has(projectPath)) return false;

    // Only analyze local paths that exist on disk
    try {
      if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
        return false;
      }
    } catch {
      return false;
    }

    pendingPaths.add(projectPath);

    // Don't re-analyze if pipeline already has a graph
    if (pipelineService.isReady()) {
      analyzedPaths.add(projectPath);
      pendingPaths.delete(projectPath);
      return false;
    }

    try {
      const jobId = pipelineService.startAnalysis(projectPath);
      analyzedPaths.add(projectPath);
      console.log(`[swarmcraft-bridge] Auto-analyzing repo at ${projectPath} (job: ${jobId})`);
      return true;
    } catch (err) {
      console.warn(`[swarmcraft-bridge] Failed to auto-analyze ${projectPath}: ${(err as Error).message}`);
      return false;
    } finally {
      pendingPaths.delete(projectPath);
    }
  }

  // ── Startup hydration: check historical swarm metadata for projectPaths ──
  try {
    const { data: allSwarms } = listSwarms({ limit: 500 });
    for (const swarm of allSwarms) {
      const meta = swarm.metadata as Record<string, unknown> | null;
      const projectPath = meta?.projectPath as string | undefined;
      if (projectPath && tryAnalyze(projectPath)) {
        break; // Only analyze one repo at startup to avoid overloading the pipeline
      }
    }
  } catch (err) {
    console.warn(`[swarmcraft-bridge] Repo hydration failed: ${(err as Error).message}`);
  }

  // ── Real-time: trajectory checkpoints with projectPath ────────────────
  on('trajectory_checkpoint', (e: unknown) => {
    const ev = e as { projectPath?: string; source_swarm_id?: string };
    if (ev.projectPath) {
      tryAnalyze(ev.projectPath);
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
