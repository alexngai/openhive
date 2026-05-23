/**
 * Phase 2.5 — cascade merge `task_ref` backfill.
 *
 * cc-swarm sidecars emit `x-cascade/stream.merged` with `task_ref: { node_id }`
 * — node id only, no `resource_id` (the agent's daemon doesn't know its own
 * OpenHive resource id). The hub backfills the missing `resource_id` from the
 * source swarm's registered `defaultTaskGraph` so the cascade task-binder can
 * resolve a resource and auto-close the opentasks task.
 *
 * Verifies:
 * - node-only task_ref + source swarm with defaultTaskGraph.resource_id
 *   → emitted `cascade_stream_merged` carries a complete task_ref
 * - node-only task_ref + no defaultTaskGraph → no task_ref, no throw
 * - complete (macro-agent) task_ref → unchanged, no backfill applied
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { handleCascadeRequest, CASCADE_METHODS } from '../../map/cascade-handler.js';
import { mapHubEvents } from '../../map/service.js';
import {
  registerInbound,
  unregisterInbound,
  setDefaultTaskGraph,
} from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('cascade-handler-task-ref-backfill');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'cascade-handler-task-ref-backfill.db');

function mockWs(): WebSocket {
  return new EventEmitter() as unknown as WebSocket;
}

/** Capture the next `cascade_stream_merged` hub event during `fn`. */
function captureMergedEvent(fn: () => void): Record<string, unknown> | undefined {
  let captured: Record<string, unknown> | undefined;
  const listener = (data: Record<string, unknown>) => { captured = data; };
  mapHubEvents.on('cascade_stream_merged', listener);
  try {
    fn();
  } finally {
    mapHubEvents.off('cascade_stream_merged', listener);
  }
  return captured;
}

describe('cascade stream.merged task_ref backfill', () => {
  const agentId = 'cascade-backfill-agent';

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    await agentsDAL.createAgent({
      name: agentId,
      description: 'Agent for cascade task_ref backfill tests',
    });
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('backfills resource_id from the source swarm defaultTaskGraph for a node-only task_ref', () => {
    const swarmId = 'swarm-ccswarm-001';
    registerInbound(swarmId, {
      ws: mockWs(),
      agentId,
      swarmId,
      connectedAt: '',
      lastMessageAt: '',
      registeredAgents: new Map(),
    });
    setDefaultTaskGraph(swarmId, { resource_id: 'res_ccswarm_tasks', location_hash: 'lh-ccswarm' });

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      { stream_id: 'src-cc', name: 'src', agent_id: 'a' },
      { swarmId, agentId }
    );
    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      { stream_id: 'tgt-cc', name: 'tgt', agent_id: 'a' },
      { swarmId, agentId }
    );

    const event = captureMergedEvent(() => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_MERGED,
        {
          source_stream_id: 'src-cc',
          target_stream_id: 'tgt-cc',
          merge_commit: 'merge-cc-1',
          agent_id: 'a',
          // cc-swarm emits node-only — no resource_id.
          metadata: { task_ref: { node_id: 'task-node-cc' } },
        },
        { swarmId, agentId }
      );
    });

    expect(event).toBeDefined();
    expect(event!.task_ref).toEqual({
      resource_id: 'res_ccswarm_tasks',
      node_id: 'task-node-cc',
    });

    unregisterInbound(swarmId);
  });

  it('emits no task_ref (and does not throw) when the source swarm has no defaultTaskGraph', () => {
    const swarmId = 'swarm-no-graph-002';
    registerInbound(swarmId, {
      ws: mockWs(),
      agentId,
      swarmId,
      connectedAt: '',
      lastMessageAt: '',
      registeredAgents: new Map(),
    });
    // No setDefaultTaskGraph call — nothing to backfill from.

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      { stream_id: 'src-ng', name: 'src', agent_id: 'a' },
      { swarmId, agentId }
    );
    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      { stream_id: 'tgt-ng', name: 'tgt', agent_id: 'a' },
      { swarmId, agentId }
    );

    let event: Record<string, unknown> | undefined;
    expect(() => {
      event = captureMergedEvent(() => {
        handleCascadeRequest(
          CASCADE_METHODS.STREAM_MERGED,
          {
            source_stream_id: 'src-ng',
            target_stream_id: 'tgt-ng',
            merge_commit: 'merge-ng-1',
            agent_id: 'a',
            metadata: { task_ref: { node_id: 'task-node-ng' } },
          },
          { swarmId, agentId }
        );
      });
    }).not.toThrow();

    expect(event).toBeDefined();
    expect(event!.task_ref).toBeUndefined();

    unregisterInbound(swarmId);
  });

  it('leaves a complete macro-agent task_ref unchanged (no backfill applied)', () => {
    const swarmId = 'swarm-macro-003';
    registerInbound(swarmId, {
      ws: mockWs(),
      agentId,
      swarmId,
      connectedAt: '',
      lastMessageAt: '',
      registeredAgents: new Map(),
    });
    // Even with a defaultTaskGraph present, a complete ref must win verbatim.
    setDefaultTaskGraph(swarmId, { resource_id: 'res_should_not_be_used' });

    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      { stream_id: 'src-mac', name: 'src', agent_id: 'a' },
      { swarmId, agentId }
    );
    handleCascadeRequest(
      CASCADE_METHODS.STREAM_OPENED,
      { stream_id: 'tgt-mac', name: 'tgt', agent_id: 'a' },
      { swarmId, agentId }
    );

    const event = captureMergedEvent(() => {
      handleCascadeRequest(
        CASCADE_METHODS.STREAM_MERGED,
        {
          source_stream_id: 'src-mac',
          target_stream_id: 'tgt-mac',
          merge_commit: 'merge-mac-1',
          agent_id: 'a',
          metadata: {
            task_ref: { resource_id: 'res_macro_explicit', node_id: 'task-node-macro' },
          },
        },
        { swarmId, agentId }
      );
    });

    expect(event).toBeDefined();
    expect(event!.task_ref).toEqual({
      resource_id: 'res_macro_explicit',
      node_id: 'task-node-macro',
    });

    unregisterInbound(swarmId);
  });
});
