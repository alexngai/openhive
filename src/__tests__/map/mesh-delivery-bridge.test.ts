/**
 * Tests for Mesh Delivery Bridge — MapServer message routing to inbox storage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mockServer = new EventEmitter();
const mockPeer = { server: mockServer };

vi.mock('../../map/mesh-peer.js', () => ({
  isMeshEnabled: vi.fn(() => true),
  getHubMeshPeer: vi.fn(() => mockPeer),
}));

// Must import after mocks are set up
import { initMeshDeliveryBridge, stopMeshDeliveryBridge, isDeliveryBridgeActive } from '../../map/mesh-delivery-bridge.js';
import { isMeshEnabled } from '../../map/mesh-peer.js';

function createMockOpts() {
  return {
    storage: { putMessage: vi.fn() },
    events: new EventEmitter(),
  };
}

describe('Mesh Delivery Bridge', () => {
  afterEach(() => {
    stopMeshDeliveryBridge();
    mockServer.removeAllListeners();
  });

  it('should set bridge active after init', () => {
    const opts = createMockOpts();
    initMeshDeliveryBridge(opts);

    expect(isDeliveryBridgeActive()).toBe(true);
  });

  it('should subscribe to message:sent on the MapServer', () => {
    const opts = createMockOpts();
    initMeshDeliveryBridge(opts);

    expect(mockServer.listenerCount('message:sent')).toBe(1);
  });

  it('should return true from isDeliveryBridgeActive after init, false after stop', () => {
    expect(isDeliveryBridgeActive()).toBe(false);

    const opts = createMockOpts();
    initMeshDeliveryBridge(opts);
    expect(isDeliveryBridgeActive()).toBe(true);

    stopMeshDeliveryBridge();
    expect(isDeliveryBridgeActive()).toBe(false);
  });

  it('should store messages in inbox when message:sent fires', () => {
    const opts = createMockOpts();
    initMeshDeliveryBridge(opts);

    mockServer.emit('message:sent', 'msg-123', 'agent-a', 'agent-b');

    expect(opts.storage.putMessage).toHaveBeenCalledOnce();
    const stored = opts.storage.putMessage.mock.calls[0][0];
    expect(stored.id).toBe('msg-123');
    expect(stored.sender_id).toBe('agent-a');
    expect(stored.recipients[0].agent_id).toBe('agent-b');
    expect(stored.scope).toBe('default');
    expect(stored.content).toMatchObject({ type: 'delivery-trace', mesh_message_id: 'msg-123' });
    expect(stored.metadata.source).toBe('mesh-server');
  });

  it('should emit message.created on the events bus', () => {
    const opts = createMockOpts();
    const listener = vi.fn();
    opts.events.on('message.created', listener);

    initMeshDeliveryBridge(opts);
    mockServer.emit('message:sent', 'msg-456', 'sender', 'receiver');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toMatchObject({
      id: 'msg-456',
      sender_id: 'sender',
    });
  });

  it('should skip hub-relay messages (from starts with hub-relay-)', () => {
    const opts = createMockOpts();
    initMeshDeliveryBridge(opts);

    mockServer.emit('message:sent', 'msg-1', 'hub-relay-abc', 'agent-x');

    expect(opts.storage.putMessage).not.toHaveBeenCalled();
  });

  it('should skip hub-relay messages (to starts with hub-relay-)', () => {
    const opts = createMockOpts();
    initMeshDeliveryBridge(opts);

    mockServer.emit('message:sent', 'msg-2', 'agent-x', 'hub-relay-def');

    expect(opts.storage.putMessage).not.toHaveBeenCalled();
  });

  describe('address resolution', () => {
    function emitAndGetRecipient(opts: ReturnType<typeof createMockOpts>, to: unknown) {
      mockServer.emit('message:sent', 'msg-addr', 'sender', to);
      return opts.storage.putMessage.mock.calls[0][0].recipients[0].agent_id;
    }

    it('should resolve string address as-is', () => {
      const opts = createMockOpts();
      initMeshDeliveryBridge(opts);

      expect(emitAndGetRecipient(opts, 'simple-agent')).toBe('simple-agent');
    });

    it('should resolve { agent: "id" } to "id"', () => {
      const opts = createMockOpts();
      initMeshDeliveryBridge(opts);

      expect(emitAndGetRecipient(opts, { agent: 'my-agent' })).toBe('my-agent');
    });

    it('should resolve { system: "x", agent: "y" } to "y@x"', () => {
      const opts = createMockOpts();
      initMeshDeliveryBridge(opts);

      expect(emitAndGetRecipient(opts, { system: 'sys1', agent: 'bot' })).toBe('bot@sys1');
    });

    it('should resolve { agents: ["a", "b"] } to "a,b"', () => {
      const opts = createMockOpts();
      initMeshDeliveryBridge(opts);

      expect(emitAndGetRecipient(opts, { agents: ['a', 'b'] })).toBe('a,b');
    });

    it('should resolve { scope: "name" } to "scope:name"', () => {
      const opts = createMockOpts();
      initMeshDeliveryBridge(opts);

      expect(emitAndGetRecipient(opts, { scope: 'my-scope' })).toBe('scope:my-scope');
    });

    it('should resolve { broadcast: true } to "*"', () => {
      const opts = createMockOpts();
      initMeshDeliveryBridge(opts);

      expect(emitAndGetRecipient(opts, { broadcast: true })).toBe('*');
    });

    it('should resolve unknown objects to "unknown"', () => {
      const opts = createMockOpts();
      initMeshDeliveryBridge(opts);

      expect(emitAndGetRecipient(opts, { foo: 'bar' })).toBe('unknown');
    });

    it('should resolve null/undefined to "unknown"', () => {
      const opts = createMockOpts();
      initMeshDeliveryBridge(opts);

      expect(emitAndGetRecipient(opts, null)).toBe('unknown');
    });
  });

  it('should remove listener and set inactive on stop', () => {
    const opts = createMockOpts();
    initMeshDeliveryBridge(opts);

    expect(mockServer.listenerCount('message:sent')).toBe(1);

    stopMeshDeliveryBridge();

    expect(mockServer.listenerCount('message:sent')).toBe(0);
    expect(isDeliveryBridgeActive()).toBe(false);
  });

  it('should be idempotent — second init call is a no-op', () => {
    const opts = createMockOpts();
    initMeshDeliveryBridge(opts);
    initMeshDeliveryBridge(opts);

    expect(mockServer.listenerCount('message:sent')).toBe(1);
  });

  it('should not init when mesh is disabled', () => {
    vi.mocked(isMeshEnabled).mockReturnValueOnce(false);

    const opts = createMockOpts();
    initMeshDeliveryBridge(opts);

    expect(isDeliveryBridgeActive()).toBe(false);
    expect(mockServer.listenerCount('message:sent')).toBe(0);
  });

  it('should use custom scope when provided', () => {
    const opts = { ...createMockOpts(), scope: 'custom-scope' };
    initMeshDeliveryBridge(opts);

    mockServer.emit('message:sent', 'msg-scoped', 'a', 'b');

    const stored = opts.storage.putMessage.mock.calls[0][0];
    expect(stored.scope).toBe('custom-scope');
  });

  it('should stop being a no-op when already stopped', () => {
    // Should not throw
    stopMeshDeliveryBridge();
    stopMeshDeliveryBridge();
    expect(isDeliveryBridgeActive()).toBe(false);
  });
});
