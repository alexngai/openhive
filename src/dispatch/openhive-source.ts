/**
 * OpenHive Dispatch Source — DispatchTaskSource adapter
 *
 * Composes swarm-dispatch's generic createSqlSource with OpenHive-specific
 * dispatches DAL and spec content enrichment from opentasks.
 */

import { createSqlSource } from 'swarm-dispatch/client';
import type { DispatchTaskSource, DispatchTask, DispatchRecord } from 'swarm-dispatch';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import type { Dispatch } from '../db/dal/dispatches.js';
import { advanceLinkedTasksOnStart } from './start.js';
import {
  materializeLoadoutById,
  materializeRoleLoadout,
  MaterializationForbiddenError,
} from '../openteams/resolver.js';
import { emptyMaterialization, type MaterializedLoadout } from '../openteams/types.js';
import { registerLoadoutForDispatch } from './loadout-side-channel.js';
import { registerRepoForDispatch, setActiveDispatchRepoId } from './repo-side-channel.js';
import { findRepoById } from '../db/dal/repos.js';
import { findSwarmById } from '../db/dal/map.js';
import { broadcastToChannel } from '../realtime/index.js';

export interface SpecContentFetcher {
  fetch(resourceId: string, specId: string): Promise<{
    title: string;
    content: string;
    tasks: Array<{ id: string; title?: string; status?: string }>;
    /** Optional spec node metadata, passed through verbatim. The dispatch
     *  source reads loadout_ref / team_role_ref from this. */
    metadata?: Record<string, unknown>;
  } | null>;
}

/**
 * Reconcile stop predicate (P4.5 Layer 1). swarm-dispatch's default
 * `shouldStop` only fires on task status `closed`/`blocked` (+ claim theft),
 * but `dispatchToTask` maps a `cancelled` dispatch row straight to
 * `task.status === 'cancelled'` — which the default ignores. Result: an
 * external cancel flipped the DB row but the running ACP agent kept churning
 * until stall timeout. Stopping on any terminal dispatch status makes the
 * reconcile tick reliably call `cancelExecutor` → `runtime.terminate`
 * (ACP `closeStream`).
 *
 * NOTE: mail-origin records are skipped by the library reconcile loop
 * (`record.origin === 'mail'`), so proactive cancel for mail-routed agents
 * still needs the MAP push (Layer 2, cross-repo sidecar work).
 */
export function reconcileShouldStop(task: DispatchTask, record: DispatchRecord): boolean {
  if (task.status === 'cancelled' || task.status === 'complete' || task.status === 'failed') {
    return true;
  }
  // Preserve the library defaults (closed/blocked + claim theft).
  if (task.status === 'closed' || task.status === 'blocked') return true;
  if (task.claimed_by != null && task.claimed_by !== record.claimantId) return true;
  return false;
}

function dispatchToTask(d: Dispatch): DispatchTask {
  // Resolve linked tasks so the prompt builder can reference them.
  // Fire-and-forget style: if the DAL throws, the task still proceeds.
  let linkedTasks: Array<{ resource_id: string; node_id: string; title?: string }> = [];
  try {
    linkedTasks = dispatchesDAL.getDispatchLinkedTasks(d.id);
  } catch { /* best effort */ }

  return {
    id: d.id,
    title: `[dispatch] ${d.spec_id}`,
    content: d.prompt_override ?? undefined,
    status: d.status === 'queued' ? 'open' : d.status,
    created_at: d.created_at,
    metadata: {
      spec_resource_id: d.spec_resource_id,
      spec_id: d.spec_id,
      spec_captured_at: d.spec_captured_at,
      target_swarm_id: d.target_swarm_id,
      initiator_type: d.initiator_type,
      initiator_id: d.initiator_id,
      prompt_override: d.prompt_override,
      // Structured fields for the prompt builder's coordination section
      initiator: { type: d.initiator_type, id: d.initiator_id },
      conversation_id: d.conversation_id ?? undefined,
      team_conversation_id: d.team_conversation_id ?? undefined,
      linkedTasks,
    },
  };
}

