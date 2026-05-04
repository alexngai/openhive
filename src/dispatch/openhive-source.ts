/**
 * OpenHive Dispatch Source — DispatchTaskSource adapter
 *
 * Composes swarm-dispatch's generic createSqlSource with OpenHive-specific
 * dispatches DAL and spec content enrichment from opentasks.
 */

import { createSqlSource } from 'swarm-dispatch/client';
import type { DispatchTaskSource, DispatchTask } from 'swarm-dispatch';
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

function dispatchToTask(d: Dispatch): DispatchTask {
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
    },
  };
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
  const binding = readLoadoutBinding(meta);
  if (!binding) return task;

  // Use the dispatch initiator's identity for ACL checks so a dispatcher
  // cannot leak content from resources they cannot access.
  const viewerAgentId =
    typeof meta.initiator_id === 'string' ? meta.initiator_id : undefined;

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
    // ACP lifecycle hint: read from the dispatch row's `acp_lifecycle`
    // column (V47 schema). The column is set per-dispatch via the REST
    // request body's `acp_lifecycle` field — this keeps the routing
    // concern at the dispatch-creation layer, NOT on opentasks spec
    // content (which is content authoring) or loadout content (which is
    // a role-bundle abstraction). The resolver later applies the
    // config-default fallback when the column is null.
    const dispatchRow = dispatchesDAL.findDispatchById(task.id);
    const acpLifecycle =
      dispatchRow?.acp_lifecycle === 'fresh' || dispatchRow?.acp_lifecycle === 'reuse'
        ? dispatchRow.acp_lifecycle
        : undefined;
    registerLoadoutForDispatch(
      task.id,
      materialized,
      acpLifecycle ? { acpLifecycle } : undefined,
    );

    return {
      ...task,
      metadata: { ...meta, materializedLoadout: materialized },
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
    return {
      ...task,
      metadata: {
        ...meta,
        loadout_error: errorMessage,
      },
    };
  }
}

export function createOpenHiveDispatchSource(
  specFetcher: SpecContentFetcher,
  claimantId: string,
): DispatchTaskSource {
  async function enrich(task: DispatchTask): Promise<DispatchTask> {
    const withSpec = await enrichWithSpec(task, specFetcher);
    return enrichWithLoadout(withSpec);
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
