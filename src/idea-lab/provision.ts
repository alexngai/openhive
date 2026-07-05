/**
 * Idempotent boot-time provisioner for the idea lab.
 *
 * Applies a pack (graph + ledger resources, seed objectives, role schedules)
 * and converges to the declared state on every run — the "reload reliably
 * after install" guarantee. Reconciliation is keyed, never blind:
 *
 * - Resources upsert by (owner, type, name) via `upsertDiscoveredResource`.
 * - Objectives reconcile by an `idealab_key` stamped in spec metadata, and
 *   are CREATE-ONLY — we never rewrite an idea an agent may have evolved.
 * - Schedules reconcile by an `idealab_key` stamped in the payload, and are
 *   MANAGED — cron / prompt / targets are operator-owned config, so drift is
 *   reconciled (but paused-state is left to the operator after first create).
 *
 * Nothing here is destructive: it only creates and updates lab-owned rows.
 * Mirrors the boot-seed pattern of `map/hub-task-graph.ts` and
 * `openteams/seed.ts`.
 */

import * as path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { evaluateCron } from 'swarm-dispatch';

import * as resourcesDAL from '../db/dal/syncable-resources.js';
import * as schedulesDAL from '../db/dal/schedules.js';
import { findDefaultOwnerAgent } from '../db/dal/agents.js';
import { ensureInitialized } from '../map/task-daemon-lifecycle.js';
import {
  daemonCreateSpec,
  daemonGetGraph,
  resolveDaemonSocket,
} from '../map/task-daemon-client.js';
import { applyGitSyncConfig, type GitSyncMetadata } from '../swarmkit/git-sync-config.js';
import { DEFAULT_IDEA_LAB_PACK } from './pack.js';
import { objectiveKey, roleKey, type IdeaLabPack } from './types.js';

/** Initiator id stamped on every lab-owned schedule (scopes reconcile). */
export const IDEA_LAB_INITIATOR = 'idea-lab';

export type ReconcileMode = 'create-only' | 'managed';

export interface ProvisionIdeaLabDeps {
  /** Resolved openhive data dir (`resolveDataDir()` at the call site). */
  dataDir: string;
  /** Pack to apply; defaults to the checked-in {@link DEFAULT_IDEA_LAB_PACK}. */
  pack?: IdeaLabPack;
  /** Schedule tenancy tag. */
  hiveId?: string;
  /** Swarms the role dispatches target. Empty → schedules created paused. */
  targetSwarmIds?: string[];
  /** Schedule reconcile mode (default "managed"). Objectives are always create-only. */
  reconcile?: ReconcileMode;
  /**
   * Optional shared git remote for the lab graph. When set, the graph is
   * registered as a standard git-synced task resource (metadata.git_sync +
   * applyGitSyncConfig). When unset, the graph is hub-local (default).
   */
  gitRemote?: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

export interface ProvisionSummary {
  ok: boolean;
  /** True when there was no owner agent yet — caller may retry next boot. */
  deferred: boolean;
  graph?: { resourceId: string; created: boolean };
  ledger?: { resourceId: string; created: boolean };
  objectives: { created: number; existing: number };
  schedules: { created: number; updated: number; unchanged: number; paused: number };
  warnings: string[];
}

function readPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (payload ?? {}) as Record<string, unknown>;
}

/**
 * Ensure `root` is a git working copy whose `origin` points at `remote`.
 * git-inits if needed and adds/updates the remote. No fetch/clone here — the
 * opentasks daemon's git-sync (pullOnStartup) converges content on start.
 */
function ensureGitRemote(root: string, remote: string): void {
  mkdirSync(root, { recursive: true });
  if (!existsSync(path.join(root, '.git'))) {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  }
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['remote', 'set-url', 'origin', remote], { cwd: root, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: root, stdio: 'ignore' });
  }
}

/**
 * Provision (or reconcile) the idea lab. Safe to call on every boot.
 */
