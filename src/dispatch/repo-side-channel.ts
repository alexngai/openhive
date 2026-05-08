/**
 * Repo side-channel — passes the current dispatch's repo_id to the roster.
 *
 * Same pattern as delivery-tracker.ts: enrichment registers, the roster
 * reads, stale entries expire. The roster can't receive task-specific
 * context through swarm-dispatch's AgentRoster interface, so this bridges
 * the gap.
 */

const repoHints = new Map<string, { repoId: string; registeredAt: number }>();

const TTL_MS = 5 * 60 * 1000;

export function registerRepoForDispatch(taskId: string, repoId: string): void {
  repoHints.set(taskId, { repoId, registeredAt: Date.now() });
}

export function getRepoForDispatch(taskId: string): string | undefined {
  const entry = repoHints.get(taskId);
  if (!entry) return undefined;
  if (Date.now() - entry.registeredAt > TTL_MS) {
    repoHints.delete(taskId);
    return undefined;
  }
  return entry.repoId;
}

export function clearRepoForDispatch(taskId: string): void {
  repoHints.delete(taskId);
}

let activeRepoId: string | undefined;

export function setActiveDispatchRepoId(repoId: string | undefined): void {
  activeRepoId = repoId;
}

export function getActiveDispatchRepoId(): string | undefined {
  return activeRepoId;
}

export function _resetRepoSideChannelForTest(): void {
  repoHints.clear();
  activeRepoId = undefined;
}
