/**
 * Tests for the task event bridge.
 *
 * The bridge manages the opentasks MAPEventBridge for structured
 * agent notifications. Store event → frontend broadcasting is
 * handled by task-broadcaster (separate concern).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MAPTaskStore } from '../../map/task-store.js';
import {
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
const mockEventBridgeStop = vi.fn();
const mockCreateMAPEventBridge = vi.fn((_config?: unknown) => ({
  emitTaskCreated: vi.fn(),
  emitTaskStatus: vi.fn(),
  emitTaskAssigned: vi.fn(),
  emitTaskCompleted: vi.fn(),
  handleProviderChange: vi.fn(),
  stop: mockEventBridgeStop,
  active: true,
}));
vi.mock('opentasks', () => ({
  createMAPEventBridge: (config: any) => mockCreateMAPEventBridge(config),
}));

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

  describe('MAPEventBridge initialization', () => {
    it('creates the opentasks MAPEventBridge on init', async () => {
      await initTaskBridge({ store });

      expect(mockCreateMAPEventBridge).toHaveBeenCalledTimes(1);
      expect(mockCreateMAPEventBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'openhive-bridge',
          send: expect.any(Function),
        }),
      );
    });

    it('does not double-initialize', async () => {
      await initTaskBridge({ store });
      await initTaskBridge({ store }); // no-op

      expect(mockCreateMAPEventBridge).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle', () => {
    it('cleans up on stop', async () => {
      await initTaskBridge({ store });
      stopTaskBridge();

      expect(mockEventBridgeStop).toHaveBeenCalled();
    });

    it('stop is safe to call without init', () => {
      expect(() => stopTaskBridge()).not.toThrow();
    });

    it('can re-initialize after stop', async () => {
      await initTaskBridge({ store });
      stopTaskBridge();
      vi.clearAllMocks();

      await initTaskBridge({ store });
      expect(mockCreateMAPEventBridge).toHaveBeenCalledTimes(1);
    });
  });
});
