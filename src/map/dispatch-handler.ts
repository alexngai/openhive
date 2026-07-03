/**
 * MAP Dispatch Request Handler
 *
 * Handles `map/dispatches/*` MAP protocol methods — currently just `report`,
 * the agent-driven status-transition channel from D11. The seed prompt the
 * hub builds at dispatch time tells the agent: "When you finish or fail,
 * report back here." Agents can also report `running` to acknowledge they
 * picked the dispatch up; the hub flips queued → running. Per D9 there is
 * no per-agent capability gating; the reporter's id is captured for audit.
 */

import * as dispatchesDAL from '../db/dal/dispatches.js';
import type { DispatchOutcome, DispatchStatus } from '../db/dal/dispatches.js';
import { finalizeDispatch } from '../dispatch/finalize.js';

// ============================================================================
// Method Constants
// ============================================================================

export const MAP_DISPATCH_METHODS = {
  REPORT: 'map/dispatches/report',
} as const;

export const MAP_DISPATCH_METHOD_SET = new Set<string>(Object.values(MAP_DISPATCH_METHODS));

// ============================================================================
// Errors
// ============================================================================

export class MAPDispatchRequestError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = 'MAPDispatchRequestError';
  }
}

// ============================================================================
// Context
// ============================================================================

export interface DispatchRequestContext {
  swarmId: string;
  agentId: string;
}

// ============================================================================
// Allowed agent-reported transitions (D15)
//
// The hub itself writes `queued` (on insert) and `cancelled` (REST endpoint).
// Agents may report the others, mapped here. We accept `running` as an
// "I picked it up" acknowledgement so dispatches can flip out of `queued`
// without the hub orchestrating session bootstrap.
// ============================================================================

const AGENT_REPORTABLE_STATUSES = new Set<DispatchStatus>(['running', 'complete', 'failed']);

function isAgentReportable(s: unknown): s is DispatchStatus {
  return typeof s === 'string' && AGENT_REPORTABLE_STATUSES.has(s as DispatchStatus);
}

// ============================================================================
// Handler
// ============================================================================

export async function handleDispatchRequest(
  method: string,
  params: unknown,
  context: DispatchRequestContext,
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case MAP_DISPATCH_METHODS.REPORT: {
      const dispatchId = p.dispatch_id as string | undefined;
      const status = p.status;
      const outcomeRaw = p.outcome as Record<string, unknown> | undefined;

      if (!dispatchId) {
        throw new MAPDispatchRequestError(-32602, 'Invalid params: missing dispatch_id');
      }
      if (!isAgentReportable(status)) {
        throw new MAPDispatchRequestError(
          -32602,
          `Invalid params: status must be one of running | complete | failed (agent-reportable transitions per D15). Got: ${String(status)}`,
        );
      }

      const dispatch = dispatchesDAL.findDispatchById(dispatchId);
      if (!dispatch) {
        throw new MAPDispatchRequestError(-32001, `Dispatch not found: ${dispatchId}`);
      }
      if (dispatch.status === 'cancelled') {
        throw new MAPDispatchRequestError(
          -32000,
          'Cannot report on a cancelled dispatch',
        );
      }
      if (dispatch.status === 'complete' || dispatch.status === 'failed') {
        throw new MAPDispatchRequestError(
          -32000,
          `Cannot report on a terminal dispatch (current: ${dispatch.status})`,
        );
      }

      const outcome: DispatchOutcome | undefined = outcomeRaw as DispatchOutcome | undefined;
      // `running` is a non-terminal acknowledgement — leave it to the plain
      // status updater. Terminal transitions go through finalizeDispatch so
      // cascade artifacts get enriched onto the outcome.
      const updated =
        status === 'complete' || status === 'failed'
          ? finalizeDispatch(dispatchId, status, outcome)
          : dispatchesDAL.updateDispatchStatus(dispatchId, status, outcome);
      if (!updated) {
        throw new MAPDispatchRequestError(-32000, 'Failed to persist status update');
      }

      // Broadcast for hub WS subscribers (frontend invalidation).
      try {
        const { broadcastToChannel } = await import('../realtime/index.js');
        const eventType =
          status === 'complete' || status === 'failed'
            ? 'dispatch.completed'
            : 'dispatch.status_changed';
        broadcastToChannel('map:dispatches', {
          type: eventType,
          data: {
            dispatch: {
              id: updated.id,
              status: updated.status,
              outcome: updated.outcome,
            },
            spec_ref: {
              resource_id: updated.spec_resource_id,
              spec_id: updated.spec_id,
              captured_at: updated.spec_captured_at,
            },
            target_swarm_id: updated.target_swarm_id,
            initiator: { type: updated.initiator_type, id: updated.initiator_id },
            reporter: { type: 'agent', id: context.agentId, swarm_id: context.swarmId },
          },
        });
      } catch {
        /* best effort */
      }

      // Narrate agent-reported terminal outcomes into the spec discussion
      // thread (only if one has been opened). Best-effort — never breaks the
      // report path.
      if (
        (status === 'complete' || status === 'failed') &&
        updated.spec_resource_id &&
        updated.spec_id
      ) {
        try {
          const [{ postSpecThreadOutcome }, { getMailJsonRpc, getMailStorage }, { findSwarmById }] =
            await Promise.all([
              import('../specs/spec-conversation.js'),
              import('../mail/index.js'),
              import('../db/dal/map.js'),
            ]);
          const swarmName = findSwarmById(updated.target_swarm_id)?.name ?? updated.target_swarm_id;
          const detail =
            status === 'complete' ? updated.outcome?.summary : updated.outcome?.error;
          await postSpecThreadOutcome(
            {
              resourceId: updated.spec_resource_id,
              specId: updated.spec_id,
              dispatchId,
              outcome: status,
              swarmName,
              detail: detail ?? undefined,
              kind: updated.role === 'reviewer' ? 'validation' : 'dispatch',
            },
            { getMailJsonRpc, getMailStorage },
          );
        } catch {
          /* best effort */
        }
      }

      return { dispatch: updated };
    }

    default:
      throw new MAPDispatchRequestError(-32601, `Unknown method: ${method}`);
  }
}
