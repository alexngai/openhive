/**
 * Tests for MAP trajectory handler: trajectory/checkpoint request handling.
 *
 * Verifies:
 * - Auto-creates session resource on first checkpoint
 * - Reuses existing session resource on subsequent checkpoints
 * - Stores checkpoint data correctly via DAL
 * - Uses explicit resource_id when provided
 * - Broadcasts trajectory:sync events
 * - Returns resource_id and created flag to client
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as trajectoryDAL from '../../db/dal/trajectory-checkpoints.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { handleTrajectoryRequest, TrajectoryRequestError } from '../../map/trajectory-handler.js';
import * as mapDAL from '../../db/dal/map.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';
const mockBroadcast = vi.mocked(broadcastToChannel);

const TEST_ROOT = testRoot('trajectory-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'trajectory-handler.db');

describe('Trajectory Handler', () => {
  let agentId: string;
  const swarmId = 'swarm-traj-test-001';

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'trajectory-test-agent',
      description: 'Agent for trajectory handler tests',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('trajectory/checkpoint', () => {
    it('auto-creates session resource on first checkpoint', () => {
      mockBroadcast.mockClear();

      const result = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: {
            id: 'cp-auto-001',
            agent: 'gsd-sidecar',
            session_id: 'sess-auto-001',
            files_touched: ['src/app.ts'],
            checkpoints_count: 1,
            token_usage: { input_tokens: 5000, output_tokens: 1500 },
          },
        },
        { swarmId, agentId },
      );

      expect(result.ok).toBe(true);
      expect(result.created).toBe(true);
      expect(result.resource_id).toBeDefined();
      expect(result.checkpoint_id).toBe('cp-auto-001');

      // Verify checkpoint stored
      const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(result.resource_id);
      expect(checkpoints.length).toBe(1);
      expect(checkpoints[0].agent).toBe('gsd-sidecar');
      expect(checkpoints[0].files_touched).toEqual(['src/app.ts']);
      expect(checkpoints[0].token_usage).toEqual({ input_tokens: 5000, output_tokens: 1500 });
    });

    it('reuses existing session resource on subsequent checkpoints', () => {
      // First checkpoint (creates resource)
      const first = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: { id: 'cp-reuse-001', agent: 'test-sidecar' },
        },
        { swarmId: 'swarm-reuse-test', agentId },
      );
      expect(first.created).toBe(true);

      // Second checkpoint (reuses resource)
      const second = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: { id: 'cp-reuse-002', agent: 'test-sidecar' },
        },
        { swarmId: 'swarm-reuse-test', agentId },
      );
      expect(second.created).toBe(false);
      expect(second.resource_id).toBe(first.resource_id);
    });

    it('uses explicit resource_id when provided', () => {
      // Create a session resource manually
      const resource = resourcesDAL.createResource({
        resource_type: 'session',
        name: 'explicit-session',
        git_remote_url: 'map://test/explicit',
        owner_agent_id: agentId,
      });

      const result = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          resource_id: resource.id,
          checkpoint: { id: 'cp-explicit-001', agent: 'explicit-agent' },
        },
        { swarmId, agentId },
      );

      expect(result.ok).toBe(true);
      expect(result.resource_id).toBe(resource.id);
      expect(result.created).toBe(false);
    });

    it('throws when explicit resource_id does not exist', () => {
      expect(() =>
        handleTrajectoryRequest(
          'trajectory/checkpoint',
          {
            resource_id: 'res_nonexistent',
            checkpoint: { id: 'cp-404' },
          },
          { swarmId, agentId },
        ),
      ).toThrow(TrajectoryRequestError);
    });

    it('throws when checkpoint is missing', () => {
      expect(() =>
        handleTrajectoryRequest(
          'trajectory/checkpoint',
          {} as any,
          { swarmId, agentId },
        ),
      ).toThrow('missing checkpoint object');
    });

    it('broadcasts trajectory:sync to WebSocket channels', () => {
      mockBroadcast.mockClear();

      const result = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: { id: 'cp-broadcast-001', agent: 'broadcast-agent' },
        },
        { swarmId: 'swarm-broadcast-test', agentId },
      );

      // Should broadcast to both resource-specific and global channels
      expect(mockBroadcast).toHaveBeenCalledTimes(2);
      expect(mockBroadcast).toHaveBeenCalledWith(
        `resource:session:${result.resource_id}`,
        expect.objectContaining({ type: 'trajectory:sync' }),
      );
      expect(mockBroadcast).toHaveBeenCalledWith(
        'global',
        expect.objectContaining({ type: 'trajectory:sync' }),
      );
    });

    it('stores cc-swarm wire format checkpoint correctly', () => {
      // Exact shape from buildTrajectoryCheckpoint at metrics level
      const ccSwarmCheckpoint = {
        id: 'cp-wire-001',
        session_id: 'sess-wire-001',
        agent: 'gsd-sidecar',
        files_touched: ['src/app.ts', 'src/config.ts'],
        checkpoints_count: 3,
        token_usage: {
          input_tokens: 20000,
          output_tokens: 6000,
          cache_creation_tokens: 800,
          cache_read_tokens: 4000,
          api_call_count: 12,
        },
        metadata: {
          phase: 'idle',
          turnId: 'turn-5',
          startedAt: '2024-06-01T10:00:00Z',
          label: 'Turn turn-5 (step 12, idle)',
          stepCount: 12,
        },
      };

      const result = handleTrajectoryRequest(
        'trajectory/checkpoint',
        { checkpoint: ccSwarmCheckpoint },
        { swarmId: 'swarm-wire-test', agentId },
      );

      expect(result.ok).toBe(true);

      const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(result.resource_id);
      const stored = checkpoints.find((c) => c.checkpoint_id === 'cp-wire-001');
      expect(stored).toBeDefined();
      expect(stored!.agent).toBe('gsd-sidecar');
      expect(stored!.files_touched).toEqual(['src/app.ts', 'src/config.ts']);
      expect(stored!.checkpoints_count).toBe(3);
      expect(stored!.token_usage).toEqual(ccSwarmCheckpoint.token_usage);

      // Verify stats aggregation
      const stats = trajectoryDAL.getSessionStats(result.resource_id);
      expect(stats.total_input_tokens).toBe(20000);
      expect(stats.total_output_tokens).toBe(6000);
      expect(stats.total_files_touched).toBe(2);
    });
  });

  describe('enriched session context', () => {
    it('uses project and branch for session resource name', () => {
      const result = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: {
            id: 'enrich-001',
            agent: 'default-sidecar',
            branch: 'main',
            metadata: { project: 'my-app', template: 'gsd' },
          },
        },
        { swarmId: 'swarm-enrich-test', agentId },
      );

      const resource = resourcesDAL.findResourceById(result.resource_id);
      expect(resource).toBeDefined();
      expect(resource!.name).toBe('my-app (main)');
    });

    it('uses firstPrompt as session description', () => {
      const result = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: {
            id: 'enrich-002',
            agent: 'default-sidecar',
            metadata: { project: 'my-app', firstPrompt: 'add JWT authentication' },
          },
        },
        { swarmId: 'swarm-enrich-desc', agentId },
      );

      const resource = resourcesDAL.findResourceById(result.resource_id);
      expect(resource!.description).toBe('add JWT authentication');
    });

    it('updates description when firstPrompt arrives on subsequent checkpoint', () => {
      // First checkpoint — no firstPrompt
      const r1 = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: { id: 'enrich-003a', agent: 'sidecar', metadata: { project: 'proj' } },
        },
        { swarmId: 'swarm-enrich-update', agentId },
      );

      const before = resourcesDAL.findResourceById(r1.resource_id);
      expect(before!.description).not.toContain('fix the bug');

      // Second checkpoint — with firstPrompt
      handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: {
            id: 'enrich-003b', agent: 'sidecar',
            metadata: { project: 'proj', firstPrompt: 'fix the bug in auth' },
          },
        },
        { swarmId: 'swarm-enrich-update', agentId },
      );

      const after = resourcesDAL.findResourceById(r1.resource_id);
      expect(after!.description).toBe('fix the bug in auth');
    });

    it('falls back to session:swarmId name when no project context', () => {
      const result = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: { id: 'enrich-004', agent: 'sidecar' },
        },
        { swarmId: 'swarm-no-project', agentId },
      );

      const resource = resourcesDAL.findResourceById(result.resource_id);
      expect(resource!.name).toBe('session:swarm-no-project');
    });

    it('looks up existing resource by git_remote_url even after name change', () => {
      // Create with project name
      const r1 = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: { id: 'lookup-001', agent: 'sidecar', metadata: { project: 'renamed-app' } },
        },
        { swarmId: 'swarm-lookup-test', agentId },
      );
      expect(r1.created).toBe(true);

      // Second checkpoint — same swarm, should find by git_remote_url
      const r2 = handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: { id: 'lookup-002', agent: 'sidecar', metadata: { project: 'renamed-app' } },
        },
        { swarmId: 'swarm-lookup-test', agentId },
      );
      expect(r2.created).toBe(false);
      expect(r2.resource_id).toBe(r1.resource_id);
    });
  });

  describe('swarm enrichment', () => {
    it('updates swarm name with project context from checkpoint', () => {
      const swarm = mapDAL.createSwarm(agentId, {
        name: 'local-hub',
        map_endpoint: 'ws://localhost:9999',
        map_transport: 'websocket',
      });
      mapDAL.updateSwarm(swarm.id, { status: 'online' });

      handleTrajectoryRequest(
        'trajectory/checkpoint',
        {
          checkpoint: {
            id: 'swarm-enrich-001', agent: 'default-sidecar', branch: 'feature',
            metadata: { project: 'cool-project', template: 'gsd' },
          },
        },
        { swarmId: swarm.id, agentId },
      );

      const updated = mapDAL.findSwarmById(swarm.id);
      expect(updated!.name).toBe('cool-project (feature)');
    });
  });

  describe('cache invalidation', () => {
    it('clears storage metadata on new checkpoint', () => {
      // Create session with cached storage
      const r1 = handleTrajectoryRequest(
        'trajectory/checkpoint',
        { checkpoint: { id: 'cache-001', agent: 'sidecar' } },
        { swarmId: 'swarm-cache-test', agentId },
      );

      // Simulate cache by setting storage metadata
      resourcesDAL.updateResource(r1.resource_id, {
        metadata: { storage: { backend: 'local', cachedAt: '2026-01-01' } },
      });

      // Verify cache is set
      const before = resourcesDAL.findResourceById(r1.resource_id);
      expect((before!.metadata as any)?.storage?.backend).toBe('local');

      // New checkpoint should invalidate
      handleTrajectoryRequest(
        'trajectory/checkpoint',
        { checkpoint: { id: 'cache-002', agent: 'sidecar' } },
        { swarmId: 'swarm-cache-test', agentId },
      );

      const after = resourcesDAL.findResourceById(r1.resource_id);
      expect((after!.metadata as any)?.storage).toBeUndefined();
    });
  });

  describe('unknown method', () => {
    it('throws for unknown trajectory method', () => {
      expect(() =>
        handleTrajectoryRequest('trajectory/unknown', {}, { swarmId, agentId }),
      ).toThrow('Unknown trajectory method');
    });
  });
});
