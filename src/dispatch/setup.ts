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
import type { SpecContentFetcher, DispatchSourceDeps } from './openhive-source.js';
import { createOpenHiveAgentRuntime } from './openhive-runtime.js';
import type { OpenHiveRuntimeDeps } from './openhive-runtime.js';
import {
  createOpenHiveSwarmCodexRuntime,
  type SwarmCodexDispatchRuntime,
} from './swarm-codex-runtime.js';
import { createOpenHiveRoster } from './openhive-roster.js';
import { openHivePromptBuilder } from './prompt.js';
import { broadcastToChannel } from '../realtime/index.js';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { finalizeDispatch } from './finalize.js';
import {
  claimDelivery,
  getThreadDrivenCount,
  incrementThreadDrivenCount,
  clearThreadDrivenCount,
} from './delivery-tracker.js';
import { resolveInboxAgentId } from '../map/connection-registry.js';
import type { Config } from '../config.js';
import type { MailJsonRpcServer } from 'agent-inbox';

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
  /**
   * Optional callback fired (fire-and-forget) when a dispatch reaches a
   * terminal state via the orchestrator's event bridge. Decoupling hook
   * for cross-subsystem concerns (e.g., the scheduler's `fallback_spawn`
   * cleanup stops the spawned hosted swarm here). Errors are swallowed
   * so a misbehaving listener can't break the dispatch lifecycle.
   */
  onTerminal?: (
    taskId: string,
    status: 'complete' | 'failed' | 'cancelled',
  ) => void | Promise<void>;
  /**
   * Optional mail JSON-RPC accessor. When provided, enables:
   * - Pending thread message enrichment on continuation prompts
   * - System turns on retry events
   * - New-agent invites on retry dispatched events
   */
  getMailJsonRpc?: () => MailJsonRpcServer;
  /**
   * Register cleanup owned by optional runtime branches. Server bootstrap
   * passes Fastify's onClose hook here without making setup.ts import Fastify.
   */
  registerCleanup?: (cleanup: () => void | Promise<void>) => void;
}

