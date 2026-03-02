/**
 * Tests for MAP sync listener: handleSyncMessage, relay, and DAL helpers.
 *
 * These tests exercise the server-side sync flow:
 *   swarm emits message → handleSyncMessage validates, bookkeeps, broadcasts, relays
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { handleSyncMessage } from '../../map/sync-listener.js';
import * as trajectoryDAL from '../../db/dal/trajectory-checkpoints.js';
import { SYNC_MESSAGE_RESOURCE_TYPE, createSyncNotification } from '../../map/types.js';
import type { MapSyncMessage } from '../../map/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel — sync-listener imports it for WebSocket broadcasts
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';
const mockBroadcast = vi.mocked(broadcastToChannel);

const TEST_ROOT = testRoot('map-sync-listener');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'sync-listener.db');

describe('MAP Sync Listener', () => {
  let agentId: string;
  let agent2Id: string;
  let memoryResourceId: string;
  let skillResourceId: string;
  let sessionResourceId: string;
  let swarmId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    // Create two agents
    const { agent } = await agentsDAL.createAgent({
      name: 'sync-listener-agent-1',
      description: 'Agent 1 for sync listener tests',
    });
    agentId = agent.id;

    const { agent: agent2 } = await agentsDAL.createAgent({
      name: 'sync-listener-agent-2',
      description: 'Agent 2 for sync listener tests',
    });
    agent2Id = agent2.id;

    // Create syncable resources
    const memResource = resourcesDAL.createResource({
      resource_type: 'memory_bank',
      name: 'test-memory-bank',
      git_remote_url: 'https://github.com/test/memory.git',
      owner_agent_id: agentId,
    });
    memoryResourceId = memResource.id;

    const skillResource = resourcesDAL.createResource({
      resource_type: 'skill',
      name: 'test-skill-repo',
      git_remote_url: 'https://github.com/test/skills.git',
      owner_agent_id: agentId,
    });
    skillResourceId = skillResource.id;

    const sessionResource = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'test-session-log',
      git_remote_url: 'https://github.com/test/sessions.git',
      owner_agent_id: agentId,
    });
    sessionResourceId = sessionResource.id;

    // Create a swarm owned by agent 1
    const swarm = mapDAL.createSwarm(agentId, {
      name: 'test-swarm-1',
      map_endpoint: 'ws://localhost:9001/map',
      map_transport: 'websocket',
    });
    swarmId = swarm.id;
    mapDAL.updateSwarm(swarmId, { status: 'online' });
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ═══════════════════════════════════════════════════════════════
  // SYNC_MESSAGE_RESOURCE_TYPE mapping
  // ═══════════════════════════════════════════════════════════════

  describe('SYNC_MESSAGE_RESOURCE_TYPE', () => {
    it('should map x-openhive/memory.sync to memory_bank', () => {
      expect(SYNC_MESSAGE_RESOURCE_TYPE['x-openhive/memory.sync']).toBe('memory_bank');
    });

    it('should map x-openhive/skill.sync to skill', () => {
      expect(SYNC_MESSAGE_RESOURCE_TYPE['x-openhive/skill.sync']).toBe('skill');
    });

    it('should map trajectory/checkpoint to session', () => {
      expect(SYNC_MESSAGE_RESOURCE_TYPE['trajectory/checkpoint']).toBe('session');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // handleSyncMessage
  // ═══════════════════════════════════════════════════════════════

  describe('handleSyncMessage', () => {
    beforeAll(() => {
      mockBroadcast.mockClear();
    });

    it('should process a valid memory.sync message', () => {
      mockBroadcast.mockClear();

      const msg: MapSyncMessage = createSyncNotification('x-openhive/memory.sync', {
        resource_id: memoryResourceId,
        agent_id: agentId,
        commit_hash: 'abc123def456',
        timestamp: new Date().toISOString(),
      });

      handleSyncMessage(msg, swarmId);

      // Verify sync state was updated
      const resource = resourcesDAL.findResourceById(memoryResourceId);
      expect(resource).not.toBeNull();
      expect(resource!.last_commit_hash).toBe('abc123def456');

      // Verify broadcast was called (resource channel + legacy memory channel)
      expect(mockBroadcast).toHaveBeenCalledWith(
        `resource:memory_bank:${memoryResourceId}`,
        expect.objectContaining({
          type: 'memory:sync',
          data: expect.objectContaining({
            resource_id: memoryResourceId,
            commit_hash: 'abc123def456',
          }),
        }),
      );

      // Legacy memory_bank channel
      expect(mockBroadcast).toHaveBeenCalledWith(
        `memory-bank:${memoryResourceId}`,
        expect.objectContaining({
          type: 'memory_bank_updated',
        }),
      );
    });

    it('should process a valid skill.sync message', () => {
      mockBroadcast.mockClear();

      const msg: MapSyncMessage = createSyncNotification('x-openhive/skill.sync', {
        resource_id: skillResourceId,
        agent_id: agentId,
        commit_hash: 'skill_commit_001',
        timestamp: new Date().toISOString(),
      });

      handleSyncMessage(msg, swarmId);

      // Verify sync state was updated
      const resource = resourcesDAL.findResourceById(skillResourceId);
      expect(resource!.last_commit_hash).toBe('skill_commit_001');

      // Verify broadcast — skill resources should NOT get legacy memory channel
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      expect(mockBroadcast).toHaveBeenCalledWith(
        `resource:skill:${skillResourceId}`,
        expect.objectContaining({
          type: 'skill:sync',
          data: expect.objectContaining({
            resource_id: skillResourceId,
            commit_hash: 'skill_commit_001',
          }),
        }),
      );
    });

    it('should skip unknown resource IDs', () => {
      mockBroadcast.mockClear();

      const msg: MapSyncMessage = createSyncNotification('x-openhive/memory.sync', {
        resource_id: 'res_nonexistent',
        agent_id: agentId,
        commit_hash: 'deadbeef',
        timestamp: new Date().toISOString(),
      });

      // Should not throw
      handleSyncMessage(msg, swarmId);

      // Should not broadcast
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('should skip when message method does not match resource type', () => {
      mockBroadcast.mockClear();

      // Send a skill.sync message for a memory_bank resource
      const msg: MapSyncMessage = createSyncNotification('x-openhive/skill.sync', {
        resource_id: memoryResourceId, // This is a memory_bank
        agent_id: agentId,
        commit_hash: 'mismatch_hash',
        timestamp: new Date().toISOString(),
      });

      handleSyncMessage(msg, swarmId);

      // Should not update or broadcast
      expect(mockBroadcast).not.toHaveBeenCalled();
      const resource = resourcesDAL.findResourceById(memoryResourceId);
      expect(resource!.last_commit_hash).not.toBe('mismatch_hash');
    });

    it('should deduplicate by commit hash', () => {
      mockBroadcast.mockClear();

      // First, update the resource to have a known commit hash
      resourcesDAL.updateResourceSyncState(memoryResourceId, 'already_seen', agentId);

      const msg: MapSyncMessage = createSyncNotification('x-openhive/memory.sync', {
        resource_id: memoryResourceId,
        agent_id: agentId,
        commit_hash: 'already_seen',
        timestamp: new Date().toISOString(),
      });

      handleSyncMessage(msg, swarmId);

      // Should not broadcast since commit hash was already recorded
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('should create a sync event audit entry', () => {
      mockBroadcast.mockClear();

      const msg: MapSyncMessage = createSyncNotification('x-openhive/memory.sync', {
        resource_id: memoryResourceId,
        agent_id: agentId,
        commit_hash: 'audit_commit_hash',
        timestamp: new Date().toISOString(),
      });

      handleSyncMessage(msg, swarmId);

      // Verify a sync event was created
      const { data: events } = resourcesDAL.getSyncEvents(memoryResourceId, 10, 0);
      const auditEvent = events.find((e) => e.commit_hash === 'audit_commit_hash');
      expect(auditEvent).toBeDefined();
      expect(auditEvent!.pusher).toBe(`map:${agentId}`);
    });

    it('should process a valid trajectory/checkpoint message', () => {
      mockBroadcast.mockClear();

      const msg: MapSyncMessage = createSyncNotification('trajectory/checkpoint', {
        resource_id: sessionResourceId,
        agent_id: agentId,
        commit_hash: 'checkpoint_hash_001',
        timestamp: new Date().toISOString(),
      });

      handleSyncMessage(msg, swarmId);

      // Verify sync state was updated
      const resource = resourcesDAL.findResourceById(sessionResourceId);
      expect(resource).not.toBeNull();
      expect(resource!.last_commit_hash).toBe('checkpoint_hash_001');

      // Verify broadcast uses trajectory:sync event type (not skill:sync)
      expect(mockBroadcast).toHaveBeenCalledWith(
        `resource:session:${sessionResourceId}`,
        expect.objectContaining({
          type: 'trajectory:sync',
          data: expect.objectContaining({
            resource_id: sessionResourceId,
            resource_type: 'session',
            commit_hash: 'checkpoint_hash_001',
          }),
        }),
      );

      // Should NOT get legacy memory_bank channel broadcast
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
    });

    it('should reject trajectory/checkpoint for non-session resources', () => {
      mockBroadcast.mockClear();

      // Send trajectory/checkpoint for a memory_bank resource — should be rejected
      const msg: MapSyncMessage = createSyncNotification('trajectory/checkpoint', {
        resource_id: memoryResourceId, // This is a memory_bank
        agent_id: agentId,
        commit_hash: 'wrong_type_hash',
        timestamp: new Date().toISOString(),
      });

      handleSyncMessage(msg, swarmId);

      // Should not broadcast
      expect(mockBroadcast).not.toHaveBeenCalled();
    });

    it('should create audit entry for trajectory/checkpoint', () => {
      mockBroadcast.mockClear();

      const msg: MapSyncMessage = createSyncNotification('trajectory/checkpoint', {
        resource_id: sessionResourceId,
        agent_id: agentId,
        commit_hash: 'trajectory_audit_hash',
        timestamp: new Date().toISOString(),
      });

      handleSyncMessage(msg, swarmId);

      const { data: events } = resourcesDAL.getSyncEvents(sessionResourceId, 10, 0);
      const auditEvent = events.find((e) => e.commit_hash === 'trajectory_audit_hash');
      expect(auditEvent).toBeDefined();
      expect(auditEvent!.pusher).toBe(`map:${agentId}`);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Checkpoint metadata storage via handleSyncMessage
  // ═══════════════════════════════════════════════════════════════

  describe('checkpoint metadata storage', () => {
    it('should store checkpoint metadata when params.checkpoint is present', () => {
      mockBroadcast.mockClear();

      const msg: MapSyncMessage = {
        jsonrpc: '2.0',
        method: 'trajectory/checkpoint',
        params: {
          resource_id: sessionResourceId,
          agent_id: agentId,
          commit_hash: 'store_meta_hash_001',
          timestamp: new Date().toISOString(),
          checkpoint: {
            id: 'chk_store_001',
            agent: 'claude-coder',
            branch: 'feature-x',
            files_touched: ['src/app.ts', 'src/utils.ts'],
            checkpoints_count: 5,
            token_usage: { input_tokens: 2000, output_tokens: 800 },
            summary: { intent: 'add auth flow', outcome: 'implemented' },
            attribution: { claude: 0.9, human: 0.1 },
          },
        } as Record<string, unknown>,
      } as MapSyncMessage;

      handleSyncMessage(msg, swarmId);

      // Verify checkpoint was stored
      const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(sessionResourceId);
      const stored = checkpoints.find((c) => c.commit_hash === 'store_meta_hash_001');
      expect(stored).toBeDefined();
      expect(stored!.checkpoint_id).toBe('chk_store_001');
      expect(stored!.agent).toBe('claude-coder');
      expect(stored!.branch).toBe('feature-x');
      expect(stored!.files_touched).toEqual(['src/app.ts', 'src/utils.ts']);
      expect(stored!.checkpoints_count).toBe(5);
      expect(stored!.token_usage).toEqual({ input_tokens: 2000, output_tokens: 800 });
      expect(stored!.summary).toEqual({ intent: 'add auth flow', outcome: 'implemented' });
      expect(stored!.attribution).toEqual({ claude: 0.9, human: 0.1 });
      expect(stored!.source_swarm_id).toBe(swarmId);
      expect(stored!.source_agent_id).toBe(agentId);
    });

    it('should use commit_hash as checkpoint_id when checkpoint.id is missing', () => {
      mockBroadcast.mockClear();

      const msg: MapSyncMessage = {
        jsonrpc: '2.0',
        method: 'trajectory/checkpoint',
        params: {
          resource_id: sessionResourceId,
          agent_id: agentId,
          commit_hash: 'store_meta_hash_002',
          timestamp: new Date().toISOString(),
          checkpoint: {
            agent: 'fallback-agent',
          },
        } as Record<string, unknown>,
      } as MapSyncMessage;

      handleSyncMessage(msg, swarmId);

      const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(sessionResourceId);
      const stored = checkpoints.find((c) => c.commit_hash === 'store_meta_hash_002');
      expect(stored).toBeDefined();
      expect(stored!.checkpoint_id).toBe('store_meta_hash_002');
      expect(stored!.agent).toBe('fallback-agent');
    });

    it('should not store checkpoint when params.checkpoint is absent', () => {
      mockBroadcast.mockClear();

      const msg: MapSyncMessage = createSyncNotification('trajectory/checkpoint', {
        resource_id: sessionResourceId,
        agent_id: agentId,
        commit_hash: 'no_checkpoint_meta_hash',
        timestamp: new Date().toISOString(),
      });

      handleSyncMessage(msg, swarmId);

      // The sync still processes (broadcast happens), but no checkpoint row
      const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(sessionResourceId);
      const stored = checkpoints.find((c) => c.commit_hash === 'no_checkpoint_meta_hash');
      expect(stored).toBeUndefined();
    });

    it('should dedup checkpoint metadata on repeated sync', () => {
      mockBroadcast.mockClear();

      const makeMsg = (commitHash: string): MapSyncMessage => ({
        jsonrpc: '2.0',
        method: 'trajectory/checkpoint',
        params: {
          resource_id: sessionResourceId,
          agent_id: agentId,
          commit_hash: commitHash,
          timestamp: new Date().toISOString(),
          checkpoint: {
            id: 'chk_dedup_sync',
            agent: 'dedup-agent',
          },
        } as Record<string, unknown>,
      } as MapSyncMessage);

      // First send
      handleSyncMessage(makeMsg('dedup_hash_1'), swarmId);

      // Second send with different commit_hash but same checkpoint_id
      // The sync-listener dedup on commit_hash will skip this (resource already has dedup_hash_1)
      // But even if it got through, trajectory DAL dedup on (session, checkpoint_id) would catch it
      handleSyncMessage(makeMsg('dedup_hash_2'), swarmId);

      const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(sessionResourceId);
      const matches = checkpoints.filter((c) => c.checkpoint_id === 'chk_dedup_sync');
      expect(matches.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // findSwarmsByOwnerAgentIds
  // ═══════════════════════════════════════════════════════════════

  describe('findSwarmsByOwnerAgentIds', () => {
    let swarm2Id: string;

    beforeAll(() => {
      // Create a second swarm owned by agent 2
      const swarm2 = mapDAL.createSwarm(agent2Id, {
        name: 'test-swarm-2',
        map_endpoint: 'ws://localhost:9002/map',
        map_transport: 'websocket',
      });
      swarm2Id = swarm2.id;
      mapDAL.updateSwarm(swarm2Id, { status: 'online' });
    });

    it('should return online swarms for given agent IDs', () => {
      const swarms = mapDAL.findSwarmsByOwnerAgentIds([agentId, agent2Id]);
      expect(swarms.length).toBe(2);
      const ids = swarms.map((s) => s.id);
      expect(ids).toContain(swarmId);
      expect(ids).toContain(swarm2Id);
    });

    it('should only return online swarms', () => {
      // Set swarm2 offline
      mapDAL.updateSwarm(swarm2Id, { status: 'offline' });

      const swarms = mapDAL.findSwarmsByOwnerAgentIds([agentId, agent2Id]);
      expect(swarms.length).toBe(1);
      expect(swarms[0].id).toBe(swarmId);

      // Restore
      mapDAL.updateSwarm(swarm2Id, { status: 'online' });
    });

    it('should return empty array for empty input', () => {
      const swarms = mapDAL.findSwarmsByOwnerAgentIds([]);
      expect(swarms).toEqual([]);
    });

    it('should return empty array for unknown agent IDs', () => {
      const swarms = mapDAL.findSwarmsByOwnerAgentIds(['nonexistent_agent']);
      expect(swarms).toEqual([]);
    });
  });
});
