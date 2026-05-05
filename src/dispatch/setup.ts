/**
 * Dispatch Orchestrator Setup
 *
 * Wires swarm-dispatch into the OpenHive server. Creates the orchestrator
 * with OpenHive-specific adapters and bridges events to the WS channel.
 */

import { hostname } from 'node:os';
import { createOrchestrator, heuristicScorer, noopScorer } from 'swarm-dispatch';
import type { Orchestrator, DispatchEvent, MessagePort, EligibilityScorer } from 'swarm-dispatch';
import { createOpenHiveDispatchSource } from './openhive-source.js';
import type { SpecContentFetcher } from './openhive-source.js';
import { createOpenHiveAgentRuntime } from './openhive-runtime.js';
import type { OpenHiveRuntimeDeps } from './openhive-runtime.js';
import { createOpenHiveRoster } from './openhive-roster.js';
import { openHivePromptBuilder } from './prompt.js';
import { broadcastToChannel } from '../realtime/index.js';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { finalizeDispatch } from './finalize.js';
import { claimDelivery } from './delivery-tracker.js';
import type { Config } from '../config.js';

export interface SetupOrchestratorOptions {
  specFetcher: SpecContentFetcher;
  runtimeDeps: OpenHiveRuntimeDeps;
  messagePort?: MessagePort;
  /**
   * Dispatch-specific config section. Optional so tests can omit. Accepts
   * a partial — the helper applies its own defaults for any missing
   * fields, mirroring the Zod-default behavior of the full config schema.
   */
  dispatchConfig?: Partial<Config['dispatch']>;
  /**
   * Orchestrator dispatch mode. Defaults to `'prefer-route'` (try mail
   * first, fall back to ACP spawn). Tests that want to exercise the ACP
   * path explicitly should pass `'spawn-only'` so the orchestrator goes
   * through the runtime adapter regardless of mail availability.
   */
  dispatchMode?: 'prefer-route' | 'spawn-only' | 'route-only' | 'prefer-spawn';
}