export function setupOrchestrator(opts: SetupOrchestratorOptions): Orchestrator {
  const claimantId = `openhive:${hostname()}:${process.pid}`;

  const sourceDeps: DispatchSourceDeps = {};
  if (opts.getMailJsonRpc) {
    sourceDeps.getMailJsonRpc = opts.getMailJsonRpc as DispatchSourceDeps['getMailJsonRpc'];
  }
  const source = createOpenHiveDispatchSource(opts.specFetcher, claimantId, sourceDeps);
  let runtime = createOpenHiveAgentRuntime(opts.runtimeDeps);
  if (opts.dispatchConfig?.codex_executor?.enabled) {
    const codexRuntime: SwarmCodexDispatchRuntime = createOpenHiveSwarmCodexRuntime({
      baseRuntime: runtime,
      config: opts.dispatchConfig.codex_executor,
    });
    runtime = codexRuntime;
    opts.registerCleanup?.(() => codexRuntime.stopAll());
  }
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
    continuation: {
      delayMs: 1_000,
      maxTurns: cfg?.continuation?.maxTurns ?? 20,
    },
    // Thread-aware continuation policy: when an agent's turn completes
    // and the dispatch thread has pending messages, grant extra turns so
    // the agent can respond — up to maxThreadTurns. Without pending
    // messages, fall back to the standard maxTurns budget.
    continuationPolicy: (task, turnCount, _lastExit) => {
      const maxTurns = cfg?.continuation?.maxTurns ?? 20;
      if (turnCount >= maxTurns) return 'release';

      // Local swarm-codex dispatches are one-shot repo edits. A clean Codex
      // exit means the worker is done; continuing the still-open dispatch
      // would re-enter the normal prefer-route path and can fail with
      // no_mail_transport even though cascade artifacts were already recorded.
      const dispatch = dispatchesDAL.findDispatchById(task.id);
      if (dispatch?.attempts_history.some((attempt) => attempt.transport === 'codex')) {
        return 'release';
      }

      const pending = (task.metadata?.pendingThreadMessages as number) ?? 0;
      if (pending > 0) {
        const maxThreadTurns = cfg?.continuation?.maxThreadTurns ?? 3;
        const threadCount = getThreadDrivenCount(task.id);
        if (threadCount >= maxThreadTurns) return 'release';
        incrementThreadDrivenCount(task.id);
        return 'continue';
      }

      return turnCount < maxTurns ? 'continue' : 'release';
    },
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

  // Fire the optional onTerminal hook, swallowing errors so a misbehaving
  // listener can't crash the dispatch event loop.
  const fireOnTerminal = (
    taskId: string,
    status: 'complete' | 'failed' | 'cancelled',
  ): void => {
    if (!opts.onTerminal) return;
    try {
      const r = opts.onTerminal(taskId, status);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          /* swallow */
        });
      }
    } catch {
      /* swallow */
    }
  };

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

      // On retry attempts (attempt > 1), invite the new executor to the
      // existing dispatch thread so they can see prior conversation history.
      if (attempt > 1 && opts.getMailJsonRpc) {
        const dispatch = dispatchesDAL.findDispatchById(event.taskId);
        if (dispatch?.conversation_id && agent_id) {
          const inboxId = resolveInboxAgentId(dispatch.target_swarm_id, agent_id);
          try {
            const mailRpc = opts.getMailJsonRpc();
            const reqId = `invite-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            void mailRpc.handleRequest({
              jsonrpc: '2.0',
              id: reqId,
              method: 'mail/invite',
              params: {
                conversationId: dispatch.conversation_id,
                agentId: inboxId,
                role: 'executor',
              },
            } as Parameters<MailJsonRpcServer['handleRequest']>[0]);
          } catch { /* best effort — agent may already be participant */ }
        }
      }
    }

    // Terminal: agent completed successfully → mark dispatch complete
    // Guard: skip if already terminal (map/dispatches/report may have written first)
    //
    // No hub-authored summary here — narrative is agent-owned via
    // map/dispatches/report. Silent agents leave summary undefined; observed
    // facts (attempts, session_ids, cascade artifacts) still populate.
    if (event.type === 'completed') {
      clearThreadDrivenCount(event.taskId);
      fireOnTerminal(event.taskId, 'complete');
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
        // Narrate the outcome into the spec discussion thread (if opened).
        const summary = dispatchesDAL.findDispatchById(event.taskId)?.outcome?.summary;
        void postSpecOutcomeTurn(event.taskId, 'complete', summary ?? undefined);
      }
    }

    // Terminal: all retries exhausted → mark dispatch failed with last error
    // Guard: skip if already terminal
    //
    // Hub doesn't author the narrative here either — `lastError` lives in
    // `attempts_history[n].error` and `attempts` in the dispatch row, so
    // the observed facts are preserved without shadowing the agent's voice.
    if (event.type === 'dead') {
      clearThreadDrivenCount(event.taskId);
      fireOnTerminal(event.taskId, 'failed');
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
        // Narrate the failure into the spec discussion thread (if opened).
        void postSpecOutcomeTurn(event.taskId, 'dead', lastError);
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

        // Post a system turn to the dispatch thread so participants see the retry
        if (current?.conversation_id && opts.getMailJsonRpc) {
          try {
            const mailRpc = opts.getMailJsonRpc();
            const turnId = `sys-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            void mailRpc.handleRequest({
              jsonrpc: '2.0',
              id: turnId,
              method: 'mail/turn',
              params: {
                conversationId: current.conversation_id,
                participantId: 'system:dispatch-orchestrator',
                content: `Retry attempt ${attempt}: previous attempt failed${error ? ` with: ${error}` : '.'}`,
                contentType: 'text',
                importance: 'normal',
                metadata: { system: true, attempt },
              },
            } as Parameters<MailJsonRpcServer['handleRequest']>[0]);
          } catch { /* best effort */ }
        }
      }
    }

    // Cancelled by reconciliation → mark cancelled
    if (event.type === 'cancelled') {
      fireOnTerminal(event.taskId, 'cancelled');
      const dispatch = dispatchesDAL.findDispatchById(event.taskId);
      if (dispatch && dispatch.status !== 'cancelled' && dispatch.status !== 'complete' && dispatch.status !== 'failed') {
        dispatchesDAL.cancelDispatch(event.taskId);
      }
    }
  });

  /**
   * Post a terminal-outcome system turn into the dispatch's spec discussion
   * thread — only when the dispatch carries spec refs and that thread already
   * exists. Fully best-effort: never throws into the dispatch lifecycle.
   */
  async function postSpecOutcomeTurn(
    dispatchId: string,
    outcome: 'complete' | 'failed' | 'dead',
    detail: string | undefined,
  ): Promise<void> {
    if (!opts.getMailJsonRpc) return;
    const d = dispatchesDAL.findDispatchById(dispatchId);
    if (!d?.spec_resource_id || !d?.spec_id) return;
    try {
      const [{ findSwarmById }, { postSpecThreadOutcome }, { getMailStorage }] =
        await Promise.all([
          import('../db/dal/map.js'),
          import('../specs/spec-conversation.js'),
          import('../mail/index.js'),
        ]);
      const swarmName = findSwarmById(d.target_swarm_id)?.name ?? d.target_swarm_id;
      await postSpecThreadOutcome(
        {
          resourceId: d.spec_resource_id,
          specId: d.spec_id,
          dispatchId,
          outcome,
          swarmName,
          detail,
        },
        { getMailJsonRpc: opts.getMailJsonRpc, getMailStorage },
      );
    } catch {
      /* best effort */
    }
  }

  return orchestrator;
}
