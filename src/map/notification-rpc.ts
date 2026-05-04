/**
 * Notification-pair RPC — request/response over notifications.
 *
 * The MAP SDK's `AgentConnection` does NOT expose `setRequestHandler`;
 * inbound JSON-RPC requests can't be handled directly on the swarm side.
 * This module simulates request/response over the SDK's existing
 * notification surface using a correlation id:
 *
 *     hub →  swarm:  notification `<method>.request` { correlation_id, ...params }
 *     swarm → hub:   notification `<method>.response` { correlation_id, result | error }
 *
 * The hub correlates by id, resolves the matching pending promise.
 *
 * Used today for `dispatch/spawn-agent` (ACP+fresh dispatch routing).
 * Future structured calls hub→swarm should use this mechanism until/unless
 * the SDK exposes inbound request handling on AgentConnection.
 */

import { nanoid } from 'nanoid';
import { sendToSwarm } from './sync-listener.js';

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

const pending = new Map<string, PendingCall>();

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Send a request notification to a swarm and wait for the matching
 * response notification. Resolves with `result`, rejects with `error` or
 * timeout.
 *
 * @returns The result the swarm replied with.
 */
export async function callViaNotificationPair<TParams, TResult>(
  swarmId: string,
  method: string,
  params: TParams,
  opts: { timeoutMs?: number } = {},
): Promise<TResult> {
  const correlationId = nanoid();
  const requestMethod = `${method}.request`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<TResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(
        new Error(
          `notification-pair: ${method} timed out after ${timeoutMs}ms (swarm=${swarmId})`,
        ),
      );
    }, timeoutMs);

    pending.set(correlationId, {
      resolve: (result) => resolve(result as TResult),
      reject,
      timer,
      method,
    });

    const sent = sendToSwarm(swarmId, {
      jsonrpc: '2.0',
      method: requestMethod,
      params: { correlation_id: correlationId, ...params },
    });
    if (!sent) {
      const entry = pending.get(correlationId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(correlationId);
      }
      reject(
        new Error(
          `notification-pair: failed to send ${requestMethod} — swarm ${swarmId} not reachable`,
        ),
      );
    }
  });
}

/**
 * Resolve a pending notification-pair call when the swarm sends back
 * `<method>.response`. Called by ws-map's notification dispatcher.
 *
 * Silently ignores responses with unknown correlation ids (late
 * responses, foreign messages).
 */
export function handleNotificationPairResponse(params: unknown): void {
  if (!params || typeof params !== 'object') return;
  const p = params as {
    correlation_id?: string;
    result?: unknown;
    error?: { message?: string; code?: number };
  };
  const correlationId = p.correlation_id;
  if (!correlationId) return;

  const entry = pending.get(correlationId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(correlationId);

  if (p.error) {
    entry.reject(new Error(p.error.message ?? 'notification-pair: remote error'));
    return;
  }
  entry.resolve(p.result);
}

/**
 * Test helper — clear all pending calls. Used by test fixtures to avoid
 * cross-test bleed.
 */
export function _clearPendingNotificationPairCallsForTest(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('notification-pair: cleared by test'));
  }
  pending.clear();
}
