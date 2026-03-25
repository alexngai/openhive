/**
 * Tests for the bidirectional task bridge:
 * - Outbound: OpenTasks mutations → MAPTaskStore + event bridge
 * - Inbound: MAPTaskStore events → frontend broadcast
 * - Echo loop prevention
 * - Lifecycle (init/stop)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAPTaskStore } from '../../map/task-store.js';
import {
  bridgeOpenTasksMutation,
  initTaskBridge,
  stopTaskBridge,
} from '../../map/task-bridge.js';

// Mock the realtime broadcast
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

// Mock the sync-listener sendToSwarm
vi.mock('../../map/sync-listener.js', () => ({
  sendToSwarm: vi.fn(() => true),
}));

// Mock the connection registry
const mockConnections = new Map<string, { ws: unknown }>();
vi.mock('../../map/connection-registry.js', () => ({
  getAllInbound: () => mockConnections,
}));

// Mock opentasks createMAPEventBridge
const mockEventBridgeSend = vi.fn();
const mockEventBridgeStop = vi.fn();
vi.mock('opentasks', () => ({
  createMAPEventBridge: vi.fn((config: { send: Function }) => {
    // Capture the send function so we can verify calls
    mockEventBridgeSend.mockImplementation(config.send);
    return {
      emitTaskCreated: vi.fn(),
      emitTaskStatus: vi.fn(),
      emitTaskAssigned: vi.fn(),
      emitTaskCompleted: vi.fn(),
      handleProviderChange: vi.fn(),
      stop: mockEventBridgeStop,
      active: true,
    };
  }),
}));

import { broadcastToChannel } from '../../realtime/index.js';
import { sendToSwarm } from '../../map/sync-listener.js';

describe('Task Bridge', () => {
  let store: MAPTaskStore;

  beforeEach(() => {
    store = new MAPTaskStore();
    mockConnections.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopTaskBridge();
  });

  // ==========================================================================
  // Outbound: OpenTasks mutations → MAPTaskStore
  // ==========================================================================

  describe('bridgeOpenTasksMutation (outbound)', () => {
    it('creates a task in MAPTaskStore when OpenTasks creates one', () => {
      bridgeOpenTasksMutation(store, {
        type: 'create',
        nodeId: 'task_abc123',
        title: 'Fix the bug',
        description: 'A critical bug needs fixing',
        status: 'open',
        sourceSwarmId: 'swarm-1',
      });

      const task = store.get('task_abc123');
      expect(task).toBeDefined();
      expect(task!.title).toBe('Fix the bug');
      expect(task!.status).toBe('open');
      expect(task!.meta?._source).toBe('opentasks');
    });

    it('updates task status in MAPTaskStore when OpenTasks updates one', () => {
      // First create the task
      store.create(
        { task: { id: 'task_xyz', title: 'Existing task', status: 'open' } },
        'swarm-1',
      );

      bridgeOpenTasksMutation(store, {
        type: 'update-status',
        nodeId: 'task_xyz',
        status: 'in_progress',
        previousStatus: 'open',
        sourceSwarmId: 'swarm-1',
      });

      const task = store.get('task_xyz');
      expect(task).toBeDefined();
      expect(task!.status).toBe('in_progress');
    });

    it('creates task on update-status if not already in store', () => {
      bridgeOpenTasksMutation(store, {
        type: 'update-status',
        nodeId: 'task_new',
        title: 'New task from update',
        status: 'completed',
        previousStatus: 'in_progress',
        sourceSwarmId: 'swarm-2',
      });

      const task = store.get('task_new');
      expect(task).toBeDefined();
      expect(task!.status).toBe('completed');
    });

    it('maps OpenTasks "closed" status to MAP "completed"', () => {
      bridgeOpenTasksMutation(store, {
        type: 'create',
        nodeId: 'task_closed',
        title: 'Closed task',
        status: 'closed',
        sourceSwarmId: 'swarm-1',
      });

      const task = store.get('task_closed');
      expect(task!.status).toBe('completed');
    });

    it('is idempotent — does not duplicate task on repeated create', () => {
      bridgeOpenTasksMutation(store, {
        type: 'create',
        nodeId: 'task_idem',
        title: 'First create',
        status: 'open',
        sourceSwarmId: 'swarm-1',
      });

      bridgeOpenTasksMutation(store, {
        type: 'create',
        nodeId: 'task_idem',
        title: 'Second create',
        status: 'open',
        sourceSwarmId: 'swarm-1',
      });

      // Should only have one task
      const list = store.list();
      const matching = list.tasks.filter((t) => t.id === 'task_idem');
      expect(matching).toHaveLength(1);
      expect(matching[0].title).toBe('First create'); // first wins
    });
  });

  // ==========================================================================
  // Inbound: MAPTaskStore events → broadcast
  // ==========================================================================

  describe('inbound store events → broadcast', () => {
    it('broadcasts MAPTaskStore events to map:opentasks channel', () => {
      initTaskBridge({ store });

      // Simulate a task creation via MAPTaskStore (as if from cc-swarm)
      store.create(
        { task: { id: 'task_from_agent', title: 'Agent task', status: 'open' } },
        'swarm-agent',
      );

      expect(broadcastToChannel).toHaveBeenCalledWith(
        'map:opentasks',
        expect.objectContaining({
          type: 'task.created',
          data: expect.objectContaining({
            _sourceSwarm: 'swarm-agent',
            _bridged: true,
          }),
        }),
      );
    });

    it('does not broadcast events from bridged mutations (echo prevention)', async () => {
      initTaskBridge({ store });

      // Clear any calls from init
      vi.clearAllMocks();

      // Bridge a mutation (this should suppress the store event broadcast)
      bridgeOpenTasksMutation(store, {
        type: 'create',
        nodeId: 'task_bridged',
        title: 'Bridged task',
        status: 'open',
        sourceSwarmId: 'swarm-1',
      });

      // The broadcastToChannel should NOT have been called from handleStoreEvent
      // because the task is in the bridging set
      const opentasksCalls = (broadcastToChannel as any).mock.calls.filter(
        ([ch]: [string]) => ch === 'map:opentasks',
      );
      expect(opentasksCalls).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Event bridge integration
  // ==========================================================================

  describe('opentasks event bridge', () => {
    it('initializes the event bridge and sends to connected agents', () => {
      // Add a mock connected agent
      mockConnections.set('swarm-A', { ws: {} });

      initTaskBridge({ store });

      // Trigger the event bridge send function
      mockEventBridgeSend('task.created', { task: { id: 't-1' } });

      expect(sendToSwarm).toHaveBeenCalledWith(
        'swarm-A',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'map/event',
          params: expect.objectContaining({
            type: 'task.created',
          }),
        }),
      );
    });

    it('skips sending to the originating swarm', () => {
      mockConnections.set('swarm-origin', { ws: {} });
      mockConnections.set('swarm-other', { ws: {} });

      initTaskBridge({ store });

      mockEventBridgeSend('task.status', { _origin: 'swarm-origin', taskId: 't-1' });

      // Should NOT send to swarm-origin
      const calls = (sendToSwarm as any).mock.calls;
      const recipients = calls.map(([sid]: [string]) => sid);
      expect(recipients).not.toContain('swarm-origin');
      expect(recipients).toContain('swarm-other');
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe('lifecycle', () => {
    it('does not double-initialize', () => {
      initTaskBridge({ store });
      initTaskBridge({ store }); // second call should be no-op

      // Verify event bridge stop works
      stopTaskBridge();
      expect(mockEventBridgeStop).toHaveBeenCalledTimes(1);
    });

    it('cleans up on stop', () => {
      initTaskBridge({ store });
      stopTaskBridge();

      expect(mockEventBridgeStop).toHaveBeenCalled();

      // After stop, store events should not trigger broadcasts
      vi.clearAllMocks();
      store.create(
        { task: { id: 'task_after_stop', title: 'After stop', status: 'open' } },
        'swarm-1',
      );

      const opentasksCalls = (broadcastToChannel as any).mock.calls.filter(
        ([ch]: [string]) => ch === 'map:opentasks',
      );
      expect(opentasksCalls).toHaveLength(0);
    });
  });
});