/**
 * Enrich a coordinated-team dispatch with its peer roster (P4.2). Reads the
 * sibling dispatches sharing the same `team_conversation_id` and attaches a
 * `peers` list (swarm name + role, excluding self) so the prompt builder can
 * tell each agent who else is on the team and which shared thread to use.
 * Best-effort — a DB hiccup leaves the task un-enriched.
 */
function enrichWithTeam(task: DispatchTask): DispatchTask {
  const meta = task.metadata ?? {};
  const teamConversationId = meta.team_conversation_id as string | undefined;
  if (!teamConversationId) return task;

  try {
    const siblings = dispatchesDAL.listDispatchesByTeamConversation(teamConversationId);
    const peers = siblings
      .filter((d) => d.id !== task.id)
      .map((d) => ({
        swarmName: findSwarmById(d.target_swarm_id)?.name ?? d.target_swarm_id,
        role: d.role ?? undefined,
      }));
    if (peers.length === 0) return task;
    return { ...task, metadata: { ...meta, peers } };
  } catch {
    return task;
  }
}

async function enrichWithSpec(
  task: DispatchTask,
  specFetcher: SpecContentFetcher,
): Promise<DispatchTask> {
  const meta = task.metadata ?? {};
  const resourceId = meta.spec_resource_id as string;
  const specId = meta.spec_id as string;
  const promptOverride = meta.prompt_override as string | null;

  if (!resourceId || !specId) return task;

  try {
    const spec = await specFetcher.fetch(resourceId, specId);
    if (!spec) return task;

    const parts: string[] = [`# ${spec.title}`];
    if (spec.content) parts.push(spec.content);
    if (spec.tasks.length > 0) {
      parts.push('## Tasks');
      for (const t of spec.tasks) {
        const status = t.status ? `[${t.status}] ` : '';
        parts.push(`- ${status}\`${t.id}\` — ${t.title ?? '(untitled)'}`);
      }
    }
    if (promptOverride) {
      parts.push('## Additional instructions');
      parts.push(promptOverride);
    }

    return {
      ...task,
      title: spec.title,
      content: parts.join('\n\n'),
      metadata: {
        ...meta,
        spec_title: spec.title,
        criteria: spec.tasks.map((t) => t.title).filter(Boolean),
        description: spec.content,
        // Pass spec metadata through so downstream enrichment steps (e.g.
        // enrichWithLoadout) can read loadout_ref / team_role_ref.
        spec_metadata: spec.metadata ?? {},
      },
    };
  } catch {
    return task;
  }
}

interface SpecLoadoutBinding {
  loadoutRef?: string;
  teamRoleRef?: { teamTemplateId: string; role: string };
}

function readLoadoutBinding(meta: Record<string, unknown>): SpecLoadoutBinding | null {
  const specMeta = (meta.spec_metadata as Record<string, unknown> | undefined) ?? {};
  const loadoutRef =
    typeof specMeta.loadout_ref === 'string' ? specMeta.loadout_ref : undefined;
  const teamRoleRefRaw = specMeta.team_role_ref as
    | { teamTemplateId?: unknown; role?: unknown }
    | undefined;
  const teamRoleRef =
    teamRoleRefRaw &&
    typeof teamRoleRefRaw.teamTemplateId === 'string' &&
    typeof teamRoleRefRaw.role === 'string'
      ? { teamTemplateId: teamRoleRefRaw.teamTemplateId, role: teamRoleRefRaw.role }
      : undefined;
  if (!loadoutRef && !teamRoleRef) return null;
  return { loadoutRef, teamRoleRef };
}

/**
 * Read a loadout binding from the dispatch row's openteams *resource* refs
 * (V64) — the modal's explicit loadout / team+role selection. Mirrors the
 * spec-metadata binding shape so `enrichWithLoadout` can materialize it
 * through the same resolver path. team_template + role wins over a bare
 * loadout (a role is the more specific choice).
 */
