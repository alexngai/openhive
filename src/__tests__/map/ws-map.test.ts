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
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
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
import { initInboxBridge, stopInboxBridge, getInboxStorage } from '../../map/inbox-bridge.js';
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
        transport: { type: 'websocket', ws },
        agentId: 'agent_1',
        swarmId: 'swarm_1',
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });

      const conn = getInbound('swarm_1');
      expect(conn).toBeDefined();
      expect(conn!.transport.type).toBe('websocket');
      expect(conn!.agentId).toBe('agent_1');
    });

    it('should return undefined for unregistered swarm', () => {
      expect(getInbound('nonexistent')).toBeUndefined();
    });

    it('should unregister a connection', () => {
      const ws = createMockWs();
      registerInbound('swarm_1', {
        transport: { type: 'websocket', ws },
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
        transport: { type: 'websocket', ws: ws1 },
        agentId: 'agent_1',
        swarmId: 'swarm_1',
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });

      registerInbound('swarm_1', {
        transport: { type: 'websocket', ws: ws2 },
        agentId: 'agent_1',
        swarmId: 'swarm_1',
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });

      const conn = getInbound('swarm_1')!;
      expect(conn.transport.type === 'websocket' && conn.transport.ws === ws2).toBe(true);
      expect((ws1.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect(getInboundCount()).toBe(1);
    });

    it('should track count correctly', () => {
      expect(getInboundCount()).toBe(0);

      registerInbound('s1', { transport: { type: 'websocket', ws: createMockWs() }, agentId: 'a1', swarmId: 's1', connectedAt: '', lastMessageAt: '' });
      registerInbound('s2', { transport: { type: 'websocket', ws: createMockWs() }, agentId: 'a2', swarmId: 's2', connectedAt: '', lastMessageAt: '' });
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
        transport: { type: 'websocket', ws },
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
        transport: { type: 'websocket', ws },
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

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: Direct addressing + agent registration
  // ═══════════════════════════════════════════════════════════════

  describe('Phase 2 — direct addressing and agent registration', () => {
    let p2AgentId: string;
    let p2Agent2Id: string;
    let p2Swarm1Id: string;
    let p2Swarm2Id: string;

    beforeAll(async () => {
      await initInboxBridge();

      const { agent: a1 } = await agentsDAL.createAgent({
        name: 'p2-agent-1',
        description: 'Phase 2 Agent 1',
      });
      p2AgentId = a1.id;

      const { agent: a2 } = await agentsDAL.createAgent({
        name: 'p2-agent-2',
        description: 'Phase 2 Agent 2',
      });
      p2Agent2Id = a2.id;

      const s1 = mapDAL.createSwarm(p2AgentId, {
        name: 'p2-swarm-1',
        map_endpoint: 'hub-inbound',
        map_transport: 'websocket',
        auth_method: 'none',
      });
      p2Swarm1Id = s1.id;
      mapDAL.updateSwarm(p2Swarm1Id, { status: 'online' });

      const s2 = mapDAL.createSwarm(p2Agent2Id, {
        name: 'p2-swarm-2',
        map_endpoint: 'hub-inbound',
        map_transport: 'websocket',
        auth_method: 'none',
      });
      p2Swarm2Id = s2.id;
      mapDAL.updateSwarm(p2Swarm2Id, { status: 'online' });

      // Register inbound connections
      registerInbound(p2Swarm1Id, {
        transport: { type: 'websocket', ws: createMockWs() },
        agentId: p2AgentId,
        swarmId: p2Swarm1Id,
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });
      registerInbound(p2Swarm2Id, {
        transport: { type: 'websocket', ws: createMockWs() },
        agentId: p2Agent2Id,
        swarmId: p2Swarm2Id,
        connectedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
      });
    });

    afterAll(async () => {
      unregisterInbound(p2Swarm1Id);
      unregisterInbound(p2Swarm2Id);
      await stopInboxBridge();
    });

    it('should resolve agent to swarm via ownership fallback', () => {
      // p2AgentId owns p2Swarm1Id — resolveAgentSwarm uses listSwarms fallback
      const { data: swarms } = mapDAL.listSwarms({ owner_agent_id: p2AgentId, status: 'online', limit: 1 });
      expect(swarms.length).toBeGreaterThan(0);
      expect(swarms[0].id).toBe(p2Swarm1Id);
    });

    it('should resolve agent to swarm via map_nodes when node is registered', () => {
      // Register a node for p2Agent2 in p2Swarm1
      const node = mapDAL.createNode({
        swarm_id: p2Swarm1Id,
        map_agent_id: 'custom-agent-id',
        name: 'custom-node',
        role: 'worker',
        state: 'active',
        capabilities: {},
      });

      // The node should be findable via direct SQL (matches resolveAgentSwarm logic)
      const db = getDatabase();
      const found = db.prepare(
        "SELECT swarm_id FROM map_nodes WHERE map_agent_id = ? AND state = 'active' LIMIT 1"
      ).get('custom-agent-id') as { swarm_id: string } | undefined;
      expect(found).toBeDefined();
      expect(found!.swarm_id).toBe(p2Swarm1Id);

      // Cleanup
      mapDAL.deleteNode(node.id);
    });

    it('should register agent in inbox on putAgent', () => {
      const inboxStorage = getInboxStorage();

      // Simulate what ws-map does on connect
      inboxStorage.putAgent({
        agent_id: p2AgentId,
        scope: 'default',
        status: 'active',
        metadata: { swarm_id: p2Swarm1Id, name: 'p2-agent-1' },
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });

      const agent = inboxStorage.getAgent(p2AgentId);
      expect(agent).toBeDefined();
      expect(agent!.status).toBe('active');
      expect(agent!.metadata).toEqual(
        expect.objectContaining({ swarm_id: p2Swarm1Id }),
      );
    });

    it('should mark agent offline in inbox on disconnect', () => {
      const inboxStorage = getInboxStorage();

      // First register
      inboxStorage.putAgent({
        agent_id: p2Agent2Id,
        scope: 'default',
        status: 'active',
        metadata: { swarm_id: p2Swarm2Id },
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });

      // Simulate disconnect
      const inboxAgent = inboxStorage.getAgent(p2Agent2Id);
      expect(inboxAgent).toBeDefined();
      inboxAgent!.status = 'offline';
      inboxAgent!.last_active_at = new Date().toISOString();
      inboxStorage.putAgent(inboxAgent!);

      const updated = inboxStorage.getAgent(p2Agent2Id);
      expect(updated!.status).toBe('offline');
    });

    it('should create and delete agent nodes via DAL', () => {
      // Simulates map/agents/register
      const node = mapDAL.createNode({
        swarm_id: p2Swarm1Id,
        map_agent_id: 'register-test-agent',
        name: 'test-node',
        role: 'worker',
        state: 'active',
        capabilities: { tools: ['search'] },
      });

      expect(node.id).toBeDefined();
      expect(node.map_agent_id).toBe('register-test-agent');

      const found = mapDAL.findNodeBySwarmAndAgentId(p2Swarm1Id, 'register-test-agent');
      expect(found).toBeDefined();

      // Simulates map/agents/unregister
      mapDAL.deleteNode(node.id);
      const deleted = mapDAL.findNodeBySwarmAndAgentId(p2Swarm1Id, 'register-test-agent');
      expect(deleted).toBeFalsy();
    });

    it('should deliver direct message via inbox router and sendToSwarm', async () => {
      const inboxStorage = getInboxStorage();
      const { getInboxRouter } = await import('../../map/inbox-bridge.js');
      const router = getInboxRouter();

      // Register sender in inbox
      inboxStorage.putAgent({
        agent_id: p2Swarm1Id,
        scope: 'default',
        status: 'active',
        metadata: {},
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });

      // Route a direct message (simulates handleDirectSend)
      const message = await router.routeMessage({
        from: p2Swarm1Id,
        to: p2Swarm2Id,
        payload: 'Direct message test',
      });

      expect(message.id).toBeDefined();
      expect(message.sender_id).toBe(p2Swarm1Id);

      // Verify stored
      const stored = inboxStorage.getMessage(message.id);
      expect(stored).toBeDefined();
      expect(stored!.content).toEqual({ type: 'text', text: 'Direct message test' });

      // Verify delivery via sendToSwarm
      const conn = getInbound(p2Swarm2Id);
      const sendSpy = conn?.transport.type === 'websocket' ? conn.transport.ws.send as ReturnType<typeof vi.fn> : undefined;
      const sent = sendToSwarm(p2Swarm2Id, {
        jsonrpc: '2.0',
        method: 'map/send',
        params: {
          from: { type: 'agent', id: p2Swarm1Id },
          to: { type: 'agent', id: p2Swarm2Id },
          payload: 'Direct message test',
          messageId: message.id,
        },
      });
      expect(sent).toBe(true);
      expect(sendSpy).toHaveBeenCalled();
    });

    it('should list agents via discoverNodes', () => {
      const node = mapDAL.createNode({
        swarm_id: p2Swarm1Id,
        map_agent_id: 'listable-agent',
        name: 'listable',
        role: 'worker',
        state: 'active',
        capabilities: {},
      });

      const { data } = mapDAL.discoverNodes({ swarm_id: p2Swarm1Id, state: 'active' });
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data.some(n => n.map_agent_id === 'listable-agent')).toBe(true);

      mapDAL.deleteNode(node.id);
    });

    it('should filter agents by map_agent_id', () => {
      const node = mapDAL.createNode({
        swarm_id: p2Swarm1Id,
        map_agent_id: 'findable-agent',
        name: 'findable',
        role: 'worker',
        state: 'active',
        capabilities: {},
      });

      const { data } = mapDAL.discoverNodes({ map_agent_id: 'findable-agent', state: 'active', limit: 1 });
      expect(data).toHaveLength(1);
      expect(data[0].map_agent_id).toBe('findable-agent');
      expect(data[0].swarm_id).toBe(p2Swarm1Id);

      mapDAL.deleteNode(node.id);
    });
  });
});
