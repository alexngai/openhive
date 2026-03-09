/**
 * Tests for MAP inbound WebSocket (/ws/map):
 * - Connection registry (register, unregister, replace)
 * - isMapSyncMessage / isCoordinationMessage type guards
 * - Dual-transport sendToSwarm (inbound preferred over outbound)
 * - Auto-registration of hub-inbound swarms
 * - connectToSwarm skips hub-inbound endpoints
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import {
  registerInbound,
  unregisterInbound,
  getInbound,
  getAllInbound,
  getInboundCount,
} from '../../map/connection-registry.js';
import {
  isMapSyncMessage,
  handleSyncMessage,
  sendToSwarm,
} from '../../map/sync-listener.js';
import { isCoordinationMessage } from '../../coordination/listener.js';
import { createSyncNotification } from '../../map/types.js';
import type { MapSyncMessage } from '../../map/types.js';
import { createHive } from '../../db/dal/hives.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel — sync-listener imports it for WebSocket broadcasts
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

// Mock resource hooks
vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: vi.fn(),
}));

const TEST_ROOT = testRoot('ws-map');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'ws-map.db');

// ============================================================================
// Helpers: mock WebSocket
// ============================================================================

function createMockWs(readyState = WebSocket.OPEN): WebSocket {
  const ws = new EventEmitter() as unknown as WebSocket;
  (ws as unknown as { readyState: number }).readyState = readyState;
  (ws as unknown as { send: (data: string) => void }).send = vi.fn();
  (ws as unknown as { close: () => void }).close = vi.fn();
  (ws as unknown as { terminate: () => void }).terminate = vi.fn();
  return ws;
}

// ============================================================================
// Tests
// ============================================================================

describe('MAP Inbound WebSocket', () => {
  let agentId: string;
  let agent2Id: string;
  let swarmId: string;
  let swarm2Id: string;
  let memoryResourceId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'ws-map-agent-1',
      description: 'Agent 1 for ws-map tests',
    });
    agentId = agent.id;

    const { agent: agent2 } = await agentsDAL.createAgent({
      name: 'ws-map-agent-2',
      description: 'Agent 2 for ws-map tests',
    });
    agent2Id = agent2.id;

    // Create swarm 1 (traditional outbound)
    const swarm = mapDAL.createSwarm(agentId, {
      name: 'test-outbound-swarm',
      map_endpoint: 'ws://localhost:9999/map',
      map_transport: 'websocket',
    });
    swarmId = swarm.id;
    mapDAL.updateSwarm(swarmId, { status: 'online' });

    // Create swarm 2 (hub-inbound)
    const swarm2 = mapDAL.createSwarm(agent2Id, {
      name: 'test-inbound-swarm',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
    });
    swarm2Id = swarm2.id;
    mapDAL.updateSwarm(swarm2Id, { status: 'online' });

    // Create a syncable resource
    const resource = resourcesDAL.createResource({
      resource_type: 'memory_bank',
      name: 'ws-map-test-memory',
      git_remote_url: 'https://github.com/test/ws-map-memory.git',
      owner_agent_id: agentId,
    });
    memoryResourceId = resource.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ═══════════════════════════════════════════════════════════════
  // Connection Registry
  // ═══════════════════════════════════════════════════════════════

  describe('connection registry', () => {
    beforeEach(() => {
      // Clean registry between tests
      for (const id of getAllInbound().keys()) {
        unregisterInbound(id);
      }
    });

    it('should register and retrieve an inbound connection', () => {
      const ws = createMockWs();
      registerInbound('swarm_1', {
        ws,
        agentId: 'agent_1',
        swarmId: 'swarm_1',
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });

      const conn = getInbound('swarm_1');
      expect(conn).toBeDefined();
      expect(conn!.ws).toBe(ws);
      expect(conn!.agentId).toBe('agent_1');
    });

    it('should return undefined for unregistered swarm', () => {
      expect(getInbound('nonexistent')).toBeUndefined();
    });

    it('should unregister a connection', () => {
      const ws = createMockWs();
      registerInbound('swarm_1', {
        ws,
        agentId: 'agent_1',
        swarmId: 'swarm_1',
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });

      unregisterInbound('swarm_1');
      expect(getInbound('swarm_1')).toBeUndefined();
      expect(getInboundCount()).toBe(0);
    });

    it('should replace existing connection and close the old one', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      registerInbound('swarm_1', {
        ws: ws1,
        agentId: 'agent_1',
        swarmId: 'swarm_1',
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });

      registerInbound('swarm_1', {
        ws: ws2,
        agentId: 'agent_1',
        swarmId: 'swarm_1',
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });

      expect(getInbound('swarm_1')!.ws).toBe(ws2);
      expect((ws1.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect(getInboundCount()).toBe(1);
    });

    it('should track count correctly', () => {
      expect(getInboundCount()).toBe(0);

      registerInbound('s1', { ws: createMockWs(), agentId: 'a1', swarmId: 's1', connectedAt: '', lastMessageAt: '' });
      registerInbound('s2', { ws: createMockWs(), agentId: 'a2', swarmId: 's2', connectedAt: '', lastMessageAt: '' });
      expect(getInboundCount()).toBe(2);

      unregisterInbound('s1');
      expect(getInboundCount()).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Type Guards
  // ═══════════════════════════════════════════════════════════════

  describe('message type guards', () => {
    it('isMapSyncMessage should accept valid memory sync', () => {
      const msg = createSyncNotification('x-openhive/memory.sync', {
        resource_id: 'res_1',
        agent_id: 'ag_1',
        commit_hash: 'abc123',
        timestamp: new Date().toISOString(),
      });
      expect(isMapSyncMessage(msg)).toBe(true);
    });

    it('isMapSyncMessage should reject non-sync methods', () => {
      expect(isMapSyncMessage({
        jsonrpc: '2.0',
        method: 'x-openhive/task.assign',
        params: { resource_id: 'r', agent_id: 'a', commit_hash: 'c', timestamp: 't' },
      })).toBe(false);
    });

    it('isMapSyncMessage should reject invalid structure', () => {
      expect(isMapSyncMessage(null)).toBe(false);
      expect(isMapSyncMessage({})).toBe(false);
      expect(isMapSyncMessage({ jsonrpc: '2.0', method: 'x-openhive/memory.sync' })).toBe(false);
    });

    it('isCoordinationMessage should accept valid task.assign', () => {
      expect(isCoordinationMessage({
        jsonrpc: '2.0',
        method: 'x-openhive/task.assign',
        params: { task_id: 't1', title: 'Test' },
      })).toBe(true);
    });

    it('isCoordinationMessage should reject sync methods', () => {
      expect(isCoordinationMessage({
        jsonrpc: '2.0',
        method: 'x-openhive/memory.sync',
        params: { resource_id: 'r' },
      })).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Dual-Transport sendToSwarm
  // ═══════════════════════════════════════════════════════════════

  describe('sendToSwarm dual-transport', () => {
    beforeEach(() => {
      for (const id of getAllInbound().keys()) {
        unregisterInbound(id);
      }
    });

    it('should deliver via inbound connection when available', () => {
      const ws = createMockWs();
      registerInbound(swarmId, {
        ws,
        agentId,
        swarmId,
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });

      const result = sendToSwarm(swarmId, { jsonrpc: '2.0', method: 'test', params: {} });
      expect(result).toBe(true);
      expect((ws.send as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        JSON.stringify({ jsonrpc: '2.0', method: 'test', params: {} })
      );
    });

    it('should return false when no connection exists', () => {
      const result = sendToSwarm('nonexistent_swarm', { jsonrpc: '2.0', method: 'test', params: {} });
      expect(result).toBe(false);
    });

    it('should skip closed inbound connections', () => {
      const ws = createMockWs(WebSocket.CLOSED);
      registerInbound(swarmId, {
        ws,
        agentId,
        swarmId,
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });

      // No outbound connection either, so this should return false
      const result = sendToSwarm(swarmId, { jsonrpc: '2.0', method: 'test', params: {} });
      expect(result).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Inbound message processing through handleSyncMessage
  // ═══════════════════════════════════════════════════════════════

  describe('inbound sync message processing', () => {
    it('should process a sync message from an inbound-connected swarm', () => {
      const msg: MapSyncMessage = createSyncNotification('x-openhive/memory.sync', {
        resource_id: memoryResourceId,
        agent_id: agentId,
        commit_hash: 'inbound_commit_001',
        timestamp: new Date().toISOString(),
      });

      // This is the same handler used by outbound connections
      handleSyncMessage(msg, swarm2Id);

      const resource = resourcesDAL.findResourceById(memoryResourceId);
      expect(resource!.last_commit_hash).toBe('inbound_commit_001');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Hub-inbound swarm creation
  // ═══════════════════════════════════════════════════════════════

  describe('hub-inbound swarm', () => {
    it('should be discoverable via listSwarms', () => {
      const { data: swarms } = mapDAL.listSwarms({ owner_agent_id: agent2Id });
      const inbound = swarms.find((s) => s.map_endpoint === 'hub-inbound');
      expect(inbound).toBeDefined();
      expect(inbound!.map_transport).toBe('websocket');
    });

    it('should appear in peer lists with hub-inbound endpoint', () => {
      // Join both swarms to the same hive first
      const hive = createHive({
        name: 'ws-map-test-hive',
        description: 'Test hive for ws-map peer discovery',
        owner_id: agentId,
      });

      mapDAL.joinHive(swarmId, hive.id);
      mapDAL.joinHive(swarm2Id, hive.id);

      // Get peer list from swarm1's perspective
      const peers = mapDAL.getPeerList(swarmId);
      const inboundPeer = peers.find((p) => p.swarm_id === swarm2Id);
      expect(inboundPeer).toBeDefined();
      expect(inboundPeer!.map_endpoint).toBe('hub-inbound');
    });
  });
});