function readRowLoadoutBinding(row: Dispatch | null): SpecLoadoutBinding | null {
  if (!row) return null;
  const teamId = row.team_template_resource_id?.trim();
  const role = row.role?.trim();
  if (teamId && role) {
    return { teamRoleRef: { teamTemplateId: teamId, role } };
  }
  const loadoutId = row.loadout_resource_id?.trim();
  if (loadoutId) return { loadoutRef: loadoutId };
  return null;
}

/** Injectable broadcast fn — production uses broadcastToChannel; tests inject a spy. */
export type MaterializationBroadcastFn = (dispatchId: string, errorMessage: string) => void;

function defaultBroadcast(dispatchId: string, errorMessage: string): void {
  try {
    broadcastToChannel('map:dispatches', {
      type: 'dispatch.materialization_failed',
      data: {
        dispatch_id: dispatchId,
        error: errorMessage,
      },
    });
  } catch {
    /* best effort — realtime layer may not be initialized in all contexts */
  }
}

/**
 * Enrich a DispatchTask with a materialized loadout when the spec has a
 * loadout_ref or team_role_ref binding. Best-effort — failures attach a
 * `loadout_error` marker but never block dispatch.
 *
 * On failure: emits a `dispatch.materialization_failed` event on the
 * `map:dispatches` WS channel so operators see the error, logs a warning,
 * and returns the task unenriched.
 *
 * Precedence: direct loadout_ref > team_role_ref. Documented contract.
 */
