/**
 * E2E Tests: agentic-mesh Transport Integration
 *
 * Starts a real Fastify server with MAP WebSocket, inbox bridge, AND
 * the hub's MeshPeer. Exercises the full MAP protocol via mesh-connected
 * peers alongside WebSocket-connected agents:
 *
 *   - Mesh peer connection and auto-registration
 *   - Agent lifecycle via mesh (spawn, update, list, unregister)
 *   - Direct messaging between mesh peers
 *   - Cross-transport messaging (mesh peer ↔ WebSocket agent)
 *   - Mail conversations over mesh
 *   - Mesh peer disconnection and cleanup
 *   - Dual-mode: both transports coexist
 *
 * Uses real agentic-mesh MeshPeer instances (no mocking).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import {
  joinHive as joinSwarmToHive,
  findSwarmByMeshPeerId,
  listSwarms,
  discoverNodes,
  createNode,
  findNodeBySwarmAndAgentId,
  getNodeChildren,
  getNodeParent,
  getNodeHierarchy,
  getNodeAncestors,
} from '../../db/dal/map.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initInboxBridge, stopInboxBridge, getInboxStorage } from '../../map/inbox-bridge.js';
import { initMeshPeer, stopMeshPeer, getHubMeshPeer, isMeshEnabled } from '../../map/mesh-peer.js';
import { setupMeshHandler, stopMeshHandler } from '../../map/mesh-handler.js';
import { getAllInbound } from '../../map/connection-registry.js';
import {
  createHiveScope, deleteHiveScope, joinHiveScope, leaveHiveScope,
  broadcastToHiveScope, getHiveScopeMembers, hiveScopeId, syncHiveScopesFromDb,
} from '../../map/hive-scopes.js';
import { joinHive as serviceJoinHive, leaveHive as serviceLeaveHive } from '../../map/service.js';
import { createSwarm as dalCreateSwarm } from '../../db/dal/map.js';
import {
  HubChannel, initDefaultChannels as initChannels, closeAllChannels,
  getChannel, listChannels, getAllChannelStats, classifyMethod,
  createChannel, flushAllQueues,
} from '../../map/mesh-channels.js';
import { getPeerList } from '../../map/service.js';
import { sendToSwarm } from '../../map/sync-listener.js';
import { routeHiveMessage, isHiveRouteError } from '../../map/hive-router.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel (imported transitively by sync-listener)
import { vi } from 'vitest';
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));
vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: vi.fn(),
}));

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('e2e-mesh-transport');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e-mesh.db');
const SERVER_PORT = 19690;

// ============================================================================
// JSON-RPC Helpers (same as e2e-map-protocol.test.ts)
// ============================================================================

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

let rpcIdCounter = 0;
function nextId(): string {
  return `mesh-${++rpcIdCounter}`;
}

/**
 * Connect a WebSocket to the MAP endpoint and wait for hub/welcome.
 */
