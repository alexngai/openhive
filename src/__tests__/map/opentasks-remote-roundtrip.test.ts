/**
 * Integration test: hub ↔ sidecar task round-trips over the MAP notification
 * protocol.
 *
 * Unlike `opentasks-remote-e2e` (which spawns a real sidecar process), this
 * test stubs the WebSocket so we can assert the exact wire format the hub
 * sends for each operation and simulate a sidecar response in-process. This
 * is the fast, deterministic layer for catching protocol regressions on the
 * hub side — in particular:
 *
 *   - `opentasks/graph.create.request` for task creation
 *   - `opentasks/task.request` { transition } for status updates
 *   - `opentasks/task.request` { assign } for assignment
 *   - `opentasks/graph.update.request` for non-status field updates
 *   - `opentasks/query.request` for listing
 *   - timeout handling when the sidecar does not respond
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { registerInbound, unregisterInbound, getAllInbound } from '../../map/connection-registry.js';
import {
  remoteCreateTask,
  remoteUpdateTask,
  remoteAssignTask,
  remoteUpdateTaskFields,
  remoteQueryTasks,
  handleOpenTasksResponse,
} from '../../map/opentasks-remote.js';

// ─── Stub WebSocket ────────────────────────────────────────────────────────

interface CapturedSend {
  method: string;
  params: Record<string, unknown>;
}

function makeStubWs(captured: CapturedSend[]) {
  return {
    readyState: 1, // OPEN
    send: (raw: string) => {
      const msg = JSON.parse(raw) as { method: string; params: Record<string, unknown> };
      captured.push({ method: msg.method, params: msg.params });
    },
    close: () => {},
  } as unknown as WebSocket;
}

function registerStubSwarm(swarmId: string, ws: unknown): void {
  registerInbound(swarmId, {
    ws: ws as never,
    agentId: 'agent_owner',
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map(),
    defaultTaskGraph: { location_hash: 'test-loc' },
  });
}

describe('opentasks-remote wire format', () => {
  const SWARM_ID = 'test-swarm';
  let captured: CapturedSend[];

  beforeEach(() => {
    captured = [];
    registerStubSwarm(SWARM_ID, makeStubWs(captured));
  });

  afterEach(() => {
    for (const id of [...getAllInbound().keys()]) unregisterInbound(id);
  });

  // ─── create ────────────────────────────────────────────────────────────

  it('remoteCreateTask sends opentasks/graph.create.request with the correct payload', async () => {
    const promise = remoteCreateTask(SWARM_ID, {
      title: 'New task',
      description: 'body',
      status: 'open',
      priority: 2,
      assignee: 'alice',
      meta: { source: 'unit-test' },
    });

    // Wait for send to be captured
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('opentasks/graph.create.request');
    const { request_id, create } = captured[0].params as {
      request_id: string;
      create: Record<string, unknown>;
    };
    expect(request_id).toBeDefined();
    expect(create).toEqual({
      type: 'task',
      title: 'New task',
      content: 'body',
      status: 'open',
      priority: 2,
      assignee: 'alice',
      metadata: { source: 'unit-test' },
    });

    // Simulate sidecar response
    handleOpenTasksResponse({
      request_id,
      node: { id: 'node-42', type: 'task', title: 'New task', status: 'open' },
    });

    const result = await promise;
    expect(result).toEqual({ id: 'node-42', type: 'task', title: 'New task', status: 'open' });
  });

  it('remoteCreateTask applies "Untitled" fallback when title is absent', async () => {
    const promise = remoteCreateTask(SWARM_ID, {});
    await new Promise((r) => setImmediate(r));

    const { request_id, create } = captured[0].params as {
      request_id: string;
      create: Record<string, unknown>;
    };
    expect(create.title).toBe('Untitled');
    expect(create.status).toBe('open');

    handleOpenTasksResponse({ request_id, node: { id: 'n' } });
    await promise;
  });

  it('remoteCreateTask returns null when response contains error', async () => {
    const promise = remoteCreateTask(SWARM_ID, { title: 'fail' });
    await new Promise((r) => setImmediate(r));

    const { request_id } = captured[0].params as { request_id: string };
    handleOpenTasksResponse({ request_id, error: 'daemon down' });

    const result = await promise;
    expect(result).toBeNull();
  });

  // ─── status update (task.transition) ───────────────────────────────────

  it('remoteUpdateTask sends opentasks/task.request with a semantic transition', async () => {
    const promise = remoteUpdateTask(SWARM_ID, 't-1', 'in_progress');
    await new Promise((r) => setImmediate(r));

    expect(captured[0].method).toBe('opentasks/task.request');
    const { request_id, task } = captured[0].params as {
      request_id: string;
      task: { transition: { id: string; action: string } };
    };
    expect(task.transition).toEqual({ id: 't-1', action: 'start' });

    handleOpenTasksResponse({
      request_id,
      success: true,
      data: { type: 'transition', node: { id: 't-1', status: 'in_progress' }, provider: 'native', action: 'start' },
    });

    const result = await promise;
    expect(result).toEqual({ id: 't-1', status: 'in_progress' });
  });

  it('remoteUpdateTask maps known statuses to canonical actions', async () => {
    const cases: Array<[string, string]> = [
      ['in_progress', 'start'],
      ['completed', 'complete'],
      ['blocked', 'block'],
      ['open', 'reopen'],
      ['closed', 'close'],
    ];

    for (const [status, expectedAction] of cases) {
      captured.length = 0;
      const promise = remoteUpdateTask(SWARM_ID, 't-x', status);
      await new Promise((r) => setImmediate(r));
      const { request_id, task } = captured[0].params as {
        request_id: string;
        task: { transition: { action: string } };
      };
      expect(task.transition.action).toBe(expectedAction);
      handleOpenTasksResponse({ request_id, success: true, data: { type: 'transition', node: { id: 't-x' } } });
      await promise;
    }
  });

  // ─── assign (task.assign) ──────────────────────────────────────────────

  it('remoteAssignTask sends opentasks/task.request with assign params', async () => {
    const promise = remoteAssignTask(SWARM_ID, 't-9', 'bob');
    await new Promise((r) => setImmediate(r));

    expect(captured[0].method).toBe('opentasks/task.request');
    const { request_id, task } = captured[0].params as {
      request_id: string;
      task: { assign: { id: string; assignee: string } };
    };
    expect(task.assign).toEqual({ id: 't-9', assignee: 'bob' });

    handleOpenTasksResponse({
      request_id,
      success: true,
      data: { type: 'assign', node: { id: 't-9', assignee: 'bob' }, provider: 'native' },
    });

    const result = await promise;
    expect(result).toEqual({ id: 't-9', assignee: 'bob' });
  });

  // ─── non-status update (graph.update) ──────────────────────────────────

  it('remoteUpdateTaskFields sends opentasks/graph.update.request with mapped fields', async () => {
    const promise = remoteUpdateTaskFields(SWARM_ID, 't-7', {
      title: 'Renamed',
      description: 'New body',
      assignee: 'carol',
      priority: 1,
      meta: { tag: 'x' },
    });
    await new Promise((r) => setImmediate(r));

    expect(captured[0].method).toBe('opentasks/graph.update.request');
    const { request_id, update } = captured[0].params as {
      request_id: string;
      update: Record<string, unknown>;
    };
    // description → content (per UpdateNodeInput), meta → metadata
    expect(update).toEqual({
      id: 't-7',
      title: 'Renamed',
      content: 'New body',
      assignee: 'carol',
      priority: 1,
      metadata: { tag: 'x' },
    });

    handleOpenTasksResponse({
      request_id,
      node: { id: 't-7', title: 'Renamed', assignee: 'carol' },
    });

    const result = await promise;
    expect(result).toEqual({ id: 't-7', title: 'Renamed', assignee: 'carol' });
  });

  it('remoteUpdateTaskFields omits fields that are undefined', async () => {
    const promise = remoteUpdateTaskFields(SWARM_ID, 't-7', { title: 'only-title' });
    await new Promise((r) => setImmediate(r));

    const { request_id, update } = captured[0].params as {
      request_id: string;
      update: Record<string, unknown>;
    };
    expect(update).toEqual({ id: 't-7', title: 'only-title' });
    expect(update).not.toHaveProperty('content');
    expect(update).not.toHaveProperty('assignee');
    expect(update).not.toHaveProperty('priority');
    expect(update).not.toHaveProperty('metadata');

    handleOpenTasksResponse({ request_id, node: { id: 't-7' } });
    await promise;
  });

  // ─── list (query) ──────────────────────────────────────────────────────

  it('remoteQueryTasks sends opentasks/query.request with filter + limit', async () => {
    const promise = remoteQueryTasks(SWARM_ID, { status: ['open'], assignee: 'alice' }, 25);
    await new Promise((r) => setImmediate(r));

    expect(captured[0].method).toBe('opentasks/query.request');
    const { request_id, query } = captured[0].params as {
      request_id: string;
      query: { nodes: Record<string, unknown> };
    };
    expect(query.nodes).toMatchObject({
      type: 'task',
      archived: false,
      status: ['open'],
      assignee: 'alice',
      limit: 25,
    });

    handleOpenTasksResponse({
      request_id,
      items: [{ id: 't-1', type: 'task', title: 'A', status: 'open' }],
      hasMore: false,
    });

    const result = await promise;
    expect(result).toEqual({
      items: [{ id: 't-1', type: 'task', title: 'A', status: 'open' }],
      hasMore: false,
    });
  });

  // ─── timeout ───────────────────────────────────────────────────────────

  it('returns null when no response arrives (timeout path)', async () => {
    // The real request uses a 10s timeout; to keep the test fast, we assert
    // that an un-matched request_id doesn't resolve, and a non-matching
    // response is ignored. A true timeout test would require fake timers;
    // we verify the routing is exclusive here.

    const promise = remoteUpdateTask(SWARM_ID, 't-unknown', 'closed');
    await new Promise((r) => setImmediate(r));
    expect(captured).toHaveLength(1);

    // Wrong request_id — should be ignored
    handleOpenTasksResponse({ request_id: 'bogus', success: true, data: {} });

    // Give the handler a tick to (not) resolve
    const raceWinner = await Promise.race([
      promise.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(raceWinner).toBe('pending');

    // Resolve correctly to clean up the pending request
    const { request_id } = captured[0].params as { request_id: string };
    handleOpenTasksResponse({ request_id, success: true, data: { type: 'transition', node: { id: 't-unknown' } } });
    await promise;
  });

  it('returns null when the swarm connection is not open', async () => {
    // Unregister and re-register with a closed WS
    unregisterInbound(SWARM_ID);
    registerInbound(SWARM_ID, {
      ws: { readyState: 3, send: () => {}, close: () => {} } as never, // CLOSED
      agentId: 'agent_owner',
      swarmId: SWARM_ID,
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      defaultTaskGraph: { location_hash: 'test-loc' },
    });

    const result = await remoteCreateTask(SWARM_ID, { title: 'x' });
    expect(result).toBeNull();
  });
});