export function setupOrchestrator(opts: SetupOrchestratorOptions): Orchestrator {
  const claimantId = `openhive:${hostname()}:${process.pid}`;

  const source = createOpenHiveDispatchSource(opts.specFetcher, claimantId);
  const runtime = createOpenHiveAgentRuntime(opts.runtimeDeps);
  const roster = createOpenHiveRoster();

  const cfg = opts.dispatchConfig;
  const scorer: EligibilityScorer =
    cfg?.scorer === 'noop' ? noopScorer : heuristicScorer;

  const orchestrator = createOrchestrator(source, runtime, {
    claimantId,
    pollIntervalMs: cfg?.pollIntervalMs ?? 15_000,
    defaultRole: 'worker',
    concurrency: { global: cfg?.globalConcurrency ?? 5 },
    retry: {
      maxRetries: cfg?.retry?.maxRetries ?? 3,
      baseDelayMs: cfg?.retry?.baseDelayMs ?? 10_000,
      maxDelayMs: cfg?.retry?.maxDelayMs ?? 300_000,
    },
    continuation: { delayMs: 1_000, maxTurns: 20 },
    promptBuilder: openHivePromptBuilder,
    eligibility: { scorer },
    roster,
    messagePort: opts.messagePort,
    dispatchMode: opts.dispatchMode ?? 'prefer-route',
    heartbeatIntervalMs: 30_000,
    // Reconcile the external-cancel → agent-terminate path quickly. The
    // default (60s) leaves the user watching a spinner after they click
    // Cancel while the agent keeps churning; 5s is indistinguishable from
    // "immediate" for the hub workload and still well above poll overhead.
    reconcile: {
      enabled: true,
      intervalMs: cfg?.reconcileIntervalMs ?? 5_000,
      stallTimeoutMs: 300_000,
    },
  });

  orchestrator.onEvent((event: DispatchEvent) => {
    // Broadcast all orchestrator events to WS subscribers
    try {
      broadcastToChannel('map:dispatches', {
        type: `dispatch.${event.type}` as string,
        data: event as unknown,
        timestamp: new Date().toISOString(),
      } as Parameters<typeof broadcastToChannel>[1]);
    } catch {
      // best effort
    }

    const now = new Date().toISOString();

    // New attempt started → append to attempts_history. If the orchestrator
    // re-emits `dispatched` for the same attempt (claim contention, reconnect),
    // preserve the original `started_at` so the timeline doesn't drift.
    if (event.type === 'dispatched') {
      const attempt = 'attempt' in event ? (event as { attempt?: number }).attempt ?? 1 : 1;
      const current = dispatchesDAL.findDispatchById(event.taskId);
      const prior = current?.attempts_history.find((a) => a.attempt === attempt);
      dispatchesDAL.upsertDispatchAttempt(event.taskId, {
        attempt,
        started_at: prior?.started_at ?? now,
        status: 'running',
      });
      // Pair the orchestrator's view (event.agentId, event.via, event.attempt)
      // with the OpenHive transport hint that the runtime/mail-port stashed
      // in the delivery tracker. Merges into the same attempts_history row
      // so the UI can show "ACP · spawn · agent_id" / "Mail · route · agent_id".
      const eventDispatched = event as { agentId?: string; via?: 'spawn' | 'route' };
      const hint = claimDelivery(event.taskId);
      const transport = hint?.transport;
      const agent_id = eventDispatched.agentId ?? hint?.agent_id;
      const via = eventDispatched.via;
      if (transport || agent_id || via) {
        dispatchesDAL.recordAttemptDelivery(event.taskId, attempt, {
          ...(transport ? { transport } : {}),
          ...(agent_id ? { agent_id } : {}),
          ...(via ? { via } : {}),
        });
      }
    }

    // Terminal: agent completed successfully → mark dispatch complete
    // Guard: skip if already terminal (map/dispatches/report may have written first)
    //
    // No hub-authored summary here — narrative is agent-owned via
    // map/dispatches/report. Silent agents leave summary undefined; observed
    // facts (attempts, session_ids, cascade artifacts) still populate.
    if (event.type === 'completed') {
      const current = dispatchesDAL.findDispatchById(event.taskId);
      if (current && current.status !== 'complete' && current.status !== 'failed' && current.status !== 'cancelled') {
        finalizeDispatch(event.taskId, 'complete');
        const record = orchestrator.tracker.getTask(event.taskId);
        if (record) {
          dispatchesDAL.updateDispatchAttemptTurn(
            event.taskId,
            record.attempt,
            record.turnCount,
          );
          dispatchesDAL.upsertDispatchAttempt(event.taskId, {
            attempt: record.attempt,
            started_at: current.attempts_history.find((a) => a.attempt === record.attempt)?.started_at ?? now,
            ended_at: now,
            status: 'completed',
          });
        }
      }
    }

    // Terminal: all retries exhausted → mark dispatch failed with last error
    // Guard: skip if already terminal
    //
    // Hub doesn't author the narrative here either — `lastError` lives in
    // `attempts_history[n].error` and `attempts` in the dispatch row, so
    // the observed facts are preserved without shadowing the agent's voice.
    if (event.type === 'dead') {
      const current = dispatchesDAL.findDispatchById(event.taskId);
      if (current && current.status !== 'complete' && current.status !== 'failed' && current.status !== 'cancelled') {
        const lastError = 'lastError' in event ? (event as { lastError?: string }).lastError : undefined;
        const attempts = 'attempts' in event ? (event as { attempts?: number }).attempts : undefined;
        finalizeDispatch(event.taskId, 'failed');
        dispatchesDAL.updateDispatchAttemptTurn(
          event.taskId,
          attempts ?? 0,
          0,
        );
        if (attempts) {
          const prior = current.attempts_history.find((a) => a.attempt === attempts);
          dispatchesDAL.upsertDispatchAttempt(event.taskId, {
            attempt: attempts,
            started_at: prior?.started_at ?? now,
            ended_at: now,
            status: 'failed',
            error: lastError,
          });
        }
      }
    }

    // Retry scheduled → close the failing attempt with an error, set next_retry_at
    if (event.type === 'retrying') {
      const attempt = 'attempt' in event ? (event as { attempt?: number }).attempt : undefined;
      const nextAt = 'nextAt' in event ? (event as { nextAt?: number }).nextAt : undefined;
      const error = 'error' in event ? (event as { error?: string }).error : undefined;
      if (attempt !== undefined) {
        dispatchesDAL.updateDispatchAttemptTurn(event.taskId, attempt, 0);
        const current = dispatchesDAL.findDispatchById(event.taskId);
        const prior = current?.attempts_history.find((a) => a.attempt === attempt);
        dispatchesDAL.upsertDispatchAttempt(event.taskId, {
          attempt,
          started_at: prior?.started_at ?? now,
          ended_at: now,
          status: 'retrying',
          error,
          next_retry_at: nextAt ? new Date(nextAt).toISOString() : undefined,
        });
      }
    }

    // Cancelled by reconciliation → mark cancelled
    if (event.type === 'cancelled') {
      const dispatch = dispatchesDAL.findDispatchById(event.taskId);
      if (dispatch && dispatch.status !== 'cancelled' && dispatch.status !== 'complete' && dispatch.status !== 'failed') {
        dispatchesDAL.cancelDispatch(event.taskId);
      }
    }
  });

  return orchestrator;
}