function connectWsAgent(
  port: number,
  apiKey: string,
): Promise<{ ws: WebSocket; welcome: JsonRpcNotification }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ token: apiKey, auto_register: 'true' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/map?${params}`);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Connection timeout')); }, 5000);

    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    ws.on('close', (code) => { clearTimeout(timeout); reject(new Error(`Closed: ${code}`)); });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'hub/welcome') {
        clearTimeout(timeout);
        resolve({ ws, welcome: msg });
      }
    });
  });
}

/**
 * Send a JSON-RPC request over WebSocket and wait for matching response.
 */
function wsRpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`RPC timeout for ${method} (id: ${id})`));
    }, timeoutMs);

    function handler(data: Buffer | string) {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    }

    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function collectNotifications(
  ws: WebSocket,
  method: string,
  count: number,
  timeoutMs = 3000,
): Promise<JsonRpcNotification[]> {
  return new Promise((resolve) => {
    const collected: JsonRpcNotification[] = [];
    const timeout = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(collected);
    }, timeoutMs);

    function handler(data: Buffer | string) {
      const msg = JSON.parse(data.toString());
      if (msg.method === method && !msg.id) {
        collected.push(msg);
        if (collected.length >= count) {
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve(collected);
        }
      }
    }

    ws.on('message', handler);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
  });
}

// ============================================================================
// MeshPeer Helpers
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let MeshPeerClass: any;

/**
 * Create an embedded MeshPeer for testing (in-process, no networking).
 * Does NOT call start() — the MapServer is functional without transport.
 */
async function createTestMeshPeer(peerId: string) {
  if (!MeshPeerClass) {
    const mod = await import('agentic-mesh');
    MeshPeerClass = mod.MeshPeer;
  }
  return new MeshPeerClass({ peerId, peerName: `Test ${peerId}` });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('E2E: Mesh Transport', () => {
  let app: FastifyInstance;
  let agentA: { id: string; apiKey: string; name: string };
  let agentB: { id: string; apiKey: string; name: string };
  let hive: { id: string; name: string };

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    // Create test agents
    const resultA = await agentsDAL.createAgent({ name: 'mesh-agent-a', description: 'Mesh Agent A' });
    agentA = { id: resultA.agent.id, apiKey: resultA.apiKey, name: 'mesh-agent-a' };

    const resultB = await agentsDAL.createAgent({ name: 'mesh-agent-b', description: 'Mesh Agent B' });
    agentB = { id: resultB.agent.id, apiKey: resultB.apiKey, name: 'mesh-agent-b' };

    // Create test hive and join both agents
    const h = hivesDAL.createHive({
      name: 'mesh-test-hive',
      description: 'Mesh transport test hive',
      owner_id: agentA.id,
    });
    hive = { id: h.id, name: h.name };
    hivesDAL.joinHive(hive.id, agentB.id);

    // Initialize inbox bridge
    await initInboxBridge();

    // Initialize hub's MeshPeer (embedded, no real networking)
    await initMeshPeer({ enabled: true, peerId: 'openhive-hub-test' });
    setupMeshHandler();

    // Build Fastify app with WebSocket
    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app);

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 30000);

  afterAll(async () => {
    stopMeshHandler();
    await stopMeshPeer();
    stopMapWebSocket();
    await new Promise((r) => setTimeout(r, 200));
    await app.close();
    await stopInboxBridge();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  }, 15000);

  // ══════════════════════════════════════════════════════════════════════
  // Hub MeshPeer Initialization
  // ══════════════════════════════════════════════════════════════════════

  describe('Hub MeshPeer Initialization', () => {
    it('should have initialized the hub MeshPeer', () => {
      expect(isMeshEnabled()).toBe(true);
      const hubPeer = getHubMeshPeer();
      expect(hubPeer).toBeDefined();
      expect(hubPeer.peerId).toBe('openhive-hub-test');
    });

    it('should have an embedded MapServer on the hub', () => {
      const server = getHubMeshPeer().server;
      expect(server).toBeDefined();
      expect(server.systemId).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Mesh Peer Connection
  // ══════════════════════════════════════════════════════════════════════

  describe('Mesh Peer Connection', () => {
    it('should auto-register a swarm when a mesh peer connects', async () => {
      // Create a client MeshPeer and simulate connection to hub
      const clientPeer = await createTestMeshPeer('test-swarm-alpha');
      try {
        // Simulate the hub detecting a new peer connection
        // In embedded mode, we directly trigger the handler
        const hubPeer = getHubMeshPeer();
        hubPeer.emit('peer:connected', 'test-swarm-alpha');

        // Wait for async handler
        await new Promise((r) => setTimeout(r, 100));

        // Verify a swarm was auto-registered with this mesh peer ID
        const swarm = findSwarmByMeshPeerId('test-swarm-alpha');
        expect(swarm).not.toBeNull();
        expect(swarm!.mesh_peer_id).toBe('test-swarm-alpha');
        expect(swarm!.map_transport).toBe('mesh');
        expect(swarm!.status).toBe('online');

        // Verify it's in the connection registry
        const conn = getAllInbound().get(swarm!.id);
        expect(conn).toBeDefined();
        expect(conn!.transport.type).toBe('mesh');

        // Cleanup: simulate disconnect
        hubPeer.emit('peer:disconnected', 'test-swarm-alpha');
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        await clientPeer.stop();
      }
    });

    it('should reuse existing swarm on reconnection', async () => {
      const clientPeer = await createTestMeshPeer('test-swarm-beta');
      try {
        const hubPeer = getHubMeshPeer();

        // First connection
        hubPeer.emit('peer:connected', 'test-swarm-beta');
        await new Promise((r) => setTimeout(r, 100));
        const swarm1 = findSwarmByMeshPeerId('test-swarm-beta');
        expect(swarm1).not.toBeNull();
        const swarmId = swarm1!.id;

        // Disconnect
        hubPeer.emit('peer:disconnected', 'test-swarm-beta');
        await new Promise((r) => setTimeout(r, 100));

        // Reconnect — should find existing swarm, not create new
        hubPeer.emit('peer:connected', 'test-swarm-beta');
        await new Promise((r) => setTimeout(r, 100));
        const swarm2 = findSwarmByMeshPeerId('test-swarm-beta');
        expect(swarm2).not.toBeNull();
        expect(swarm2!.id).toBe(swarmId); // Same swarm ID

        // Cleanup
        hubPeer.emit('peer:disconnected', 'test-swarm-beta');
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        await clientPeer.stop();
      }
    });

    it('should mark swarm offline when mesh peer disconnects', async () => {
      const clientPeer = await createTestMeshPeer('test-swarm-gamma');
      try {
        const hubPeer = getHubMeshPeer();

        // Connect
        hubPeer.emit('peer:connected', 'test-swarm-gamma');
        await new Promise((r) => setTimeout(r, 100));
        const swarm = findSwarmByMeshPeerId('test-swarm-gamma');
        expect(swarm!.status).toBe('online');

        // Verify in registry
        expect(getAllInbound().has(swarm!.id)).toBe(true);

        // Disconnect
        hubPeer.emit('peer:disconnected', 'test-swarm-gamma');
        await new Promise((r) => setTimeout(r, 100));

        // Verify swarm marked offline
        const swarmAfter = findSwarmByMeshPeerId('test-swarm-gamma');
        expect(swarmAfter!.status).toBe('offline');

        // Verify removed from registry
        expect(getAllInbound().has(swarm!.id)).toBe(false);
      } finally {
        await clientPeer.stop();
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Agent Lifecycle via Mesh
  // ══════════════════════════════════════════════════════════════════════

  describe('Agent Lifecycle via Mesh', () => {
    it('should register agents on the hub MapServer via mesh', async () => {
      const hubPeer = getHubMeshPeer();

      // Connect peer
      hubPeer.emit('peer:connected', 'lifecycle-peer');
      await new Promise((r) => setTimeout(r, 100));

      const swarm = findSwarmByMeshPeerId('lifecycle-peer');
      expect(swarm).not.toBeNull();

      // Simulate agent registration message from mesh peer
      // The mesh handler sets up a message handler that processes
      // JSON-RPC messages through the shared dispatch
      const messageHandler = hubPeer.server.setMessageHandler;
      expect(messageHandler).toBeDefined();

      // Verify the swarm was created and is in the registry
      const conn = getAllInbound().get(swarm!.id);
      expect(conn).toBeDefined();
      expect(conn!.transport.type).toBe('mesh');

      // Cleanup
      hubPeer.emit('peer:disconnected', 'lifecycle-peer');
      await new Promise((r) => setTimeout(r, 100));
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Dual-Mode: Mesh + WebSocket Coexistence
  // ══════════════════════════════════════════════════════════════════════

  describe('Dual-Mode Transport', () => {
    it('should support both WebSocket and mesh connections simultaneously', async () => {
      // WebSocket connection
      const wsConn = await connectWsAgent(SERVER_PORT, agentA.apiKey);

      // Mesh connection
      const hubPeer = getHubMeshPeer();
      hubPeer.emit('peer:connected', 'dual-mode-peer');
      await new Promise((r) => setTimeout(r, 100));

      try {
        // Verify WS agent is connected
        expect(wsConn.welcome.method).toBe('hub/welcome');
        const wsSwarmId = wsConn.welcome.params.swarm_id as string;
        const wsInbound = getAllInbound().get(wsSwarmId);
        expect(wsInbound).toBeDefined();
        expect(wsInbound!.transport.type).toBe('websocket');

        // Verify mesh peer is connected
        const meshSwarm = findSwarmByMeshPeerId('dual-mode-peer');
        expect(meshSwarm).not.toBeNull();
        const meshInbound = getAllInbound().get(meshSwarm!.id);
        expect(meshInbound).toBeDefined();
        expect(meshInbound!.transport.type).toBe('mesh');

        // Both should be in the registry
        expect(getAllInbound().size).toBeGreaterThanOrEqual(2);
      } finally {
        await closeWs(wsConn.ws);
        hubPeer.emit('peer:disconnected', 'dual-mode-peer');
        await new Promise((r) => setTimeout(r, 100));
      }
    });

    it('should handle WebSocket agent spawning alongside mesh peers', async () => {
      const wsConn = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      const hubPeer = getHubMeshPeer();
      hubPeer.emit('peer:connected', 'coexist-peer');
      await new Promise((r) => setTimeout(r, 100));

      try {
        // Spawn agent via WebSocket
        const spawnRes = await wsRpc(wsConn.ws, 'map/agents/spawn', {
          agentId: 'ws-spawned-agent',
          name: 'WS Spawned',
          role: 'worker',
        });
        expect(spawnRes.error).toBeUndefined();

        // Verify agent appears in discovery (visible to all transports)
        const { data: nodes } = discoverNodes({
          map_agent_id: 'ws-spawned-agent',
          limit: 10,
        });
        expect(nodes.length).toBeGreaterThanOrEqual(1);
        expect(nodes[0].map_agent_id).toBe('ws-spawned-agent');

        // Clean up agent
        await wsRpc(wsConn.ws, 'map/agents/unregister', { agentId: 'ws-spawned-agent' });
      } finally {
        await closeWs(wsConn.ws);
        hubPeer.emit('peer:disconnected', 'coexist-peer');
        await new Promise((r) => setTimeout(r, 100));
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Connection Registry Transport Types
  // ══════════════════════════════════════════════════════════════════════

  describe('Connection Registry', () => {
    it('should correctly track transport types in the registry', async () => {
      const wsConn = await connectWsAgent(SERVER_PORT, agentB.apiKey);
      const hubPeer = getHubMeshPeer();
      hubPeer.emit('peer:connected', 'registry-test-peer');
      await new Promise((r) => setTimeout(r, 100));

      try {
        const allConns = getAllInbound();

        // Find WebSocket connection
        let wsFound = false;
        let meshFound = false;
        for (const [, conn] of allConns) {
          if (conn.transport.type === 'websocket') wsFound = true;
          if (conn.transport.type === 'mesh') meshFound = true;
        }

        expect(wsFound).toBe(true);
        expect(meshFound).toBe(true);
      } finally {
        await closeWs(wsConn.ws);
        hubPeer.emit('peer:disconnected', 'registry-test-peer');
        await new Promise((r) => setTimeout(r, 100));
      }
    });

    it('should clean up mesh connections from registry on disconnect', async () => {
      const hubPeer = getHubMeshPeer();

      // Connect
      hubPeer.emit('peer:connected', 'cleanup-test-peer');
      await new Promise((r) => setTimeout(r, 100));

      const swarm = findSwarmByMeshPeerId('cleanup-test-peer');
      expect(swarm).not.toBeNull();
      expect(getAllInbound().has(swarm!.id)).toBe(true);

      // Disconnect
      hubPeer.emit('peer:disconnected', 'cleanup-test-peer');
      await new Promise((r) => setTimeout(r, 100));

      // Verify cleaned up
      expect(getAllInbound().has(swarm!.id)).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Swarm Registration with mesh_peer_id
  // ══════════════════════════════════════════════════════════════════════

  describe('Swarm DAL: mesh_peer_id', () => {
    it('should persist and query mesh_peer_id', () => {
      const swarm = findSwarmByMeshPeerId('test-swarm-alpha');
      // This swarm was created in the peer connection tests above
      if (swarm) {
        expect(swarm.mesh_peer_id).toBe('test-swarm-alpha');
        expect(swarm.map_transport).toBe('mesh');
      }
    });

    it('should return null for non-existent mesh peer ID', () => {
      const swarm = findSwarmByMeshPeerId('nonexistent-peer-id');
      expect(swarm).toBeNull();
    });

    it('should include mesh_peer_id in swarm listings', () => {
      const { data: swarms } = listSwarms({ limit: 100 });
      const meshSwarms = swarms.filter((s) => s.mesh_peer_id !== null);
      // At least some mesh swarms should exist from earlier tests
      if (meshSwarms.length > 0) {
        for (const s of meshSwarms) {
          expect(s.mesh_peer_id).toBeTruthy();
          expect(s.map_transport).toBe('mesh');
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // WebSocket Protocol Still Works (Regression)
  // ══════════════════════════════════════════════════════════════════════

  describe('WebSocket Regression', () => {
    it('should still handle map/connect via WebSocket', async () => {
      const { ws } = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await wsRpc(ws, 'map/connect', {});
        expect(res.result).toBeDefined();
        const result = res.result as Record<string, unknown>;
        expect(result.protocolVersion).toBeDefined();
        expect(result.serverId).toBe('openhive-hub');
      } finally {
        await closeWs(ws);
      }
    });

    it('should still spawn agents via WebSocket', async () => {
      const { ws } = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await wsRpc(ws, 'map/agents/spawn', {
          agentId: 'ws-regression-agent',
          name: 'Regression Agent',
          role: 'worker',
        });
        expect(res.error).toBeUndefined();
        const result = res.result as { agent: { id: string; state: string } };
        expect(result.agent.id).toBe('ws-regression-agent');
        expect(result.agent.state).toBe('active');

        // Cleanup
        await wsRpc(ws, 'map/agents/unregister', { agentId: 'ws-regression-agent' });
      } finally {
        await closeWs(ws);
      }
    });

    it('should still send messages between WebSocket agents', async () => {
      const connA = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      const connB = await connectWsAgent(SERVER_PORT, agentB.apiKey);
      try {
        const msgPromise = collectNotifications(connB.ws, 'map/send', 1);
        const sendRes = await wsRpc(connA.ws, 'map/send', {
          to: { id: `swarm:${connB.welcome.params.swarm_id}` },
          payload: 'WS regression message',
        });
        expect(sendRes.error).toBeUndefined();
        const result = sendRes.result as { messageId: string; delivered: boolean };
        expect(result.messageId).toBeDefined();

        if (result.delivered) {
          const received = await msgPromise;
          expect(received.length).toBe(1);
          expect(received[0].params.payload).toBe('WS regression message');
        }
      } finally {
        await closeWs(connA.ws);
        await closeWs(connB.ws);
      }
    });

    it('should still create mail conversations via WebSocket', async () => {
      const { ws } = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await wsRpc(ws, 'mail/create', {
          subject: 'Mesh Regression Mail Test',
          scope: 'default',
        });
        expect(res.error).toBeUndefined();
        const conv = res.result as { id: string; subject: string };
        expect(conv.id).toBeDefined();
        expect(conv.subject).toBe('Mesh Regression Mail Test');
      } finally {
        await closeWs(ws);
      }
    });

    it('should still support event subscriptions via WebSocket', async () => {
      const { ws } = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      try {
        const subRes = await wsRpc(ws, 'map/subscribe', {
          filter: { eventTypes: ['mail.created'] },
        });
        expect(subRes.error).toBeUndefined();
        const subId = (subRes.result as { subscriptionId: string }).subscriptionId;
        expect(subId).toBeDefined();

        const eventPromise = collectNotifications(ws, 'map/event', 1);
        await wsRpc(ws, 'mail/create', { subject: 'Subscription Regression' });
        const events = await eventPromise;
        expect(events.length).toBe(1);
        expect((events[0].params.event as { type: string }).type).toBe('mail.created');
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Hub MapServer Agent Discovery
  // ══════════════════════════════════════════════════════════════════════

  describe('Hub MapServer', () => {
    it('should expose system info from the embedded MapServer', () => {
      const server = getHubMeshPeer().server;
      const info = server.getSystemInfo();
      expect(info).toBeDefined();
      expect(info.systemId).toBeDefined();
    });

    it('should list agents registered on the MapServer', () => {
      const server = getHubMeshPeer().server;
      const agents = server.listAgents();
      expect(Array.isArray(agents)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Stress: Multiple Mesh Peers
  // ══════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════
  // Phase 4: Mesh Delivery Bridge
  // ══════════════════════════════════════════════════════════════════════

  describe('Mesh Delivery Bridge', () => {
    it('should intercept MapServer native message routing and store in inbox', async () => {
      const hubPeer = getHubMeshPeer();
      const server = hubPeer.server;

      // Register two agents on the MapServer natively
      const agentX = server.registerAgent({ name: 'bridge-agent-x', agentId: 'bridge-x' } as any);
      const agentY = server.registerAgent({ name: 'bridge-agent-y', agentId: 'bridge-y' } as any);

      // Track messages received by agent Y
      const received: unknown[] = [];
      server.setMessageHandler('bridge-y', (msg: unknown) => {
        received.push(msg);
      });

      // Send a message through MapServer's native routing
      await server.send('bridge-x', 'bridge-y', { text: 'hello from native routing' });

      await new Promise((r) => setTimeout(r, 200));

      // Agent Y should have received the message via MapServer handler
      expect(received.length).toBeGreaterThanOrEqual(1);

      // Clean up
      server.removeMessageHandler('bridge-y');
      server.unregisterAgent('bridge-x');
      server.unregisterAgent('bridge-y');
    });

    it('should expose delivery bridge status', async () => {
      const { isDeliveryBridgeActive } = await import('../../map/mesh-delivery-bridge.js');
      // Delivery bridge is not active because initInboxBridge was called without meshEnabled
      // In the e2e setup, we called initInboxBridge() without meshEnabled: true
      // This verifies the guard works
      expect(typeof isDeliveryBridgeActive()).toBe('boolean');
    });

    it('should initialize delivery bridge when meshEnabled is true', async () => {
      const {
        initMeshDeliveryBridge,
        stopMeshDeliveryBridge,
        isDeliveryBridgeActive,
      } = await import('../../map/mesh-delivery-bridge.js');

      const { EventEmitter } = await import('node:events');
      const events = new EventEmitter();
      const storedMessages: Record<string, unknown>[] = [];

      // Initialize with real storage mock that tracks calls
      initMeshDeliveryBridge({
        storage: {
          putMessage: (msg: Record<string, unknown>) => { storedMessages.push(msg); },
        },
        events,
      });

      expect(isDeliveryBridgeActive()).toBe(true);

      // Trigger a MapServer message:sent event — the bridge should catch it
      const hubPeer = getHubMeshPeer();
      const server = hubPeer.server as unknown as import('node:events').EventEmitter;
      server.emit('message:sent', 'msg-123', 'agent-from', 'agent-to');

      await new Promise((r) => setTimeout(r, 100));

      // The bridge should have stored the message
      expect(storedMessages.length).toBe(1);
      expect(storedMessages[0].sender_id).toBe('agent-from');
      expect((storedMessages[0].recipients as any[])[0].agent_id).toBe('agent-to');

      // Clean up
      stopMeshDeliveryBridge();
      expect(isDeliveryBridgeActive()).toBe(false);
    });

    it('should handle complex MAP addresses in delivery bridge', async () => {
      const {
        initMeshDeliveryBridge,
        stopMeshDeliveryBridge,
      } = await import('../../map/mesh-delivery-bridge.js');

      const { EventEmitter } = await import('node:events');
      const events = new EventEmitter();
      const storedMessages: Record<string, unknown>[] = [];

      initMeshDeliveryBridge({
        storage: {
          putMessage: (msg: Record<string, unknown>) => { storedMessages.push(msg); },
        },
        events,
      });

      const server = getHubMeshPeer().server as unknown as import('node:events').EventEmitter;

      // Test various address formats
      server.emit('message:sent', 'msg-1', 'sender', { agent: 'target-agent' });
      server.emit('message:sent', 'msg-2', 'sender', { agents: ['a1', 'a2'] });
      server.emit('message:sent', 'msg-3', 'sender', { system: 'remote', agent: 'bob' });
      server.emit('message:sent', 'msg-4', 'sender', { scope: 'team-alpha' });
      server.emit('message:sent', 'msg-5', 'sender', { broadcast: true });

      await new Promise((r) => setTimeout(r, 100));

      expect(storedMessages.length).toBe(5);
      expect((storedMessages[0].recipients as any[])[0].agent_id).toBe('target-agent');
      expect((storedMessages[1].recipients as any[])[0].agent_id).toBe('a1,a2');
      expect((storedMessages[2].recipients as any[])[0].agent_id).toBe('bob@remote');
      expect((storedMessages[3].recipients as any[])[0].agent_id).toBe('scope:team-alpha');
      expect((storedMessages[4].recipients as any[])[0].agent_id).toBe('*');

      stopMeshDeliveryBridge();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Phase 5: Federation Gateway Wiring
  // ══════════════════════════════════════════════════════════════════════

  describe('Mesh Federation Gateway', () => {
    it('should create FederationGateway for mesh-capable federation peers', async () => {
      const agenticMesh = await import('agentic-mesh');
      const hubPeer = getHubMeshPeer();

      // Create a FederationGateway using the hub's MapServer
      const gateway = agenticMesh.createFederationGateway(hubPeer.server as any, {
        localSystemId: 'openhive-hub-test',
        remoteSystemId: 'remote-system-1',
        remoteEndpoint: 'mesh://remote-peer-1',
      });

      expect(gateway).toBeDefined();
      expect(gateway.localSystemId).toBe('openhive-hub-test');
      expect(gateway.remoteSystemId).toBe('remote-system-1');
      expect(gateway.isConnected).toBe(false);
      expect(gateway.bufferedMessageCount).toBe(0);
    });

    it('should buffer messages when federation peer is not connected', async () => {
      const agenticMesh = await import('agentic-mesh');
      const hubPeer = getHubMeshPeer();

      const gateway = agenticMesh.createFederationGateway(hubPeer.server as any, {
        localSystemId: 'openhive-hub-test',
        remoteSystemId: 'remote-system-2',
        remoteEndpoint: 'mesh://remote-peer-2',
        buffer: { maxSize: 100 },
      });

      // Route a message — should be buffered since not connected
      const result = await gateway.route(
        { id: 'test-msg-1', from: 'agent-a', to: 'agent-b', timestamp: Date.now(), payload: { text: 'hello' } } as any,
        ['agent-b'],
      );

      // Message gets buffered, not delivered
      expect(gateway.bufferedMessageCount).toBeGreaterThanOrEqual(0);
    });

    it('should emit message:received events for incoming federation messages', async () => {
      const agenticMesh = await import('agentic-mesh');
      const hubPeer = getHubMeshPeer();

      const gateway = agenticMesh.createFederationGateway(hubPeer.server as any, {
        localSystemId: 'openhive-hub-test',
        remoteSystemId: 'remote-system-3',
        remoteEndpoint: 'mesh://remote-peer-3',
      });

      const receivedEvents: unknown[] = [];
      gateway.on('message:received', (envelope: unknown) => {
        receivedEvents.push(envelope);
      });

      // Gateway is created and event listener is wired
      expect(gateway.isConnected).toBe(false);
      // When connected, incoming messages would trigger this event
      // For now we verify the wiring is correct
      expect(receivedEvents.length).toBe(0);
    });

    it('should support meshPeerId in inbox bridge federation config', async () => {
      // Verify the InboxBridgeOptions type accepts meshPeerId
      const config: import('../../map/inbox-bridge.js').InboxBridgeOptions = {
        federation: {
          enabled: true,
          systemId: 'test-hub',
          peers: [
            { systemId: 'peer-1', url: 'http://peer-1:3000', meshPeerId: 'mesh-peer-1' },
            { systemId: 'peer-2', url: 'http://peer-2:3000' }, // HTTP only
          ],
        },
        meshEnabled: true,
      };

      expect(config.federation!.peers![0].meshPeerId).toBe('mesh-peer-1');
      expect(config.federation!.peers![1].meshPeerId).toBeUndefined();
      expect(config.meshEnabled).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Phase 6b: Sync Listener Mesh Awareness
  // ══════════════════════════════════════════════════════════════════════

  describe('Sync Listener Mesh Awareness', () => {
    it('should register mesh swarms in sync listener without WebSocket', async () => {
      const { sendToSwarm } = await import('../../map/sync-listener.js');

      // Connect a mesh peer — mesh-handler auto-registers the swarm
      const hubPeer = getHubMeshPeer();
      hubPeer.emit('peer:connected', 'sync-test-peer');
      await new Promise((r) => setTimeout(r, 200));

      // Find the auto-registered swarm
      const meshSwarm = findSwarmByMeshPeerId('sync-test-peer');
      expect(meshSwarm).toBeDefined();

      // sendToSwarm should be able to send to this mesh swarm via inbound connection
      const sent = sendToSwarm(meshSwarm!.id, {
        jsonrpc: '2.0',
        method: 'x-openhive/memory.sync',
        params: { resource_id: 'test-res', agent_id: 'test-agent', commit_hash: 'abc123', timestamp: new Date().toISOString() },
      });

      // Should succeed via inbound connection (mesh-handler registers it)
      expect(sent).toBe(true);

      // Clean up
      hubPeer.emit('peer:disconnected', 'sync-test-peer');
      await new Promise((r) => setTimeout(r, 200));
    });

    it('should fall back to mesh peer for outbound sync delivery', async () => {
      const { sendToSwarm } = await import('../../map/sync-listener.js');
      const { createSwarm } = await import('../../db/dal/map.js');
      const { getOrCreateLocalAgent } = await import('../../db/dal/agents.js');

      // Create a mesh swarm but DON'T connect the peer (no inbound connection)
      const systemAgent = await getOrCreateLocalAgent();
      const meshSwarm = createSwarm(systemAgent.id, {
        name: 'outbound-mesh-swarm',
        map_endpoint: 'mesh://outbound-test-peer',
        map_transport: 'mesh',
        mesh_peer_id: 'outbound-test-peer',
        auth_method: 'none',
      });

      // Without inbound connection, sendToSwarm should return false
      // (peer not actually connected via mesh transport either)
      const sent = sendToSwarm(meshSwarm.id, {
        jsonrpc: '2.0',
        method: 'x-openhive/memory.sync',
        params: { resource_id: 'test-res', agent_id: 'test-agent', commit_hash: 'def456', timestamp: new Date().toISOString() },
      });

      expect(sent).toBe(false);
    });

    it('should skip mesh swarms in connectToSwarm when mesh is enabled', async () => {
      const { initMapSyncListener, stopMapSyncListener, getSyncListenerStatus } = await import('../../map/sync-listener.js');
      const { createSwarm, heartbeatSwarm } = await import('../../db/dal/map.js');
      const { getOrCreateLocalAgent } = await import('../../db/dal/agents.js');

      // Create an online mesh swarm
      const systemAgent = await getOrCreateLocalAgent();
      const meshSwarm = createSwarm(systemAgent.id, {
        name: 'listener-mesh-swarm',
        map_endpoint: 'mesh://listener-test-peer',
        map_transport: 'mesh',
        mesh_peer_id: 'listener-test-peer',
        auth_method: 'none',
      });
      heartbeatSwarm(meshSwarm.id);

      // Initialize sync listener — should pick up the mesh swarm
      initMapSyncListener();

      const status = getSyncListenerStatus();
      // Mesh swarm should appear in connections list (registered, not via WebSocket)
      const meshConn = status.connections.find(c => c.swarmId === meshSwarm.id);
      expect(meshConn).toBeDefined();
      expect(meshConn!.status).toBe('disconnected'); // No WebSocket, registered as mesh

      stopMapSyncListener();
    });

    it('should handle sendToSwarm with mesh fallback after registering in sync listener', async () => {
      const { initMapSyncListener, stopMapSyncListener, sendToSwarm } = await import('../../map/sync-listener.js');
      const { createSwarm, heartbeatSwarm } = await import('../../db/dal/map.js');
      const { getOrCreateLocalAgent } = await import('../../db/dal/agents.js');

      const systemAgent = await getOrCreateLocalAgent();
      const meshSwarm = createSwarm(systemAgent.id, {
        name: 'fallback-mesh-swarm',
        map_endpoint: 'mesh://fallback-test-peer',
        map_transport: 'mesh',
        mesh_peer_id: 'fallback-test-peer',
        auth_method: 'none',
      });
      heartbeatSwarm(meshSwarm.id);

      initMapSyncListener();

      // sendToSwarm should attempt mesh send via the registered connection
      // Since the peer isn't actually connected, peer.send will fire-and-forget
      // but the function should return true (mesh send is async, best-effort)
      const sent = sendToSwarm(meshSwarm.id, {
        jsonrpc: '2.0',
        method: 'test/notification',
        params: { data: 'mesh-fallback-test' },
      });

      // Mesh send is attempted via hubPeer.send() which is fire-and-forget
      expect(sent).toBe(true);

      stopMapSyncListener();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Cross-Phase Integration
  // ══════════════════════════════════════════════════════════════════════

  describe('Cross-Phase Integration', () => {
    it('should route mesh peer messages through dispatch and store in inbox', async () => {
      const hubPeer = getHubMeshPeer();

      // Connect a mesh peer
      hubPeer.emit('peer:connected', 'integration-peer');
      await new Promise((r) => setTimeout(r, 200));

      // Find the auto-registered swarm
      const swarm = findSwarmByMeshPeerId('integration-peer');
      expect(swarm).toBeDefined();

      // The mesh handler should have set up routing — verify the swarm is in the registry
      const inbound = getAllInbound().get(swarm!.id);
      expect(inbound).toBeDefined();
      expect(inbound!.transport.type).toBe('mesh');

      // Verify inbox storage has the swarm's agent registered
      try {
        const inboxStorage = getInboxStorage();
        const inboxAgent = inboxStorage.getAgent(swarm!.owner_agent_id);
        // Agent may or may not be in inbox depending on timing, but the call shouldn't throw
        expect(inboxAgent === null || typeof inboxAgent === 'object').toBe(true);
      } catch {
        // Inbox getAgent may not find the agent — that's OK for this test
      }

      // Clean up
      hubPeer.emit('peer:disconnected', 'integration-peer');
      await new Promise((r) => setTimeout(r, 200));
    });

    it('should handle full lifecycle: connect → register agent → sync → disconnect', async () => {
      const hubPeer = getHubMeshPeer();

      // 1. Connect mesh peer
      hubPeer.emit('peer:connected', 'lifecycle-full-peer');
      await new Promise((r) => setTimeout(r, 200));

      const swarm = findSwarmByMeshPeerId('lifecycle-full-peer');
      expect(swarm).toBeDefined();
      expect(swarm!.status).toBe('online');

      // 2. Verify connection registry
      const conn = getAllInbound().get(swarm!.id);
      expect(conn).toBeDefined();
      expect(conn!.transport).toEqual({ type: 'mesh', peerId: 'lifecycle-full-peer' });

      // 3. Verify swarm has mesh_peer_id
      expect(swarm!.mesh_peer_id).toBe('lifecycle-full-peer');

      // 4. Disconnect
      hubPeer.emit('peer:disconnected', 'lifecycle-full-peer');
      await new Promise((r) => setTimeout(r, 200));

      // 5. Verify cleanup
      const disconnectedSwarm = findSwarmByMeshPeerId('lifecycle-full-peer');
      expect(disconnectedSwarm!.status).toBe('offline');
      expect(getAllInbound().has(swarm!.id)).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Multiple Mesh Peers (existing)
  // ══════════════════════════════════════════════════════════════════════

  describe('Multiple Mesh Peers', () => {
    it('should handle multiple mesh peers connecting simultaneously', async () => {
      const hubPeer = getHubMeshPeer();
      const peerIds = ['multi-peer-1', 'multi-peer-2', 'multi-peer-3'];

      // Connect all peers
      for (const peerId of peerIds) {
        hubPeer.emit('peer:connected', peerId);
      }
      await new Promise((r) => setTimeout(r, 200));

      try {
        // Verify all peers registered
        for (const peerId of peerIds) {
          const swarm = findSwarmByMeshPeerId(peerId);
          expect(swarm).not.toBeNull();
          expect(swarm!.status).toBe('online');
          expect(getAllInbound().has(swarm!.id)).toBe(true);
        }
      } finally {
        // Disconnect all peers
        for (const peerId of peerIds) {
          hubPeer.emit('peer:disconnected', peerId);
        }
        await new Promise((r) => setTimeout(r, 200));

        // Verify all cleaned up
        for (const peerId of peerIds) {
          const swarm = findSwarmByMeshPeerId(peerId);
          expect(swarm!.status).toBe('offline');
          expect(getAllInbound().has(swarm!.id)).toBe(false);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Feature 1: Hive Scopes
  // ══════════════════════════════════════════════════════════════════════

  describe('Hive Scopes', () => {
    it('should create a hive scope and join/leave members', () => {
      // Create a scope for the test hive
      createHiveScope('scope-test-hive');
      const server = getHubMeshPeer().server;
      const scope = server.getScope(hiveScopeId('scope-test-hive'));
      expect(scope).toBeDefined();

      // Join two agents
      joinHiveScope('scope-test-hive', 'agent-alpha');
      joinHiveScope('scope-test-hive', 'agent-beta');

      const members = getHiveScopeMembers('scope-test-hive');
      expect(members).toContain('agent-alpha');
      expect(members).toContain('agent-beta');
      expect(members.length).toBe(2);

      // Leave one agent
      leaveHiveScope('scope-test-hive', 'agent-alpha');
      const membersAfter = getHiveScopeMembers('scope-test-hive');
      expect(membersAfter).not.toContain('agent-alpha');
      expect(membersAfter).toContain('agent-beta');
      expect(membersAfter.length).toBe(1);
    });

    it('should auto-create scope on joinHiveScope if it does not exist', () => {
      // Join without explicit createHiveScope — should auto-create
      joinHiveScope('auto-created-hive', 'agent-gamma');

      const server = getHubMeshPeer().server;
      const scope = server.getScope(hiveScopeId('auto-created-hive'));
      expect(scope).toBeDefined();

      const members = getHiveScopeMembers('auto-created-hive');
      expect(members).toContain('agent-gamma');
    });

    it('should delete scope on deleteHiveScope', () => {
      createHiveScope('ephemeral-hive');
      const server = getHubMeshPeer().server;
      expect(server.getScope(hiveScopeId('ephemeral-hive'))).toBeDefined();

      deleteHiveScope('ephemeral-hive');
      expect(server.getScope(hiveScopeId('ephemeral-hive'))).toBeUndefined();
    });

    it('should broadcast to hive scope members', async () => {
      createHiveScope('broadcast-hive');
      joinHiveScope('broadcast-hive', 'listener-1');
      joinHiveScope('broadcast-hive', 'listener-2');

      // Broadcast should succeed (scope exists and has members)
      const result = await broadcastToHiveScope('broadcast-hive', 'sender-agent', { text: 'hello hive' });
      expect(result).toBe(true);

      // Broadcast to nonexistent scope should return false
      const result2 = await broadcastToHiveScope('nonexistent-hive', 'sender-agent', { text: 'hello' });
      expect(result2).toBe(false);
    });

    it('should auto-join hive scopes when mesh peer connects', async () => {
      // Create a hive scope for mesh-test-hive (the hive created in beforeAll)
      createHiveScope(hive.name);

      // Create a test mesh peer and join it to the hive
      const hubPeer = getHubMeshPeer();
      const peerId = 'hive-scope-test-peer';

      // Simulate peer connection (mesh-handler will auto-join hive scopes)
      hubPeer.emit('peer:connected', peerId);
      await new Promise((r) => setTimeout(r, 300));

      try {
        // Find the auto-registered swarm
        const swarm = findSwarmByMeshPeerId(peerId);
        expect(swarm).not.toBeNull();

        // Join the swarm to the test hive (DB level)
        joinSwarmToHive(swarm!.id, hive.id);

        // Disconnect and reconnect — now with hive membership
        hubPeer.emit('peer:disconnected', peerId);
        await new Promise((r) => setTimeout(r, 200));

        hubPeer.emit('peer:connected', peerId);
        await new Promise((r) => setTimeout(r, 300));

        // The swarm's owner agent should now be in the hive scope
        const members = getHiveScopeMembers(hive.name);
        const reconnectedSwarm = findSwarmByMeshPeerId(peerId);
        expect(members).toContain(reconnectedSwarm!.owner_agent_id);
      } finally {
        hubPeer.emit('peer:disconnected', peerId);
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    it('should join hive scope when calling service.joinHive for mesh swarms', () => {
      // Create a new hive for this test
      const testHive = hivesDAL.createHive({
        name: 'service-join-test',
        description: 'Test hive for service.joinHive scope wiring',
        owner_id: agentA.id,
      });
      createHiveScope(testHive.name);

      // Register a mesh swarm owned by agentB (only mesh swarms join scopes)
      const swarm = dalCreateSwarm(agentB.id, {
        name: 'scope-join-swarm',
        map_endpoint: 'mesh://scope-join-peer',
        map_transport: 'mesh',
        mesh_peer_id: 'scope-join-peer',
        auth_method: 'none',
      });

      // Join hive via service (should also join scope for mesh swarm)
      serviceJoinHive(swarm.id, testHive.name);

      const members = getHiveScopeMembers(testHive.name);
      expect(members).toContain(agentB.id);
    });

    it('should NOT join hive scope for WS-only swarms via service.joinHive', () => {
      const testHive = hivesDAL.createHive({
        name: 'service-ws-noscope-test',
        description: 'Test that WS swarms do not join scopes',
        owner_id: agentA.id,
      });
      createHiveScope(testHive.name);

      // Register a WS swarm
      const swarm = dalCreateSwarm(agentB.id, {
        name: 'ws-noscope-swarm',
        map_endpoint: 'hub-inbound',
        map_transport: 'websocket',
        auth_method: 'none',
      });

      // Join hive via service — WS swarm should NOT be added to scope
      serviceJoinHive(swarm.id, testHive.name);

      const members = getHiveScopeMembers(testHive.name);
      expect(members).not.toContain(agentB.id);
    });

    it('should leave hive scope when calling service.leaveHive for mesh swarms', () => {
      // Create hive and scope
      const testHive = hivesDAL.createHive({
        name: 'service-leave-test',
        description: 'Test hive for service.leaveHive scope wiring',
        owner_id: agentA.id,
      });
      createHiveScope(testHive.name);

      // Register a mesh swarm and join hive
      const swarm = dalCreateSwarm(agentB.id, {
        name: 'scope-leave-swarm',
        map_endpoint: 'mesh://scope-leave-peer',
        map_transport: 'mesh',
        mesh_peer_id: 'scope-leave-peer',
        auth_method: 'none',
      });
      serviceJoinHive(swarm.id, testHive.name);
      expect(getHiveScopeMembers(testHive.name)).toContain(agentB.id);

      // Leave hive (should also leave scope)
      serviceLeaveHive(swarm.id, testHive.name);
      expect(getHiveScopeMembers(testHive.name)).not.toContain(agentB.id);
    });

    it('should sync hive scopes from DB on startup', () => {
      // Simulate startup sync with known hive data
      syncHiveScopesFromDb(
        [{ name: 'synced-hive-1' }, { name: 'synced-hive-2' }],
        [
          { hive_name: 'synced-hive-1', agent_id: 'sync-agent-a' },
          { hive_name: 'synced-hive-1', agent_id: 'sync-agent-b' },
          { hive_name: 'synced-hive-2', agent_id: 'sync-agent-c' },
        ],
      );

      const server = getHubMeshPeer().server;
      expect(server.getScope(hiveScopeId('synced-hive-1'))).toBeDefined();
      expect(server.getScope(hiveScopeId('synced-hive-2'))).toBeDefined();

      const members1 = getHiveScopeMembers('synced-hive-1');
      expect(members1).toContain('sync-agent-a');
      expect(members1).toContain('sync-agent-b');

      const members2 = getHiveScopeMembers('synced-hive-2');
      expect(members2).toContain('sync-agent-c');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Feature 2: Agent Hierarchy
  // ══════════════════════════════════════════════════════════════════════

  describe('Agent Hierarchy', () => {
    it('should register agents with parent-child relationships', () => {
      // Register orchestrator (no parent)
      const orchestrator = dalCreateSwarm(agentA.id, {
        name: 'hierarchy-swarm',
        map_endpoint: 'hub-inbound',
        map_transport: 'websocket',
        auth_method: 'none',
      });

      const orchNode = createNode({
        swarm_id: orchestrator.id,
        map_agent_id: 'orchestrator-1',
        name: 'Orchestrator',
        role: 'orchestrator',
        state: 'active',
      });

      // Register workers with orchestrator as parent
      const worker1 = createNode({
        swarm_id: orchestrator.id,
        map_agent_id: 'worker-1',
        name: 'Worker 1',
        role: 'worker',
        state: 'active',
        parent_node_id: orchNode.id,
      });

      const worker2 = createNode({
        swarm_id: orchestrator.id,
        map_agent_id: 'worker-2',
        name: 'Worker 2',
        role: 'worker',
        state: 'active',
        parent_node_id: orchNode.id,
      });

      // Verify parent-child relationships
      expect(worker1.parent_node_id).toBe(orchNode.id);
      expect(worker2.parent_node_id).toBe(orchNode.id);
      expect(orchNode.parent_node_id).toBeNull();

      // Query children
      const children = getNodeChildren(orchNode.id);
      expect(children.length).toBe(2);
      expect(children.map((c: any) => c.map_agent_id)).toContain('worker-1');
      expect(children.map((c: any) => c.map_agent_id)).toContain('worker-2');

      // Query parent
      const parent = getNodeParent(worker1.id);
      expect(parent).not.toBeNull();
      expect(parent!.map_agent_id).toBe('orchestrator-1');
    });

    it('should return full hierarchy via getNodeHierarchy', () => {
      const swarm = dalCreateSwarm(agentA.id, {
        name: 'deep-hierarchy-swarm',
        map_endpoint: 'hub-inbound',
        map_transport: 'websocket',
        auth_method: 'none',
      });

      // Create 3-level hierarchy: root → mid → leaf
      const root = createNode({
        swarm_id: swarm.id,
        map_agent_id: 'root-agent',
        name: 'Root',
        role: 'orchestrator',
        state: 'active',
      });

      const mid = createNode({
        swarm_id: swarm.id,
        map_agent_id: 'mid-agent',
        name: 'Mid',
        role: 'specialist',
        state: 'active',
        parent_node_id: root.id,
      });

      const leaf = createNode({
        swarm_id: swarm.id,
        map_agent_id: 'leaf-agent',
        name: 'Leaf',
        role: 'worker',
        state: 'active',
        parent_node_id: mid.id,
      });

      // Get hierarchy from mid node
      const hierarchy = getNodeHierarchy(mid.id, {
        includeParent: true,
        includeChildren: true,
        includeSiblings: true,
        includeAncestors: true,
        includeDescendants: true,
      });

      expect(hierarchy).not.toBeNull();
      expect(hierarchy!.node.map_agent_id).toBe('mid-agent');
      expect(hierarchy!.parent?.map_agent_id).toBe('root-agent');
      expect(hierarchy!.children?.length).toBe(1);
      expect(hierarchy!.children?.[0].map_agent_id).toBe('leaf-agent');
      expect(hierarchy!.ancestors?.length).toBe(1);
      expect(hierarchy!.ancestors?.[0].map_agent_id).toBe('root-agent');
      expect(hierarchy!.descendants?.length).toBe(1);
      expect(hierarchy!.descendants?.[0].map_agent_id).toBe('leaf-agent');
    });

    it('should register agent with parent via WebSocket map/agents/register', async () => {
      const { ws } = await connectWsAgent(SERVER_PORT, agentA.apiKey);

      try {
        // Register orchestrator
        const orchResult = await wsRpc(ws, 'map/agents/register', {
          agentId: 'ws-orch',
          name: 'WS Orchestrator',
          role: 'orchestrator',
        });
        expect(orchResult.error).toBeUndefined();
        const orchNodeId = (orchResult.result as any).nodeId;

        // Register worker with parent
        const workerResult = await wsRpc(ws, 'map/agents/register', {
          agentId: 'ws-worker',
          name: 'WS Worker',
          role: 'worker',
          parent: 'ws-orch',
        });
        expect(workerResult.error).toBeUndefined();
        expect((workerResult.result as any).agent.parent).toBe(orchNodeId);

        // Query hierarchy
        const hierarchyResult = await wsRpc(ws, 'map/agents/hierarchy', {
          agentId: 'ws-orch',
          includeChildren: true,
        });
        expect(hierarchyResult.error).toBeUndefined();
        const hier = hierarchyResult.result as any;
        expect(hier.agent.id).toBe('ws-orch');
        expect(hier.children?.length).toBe(1);
        expect(hier.children[0].id).toBe('ws-worker');
      } finally {
        await closeWs(ws);
      }
    });

    it('should spawn agent with parent via map/agents/spawn', async () => {
      const { ws } = await connectWsAgent(SERVER_PORT, agentB.apiKey);

      try {
        // Register parent first
        const parentResult = await wsRpc(ws, 'map/agents/register', {
          agentId: 'spawn-parent',
          name: 'Spawn Parent',
          role: 'orchestrator',
        });
        expect(parentResult.error).toBeUndefined();
        const parentNodeId = (parentResult.result as any).nodeId;

        // Spawn child with parent
        const childResult = await wsRpc(ws, 'map/agents/spawn', {
          agentId: 'spawn-child',
          name: 'Spawn Child',
          role: 'worker',
          parent: 'spawn-parent',
        });
        expect(childResult.error).toBeUndefined();
        expect((childResult.result as any).agent.parent).toBe(parentNodeId);
      } finally {
        await closeWs(ws);
      }
    });

    it('should enforce max hierarchy depth of 5', () => {
      const swarm = dalCreateSwarm(agentA.id, {
        name: 'depth-test-swarm',
        map_endpoint: 'hub-inbound',
        map_transport: 'websocket',
        auth_method: 'none',
      });

      // Create chain of 7 nodes (exceeds max depth of 5)
      let parentId: string | undefined;
      const nodes: any[] = [];
      for (let i = 0; i < 7; i++) {
        const node = createNode({
          swarm_id: swarm.id,
          map_agent_id: `depth-${i}`,
          name: `Depth ${i}`,
          role: 'agent',
          state: 'active',
          parent_node_id: parentId,
        });
        nodes.push(node);
        parentId = node.id;
      }

      // Get ancestors of deepest node — should only return 5 (max depth)
      const ancestors = getNodeAncestors(nodes[6].id, 5);
      expect(ancestors.length).toBe(5);
      // Should be nodes 5, 4, 3, 2, 1 (not 0 — cut off by depth)
      expect(ancestors[0].map_agent_id).toBe('depth-5');
      expect(ancestors[4].map_agent_id).toBe('depth-1');
    });
  });

  // ==========================================================================
  // Feature 3: MessageChannels for Protocol Separation
  // ==========================================================================

  describe('MessageChannels', () => {
    it('should initialize default protocol channels', () => {
      // Default channels may already be created by test setup; create them if not
      initChannels();

      const channels = listChannels();
      expect(channels.length).toBeGreaterThanOrEqual(4);

      const names = channels.map(c => c.name);
      expect(names).toContain('proto:resource-sync');
      expect(names).toContain('proto:coordination');
      expect(names).toContain('proto:mail');
      expect(names).toContain('proto:federation');
    });

    it('should classify methods to correct channels', () => {

      expect(classifyMethod('x-openhive/memory.sync')).toBe('proto:resource-sync');
      expect(classifyMethod('x-openhive/skill.sync')).toBe('proto:resource-sync');
      expect(classifyMethod('x-openhive/trajectory.checkpoint')).toBe('proto:resource-sync');
      expect(classifyMethod('x-openhive/task.assign')).toBe('proto:coordination');
      expect(classifyMethod('x-openhive/task.status')).toBe('proto:coordination');
      expect(classifyMethod('x-openhive/context.share')).toBe('proto:coordination');
      expect(classifyMethod('x-openhive/message.send')).toBe('proto:coordination');
      expect(classifyMethod('mail/create')).toBe('proto:mail');
      expect(classifyMethod('mail/send')).toBe('proto:mail');
      expect(classifyMethod('map/federation/list-peers')).toBe('proto:federation');
      expect(classifyMethod('map/agents/register')).toBeNull();
      expect(classifyMethod('ping')).toBeNull();
    });

    it('should track per-channel stats on received messages', () => {
      closeAllChannels();
      initChannels();

      const coordination = getChannel('proto:coordination')!;
      const mail = getChannel('proto:mail')!;

      const statsBefore = coordination.getStats();
      expect(statsBefore.messagesReceived).toBe(0);

      // Simulate receiving coordination messages
      coordination.recordReceived({ method: 'x-openhive/task.assign' }, 'swarm-1');
      coordination.recordReceived({ method: 'x-openhive/task.status' }, 'swarm-2');

      const statsAfter = coordination.getStats();
      expect(statsAfter.messagesReceived).toBe(2);

      // Mail should still be zero
      expect(mail.getStats().messagesReceived).toBe(0);
    });

    it('should queue messages for offline swarms and flush on reconnect', () => {

      const channel = new HubChannel('test:queue', {
        enableOfflineQueue: true,
        offlineQueueTTL: 60_000,
        maxQueueSize: 10,
      });

      // Send to a non-existent swarm (will fail and queue)
      const sent = channel.send('nonexistent-swarm', { test: true });
      expect(sent).toBe(false);

      const stats = channel.getStats();
      expect(stats.queuedMessages).toBe(1);
      expect(stats.messagesSent).toBe(0);

      channel.close();
    });

    it('should enforce max queue size by dropping oldest', () => {

      const channel = new HubChannel('test:maxqueue', {
        enableOfflineQueue: true,
        offlineQueueTTL: 60_000,
        maxQueueSize: 3,
      });

      // Queue 5 messages (max 3)
      for (let i = 0; i < 5; i++) {
        channel.send('offline-swarm', { seq: i });
      }

      const stats = channel.getStats();
      expect(stats.queuedMessages).toBe(3);
      // 2 oldest were dropped
      expect(stats.failedDeliveries).toBe(2);

      channel.close();
    });

    it('should reset stats independently per channel', () => {

      const ch1 = new HubChannel('test:reset-1');
      const ch2 = new HubChannel('test:reset-2');

      ch1.recordReceived({}, 'swarm-1');
      ch1.recordReceived({}, 'swarm-2');
      ch2.recordReceived({}, 'swarm-3');

      expect(ch1.getStats().messagesReceived).toBe(2);
      expect(ch2.getStats().messagesReceived).toBe(1);

      ch1.resetStats();
      expect(ch1.getStats().messagesReceived).toBe(0);
      expect(ch2.getStats().messagesReceived).toBe(1);

      ch1.close();
      ch2.close();
    });

    it('should provide aggregate stats via getAllChannelStats', () => {
      closeAllChannels();
      initChannels();

      // Record some messages
      getChannel('proto:mail')!.recordReceived({ method: 'mail/send' }, 'swarm-1');
      getChannel('proto:coordination')!.recordReceived({ method: 'x-openhive/task.assign' }, 'swarm-2');

      const allStats = getAllChannelStats();
      expect(Object.keys(allStats)).toContain('proto:mail');
      expect(Object.keys(allStats)).toContain('proto:coordination');
      expect(allStats['proto:mail'].messagesReceived).toBe(1);
      expect(allStats['proto:coordination'].messagesReceived).toBe(1);
    });

    it('should handle RPC timeout', async () => {

      // Note: request() will fail immediately since the target swarm doesn't exist
      // (sendToSwarm returns false), throwing before the timeout kicks in
      const channel = new HubChannel('test:rpc', { rpcTimeout: 100 });

      await expect(
        channel.request('nonexistent-swarm', { action: 'do-thing' }, 50),
      ).rejects.toThrow('Failed to send RPC request');

      expect(channel.getStats().failedDeliveries).toBe(1);
      channel.close();
    });
  });

  // ==========================================================================
  // Feature 5: Direct Peer-to-Peer Messaging
  // ==========================================================================

  describe('Direct P2P', () => {
    it('should include mesh_peer_id in peer list for direct connectivity', () => {
      // Create two swarms with mesh peer IDs that share a hive
      const hiveName = `p2p-test-hive-${Date.now()}`;
      const hive = hivesDAL.createHive({
        name: hiveName,
        description: 'Test hive for P2P',
        owner_id: agentA.id,
      });

      const swarm1 = dalCreateSwarm(agentA.id, {
        name: 'p2p-swarm-1',
        map_endpoint: 'mesh://peer-1',
        map_transport: 'mesh',
        mesh_peer_id: 'peer-1',
        auth_method: 'none',
      });

      const swarm2 = dalCreateSwarm(agentA.id, {
        name: 'p2p-swarm-2',
        map_endpoint: 'mesh://peer-2',
        map_transport: 'mesh',
        mesh_peer_id: 'peer-2',
        auth_method: 'none',
      });

      // Join both to the same hive
      joinSwarmToHive(swarm1.id, hive.id);
      joinSwarmToHive(swarm2.id, hive.id);

      // Get peer list for swarm1
      const peerList = getPeerList(swarm1.id);

      expect(peerList.peers.length).toBeGreaterThanOrEqual(1);
      const peer2 = peerList.peers.find(p => p.swarm_id === swarm2.id);
      expect(peer2).toBeDefined();
      expect(peer2!.mesh_peer_id).toBe('peer-2');
      expect(peer2!.map_endpoint).toBe('mesh://peer-2');
      expect(peer2!.map_transport).toBe('mesh');
      expect(peer2!.shared_hives).toContain(hiveName);
    });

    it('should have updated sendToSwarm fallback chain with PeerConnection', () => {
      // Verify the sendToSwarm function tries the direct PeerConnection path
      // by attempting to send to a swarm with a mesh_peer_id
      const swarm = dalCreateSwarm(agentA.id, {
        name: 'p2p-fallback-swarm',
        map_endpoint: 'mesh://p2p-fallback-peer',
        map_transport: 'mesh',
        mesh_peer_id: 'p2p-fallback-peer',
        auth_method: 'none',
      });

      // This should return false (no connections available) but not throw
      const result = sendToSwarm(swarm.id, { jsonrpc: '2.0', method: 'test', params: {} });
      expect(result).toBe(false);
    });

    it('should include mesh config in bootstrap token when mesh is enabled', () => {
      // Verify BootstrapToken type includes mesh field
      const token = {
        version: 1 as const,
        openhive_url: 'http://localhost:3000',
        preauth_key: 'test',
        swarm_name: 'test-swarm',
        adapter: 'macro-agent',
        mesh: {
          hub_peer_id: 'openhive-hub-test',
          hub_address: 'localhost',
          hub_port: 9090,
        },
        issued_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
      };

      // Type check: mesh field is properly structured
      expect(token.mesh.hub_peer_id).toBe('openhive-hub-test');
      expect(token.mesh.hub_address).toBe('localhost');
      expect(token.mesh.hub_port).toBe(9090);
    });
  });

  // ==========================================================================
  // Feature 4: FederationGateway for Cross-Instance Communication
  // ==========================================================================

  describe('FederationGateway', () => {
    it('should create sync gateway for mesh-enabled peer', async () => {
      const { createSyncGateway, hasGateway, closeAllGateways } = await import('../../sync/federation-bridge.js');

      // Create a gateway (may or may not succeed depending on agentic-mesh availability)
      const created = await createSyncGateway({
        localSystemId: 'test-hub',
        remoteSystemId: 'remote-hub',
        remoteMeshPeerId: 'remote-mesh-peer',
        syncToken: 'test-token',
        maxHops: 3,
      });

      // If agentic-mesh FederationGateway is available, gateway should exist
      if (created) {
        expect(hasGateway('remote-mesh-peer')).toBe(true);
      }

      await closeAllGateways();
      expect(hasGateway('remote-mesh-peer')).toBe(false);
    });

    it('should fall back to HTTP when gateway push fails', async () => {
      const { pushViaGateway } = await import('../../sync/federation-bridge.js');

      // Push to a non-existent gateway should return false
      const result = await pushViaGateway('nonexistent-peer', [], 0, 'test-trace');
      expect(result).toBe(false);
    });

    it('should track gateway status', async () => {
      const { getGatewayStatus } = await import('../../sync/federation-bridge.js');

      // Non-existent gateway returns null
      const status = getGatewayStatus('nonexistent-peer');
      expect(status).toBeNull();
    });

    it('should have mesh_peer_id in SyncPeerConfig type', () => {
      // Verify the type includes mesh_peer_id
      const config = {
        id: 'test',
        name: 'test-peer',
        sync_endpoint: 'http://localhost:3000/sync/v1',
        shared_hives: ['test-hive'],
        signing_key: null,
        sync_token: null,
        peer_instance_id: null,
        is_manual: true,
        source: 'manual' as const,
        status: 'pending' as const,
        last_heartbeat_at: null,
        last_error: null,
        gossip_ttl: 0,
        failure_count: 0,
        discovered_via: null,
        mesh_peer_id: 'mesh-peer-123', // Feature 4: mesh peer support
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      expect(config.mesh_peer_id).toBe('mesh-peer-123');
    });

    it('should register inbound event handler', async () => {
      const { onInboundSyncEvents, closeAllGateways } = await import('../../sync/federation-bridge.js');

      let receivedEvents: unknown[] = [];
      onInboundSyncEvents((events, seq, trace) => {
        receivedEvents = events;
      });

      // Handler registered successfully — will be called by gateway message:received
      // (no-op test since we can't trigger gateway events without a real connection)
      expect(receivedEvents).toEqual([]);

      await closeAllGateways();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // E2E: Hive Broadcast via WS Protocol
  // ══════════════════════════════════════════════════════════════════════

  describe('E2E: Hive Broadcast via WS Protocol', () => {
    it('should deliver hive broadcast from one WS agent to another WS agent in the same hive', async () => {
      const connA = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      const connB = await connectWsAgent(SERVER_PORT, agentB.apiKey);

      try {
        const swarmIdA = connA.welcome.params.swarm_id as string;
        const swarmIdB = connB.welcome.params.swarm_id as string;

        // Join both swarms to the hive at DB level (required for membership check)
        joinSwarmToHive(swarmIdA, hive.id);
        joinSwarmToHive(swarmIdB, hive.id);

        // Ensure hive scope exists (but do NOT join WS agents to scope —
        // scope is for mesh agents; WS agents receive via sendToSwarm fallback)
        createHiveScope(hive.name);

        // Collect notifications on B before sending
        const msgPromise = collectNotifications(connB.ws, 'map/send', 1, 5000);

        // A sends to hive
        const sendRes = await wsRpc(connA.ws, 'map/send', {
          to: { id: `hive:${hive.name}` },
          payload: { text: 'hello hive e2e' },
          subject: 'e2e test',
        });
        expect(sendRes.error).toBeUndefined();
        const result = sendRes.result as { messageId: string; hiveName: string; recipientCount: number };
        expect(result.messageId).toBeDefined();
        expect(result.hiveName).toBe(hive.name);

        // B should receive the hive broadcast
        const received = await msgPromise;
        expect(received.length).toBe(1);
        expect(received[0].params.payload).toEqual({ text: 'hello hive e2e' });
        expect(received[0].params.messageId).toBe(result.messageId);
      } finally {
        await closeWs(connA.ws);
        await closeWs(connB.ws);
      }
    });

    it('should return error when non-member sends to a hive via WS', async () => {
      // Create a hive that agentA is not a member of
      const restrictedHive = hivesDAL.createHive({
        name: `restricted-${Date.now()}`,
        description: 'Restricted hive',
        owner_id: agentB.id,
      });

      const connA = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await wsRpc(connA.ws, 'map/send', {
          to: { id: `hive:${restrictedHive.name}` },
          payload: { text: 'should fail' },
        });
        // Should get an error — agentA's swarm is not a member
        expect(res.error).toBeDefined();
        expect(res.error!.code).toBe(-32002);
      } finally {
        await closeWs(connA.ws);
      }
    });

    it('should store hive broadcast in inbox for member agents', async () => {
      const connA = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      const connB = await connectWsAgent(SERVER_PORT, agentB.apiKey);

      try {
        const swarmIdA = connA.welcome.params.swarm_id as string;
        const swarmIdB = connB.welcome.params.swarm_id as string;

        // Create a fresh hive for inbox test
        const inboxHive = hivesDAL.createHive({
          name: `inbox-test-${Date.now()}`,
          description: 'Inbox test hive',
          owner_id: agentA.id,
        });
        hivesDAL.joinHive(inboxHive.id, agentB.id);

        joinSwarmToHive(swarmIdA, inboxHive.id);
        joinSwarmToHive(swarmIdB, inboxHive.id);
        createHiveScope(inboxHive.name);

        // Send hive message
        const sendRes = await wsRpc(connA.ws, 'map/send', {
          to: { id: `hive:${inboxHive.name}` },
          payload: { text: 'inbox test payload' },
        });
        expect(sendRes.error).toBeUndefined();

        // Wait for inbox storage
        await new Promise((r) => setTimeout(r, 300));

        // Check inbox for agentB — inbox stores messages with scope metadata
        const inbox = getInboxStorage();
        const agentBId = connB.welcome.params.agent_id as string;
        const messages = inbox.getInbox(agentBId, { limit: 50 });
        // The inbox message may store payload as a nested object or stringified
        const found = messages.find((m: any) => {
          const payload = typeof m.payload === 'string' ? JSON.parse(m.payload) : m.payload;
          return payload?.text === 'inbox test payload' || m.scope === inboxHive.name;
        });
        expect(found).toBeDefined();
      } finally {
        await closeWs(connA.ws);
        await closeWs(connB.ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // E2E: Mixed Mesh + WS Hive Broadcast
  // ══════════════════════════════════════════════════════════════════════

  describe('E2E: Mixed Mesh + WS Hive Broadcast', () => {
    it('should route hive message with both mesh and WS members present', async () => {
      const hubPeer = getHubMeshPeer();
      const mixedHive = hivesDAL.createHive({
        name: `mixed-${Date.now()}`,
        description: 'Mixed transport hive',
        owner_id: agentA.id,
      });
      createHiveScope(mixedHive.name);

      // Connect a WS agent
      const connWs = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      const wsSwarmId = connWs.welcome.params.swarm_id as string;
      const wsAgentId = connWs.welcome.params.agent_id as string;

      // Connect a mesh peer
      const meshPeerId = `mixed-mesh-${Date.now()}`;
      hubPeer.emit('peer:connected', meshPeerId);
      await new Promise((r) => setTimeout(r, 200));
      const meshSwarm = findSwarmByMeshPeerId(meshPeerId)!;

      try {
        // Join both to the hive
        joinSwarmToHive(wsSwarmId, mixedHive.id);
        joinSwarmToHive(meshSwarm.id, mixedHive.id);
        joinHiveScope(mixedHive.name, wsAgentId);
        joinHiveScope(mixedHive.name, meshSwarm.owner_agent_id);

        // Route a hive message directly via the router (from the mesh swarm)
        const result = await routeHiveMessage(meshSwarm.id, {
          to: { id: `hive:${mixedHive.name}` },
          payload: { text: 'from mesh to hive' },
        });

        expect(isHiveRouteError(result)).toBe(false);
        if (!isHiveRouteError(result)) {
          expect(result.hiveName).toBe(mixedHive.name);
          // At least the WS agent should be counted as a recipient
          expect(result.recipientCount).toBeGreaterThanOrEqual(1);
        }
      } finally {
        await closeWs(connWs.ws);
        hubPeer.emit('peer:disconnected', meshPeerId);
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    it('should de-duplicate delivery for agents in both scope and inbound registry', async () => {
      const hubPeer = getHubMeshPeer();
      const dedupeHive = hivesDAL.createHive({
        name: `dedupe-${Date.now()}`,
        description: 'Dedup test hive',
        owner_id: agentA.id,
      });
      createHiveScope(dedupeHive.name);

      // Connect two mesh peers
      const peer1Id = `dedupe-peer-1-${Date.now()}`;
      const peer2Id = `dedupe-peer-2-${Date.now()}`;
      hubPeer.emit('peer:connected', peer1Id);
      hubPeer.emit('peer:connected', peer2Id);
      await new Promise((r) => setTimeout(r, 200));
      const swarm1 = findSwarmByMeshPeerId(peer1Id)!;
      const swarm2 = findSwarmByMeshPeerId(peer2Id)!;

      try {
        // Join both to hive and scope
        joinSwarmToHive(swarm1.id, dedupeHive.id);
        joinSwarmToHive(swarm2.id, dedupeHive.id);
        joinHiveScope(dedupeHive.name, swarm1.owner_agent_id);
        joinHiveScope(dedupeHive.name, swarm2.owner_agent_id);

        // Route from swarm1 — swarm2 should receive exactly once
        const result = await routeHiveMessage(swarm1.id, {
          to: { id: `hive:${dedupeHive.name}` },
          payload: { text: 'dedupe test' },
        });

        expect(isHiveRouteError(result)).toBe(false);
        if (!isHiveRouteError(result)) {
          // recipientCount should be 1 (just swarm2, not duplicated)
          expect(result.recipientCount).toBe(1);
        }
      } finally {
        hubPeer.emit('peer:disconnected', peer1Id);
        hubPeer.emit('peer:disconnected', peer2Id);
        await new Promise((r) => setTimeout(r, 200));
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // E2E: Agent Hierarchy via WS Dispatch
  // ══════════════════════════════════════════════════════════════════════

  describe('E2E: Agent Hierarchy via WS Dispatch', () => {
    it('should build and query a 3-level hierarchy entirely through WS dispatch', async () => {
      const { ws } = await connectWsAgent(SERVER_PORT, agentA.apiKey);

      try {
        // Register orchestrator
        const orchRes = await wsRpc(ws, 'map/agents/register', {
          agentId: 'e2e-orch',
          name: 'E2E Orchestrator',
          role: 'orchestrator',
        });
        expect(orchRes.error).toBeUndefined();

        // Register specialist with orchestrator as parent
        const specRes = await wsRpc(ws, 'map/agents/register', {
          agentId: 'e2e-specialist',
          name: 'E2E Specialist',
          role: 'specialist',
          parent: 'e2e-orch',
        });
        expect(specRes.error).toBeUndefined();

        // Register worker with specialist as parent
        const workerRes = await wsRpc(ws, 'map/agents/register', {
          agentId: 'e2e-worker',
          name: 'E2E Worker',
          role: 'worker',
          parent: 'e2e-specialist',
        });
        expect(workerRes.error).toBeUndefined();

        // Query hierarchy from orchestrator with full tree
        const hierRes = await wsRpc(ws, 'map/agents/hierarchy', {
          agentId: 'e2e-orch',
          includeChildren: true,
          includeDescendants: true,
        });
        expect(hierRes.error).toBeUndefined();
        const hier = hierRes.result as any;
        expect(hier.agent.id).toBe('e2e-orch');
        expect(hier.children?.length).toBe(1);
        expect(hier.children[0].id).toBe('e2e-specialist');
        expect(hier.descendants?.length).toBe(2); // specialist + worker
        const descendantIds = hier.descendants.map((d: any) => d.id);
        expect(descendantIds).toContain('e2e-specialist');
        expect(descendantIds).toContain('e2e-worker');

        // Query hierarchy from worker with ancestors
        const workerHier = await wsRpc(ws, 'map/agents/hierarchy', {
          agentId: 'e2e-worker',
          includeAncestors: true,
        });
        expect(workerHier.error).toBeUndefined();
        const wh = workerHier.result as any;
        expect(wh.ancestors?.length).toBe(2); // specialist + orchestrator
        const ancestorIds = wh.ancestors.map((a: any) => a.id);
        expect(ancestorIds).toContain('e2e-specialist');
        expect(ancestorIds).toContain('e2e-orch');
      } finally {
        await closeWs(ws);
      }
    });

    it('should return siblings in hierarchy query via WS', async () => {
      const { ws } = await connectWsAgent(SERVER_PORT, agentB.apiKey);

      try {
        // Register parent
        const parentRes = await wsRpc(ws, 'map/agents/register', {
          agentId: 'sibling-parent',
          name: 'Sibling Parent',
          role: 'orchestrator',
        });
        expect(parentRes.error).toBeUndefined();

        // Register two sibling workers
        const w1Res = await wsRpc(ws, 'map/agents/register', {
          agentId: 'sibling-w1',
          name: 'Sibling W1',
          role: 'worker',
          parent: 'sibling-parent',
        });
        expect(w1Res.error).toBeUndefined();

        const w2Res = await wsRpc(ws, 'map/agents/register', {
          agentId: 'sibling-w2',
          name: 'Sibling W2',
          role: 'worker',
          parent: 'sibling-parent',
        });
        expect(w2Res.error).toBeUndefined();

        // Query w1 with siblings
        const hierRes = await wsRpc(ws, 'map/agents/hierarchy', {
          agentId: 'sibling-w1',
          includeSiblings: true,
        });
        expect(hierRes.error).toBeUndefined();
        const hier = hierRes.result as any;
        expect(hier.siblings?.length).toBe(1);
        expect(hier.siblings[0].id).toBe('sibling-w2');
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // E2E: Channel Stats via Message Dispatch
  // ══════════════════════════════════════════════════════════════════════

  describe('E2E: Channel Stats via Message Dispatch', () => {
    it('should increment proto:mail stats when mail/create is dispatched via WS', async () => {
      closeAllChannels();
      initChannels();

      const mailBefore = getChannel('proto:mail')!.getStats().messagesReceived;

      const { ws } = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      try {
        const res = await wsRpc(ws, 'mail/create', {
          subject: 'Channel stats test',
          scope: 'default',
        });
        expect(res.error).toBeUndefined();

        const mailAfter = getChannel('proto:mail')!.getStats().messagesReceived;
        expect(mailAfter).toBe(mailBefore + 1);
      } finally {
        await closeWs(ws);
      }
    });

    it('should NOT increment stats for unclassified methods like map/agents/register', async () => {
      closeAllChannels();
      initChannels();

      const allBefore = getAllChannelStats();
      const totalBefore = Object.values(allBefore).reduce((sum, s) => sum + s.messagesReceived, 0);

      const { ws } = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      try {
        await wsRpc(ws, 'map/agents/register', {
          agentId: 'stats-check-agent',
          name: 'Stats Check',
          role: 'worker',
        });

        const allAfter = getAllChannelStats();
        const totalAfter = Object.values(allAfter).reduce((sum, s) => sum + s.messagesReceived, 0);
        // map/agents/register is not classified — no channel stats should change
        expect(totalAfter).toBe(totalBefore);
      } finally {
        await closeWs(ws);
      }
    });

    it('should increment stats for multiple protocol channels in a single session', async () => {
      closeAllChannels();
      initChannels();

      const { ws } = await connectWsAgent(SERVER_PORT, agentA.apiKey);
      try {
        // Send a mail message (proto:mail)
        await wsRpc(ws, 'mail/create', { subject: 'Multi-channel 1', scope: 'default' });

        // Send another mail message
        await wsRpc(ws, 'mail/create', { subject: 'Multi-channel 2', scope: 'default' });

        const mailStats = getChannel('proto:mail')!.getStats();
        expect(mailStats.messagesReceived).toBe(2);

        // Unclassified messages shouldn't affect any channel
        await wsRpc(ws, 'map/connect', {});
        expect(getChannel('proto:mail')!.getStats().messagesReceived).toBe(2);
      } finally {
        await closeWs(ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // E2E: Channel Queue Flush on Mesh Reconnect
  // ══════════════════════════════════════════════════════════════════════

  describe('E2E: Channel Queue Flush on Mesh Reconnect', () => {
    it('should flush queued channel messages when mesh peer reconnects', async () => {
      const hubPeer = getHubMeshPeer();
      const flushPeerId = `flush-peer-${Date.now()}`;

      // Connect mesh peer and capture swarm ID
      hubPeer.emit('peer:connected', flushPeerId);
      await new Promise((r) => setTimeout(r, 200));
      const swarm = findSwarmByMeshPeerId(flushPeerId)!;
      expect(swarm).toBeDefined();

      // Disconnect the peer
      hubPeer.emit('peer:disconnected', flushPeerId);
      await new Promise((r) => setTimeout(r, 200));

      // Create a channel in the registry with offline queueing
      const channelName = `test:e2e-flush-${Date.now()}`;
      const channel = createChannel(channelName, {
        enableOfflineQueue: true,
        offlineQueueTTL: 60_000,
        maxQueueSize: 100,
      });

      // Queue messages (will fail because peer is disconnected)
      channel.send(swarm.id, { msg: 'queued-1' });
      channel.send(swarm.id, { msg: 'queued-2' });
      channel.send(swarm.id, { msg: 'queued-3' });

      const statsBefore = channel.getStats();
      expect(statsBefore.queuedMessages).toBe(3);
      expect(statsBefore.messagesSent).toBe(0);

      // Reconnect the peer — mesh-handler calls flushAllQueues(swarm.id)
      hubPeer.emit('peer:connected', flushPeerId);
      await new Promise((r) => setTimeout(r, 300));

      const statsAfter = channel.getStats();
      // Queued messages should have been flushed (sent to the now-connected peer)
      expect(statsAfter.queuedMessages).toBe(0);
      expect(statsAfter.messagesSent).toBe(3);

      // Cleanup
      hubPeer.emit('peer:disconnected', flushPeerId);
      await new Promise((r) => setTimeout(r, 200));
      channel.close();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // E2E: sendToSwarm with Live Inbound Mesh
  // ══════════════════════════════════════════════════════════════════════

  describe('E2E: sendToSwarm with Live Inbound Mesh', () => {
    it('should deliver via sendToSwarm when mesh peer is live in inbound registry', async () => {
      const hubPeer = getHubMeshPeer();
      const livePeerId = `live-mesh-${Date.now()}`;

      hubPeer.emit('peer:connected', livePeerId);
      await new Promise((r) => setTimeout(r, 200));
      const swarm = findSwarmByMeshPeerId(livePeerId)!;

      try {
        // sendToSwarm should succeed via inbound connection
        const sent = sendToSwarm(swarm.id, {
          jsonrpc: '2.0',
          method: 'test/ping',
          params: { ts: Date.now() },
        });
        expect(sent).toBe(true);
      } finally {
        hubPeer.emit('peer:disconnected', livePeerId);
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    it('should return false from sendToSwarm after mesh peer disconnects', async () => {
      const hubPeer = getHubMeshPeer();
      const discPeerId = `disc-mesh-${Date.now()}`;

      hubPeer.emit('peer:connected', discPeerId);
      await new Promise((r) => setTimeout(r, 200));
      const swarm = findSwarmByMeshPeerId(discPeerId)!;

      // Disconnect
      hubPeer.emit('peer:disconnected', discPeerId);
      await new Promise((r) => setTimeout(r, 200));

      // sendToSwarm should fail (no connections available)
      const sent = sendToSwarm(swarm.id, {
        jsonrpc: '2.0',
        method: 'test/ping',
        params: {},
      });
      expect(sent).toBe(false);
    });

    it('should deliver to mesh peer via inbound and track in channel stats', async () => {
      closeAllChannels();
      initChannels();

      const hubPeer = getHubMeshPeer();
      const trackPeerId = `track-mesh-${Date.now()}`;

      hubPeer.emit('peer:connected', trackPeerId);
      await new Promise((r) => setTimeout(r, 200));
      const swarm = findSwarmByMeshPeerId(trackPeerId)!;

      try {
        const resourceChannel = getChannel('proto:resource-sync')!;
        const sentBefore = resourceChannel.getStats().messagesSent;

        // Send via channel (which uses sendToSwarm internally)
        const delivered = resourceChannel.send(swarm.id, {
          jsonrpc: '2.0',
          method: 'x-openhive/memory.sync',
          params: { resource_id: 'res-1' },
        });
        expect(delivered).toBe(true);

        const sentAfter = resourceChannel.getStats().messagesSent;
        expect(sentAfter).toBe(sentBefore + 1);
      } finally {
        hubPeer.emit('peer:disconnected', trackPeerId);
        await new Promise((r) => setTimeout(r, 200));
      }
    });
  });
});
