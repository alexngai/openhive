/**
 * Tests for Hive Router — resolve hive:<name> addresses and broadcast to members.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { initInboxBridge, stopInboxBridge, getInboxStorage } from '../../map/inbox-bridge.js';
import { routeHiveMessage, isHiveRouteError } from '../../map/hive-router.js';
import { registerInbound, unregisterInbound } from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { EventEmitter } from 'events';
import WebSocket from 'ws';

// Mock broadcastToChannel (imported transitively)
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: vi.fn(),
}));

const TEST_ROOT = testRoot('hive-router');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'hive-router.db');

function createMockWs(): WebSocket {
  const ws = new EventEmitter() as unknown as WebSocket;
  (ws as unknown as { readyState: number }).readyState = WebSocket.OPEN;
  (ws as unknown as { send: (data: string) => void }).send = vi.fn();
  (ws as unknown as { close: () => void }).close = vi.fn();
  (ws as unknown as { terminate: () => void }).terminate = vi.fn();
  return ws;
}

describe('Hive Router', () => {
  let agentId: string;
  let agent2Id: string;
  let swarmId: string;
  let swarm2Id: string;
  let hiveId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    await initInboxBridge();

    // Create agents
    const { agent: a1 } = await agentsDAL.createAgent({
      name: 'hive-router-agent-1',
      description: 'Agent 1',
    });
    agentId = a1.id;

    const { agent: a2 } = await agentsDAL.createAgent({
      name: 'hive-router-agent-2',
      description: 'Agent 2',
    });
    agent2Id = a2.id;

    // Create swarms
    const s1 = mapDAL.createSwarm(agentId, {
      name: 'swarm-1',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    swarmId = s1.id;
    mapDAL.updateSwarm(swarmId, { status: 'online' });

    const s2 = mapDAL.createSwarm(agent2Id, {
      name: 'swarm-2',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    swarm2Id = s2.id;
    mapDAL.updateSwarm(swarm2Id, { status: 'online' });

    // Create hive
    const hive = hivesDAL.createHive({
      name: 'test-lab',
      description: 'Test hive for routing',
      is_public: true,
      owner_id: agentId,
    });
    hiveId = hive.id;

    // Join both swarms to hive
    mapDAL.joinHive(swarmId, hiveId);
    mapDAL.joinHive(swarm2Id, hiveId);

    // Register inbound connections so sendToSwarm works
    registerInbound(swarmId, {
      ws: createMockWs(),
      agentId,
      swarmId,
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    });
    registerInbound(swarm2Id, {
      ws: createMockWs(),
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

  it('should broadcast map/send to hive members', async () => {
    const result = await routeHiveMessage(swarmId, {
      to: { type: 'agent', id: 'hive:test-lab' },
      payload: { text: 'Hello hive!' },
    });

    expect(isHiveRouteError(result)).toBe(false);
    if (!isHiveRouteError(result)) {
      expect(result.hiveName).toBe('test-lab');
      expect(result.hiveId).toBe(hiveId);
      expect(result.messageId).toBeDefined();
      expect(result.recipientCount).toBe(1); // Excluding sender
    }
  });

  it('should store the message in inbox storage', async () => {
    const result = await routeHiveMessage(swarmId, {
      to: { type: 'agent', id: 'hive:test-lab' },
      payload: { text: 'Stored message test' },
    });

    expect(isHiveRouteError(result)).toBe(false);
    if (!isHiveRouteError(result)) {
      const storage = getInboxStorage();
      const msg = storage.getMessage(result.messageId);
      expect(msg).toBeDefined();
      expect(msg!.sender_id).toBe(swarmId);
      expect(msg!.scope).toBe('test-lab');
    }
  });

  it('should send to target swarms via sendToSwarm', async () => {
    const conn = (await import('../../map/connection-registry.js')).getInbound(swarm2Id);
    const sendSpy = conn?.ws.send as ReturnType<typeof vi.fn>;
    const callsBefore = sendSpy?.mock.calls.length ?? 0;

    await routeHiveMessage(swarmId, {
      to: { type: 'agent', id: 'hive:test-lab' },
      payload: { text: 'Fan-out test' },
    });

    // swarm2 should have received the message
    expect(sendSpy?.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('should not send back to the sender swarm', async () => {
    const conn = (await import('../../map/connection-registry.js')).getInbound(swarmId);
    const sendSpy = conn?.ws.send as ReturnType<typeof vi.fn>;
    const callsBefore = sendSpy?.mock.calls.length ?? 0;

    await routeHiveMessage(swarmId, {
      to: { type: 'agent', id: 'hive:test-lab' },
      payload: { text: 'No echo test' },
    });

    // Sender should NOT receive the broadcast
    expect(sendSpy?.mock.calls.length).toBe(callsBefore);
  });

  it('should return error for nonexistent hive', async () => {
    const result = await routeHiveMessage(swarmId, {
      to: { type: 'agent', id: 'hive:nonexistent' },
      payload: { text: 'Should fail' },
    });

    expect(isHiveRouteError(result)).toBe(true);
    if (isHiveRouteError(result)) {
      expect(result.code).toBe(-32001);
      expect(result.message).toContain('nonexistent');
    }
  });

  it('should return error for non-member swarm', async () => {
    // Create a swarm not in the hive
    const { agent: a3 } = await agentsDAL.createAgent({
      name: 'outsider',
      description: 'Not a member',
    });
    const s3 = mapDAL.createSwarm(a3.id, {
      name: 'outsider-swarm',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });

    const result = await routeHiveMessage(s3.id, {
      to: { type: 'agent', id: 'hive:test-lab' },
      payload: { text: 'Should fail' },
    });

    expect(isHiveRouteError(result)).toBe(true);
    if (isHiveRouteError(result)) {
      expect(result.code).toBe(-32002);
    }
  });

  it('should return error for invalid address format', async () => {
    const result = await routeHiveMessage(swarmId, {
      to: { type: 'agent', id: 'not-a-hive-address' },
      payload: { text: 'Bad address' },
    });

    expect(isHiveRouteError(result)).toBe(true);
    if (isHiveRouteError(result)) {
      expect(result.code).toBe(-32602);
    }
  });

  it('should include hive metadata in stored message', async () => {
    const result = await routeHiveMessage(swarmId, {
      to: { type: 'agent', id: 'hive:test-lab' },
      payload: { text: 'Metadata test' },
      subject: 'Test Subject',
    });

    expect(isHiveRouteError(result)).toBe(false);
    if (!isHiveRouteError(result)) {
      const storage = getInboxStorage();
      const msg = storage.getMessage(result.messageId);
      expect(msg!.metadata).toEqual(
        expect.objectContaining({
          hive_id: hiveId,
          hive_name: 'test-lab',
          source_swarm_id: swarmId,
        }),
      );
    }
  });
});
