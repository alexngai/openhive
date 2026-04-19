/**
 * Dispatch Orchestrator Setup
 *
 * Wires swarm-dispatch into the OpenHive server. Creates the orchestrator
 * with OpenHive-specific adapters and bridges events to the WS channel.
 */

import { hostname } from 'node:os';
import { createOrchestrator } from 'swarm-dispatch';
import type { Orchestrator, DispatchEvent } from 'swarm-dispatch';
import { createOpenHiveDispatchSource } from './openhive-source.js';
import type { SpecContentFetcher } from './openhive-source.js';
import { createOpenHiveAgentRuntime } from './openhive-runtime.js';
import type { OpenHiveRuntimeDeps } from './openhive-runtime.js';
import { createOpenHiveRoster } from './openhive-roster.js';
import { openHivePromptBuilder } from './prompt.js';
import { broadcastToChannel } from '../realtime/index.js';
import * as dispatchesDAL from '../db/dal/dispatches.js';

export interface SetupOrchestratorOptions {
  specFetcher: SpecContentFetcher;
  runtimeDeps: OpenHiveRuntimeDeps;
  pollIntervalMs?: number;
  globalConcurrency?: number;
}

export function setupOrchestrator(opts: SetupOrchestratorOptions): Orchestrator {
  const claimantId = `openhive:${hostname()}:${process.pid}`;

  const source = createOpenHiveDispatchSource(opts.specFetcher, claimantId);
  const runtime = createOpenHiveAgentRuntime(opts.runtimeDeps);
  const roster = createOpenHiveRoster();

  const orchestrator = createOrchestrator(source, runtime, {
    claimantId,
    pollIntervalMs: opts.pollIntervalMs ?? 15_000,
    defaultRole: 'worker',
    concurrency: { global: opts.globalConcurrency ?? 5 },
    retry: { maxRetries: 3, baseDelayMs: 10_000, maxDelayMs: 300_000 },
    continuation: { delayMs: 1_000, maxTurns: 20 },
    promptBuilder: openHivePromptBuilder,
    roster,
    dispatchMode: 'prefer-route',
    heartbeatIntervalMs: 30_000,
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

    // Terminal: agent completed successfully → mark dispatch complete
    // Guard: skip if already terminal (map/dispatches/report may have written first)
    if (event.type === 'completed') {
      const current = dispatchesDAL.findDispatchById(event.taskId);
      if (current && current.status !== 'complete' && current.status !== 'failed' && current.status !== 'cancelled') {
        dispatchesDAL.updateDispatchStatus(event.taskId, 'complete', {
          summary: 'Agent completed successfully',
        });
        const record = orchestrator.tracker.getTask(event.taskId);
        if (record) {
          dispatchesDAL.updateDispatchAttemptTurn(
            event.taskId,
            record.attempt,
            record.turnCount,
          );
        }
      }
    }

    // Terminal: all retries exhausted → mark dispatch failed with last error
    // Guard: skip if already terminal
    if (event.type === 'dead') {
      const current = dispatchesDAL.findDispatchById(event.taskId);
      if (current && current.status !== 'complete' && current.status !== 'failed' && current.status !== 'cancelled') {
        const lastError = 'lastError' in event ? (event as { lastError?: string }).lastError : undefined;
        const attempts = 'attempts' in event ? (event as { attempts?: number }).attempts : undefined;
        dispatchesDAL.updateDispatchStatus(event.taskId, 'failed', {
          error: lastError ?? 'All retry attempts exhausted',
          summary: `Failed after ${attempts ?? '?'} attempt(s)`,
        });
        dispatchesDAL.updateDispatchAttemptTurn(
          event.taskId,
          attempts ?? 0,
          0,
        );
      }
    }

    // Retry scheduled → update attempt count so the UI shows progress
    if (event.type === 'retrying') {
      const attempt = 'attempt' in event ? (event as { attempt?: number }).attempt : undefined;
      if (attempt !== undefined) {
        dispatchesDAL.updateDispatchAttemptTurn(event.taskId, attempt, 0);
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