export async function enrichWithLoadout(
  task: DispatchTask,
  _broadcast: MaterializationBroadcastFn = defaultBroadcast,
): Promise<DispatchTask> {
  const meta = task.metadata ?? {};
  // Fetch the dispatch row once — used for the row-level openteams binding
  // (V64), the bare-role executor hint, and the lifecycle hints below.
  const dispatchRow = dispatchesDAL.findDispatchById(task.id);
  // Explicit dispatch-row selection (the modal) takes precedence over the
  // spec's default binding. Row columns are null for legacy / spec-only
  // dispatches, so this is backward compatible.
  const binding = readRowLoadoutBinding(dispatchRow) ?? readLoadoutBinding(meta);
  // A role drives swarm-dispatch's chooseExecutor even without a loadout to
  // materialize. Prefer the binding's team role; fall back to a bare row role.
  const rowRole =
    dispatchRow?.role && dispatchRow.role.trim() ? dispatchRow.role.trim() : undefined;

  if (!binding) {
    // No loadout to materialize, but a bare role still selects an executor.
    if (rowRole) {
      return { ...task, metadata: { ...meta, role: rowRole } };
    }
    return task;
  }

  // Use the dispatch initiator's identity for ACL checks so a dispatcher
  // cannot leak content from resources they cannot access.
  const viewerAgentId =
    typeof meta.initiator_id === 'string' ? meta.initiator_id : undefined;

  // Stable string form of the binding for persistence — readers can resolve
  // back to the originating loadout without re-walking the spec metadata.
  const bindingRef = binding.loadoutRef
    ? binding.loadoutRef
    : binding.teamRoleRef
      ? `team:${binding.teamRoleRef.teamTemplateId}/role:${binding.teamRoleRef.role}`
      : '';

  try {
    let materialized: MaterializedLoadout;
    if (binding.loadoutRef) {
      materialized = await materializeLoadoutById(binding.loadoutRef, viewerAgentId);
    } else if (binding.teamRoleRef) {
      materialized = await materializeRoleLoadout(
        binding.teamRoleRef.teamTemplateId,
        binding.teamRoleRef.role,
        viewerAgentId,
      );
    } else {
      materialized = emptyMaterialization();
    }

    // Side-channel: register the materialized loadout so the mail port can
    // inject structured fields (permissions, mcp metadata) into the envelope's
    // body.metadata at deliver time. swarm-dispatch's MessagePort.deliver
    // payload only carries {prompt, taskId, role}; this bridges that gap.
    // See src/dispatch/loadout-side-channel.ts.
    //
    // Lifecycle hints: read from the dispatch row's `acp_lifecycle` (V47)
    // and `mail_lifecycle` (V48) columns. Both are set per-dispatch via
    // the REST request body — this keeps the routing concern at the
    // dispatch-creation layer, NOT on opentasks spec content (content
    // authoring) or loadout content (role-bundle abstraction). The
    // ACP runtime / mail port apply config-default fallbacks when the
    // respective column is null. (dispatchRow fetched once at the top.)
    const acpLifecycle =
      dispatchRow?.acp_lifecycle === 'fresh' || dispatchRow?.acp_lifecycle === 'reuse'
        ? dispatchRow.acp_lifecycle
        : undefined;
    const mailLifecycle =
      dispatchRow?.mail_lifecycle === 'fresh' || dispatchRow?.mail_lifecycle === 'reuse'
        ? dispatchRow.mail_lifecycle
        : undefined;
    const hints =
      acpLifecycle || mailLifecycle
        ? {
            ...(acpLifecycle ? { acpLifecycle } : {}),
            ...(mailLifecycle ? { mailLifecycle } : {}),
          }
        : undefined;
    registerLoadoutForDispatch(task.id, materialized, hints);

    // Persist resolution outcome (V49) so the detail UI shows what loadout
    // was attached after the side-channel TTL expires (5 min) or after a
    // page refresh — and so post-hoc audit doesn't have to replay events.
    if (bindingRef) {
      try {
        dispatchesDAL.recordLoadoutResolution(task.id, {
          ref: bindingRef,
          status: 'materialized',
        });
      } catch {
        /* best effort — DB hiccup must not block enrichment */
      }
    }

    // Surface the spec's team_role_ref.role onto task.metadata.role so
    // swarm-dispatch's chooseExecutor reads it (`task.metadata?.role ??
    // config.defaultRole`) and passes it as the role filter to
    // roster.findAvailable. Without this, prefer-route falls back to the
    // hub's defaultRole (typically 'worker') which matches the sidecar's
    // projected role and routes mail+reuse dispatches through the
    // sidecar's fresh-spawn path instead of the dispatched role's
    // long-lived agent. Only set when the spec carries a team_role_ref;
    // direct loadout_ref dispatches stay role-less.
    return {
      ...task,
      metadata: {
        ...meta,
        materializedLoadout: materialized,
        ...(binding.teamRoleRef?.role
          ? { role: binding.teamRoleRef.role }
          : rowRole
            ? { role: rowRole }
            : {}),
      },
    };
  } catch (err) {
    // Use a generic message for authorization failures so iterated resource
    // ids cannot enumerate ACL-protected resources via error text.
    const errorMessage =
      err instanceof MaterializationForbiddenError ? 'unauthorized' : (err as Error).message;
    // Best-effort: dispatch proceeds without enrichment. Surface the failure
    // via WS broadcast so operators see it, and attach a metadata marker for
    // downstream consumers. A typo'd extends: or missing loadout id should
    // never be silent.
    console.warn(
      `[dispatch] loadout materialization failed for dispatch ${task.id}: ${errorMessage}`,
    );
    _broadcast(task.id, errorMessage);
    // Sticky persistence (V49): the WS event only reaches clients
    // subscribed at the moment it fires. Also write the failure to the
    // dispatch row so the UI banner survives refresh and audit can read
    // directly from the row.
    if (bindingRef) {
      try {
        dispatchesDAL.recordLoadoutResolution(task.id, {
          ref: bindingRef,
          status: 'failed',
          error: errorMessage,
        });
      } catch {
        /* best effort */
      }
    }
    return {
      ...task,
      metadata: {
        ...meta,
        loadout_error: errorMessage,
      },
    };
  }
}

