/**
 * Tests for the MAP spec handler — `map/specs/author`.
 *
 * Per D9, no per-agent capability gating: any registered MAP agent can author.
 * The hub still enforces resource access (canAccessResource) and validates the
 * payload. Successful authoring broadcasts spec.created with the initiator's id.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// daemon mock (read path) — used by both author + dispatch flows.
vi.mock('../../map/task-daemon-client.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { existsSync, readFileSync, writeFileSync } = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path');

  class TaskDaemonError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'TaskDaemonError';
      this.code = code;
    }
  }

  function _parseJsonl(opentasksDir: string): { nodes: any[]; edges: any[] } {
    const graphPath = join(opentasksDir, 'graph.jsonl');
    if (!existsSync(graphPath)) return { nodes: [], edges: [] };
    const lines = readFileSync(graphPath, 'utf-8').split('\n').filter((l: string) => l.trim());
    const nodes: any[] = [];
    const edges: any[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.from_id && obj.to_id) edges.push(obj);
        else nodes.push(obj);
      } catch { /* skip */ }
    }
    return { nodes, edges };
  }

  function _writeJsonl(opentasksDir: string, nodes: any[], edges: any[]): void {
    const graphPath = join(opentasksDir, 'graph.jsonl');
    const lines = [...nodes, ...edges].map((o) => JSON.stringify(o)).join('\n');
    writeFileSync(graphPath, lines + '\n');
  }

  return {
    TaskDaemonError,
    resolveDaemonSocket: (opentasksDir: string) => join(opentasksDir, 'daemon.sock'),
    daemonCreateSpec: async (
      _socketPath: string,
      params: { title: string; content?: string; priority?: number },
      opentasksDir?: string,
    ) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes, edges } = _parseJsonl(opentasksDir);
      const id = `s-${Math.random().toString(36).slice(2, 8)}`;
      const node = {
        id,
        type: 'spec',
        title: params.title,
        content: params.content ?? '',
        priority: params.priority,
        archived: false,
      };
      _writeJsonl(opentasksDir, [...nodes, node], edges);
      return node;
    },
    // Used by dispatch flow — return the seeded spec with a linked task.
    daemonGetNodeWithNeighbors: async (_socket: string, nodeId: string) => {
      if (nodeId === 's-target') {
        return {
          node: {
            id: 's-target',
            type: 'context',
            title: 'Spec to dispatch',
            content: 'Make it so',
            metadata: { kind: 'spec' },
            updated_at: '2026-04-15T20:00:00Z',
          },
          neighbors: [{ id: 't-1', type: 'task', title: 'Linked task', status: 'open' }],
          edges: [{ from_id: 's-target', to_id: 't-1', type: 'implements' }],
        };
      }
      return { node: null, neighbors: [], edges: [] };
    },
    daemonQueryNodes: async () => ({ items: [], total: 0, daemon_connected: false }),
    daemonGetGraph: async () => ({ nodes: [], edges: [] }),
    daemonUpdateSpec: async () => ({}),
    SPEC_METADATA_KIND: 'spec',
  };
});

const broadcastSpy = vi.fn();
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, event: unknown) => broadcastSpy(channel, event),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as mapDAL from '../../db/dal/map.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import { handleSpecRequest, MAPSpecRequestError, MAP_SPEC_METHODS } from '../../map/spec-handler.js';
import { resetDispatchPolicy, setAutonomousDispatchPaused } from '../../map/dispatch-policy.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('spec-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'spec-handler.db');

