/**
 * Notification-pair RPC unit tests.
 *
 * Covers the request/response-over-notifications mechanism that
 * compensates for AgentConnection's lack of `setRequestHandler` on the
 * swarm side (used for `dispatch/spawn-agent` and any future hub→swarm
 * structured calls).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  callViaNotificationPair,
  handleNotificationPairResponse,
  rejectPendingForSwarm,
  NotificationPairTransportLost,
  _clearPendingNotificationPairCallsForTest,
} from '../../map/notification-rpc.js';
import * as syncListener from '../../map/sync-listener.js';

describe('notification-pair RPC', () => {
  beforeEach(() => {
    _clearPendingNotificationPairCallsForTest();
    vi.restoreAllMocks();
  });

  it('sends `<method>.request` with a correlation_id and resolves on matching response', async () => {
    const sentMessages: Array<Record<string, unknown>> = [];
    vi.spyOn(syncListener, 'sendToSwarm').mockImplementation((_swarmId, msg) => {
      sentMessages.push(msg as Record<string, unknown>);
      return true;
    });

    // Kick off the call. Pull the correlation_id out of the request
    // payload so the test can simulate the swarm's response.
    const callPromise = callViaNotificationPair<
      { foo: string },
      { agentId: string }
    >('swarm-1', 'dispatch/spawn-agent', { foo: 'bar' });

    // The request notification should have been sent immediately.
    expect(sentMessages).toHaveLength(1);
    const request = sentMessages[0];
    expect(request.method).toBe('dispatch/spawn-agent.request');
    const params = request.params as Record<string, unknown>;
    expect(params.foo).toBe('bar');
    expect(typeof params.correlation_id).toBe('string');

    // Simulate the swarm's response.
    handleNotificationPairResponse({
      correlation_id: params.correlation_id,
      result: { agentId: 'agent-spawned-123' },
    });

    const result = await callPromise;
    expect(result).toEqual({ agentId: 'agent-spawned-123' });
  });

  it('rejects with NotificationPairRemoteError preserving the swarm-side code on response.error', async () => {
    const sentMessages: Array<Record<string, unknown>> = [];
    vi.spyOn(syncListener, 'sendToSwarm').mockImplementation((_swarmId, msg) => {
      sentMessages.push(msg as Record<string, unknown>);
      return true;
    });

    const callPromise = callViaNotificationPair(
      'swarm-1',
      'dispatch/spawn-agent',
      {},
    );

    const params = sentMessages[0].params as Record<string, unknown>;
    handleNotificationPairResponse({
      correlation_id: params.correlation_id,
      error: { code: 'unauthorized', message: 'spawn failed: unauthorized' },
    });

    await expect(callPromise).rejects.toThrow(/spawn failed/);
    await expect(callPromise).rejects.toMatchObject({
      name: 'NotificationPairRemoteError',
      code: 'unauthorized',
      method: 'dispatch/spawn-agent',
      swarmId: 'swarm-1',
    });
  });

  it('rejects with timeout if no response arrives in time', async () => {
    vi.spyOn(syncListener, 'sendToSwarm').mockReturnValue(true);

    await expect(
      callViaNotificationPair('swarm-1', 'dispatch/spawn-agent', {}, {
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('rejects immediately when sendToSwarm returns false (swarm unreachable)', async () => {
    vi.spyOn(syncListener, 'sendToSwarm').mockReturnValue(false);

    await expect(
      callViaNotificationPair('absent-swarm', 'dispatch/spawn-agent', {}),
    ).rejects.toThrow(/not reachable/);
  });

  it('silently ignores responses with unknown correlation_ids (late or foreign)', async () => {
    vi.spyOn(syncListener, 'sendToSwarm').mockReturnValue(true);

    // No pending call — should not throw, just no-op.
    expect(() =>
      handleNotificationPairResponse({
        correlation_id: 'unknown-id',
        result: { agentId: 'whatever' },
      }),
    ).not.toThrow();
  });

  it('silently ignores responses with no correlation_id (malformed)', async () => {
    expect(() => handleNotificationPairResponse({ result: {} })).not.toThrow();
    expect(() => handleNotificationPairResponse({})).not.toThrow();
    expect(() => handleNotificationPairResponse(null)).not.toThrow();
  });

  it('correlates concurrent calls by their distinct correlation_ids', async () => {
    const sentMessages: Array<Record<string, unknown>> = [];
    vi.spyOn(syncListener, 'sendToSwarm').mockImplementation((_swarmId, msg) => {
      sentMessages.push(msg as Record<string, unknown>);
      return true;
    });

    const a = callViaNotificationPair<{}, { tag: string }>(
      'swarm-1',
      'dispatch/spawn-agent',
      {},
    );
    const b = callViaNotificationPair<{}, { tag: string }>(
      'swarm-1',
      'dispatch/spawn-agent',
      {},
    );

    const idA = (sentMessages[0].params as Record<string, unknown>).correlation_id;
    const idB = (sentMessages[1].params as Record<string, unknown>).correlation_id;
    expect(idA).not.toBe(idB);

    handleNotificationPairResponse({ correlation_id: idB, result: { tag: 'B' } });
    handleNotificationPairResponse({ correlation_id: idA, result: { tag: 'A' } });

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual({ tag: 'A' });
    expect(resB).toEqual({ tag: 'B' });
  });

  it('rejectPendingForSwarm fails calls targeting that swarm with NotificationPairTransportLost', async () => {
    vi.spyOn(syncListener, 'sendToSwarm').mockReturnValue(true);

    const callPromise = callViaNotificationPair(
      'doomed-swarm',
      'dispatch/spawn-agent',
      {},
      { timeoutMs: 60_000 },
    );

    rejectPendingForSwarm('doomed-swarm', 'swarm_ws_closed');

    await expect(callPromise).rejects.toBeInstanceOf(NotificationPairTransportLost);
    await expect(callPromise).rejects.toMatchObject({
      code: 'transport_lost',
    });
  });

  it("rejectPendingForSwarm leaves pending calls for OTHER swarms untouched", async () => {
    vi.spyOn(syncListener, 'sendToSwarm').mockReturnValue(true);

    const a = callViaNotificationPair(
      'swarm-A',
      'dispatch/spawn-agent',
      {},
      { timeoutMs: 60_000 },
    );
    const b = callViaNotificationPair(
      'swarm-B',
      'dispatch/spawn-agent',
      {},
      { timeoutMs: 60_000 },
    );

    rejectPendingForSwarm('swarm-A', 'swarm_ws_closed');

    await expect(a).rejects.toBeInstanceOf(NotificationPairTransportLost);
    // B is still pending — settle via Promise.race with a quick timer
    // to confirm it's NOT yet rejected.
    const stillPending = await Promise.race([
      b.then(() => 'resolved').catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('still-pending'), 50)),
    ]);
    expect(stillPending).toBe('still-pending');

    // Clean up b so it doesn't leak across tests
    rejectPendingForSwarm('swarm-B', 'cleanup');
    await expect(b).rejects.toBeInstanceOf(NotificationPairTransportLost);
  });

  it('rejectPendingForSwarm is a no-op when no pending calls match the swarm', () => {
    expect(() => rejectPendingForSwarm('nonexistent-swarm')).not.toThrow();
  });
});
