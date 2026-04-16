/**
 * OpenHive Dispatch Source — DispatchTaskSource adapter
 *
 * Maps OpenHive's `dispatches` table to swarm-dispatch's task source interface.
 * The orchestrator polls queued dispatches, claims them with fence tokens,
 * and transitions status as agents execute.
 *
 * Spec content is fetched from the opentasks daemon (local or remote) and
 * assembled into the DispatchTask.content field for the prompt builder.
 */

import type {
  DispatchTaskSource,
  DispatchTask,
  ClaimResult,
  FenceToken,
  RenewResult,
} from 'swarm-dispatch';
import * as dispatchesDAL from '../db/dal/dispatches.js';

export interface SpecContentFetcher {
  fetch(resourceId: string, specId: string): Promise<{
    title: string;
    content: string;
    tasks: Array<{ id: string; title?: string; status?: string }>;
  } | null>;
}

export function createOpenHiveDispatchSource(
  specFetcher: SpecContentFetcher,
  claimantId: string,
): DispatchTaskSource {
  return {
    async queryReady(opts) {
      const limit = opts?.limit ?? 50;
      const dispatches = dispatchesDAL.listQueuedDispatches(limit);

      return dispatches.map((d): DispatchTask => ({
        id: d.id,
        title: `[dispatch] ${d.spec_id}`,
        content: d.prompt_override ?? undefined,
        status: d.status,
        tags: opts?.tags,
        priority: undefined,
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
      }));
    },

    async claim(taskId: string, _claimantId: string): Promise<ClaimResult> {
      const result = dispatchesDAL.claimDispatch(taskId, claimantId);
      return {
        success: result.success,
        fence: result.fence as FenceToken,
        claimedBy: result.claimedBy,
      };
    },

    async release(taskId: string, _claimantId: string, fence?: FenceToken): Promise<void> {
      dispatchesDAL.releaseDispatch(taskId, fence as string | undefined);
    },

    async transition(taskId: string, action: 'start' | 'complete' | 'fail', fence?: FenceToken): Promise<void> {
      // Don't write outcome on intermediate failures — the orchestrator may
      // retry. Terminal outcomes are written by the event bridge in setup.ts
      // when the orchestrator emits 'completed' or 'dead'.
      dispatchesDAL.transitionDispatch(taskId, action, fence as string | undefined);
    },

    async getTask(taskId: string): Promise<DispatchTask> {
      const d = dispatchesDAL.findDispatchById(taskId);
      if (!d) throw new Error(`Dispatch ${taskId} not found`);

      const meta = {
        spec_resource_id: d.spec_resource_id,
        spec_id: d.spec_id,
        spec_captured_at: d.spec_captured_at,
        target_swarm_id: d.target_swarm_id,
        initiator_type: d.initiator_type,
        initiator_id: d.initiator_id,
        prompt_override: d.prompt_override,
      } as Record<string, unknown>;

      let content = d.prompt_override ?? '';
      try {
        const spec = await specFetcher.fetch(d.spec_resource_id, d.spec_id);
        if (spec) {
          const parts: string[] = [];
          parts.push(`# ${spec.title}`);
          if (spec.content) parts.push(spec.content);
          if (spec.tasks.length > 0) {
            parts.push('## Tasks');
            for (const t of spec.tasks) {
              const status = t.status ? `[${t.status}] ` : '';
              parts.push(`- ${status}\`${t.id}\` — ${t.title ?? '(untitled)'}`);
            }
          }
          if (d.prompt_override) {
            parts.push('## Additional instructions');
            parts.push(d.prompt_override);
          }
          content = parts.join('\n\n');
          meta.spec_title = spec.title;
          meta.criteria = spec.tasks.map((t) => t.title).filter(Boolean);
          meta.description = spec.content;
        }
      } catch {
        // Spec unreachable — use prompt_override alone
      }

      return {
        id: d.id,
        title: (meta.spec_title as string) ?? `dispatch:${d.spec_id}`,
        content,
        status: d.status === 'queued' ? 'open' : d.status,
        created_at: d.created_at,
        metadata: meta,
      };
    },

    async isStillActive(taskId: string): Promise<boolean> {
      const d = dispatchesDAL.findDispatchById(taskId);
      return !!d && d.status !== 'cancelled' && d.status !== 'complete' && d.status !== 'failed';
    },

    async listInProgress(): Promise<DispatchTask[]> {
      const dispatches = dispatchesDAL.listInProgressDispatches();
      return dispatches.map((d): DispatchTask => ({
        id: d.id,
        title: `[dispatch] ${d.spec_id}`,
        status: 'in_progress',
        created_at: d.created_at,
        metadata: {
          spec_resource_id: d.spec_resource_id,
          spec_id: d.spec_id,
          target_swarm_id: d.target_swarm_id,
        },
      }));
    },

    async renewClaim(taskId: string, fence: FenceToken): Promise<RenewResult> {
      const result = dispatchesDAL.renewDispatchClaim(taskId, fence as string);
      if (result.ok) {
        return { ok: true, fence };
      }
      return { ok: false, reason: result.reason ?? 'claim lost' };
    },
  };
}
