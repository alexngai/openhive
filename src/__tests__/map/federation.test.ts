/**
 * Tests for Phase 4: Replay on reconnect and federation setup.
 *
 * Federation transport tests are limited since we don't spin up a real remote
 * peer — we test config wiring, federated address parsing in hive-router,
 * and the replay mechanism.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import { createHive } from '../../db/dal/hives.js';
import {
  initInboxBridge,
  stopInboxBridge,
  getInboxStorage,
  getInboxRouter,
  getFederation,
} from '../../map/inbox-bridge.js';
import { routeHiveMessage, isHiveRouteError } from '../../map/hive-router.js';
import { registerInbound, unregisterInbound } from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: vi.fn(),
}));

const TEST_ROOT = testRoot('federation');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'federation.db');

function createMockWs(): WebSocket {
  const ws = new EventEmitter() as unknown as WebSocket;
  (ws as unknown as { readyState: number }).readyState = WebSocket.OPEN;
  (ws as unknown as { send: (data: string) => void }).send = vi.fn();
  (ws as unknown as { close: () => void }).close = vi.fn();
  (ws as unknown as { terminate: () => void }).terminate = vi.fn();
  return ws;
}

describe('Phase 4 — Replay + Federation', () => {
  let agentId: string;
  let agent2Id: string;
  let swarmId: string;
  let swarm2Id: string;
  let hiveId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    await initInboxBridge();

    const { agent: a1 } = await agentsDAL.createAgent({
      name: 'fed-agent-1',
      description: 'Agent 1',
    });
    agentId = a1.id;

    const { agent: a2 } = await agentsDAL.createAgent({
      name: 'fed-agent-2',
      description: 'Agent 2',
    });
    agent2Id = a2.id;

    const s1 = mapDAL.createSwarm(agentId, {
      name: 'fed-swarm-1',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    swarmId = s1.id;
    mapDAL.updateSwarm(swarmId, { status: 'online' });

    const s2 = mapDAL.createSwarm(agent2Id, {
      name: 'fed-swarm-2',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    swarm2Id = s2.id;
    mapDAL.updateSwarm(swarm2Id, { status: 'online' });

    const hive = createHive({
      name: 'fed-test-hive',
      description: 'Hive for federation tests',
      is_public: true,
      owner_id: agentId,
    });
    hiveId = hive.id;

    mapDAL.joinHive(swarmId, hiveId);
    mapDAL.joinHive(swarm2Id, hiveId);

    registerInbound(swarmId, {
      transport: { type: 'websocket', ws: createMockWs() },
      agentId,
      swarmId,
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    });
    registerInbound(swarm2Id, {
      transport: { type: 'websocket', ws: createMockWs() },
      agentId: agent2Id,
      swarmId: swarm2Id,
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    unregisterInbound(swarmId);
    unregisterInbound(swarm2Id);
    await stopInboxBridge();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ═══════════════════════════════════════════════════════════════
  // 4A: Replay on reconnect
  // ═══════════════════════════════════════════════════════════════

  describe('replay on reconnect', () => {
    it('should store messages in inbox for later replay', async () => {
      const storage = getInboxStorage();
      const router = getInboxRouter();

      // Register agent2 in inbox
      storage.putAgent({
        agent_id: agent2Id,
        scope: 'default',
        status: 'active',
        metadata: {},
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });

      // Send a direct message to agent2
      const msg = await router.routeMessage({
        from: swarmId,
        to: agent2Id,
        payload: 'Missed while offline',
      });

      expect(msg.id).toBeDefined();

      // agent2's inbox should have unread messages
      const unread = storage.getInbox(agent2Id, { unreadOnly: true, limit: 50 });
      expect(unread.length).toBeGreaterThan(0);
      expect(unread.some(m => m.id === msg.id)).toBe(true);
    });

    it('should return unread messages via getInbox for replay', async () => {
      const storage = getInboxStorage();

      // Register agent in inbox
      storage.putAgent({
        agent_id: agentId,
        scope: 'default',
        status: 'active',
        metadata: {},
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });

      // Send multiple messages to agent while "offline"
      const router = getInboxRouter();
      await router.routeMessage({ from: swarm2Id, to: agentId, payload: 'Replay msg 1' });
      await router.routeMessage({ from: swarm2Id, to: agentId, payload: 'Replay msg 2' });

      // Simulate reconnect: check inbox
      const unread = storage.getInbox(agentId, { unreadOnly: true, limit: 50 });
      expect(unread.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 4B: Federation config + federated hive addressing
  // ═══════════════════════════════════════════════════════════════

  describe('federation', () => {
    it('should not have federation enabled without config', () => {
      const fed = getFederation();
      expect(fed).toBeNull();
    });

    it('should return error for federated hive address when federation disabled', async () => {
      const result = await routeHiveMessage(swarmId, {
        to: { type: 'agent', id: 'hive:test-lab@remote-hub' },
        payload: { text: 'Cross-hive test' },
      });

      expect(isHiveRouteError(result)).toBe(true);
      if (isHiveRouteError(result)) {
        expect(result.code).toBe(-32003);
        expect(result.message).toContain('Federation is not enabled');
      }
    });

    it('should parse federated hive address correctly', async () => {
      // The router splits hive:<name>@<system> and delegates
      // With federation disabled, we get -32003 which proves parsing worked
      const result = await routeHiveMessage(swarmId, {
        to: { type: 'agent', id: 'hive:remote-hive@other-system' },
        payload: { text: 'Test' },
      });

      expect(isHiveRouteError(result)).toBe(true);
      if (isHiveRouteError(result)) {
        expect(result.code).toBe(-32003); // Federation not enabled, not -32602 or -32001
      }
    });

    it('should still route local hive addresses normally', async () => {
      const result = await routeHiveMessage(swarmId, {
        to: { type: 'agent', id: 'hive:fed-test-hive' },
        payload: { text: 'Local routing still works' },
      });

      expect(isHiveRouteError(result)).toBe(false);
      if (!isHiveRouteError(result)) {
        expect(result.hiveName).toBe('fed-test-hive');
        expect(result.hiveId).toBe(hiveId);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Federation with config (separate init)
  // ═══════════════════════════════════════════════════════════════

  describe('federation initialization', () => {
    it('should initialize federation when config is provided', async () => {
      // Stop current bridge
      await stopInboxBridge();

      // Re-init with federation
      await initInboxBridge({
        federation: {
          enabled: true,
          systemId: 'openhive-test',
          peers: [], // No real peers, just verify initialization
        },
      });

      const fed = getFederation();
      expect(fed).not.toBeNull();
      expect(fed!.getSystemId().id).toBe('openhive-test');
      expect(fed!.getPeers()).toEqual([]);

      // Clean up and re-init without federation for remaining tests
      await stopInboxBridge();
      await initInboxBridge();
    });
  });
});
