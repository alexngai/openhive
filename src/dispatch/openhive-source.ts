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

export interface SpecContentFetcher {
  fetch(resourceId: string, specId: string): Promise<{
    title: string;
    content: string;
    tasks: Array<{ id: string; title?: string; status?: string }>;
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
      },
    };
  } catch {
    return task;
  }
}

export function createOpenHiveDispatchSource(
  specFetcher: SpecContentFetcher,
  claimantId: string,
): DispatchTaskSource {
  return createSqlSource<Dispatch>({
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

    listInProgress: () => dispatchesDAL.listInProgressDispatches(),

    rowToTask: dispatchToTask,

    isStillActive: (d) =>
      d.status !== 'cancelled' && d.status !== 'complete' && d.status !== 'failed',

    renewRow: (id, fence) => dispatchesDAL.renewDispatchClaim(id, fence),

    enrichContent: (task) => enrichWithSpec(task, specFetcher),
  });
}