/**
 * Count unread thread messages for a dispatch's current executor. Used by the
 * continuation prompt to nudge the agent to check its inbox. Best-effort —
 * failures return 0.
 */
export async function countPendingThreadMessages(
  conversationId: string,
  executorAgentId: string | undefined,
  mailRpc: { handleRequest: (req: unknown) => Promise<unknown> },
): Promise<number> {
  try {
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = (await mailRpc.handleRequest({
      jsonrpc: '2.0',
      id,
      method: 'mail/turns/list',
      params: { conversationId },
    })) as { result?: { turns?: Array<{ agentId?: string; created_at?: string }> } };
    const turns = response?.result?.turns;
    if (!Array.isArray(turns) || turns.length === 0) return 0;
    if (!executorAgentId) return turns.length;
    // Count turns posted after the executor's last turn
    const lastExecutorTurn = [...turns]
      .reverse()
      .find((t) => t.agentId === executorAgentId);
    if (!lastExecutorTurn?.created_at) return turns.length;
    return turns.filter(
      (t) => t.agentId !== executorAgentId && t.created_at! > lastExecutorTurn.created_at!,
    ).length;
  } catch {
    return 0;
  }
}

function enrichWithRepo(task: DispatchTask): DispatchTask {
  const meta = task.metadata ?? {};
  const specMeta = (meta.spec_metadata as Record<string, unknown> | undefined) ?? {};

  // Dispatch row columns (V54) are the primary source. Spec metadata is a
  // fallback for repo_id only — branch/commit/clone are dispatch-only concerns.
  const dispatchRow = dispatchesDAL.findDispatchById(task.id);
  const repoId =
    dispatchRow?.repo_id
      ?? (typeof meta.repo_id === 'string' ? meta.repo_id : undefined)
      ?? (typeof specMeta.repo_id === 'string' ? specMeta.repo_id : undefined);

  if (!repoId) return task;

  setActiveDispatchRepoId(repoId);

  // Resolve canonical_url from the repo row if not already on the dispatch.
  let canonicalUrl = dispatchRow?.canonical_url ?? undefined;
  if (!canonicalUrl) {
    const repo = findRepoById(repoId);
    if (repo) {
      canonicalUrl = repo.git_remote_url;
      try {
        dispatchesDAL.recordRepoResolution(task.id, canonicalUrl);
      } catch { /* best effort */ }
    }
  }

  // Register the full binding AFTER canonical_url resolution so the
  // mail port's injectRepoMetadata sees the resolved value.
  registerRepoForDispatch(task.id, repoId, {
    canonicalUrl,
    branch: dispatchRow?.branch ?? undefined,
    commitSha: dispatchRow?.commit_sha ?? undefined,
    clonePolicy: dispatchRow?.clone_policy ?? undefined,
    clonePath: dispatchRow?.clone_path ?? undefined,
  });

  const additions: Record<string, unknown> = { repo_id: repoId };
  if (canonicalUrl) additions.canonical_url = canonicalUrl;
  if (dispatchRow?.branch) additions.branch = dispatchRow.branch;
  if (dispatchRow?.commit_sha) additions.commit_sha = dispatchRow.commit_sha;
  if (dispatchRow?.clone_policy && dispatchRow.clone_policy !== 'none') {
    additions.clone_policy = dispatchRow.clone_policy;
  }
  if (dispatchRow?.clone_path) additions.clone_path = dispatchRow.clone_path;

  return { ...task, metadata: { ...meta, ...additions } };
}

export interface DispatchSourceDeps {
  /** Optional mail RPC for pending-message enrichment on continuations. */
  getMailJsonRpc?: () => { handleRequest: (req: unknown) => Promise<unknown> };
}