export async function provisionIdeaLab(
  deps: ProvisionIdeaLabDeps,
): Promise<ProvisionSummary> {
  const pack = deps.pack ?? DEFAULT_IDEA_LAB_PACK;
  const hiveId = deps.hiveId ?? '';
  const targetSwarmIds = deps.targetSwarmIds ?? [];
  const reconcile: ReconcileMode = deps.reconcile ?? 'managed';
  const log = deps.logger ?? {
    info: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
  };

  const summary: ProvisionSummary = {
    ok: false,
    deferred: false,
    objectives: { created: 0, existing: 0 },
    schedules: { created: 0, updated: 0, unchanged: 0, paused: 0 },
    warnings: [],
  };

  const owner = findDefaultOwnerAgent();
  if (!owner) {
    summary.deferred = true;
    summary.warnings.push('no owner agent yet — deferring idea-lab provisioning');
    log.warn('[idea-lab] no owner agent — deferring provisioning to a later boot');
    return summary;
  }

  // 1. Ensure the lab's OpenTasks graph resource (holds ideas + objectives).
  //    Default: a hub-local graph (git_remote_url points at the local dir).
  //    When `gitRemote` is set, it becomes a STANDARD git-synced task resource
  //    — same metadata.git_sync + applyGitSyncConfig any git-backed opentasks
  //    graph uses — so connected swarms can clone/read/write it and converge.
  //    Nothing here is idea-lab-special; regular opentasks flows are untouched.
  const graphRoot = path.join(deps.dataDir, 'idea-lab');
  const graphDir = path.join(graphRoot, '.opentasks');
  ensureInitialized(graphDir);

  let graphRemoteUrl = graphDir;
  const graphMetadata: Record<string, unknown> = { opentasks: true, idea_lab: true };

  if (deps.gitRemote) {
    graphRemoteUrl = deps.gitRemote;
    const gitSync: GitSyncMetadata = {
      enabled: true,
      remote: 'origin',
      autoCommit: true,
      autoPush: true,
      pullOnStartup: true,
      pullOnSignal: true,
    };
    graphMetadata.git_sync = gitSync;
    try {
      ensureGitRemote(graphRoot, deps.gitRemote);
      applyGitSyncConfig(graphRoot, gitSync);
    } catch (err) {
      summary.warnings.push(`git-sync setup for lab graph failed: ${(err as Error).message}`);
    }
  }

  const graphUpsert = resourcesDAL.upsertDiscoveredResource({
    resource_type: 'task',
    name: pack.graph.name,
    description: pack.graph.description ?? 'Idea-lab OpenTasks graph',
    git_remote_url: graphRemoteUrl,
    local_path: graphDir,
    sync_strategy: 'local',
    owner_agent_id: owner.id,
    scope: 'global',
    visibility: 'public',
    metadata: graphMetadata,
  });
  summary.graph = { resourceId: graphUpsert.resource.id, created: graphUpsert.created };

  // 2. Ensure the ledger memory bank resource (tried / killed / shipped).
  const ledgerDir = path.join(deps.dataDir, 'idea-lab', 'ledger');
  mkdirSync(ledgerDir, { recursive: true });
  const ledgerUpsert = resourcesDAL.upsertDiscoveredResource({
    resource_type: 'memory_bank',
    name: pack.ledger.name,
    description: pack.ledger.description ?? 'Idea-lab ledger',
    git_remote_url: ledgerDir,
    local_path: ledgerDir,
    sync_strategy: 'local',
    owner_agent_id: owner.id,
    scope: 'global',
    visibility: 'public',
    metadata: { idea_lab: true, ledger: true },
  });
  summary.ledger = { resourceId: ledgerUpsert.resource.id, created: ledgerUpsert.created };

  // 3. Reconcile objective specs (CREATE-ONLY, keyed by metadata.idealab_key).
  //    Only touch the OpenTasks daemon when there are objectives to seed.
  if (pack.objectives.length > 0) {
    const socket = resolveDaemonSocket(graphDir);
    const existingKeys = new Set<string>();
    try {
      const graph = await daemonGetGraph(socket, graphDir, { includeArchived: true });
      for (const node of graph.nodes) {
        const meta = (node.metadata ?? {}) as Record<string, unknown>;
        if (typeof meta.idealab_key === 'string') existingKeys.add(meta.idealab_key);
      }
    } catch (err) {
      summary.warnings.push(
        `could not read idea graph for objective reconcile: ${(err as Error).message}`,
      );
    }
    for (const obj of pack.objectives) {
      const key = objectiveKey(obj.key);
      if (existingKeys.has(key)) {
        summary.objectives.existing++;
        continue;
      }
      try {
        await daemonCreateSpec(
          socket,
          {
            title: obj.title,
            content: obj.content,
            priority: obj.priority,
            metadata: {
              idealab_key: key,
              idea_lab: true,
              idealab: { role: 'objective', tier: 'anchored' },
            },
          },
          graphDir,
        );
        summary.objectives.created++;
      } catch (err) {
        summary.warnings.push(`objective "${obj.key}" create failed: ${(err as Error).message}`);
      }
    }
  }

  // 4. Reconcile role schedules (keyed by payload.idealab_key).
  const willPause = targetSwarmIds.length === 0;
  if (willPause) {
    summary.warnings.push('no target swarms configured — role schedules created paused');
  }
  const existing = schedulesDAL.listSchedules({
    hive_id: hiveId,
    initiator_id: IDEA_LAB_INITIATOR,
    limit: 1000,
  }).data;
  const byKey = new Map<string, (typeof existing)[number]>();
  for (const s of existing) {
    const p = readPayload(s.payload);
    if (typeof p.idealab_key === 'string') byKey.set(p.idealab_key, s);
  }

  for (const role of pack.roles) {
    const key = roleKey(role.key);
    const payload = {
      kind: 'dispatch_prompt' as const,
      prompt: role.prompt,
      target_swarm_ids: targetSwarmIds,
      idealab_key: key,
    };
    const found = byKey.get(key);

    if (!found) {
      const next = evaluateCron(role.cron, { now: new Date(), timezone: role.timezone });
      schedulesDAL.createSchedule({
        cron: role.cron,
        timezone: role.timezone,
        payload,
        paused: willPause || role.paused === true,
        next_fires_at: next ? next.toISOString() : null,
        hive_id: hiveId,
        initiator_type: 'user',
        initiator_id: IDEA_LAB_INITIATOR,
      });
      summary.schedules.created++;
      if (willPause || role.paused === true) summary.schedules.paused++;
      continue;
    }

    if (reconcile === 'create-only') {
      summary.schedules.unchanged++;
      continue;
    }

    // managed: reconcile cron / prompt / targets if they drifted.
    const fp = readPayload(found.payload);
    const cronChanged = found.cron !== role.cron;
    const promptChanged = fp.prompt !== role.prompt;
    const targetsChanged =
      JSON.stringify(fp.target_swarm_ids ?? []) !== JSON.stringify(targetSwarmIds);

    if (cronChanged || promptChanged || targetsChanged) {
      const patch: schedulesDAL.UpdateScheduleInput = { payload };
      if (cronChanged) {
        const next = evaluateCron(role.cron, { now: new Date(), timezone: role.timezone });
        patch.cron = role.cron;
        patch.next_fires_at = next ? next.toISOString() : null;
      }
      schedulesDAL.updateSchedule(found.id, patch);
      summary.schedules.updated++;
    } else {
      summary.schedules.unchanged++;
    }
  }

  summary.ok = true;
  log.info(
    `[idea-lab] provisioned: graph ${summary.graph?.created ? 'created' : 'exists'}, ` +
      `ledger ${summary.ledger?.created ? 'created' : 'exists'}, ` +
      `objectives +${summary.objectives.created} (${summary.objectives.existing} existing), ` +
      `schedules +${summary.schedules.created} ~${summary.schedules.updated} ` +
      `=${summary.schedules.unchanged}${willPause ? ' (paused: no target swarms)' : ''}`,
  );
  return summary;
}