describe('MAP spec handler', () => {
  let agent: { id: string };
  let outsider: { id: string };
  let opentasksResource: { id: string };
  let memoryResource: { id: string };
  let opentasksDir: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const a1 = await agentsDAL.createAgent({ name: 'spec-handler-agent', description: 'owner' });
    agent = { id: a1.agent.id };

    const a2 = await agentsDAL.createAgent({ name: 'spec-handler-outsider', description: 'no access' });
    outsider = { id: a2.agent.id };

    opentasksDir = mkTestDir(TEST_ROOT, 'graph');
    fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '');
    opentasksResource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'graph',
      git_remote_url: opentasksDir,
      visibility: 'private',
      owner_agent_id: agent.id,
      metadata: { opentasks: true },
    });

    const memDir = mkTestDir(TEST_ROOT, 'memory');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# memory');
    memoryResource = resourcesDAL.createResource({
      resource_type: 'memory_bank',
      name: 'memory',
      git_remote_url: memDir,
      visibility: 'private',
      owner_agent_id: agent.id,
    });
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    broadcastSpy.mockClear();
    resetDispatchPolicy();
  });

  it('authors a spec and broadcasts spec.created with initiator', async () => {
    const result = await handleSpecRequest(
      MAP_SPEC_METHODS.AUTHOR,
      {
        resource_id: opentasksResource.id,
        spec: { title: 'agent-authored spec', content: 'planner output', priority: 2 },
      },
      { swarmId: 'swarm-1', agentId: agent.id },
    );

    const spec = (result as { spec: { id: string; title: string } }).spec;
    expect(spec.title).toBe('agent-authored spec');

    expect(broadcastSpy).toHaveBeenCalledWith(
      'map:tasks',
      expect.objectContaining({
        type: 'spec.created',
        data: expect.objectContaining({
          resource_id: opentasksResource.id,
          initiator: { type: 'agent', id: agent.id },
        }),
      }),
    );
  });

  it('rejects unknown method', async () => {
    await expect(
      handleSpecRequest('map/specs/bogus', {}, { swarmId: 's', agentId: agent.id }),
    ).rejects.toBeInstanceOf(MAPSpecRequestError);
  });

  it('rejects missing resource_id', async () => {
    await expect(
      handleSpecRequest(MAP_SPEC_METHODS.AUTHOR, { spec: { title: 't' } }, { swarmId: 's', agentId: agent.id }),
    ).rejects.toThrow(/resource_id/);
  });

  it('rejects missing spec object', async () => {
    await expect(
      handleSpecRequest(
        MAP_SPEC_METHODS.AUTHOR,
        { resource_id: opentasksResource.id },
        { swarmId: 's', agentId: agent.id },
      ),
    ).rejects.toThrow(/spec/);
  });

  it('rejects empty title', async () => {
    await expect(
      handleSpecRequest(
        MAP_SPEC_METHODS.AUTHOR,
        { resource_id: opentasksResource.id, spec: { title: '' } },
        { swarmId: 's', agentId: agent.id },
      ),
    ).rejects.toThrow(/title/);
  });

  it('rejects unknown resource', async () => {
    await expect(
      handleSpecRequest(
        MAP_SPEC_METHODS.AUTHOR,
        { resource_id: 'res_fake', spec: { title: 'x' } },
        { swarmId: 's', agentId: agent.id },
      ),
    ).rejects.toThrow(/Resource not found/);
  });

  it('rejects when agent has no access to the resource', async () => {
    await expect(
      handleSpecRequest(
        MAP_SPEC_METHODS.AUTHOR,
        { resource_id: opentasksResource.id, spec: { title: 'x' } },
        { swarmId: 's', agentId: outsider.id },
      ),
    ).rejects.toThrow(/access/);
  });

  it('rejects non-opentasks resource', async () => {
    await expect(
      handleSpecRequest(
        MAP_SPEC_METHODS.AUTHOR,
        { resource_id: memoryResource.id, spec: { title: 'x' } },
        { swarmId: 's', agentId: agent.id },
      ),
    ).rejects.toThrow(/OpenTasks/);
  });

  // ==========================================================================
  // map/specs/dispatch (PR 4 — autonomous dispatch + kill switch)
  // ==========================================================================

  describe('map/specs/dispatch', () => {
    let swarm: { id: string };

    beforeAll(() => {
      const s = mapDAL.createSwarm(agent.id, {
        name: 'autonomous-target',
        map_endpoint: 'ws://example.invalid/auto',
      });
      swarm = { id: s.id };
    });

    it('creates dispatches with initiator_type=agent when toggled off', async () => {
      const result = await handleSpecRequest(
        MAP_SPEC_METHODS.DISPATCH,
        {
          resource_id: opentasksResource.id,
          spec_id: 's-target',
          target_swarms: [swarm.id],
          prompt: 'be careful',
        },
        { swarmId: 'sw-caller', agentId: agent.id },
      );

      const dispatches = (result as { dispatches: Array<{ id: string }> }).dispatches;
      expect(dispatches).toHaveLength(1);
      const persisted = dispatchesDAL.findDispatchById(dispatches[0]!.id);
      expect(persisted?.initiator_type).toBe('agent');
      expect(persisted?.initiator_id).toBe(agent.id);
      expect(persisted?.prompt_override).toBe('be careful');
    });

    it('returns -32004 when the kill switch is engaged', async () => {
      setAutonomousDispatchPaused(true);
      await expect(
        handleSpecRequest(
          MAP_SPEC_METHODS.DISPATCH,
          {
            resource_id: opentasksResource.id,
            spec_id: 's-target',
            target_swarms: [swarm.id],
          },
          { swarmId: 'sw-caller', agentId: agent.id },
        ),
      ).rejects.toMatchObject({ code: -32004 });
    });

    it('rejects missing resource_id / spec_id / target_swarms', async () => {
      await expect(
        handleSpecRequest(
          MAP_SPEC_METHODS.DISPATCH,
          { spec_id: 's-target', target_swarms: [swarm.id] },
          { swarmId: 'sw', agentId: agent.id },
        ),
      ).rejects.toThrow(/resource_id/);

      await expect(
        handleSpecRequest(
          MAP_SPEC_METHODS.DISPATCH,
          { resource_id: opentasksResource.id, target_swarms: [swarm.id] },
          { swarmId: 'sw', agentId: agent.id },
        ),
      ).rejects.toThrow(/spec_id/);

      await expect(
        handleSpecRequest(
          MAP_SPEC_METHODS.DISPATCH,
          { resource_id: opentasksResource.id, spec_id: 's-target', target_swarms: [] },
          { swarmId: 'sw', agentId: agent.id },
        ),
      ).rejects.toThrow(/target_swarms/);
    });

    it('returns -32001 when the spec cannot be found', async () => {
      await expect(
        handleSpecRequest(
          MAP_SPEC_METHODS.DISPATCH,
          {
            resource_id: opentasksResource.id,
            spec_id: 's-does-not-exist',
            target_swarms: [swarm.id],
          },
          { swarmId: 'sw', agentId: agent.id },
        ),
      ).rejects.toMatchObject({ code: -32001 });
    });
  });
});