export function createOpenHiveDispatchSource(
  specFetcher: SpecContentFetcher,
  claimantId: string,
  deps: DispatchSourceDeps = {},
): DispatchTaskSource {
  async function enrich(task: DispatchTask): Promise<DispatchTask> {
    const withSpec = await enrichWithSpec(task, specFetcher);
    const withLoadout = await enrichWithLoadout(withSpec);
    const withRepo = enrichWithRepo(withLoadout);
    const withTeam = enrichWithTeam(withRepo);
    return enrichWithPendingMessages(withTeam);
  }

  /**
   * Enrich continuation tasks with pending thread message count so the
   * prompt builder can nudge the agent to check its inbox.
   */
  async function enrichWithPendingMessages(task: DispatchTask): Promise<DispatchTask> {
    const meta = task.metadata ?? {};
    const conversationId = meta.conversation_id as string | undefined;
    if (!conversationId || !deps.getMailJsonRpc) return task;

    // Resolve the current executor from the dispatch's latest running attempt
    const dispatch = dispatchesDAL.findDispatchById(task.id);
    const currentAttempt = dispatch?.attempts_history
      ?.filter((a) => a.status === 'running')
      .pop();
    const executorAgentId = currentAttempt?.agent_id;

    const pending = await countPendingThreadMessages(
      conversationId,
      executorAgentId,
      deps.getMailJsonRpc(),
    );
    if (pending <= 0) return task;

    return {
      ...task,
      metadata: { ...meta, pendingThreadMessages: pending },
    };
  }

  const source = createSqlSource<Dispatch>({
    claimantId,

    queryReady: ({ limit }) => dispatchesDAL.listQueuedDispatches(limit),

    claimRow: (id, claimant) => dispatchesDAL.claimDispatch(id, claimant),

    releaseRow: (id, fence) => dispatchesDAL.releaseDispatch(id, fence),

    transitionRow: (id, action, fence) => {
      dispatchesDAL.transitionDispatch(id, action, fence);
      // On successful claim, advance opentasks tasks linked to the spec from
      // `open` → `in_progress`. Fire-and-forget: daemon hiccups must not
      // block the dispatch itself.
      if (action === 'start') {
        void advanceLinkedTasksOnStart(id);
      }
    },

    getRow: (id) => dispatchesDAL.findDispatchById(id),

    // listInProgress is called once at orchestrator startup to reconstruct the
    // in-memory tracker from rows that were running before the hub restarted.
    // reconstructFromTasks() only reads id, claimed_by, metadata.attempt,
    // metadata.role, tags, and metadata.dimensions — none of which come from
    // loadout enrichment. Enrichment is intentionally skipped here; the
    // orchestrator always re-enriches via getTask() (which calls enrichContent)
    // before building a prompt for any retry or continuation.
    listInProgress: () => dispatchesDAL.listInProgressDispatches(),

    rowToTask: dispatchToTask,

    isStillActive: (d) =>
      d.status !== 'cancelled' && d.status !== 'complete' && d.status !== 'failed',

    renewRow: (id, fence) => dispatchesDAL.renewDispatchClaim(id, fence),

    // enrichContent is called by createSqlSource on getTask() — used for
    // continuations, retries, and reconciliation paths. The initial dispatch
    // path (queryReady → dispatchTask → promptBuilder) receives unenriched
    // tasks from the library, so we also wrap queryReady below.
    enrichContent: enrich,
  });

  // swarm-dispatch's createSqlSource calls enrichContent only on getTask(),
  // not on queryReady(). The orchestrator builds the first-run prompt from
  // the task returned by queryReady, so without this wrapper the loadout
  // content (spec body, promptAddendum, skills) would be absent from the
  // first prompt. Wrap queryReady to enrich every returned task so the
  // prompt builder sees the full materialized payload regardless of path.
  const originalQueryReady = source.queryReady.bind(source);
  source.queryReady = async (opts) => {
    const tasks = await originalQueryReady(opts);
    return Promise.all(tasks.map(enrich));
  };

  return source;
}
