/**
 * Repo side-channel — passes the current dispatch's repo binding to the
 * roster and the mail port.
 *
 * Same pattern as delivery-tracker.ts: enrichment registers, the roster
 * and mail port read, stale entries expire. The roster can't receive
 * task-specific context through swarm-dispatch's AgentRoster interface,
 * and the mail port's envelope only carries {prompt, taskId, role} — this
 * bridges both gaps.
 */

export interface RepoBinding {
  repoId: string;
  canonicalUrl?: string;
  branch?: string;
  commitSha?: string;
  clonePolicy?: string;
  clonePath?: string;
}

const repoHints = new Map<string, { binding: RepoBinding; registeredAt: number }>();

const TTL_MS = 5 * 60 * 1000;

export function registerRepoForDispatch(taskId: string, repoId: string, binding?: Omit<RepoBinding, 'repoId'>): void {
  repoHints.set(taskId, {
    binding: { repoId, ...binding },
    registeredAt: Date.now(),
  });
}

export function getRepoForDispatch(taskId: string): string | undefined {
  return getRepoBindingForDispatch(taskId)?.repoId;
}

export function getRepoBindingForDispatch(taskId: string): RepoBinding | undefined {
  const entry = repoHints.get(taskId);
  if (!entry) return undefined;
  if (Date.now() - entry.registeredAt > TTL_MS) {
    repoHints.delete(taskId);
    return undefined;
  }
  return entry.binding;
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
