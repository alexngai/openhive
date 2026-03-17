/**
 * Tests for Mesh Channels — HubChannel class, channel registry, and method classification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock sendToSwarm before importing the module under test
vi.mock('../../map/sync-listener.js', () => ({
  sendToSwarm: vi.fn(),
}));

// Mock nanoid to produce deterministic IDs
let nanoidCounter = 0;
vi.mock('nanoid', () => ({
  nanoid: () => `test-id-${++nanoidCounter}`,
}));

import { sendToSwarm } from '../../map/sync-listener.js';
import {
  HubChannel,
  createChannel,
  getChannel,
  listChannels,
  getAllChannelStats,
  flushAllQueues,
  closeAllChannels,
  initDefaultChannels,
  classifyMethod,
} from '../../map/mesh-channels.js';

const mockSendToSwarm = sendToSwarm as ReturnType<typeof vi.fn>;

// ============================================================================
// HubChannel class
// ============================================================================

describe('HubChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nanoidCounter = 0;
  });

  afterEach(() => {
    closeAllChannels();
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('applies default config values', () => {
      const ch = new HubChannel('test');
      expect(ch.name).toBe('test');
      const stats = ch.getStats();
      expect(stats.messagesSent).toBe(0);
      expect(stats.messagesReceived).toBe(0);
      expect(stats.queuedMessages).toBe(0);
      expect(stats.failedDeliveries).toBe(0);
      expect(stats.rpcRequestsSent).toBe(0);
      expect(stats.rpcResponsesReceived).toBe(0);
      expect(stats.rpcTimeouts).toBe(0);
    });

    it('accepts custom config', () => {
      const ch = new HubChannel('custom', {
        enableOfflineQueue: true,
        offlineQueueTTL: 5000,
        maxQueueSize: 10,
        rpcTimeout: 1000,
      });
      expect(ch.name).toBe('custom');
      // Verify custom config by exercising queue behavior
      mockSendToSwarm.mockReturnValue(false);
      ch.send('swarm-1', { data: 'hello' });
      // Should be queued (enableOfflineQueue: true) rather than failed
      expect(ch.getStats().queuedMessages).toBe(1);
      expect(ch.getStats().failedDeliveries).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------

  describe('send()', () => {
    it('increments messagesSent on successful send', () => {
      const ch = new HubChannel('ch');
      mockSendToSwarm.mockReturnValue(true);

      const result = ch.send('swarm-1', { action: 'ping' });

      expect(result).toBe(true);
      expect(ch.getStats().messagesSent).toBe(1);
      expect(mockSendToSwarm).toHaveBeenCalledWith('swarm-1', expect.objectContaining({
        action: 'ping',
        _channel: 'ch',
        _channel_type: 'message',
      }));
    });

    it('enqueues message on failure when offline queue is enabled', () => {
      const ch = new HubChannel('ch', { enableOfflineQueue: true });
      mockSendToSwarm.mockReturnValue(false);

      const result = ch.send('swarm-1', { data: 1 });

      expect(result).toBe(false);
      expect(ch.getStats().queuedMessages).toBe(1);
      expect(ch.getStats().failedDeliveries).toBe(0);
    });

    it('increments failedDeliveries on failure when queue is disabled', () => {
      const ch = new HubChannel('ch', { enableOfflineQueue: false });
      mockSendToSwarm.mockReturnValue(false);

      const result = ch.send('swarm-1', { data: 1 });

      expect(result).toBe(false);
      expect(ch.getStats().failedDeliveries).toBe(1);
      expect(ch.getStats().queuedMessages).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // broadcast()
  // --------------------------------------------------------------------------

  describe('broadcast()', () => {
    it('sends to multiple swarms and returns result map', () => {
      const ch = new HubChannel('ch');
      mockSendToSwarm
        .mockReturnValueOnce(true)   // swarm-1 succeeds
        .mockReturnValueOnce(false)  // swarm-2 fails
        .mockReturnValueOnce(true);  // swarm-3 succeeds

      const results = ch.broadcast(['swarm-1', 'swarm-2', 'swarm-3'], { msg: 'hi' });

      expect(results.get('swarm-1')).toBe(true);
      expect(results.get('swarm-2')).toBe(false);
      expect(results.get('swarm-3')).toBe(true);
      expect(results.size).toBe(3);
      expect(ch.getStats().messagesSent).toBe(2);
      expect(ch.getStats().failedDeliveries).toBe(1);
    });

    it('returns empty map for empty target list', () => {
      const ch = new HubChannel('ch');
      const results = ch.broadcast([], { msg: 'hi' });
      expect(results.size).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // request()
  // --------------------------------------------------------------------------

  describe('request()', () => {
    it('sends RPC request with envelope and resolves on response', async () => {
      const ch = new HubChannel('rpc-ch', { rpcTimeout: 5000 });
      mockSendToSwarm.mockReturnValue(true);

      const promise = ch.request('swarm-1', { method: 'doWork' });

      expect(mockSendToSwarm).toHaveBeenCalledWith('swarm-1', expect.objectContaining({
        method: 'doWork',
        _channel: 'rpc-ch',
        _channel_type: 'request',
        _channel_request_id: 'test-id-1',
      }));
      expect(ch.getStats().rpcRequestsSent).toBe(1);
      expect(ch.getStats().messagesSent).toBe(1);

      // Simulate the response arriving
      ch.recordReceived({
        _channel_type: 'response',
        _channel_request_id: 'test-id-1',
        payload: { answer: 42 },
      }, 'swarm-1');

      const result = await promise;
      expect(result).toEqual({ answer: 42 });
      expect(ch.getStats().rpcResponsesReceived).toBe(1);
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();
      const ch = new HubChannel('rpc-ch', { rpcTimeout: 100 });
      mockSendToSwarm.mockReturnValue(true);

      const promise = ch.request('swarm-1', { method: 'slow' });

      vi.advanceTimersByTime(101);

      await expect(promise).rejects.toThrow('RPC timeout on channel rpc-ch (100ms)');
      expect(ch.getStats().rpcTimeouts).toBe(1);

      vi.useRealTimers();
    });

    it('rejects immediately if sendToSwarm fails', async () => {
      const ch = new HubChannel('rpc-ch');
      mockSendToSwarm.mockReturnValue(false);

      await expect(ch.request('swarm-1', { method: 'fail' })).rejects.toThrow(
        'Failed to send RPC request on channel rpc-ch to swarm-1',
      );
      expect(ch.getStats().failedDeliveries).toBe(1);
    });

    it('accepts custom timeout override', async () => {
      vi.useFakeTimers();
      const ch = new HubChannel('rpc-ch', { rpcTimeout: 30_000 });
      mockSendToSwarm.mockReturnValue(true);

      const promise = ch.request('swarm-1', { method: 'fast' }, 50);

      vi.advanceTimersByTime(51);

      await expect(promise).rejects.toThrow('RPC timeout on channel rpc-ch (50ms)');

      vi.useRealTimers();
    });
  });

  // --------------------------------------------------------------------------
  // recordReceived()
  // --------------------------------------------------------------------------

  describe('recordReceived()', () => {
    it('increments messagesReceived', () => {
      const ch = new HubChannel('ch');
      ch.recordReceived({ data: 'hello' }, 'swarm-1');
      expect(ch.getStats().messagesReceived).toBe(1);
    });

    it('resolves pending RPC response', async () => {
      const ch = new HubChannel('ch', { rpcTimeout: 5000 });
      mockSendToSwarm.mockReturnValue(true);

      const promise = ch.request('swarm-1', { method: 'test' });

      ch.recordReceived({
        _channel_type: 'response',
        _channel_request_id: 'test-id-1',
        payload: { ok: true },
      }, 'swarm-1');

      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(ch.getStats().messagesReceived).toBe(1);
      expect(ch.getStats().rpcResponsesReceived).toBe(1);
    });

    it('handles RPC request by calling requestHandler', async () => {
      const ch = new HubChannel('ch');
      const handler = vi.fn().mockResolvedValue({ computed: 'value' });
      ch.onRequest(handler);

      mockSendToSwarm.mockReturnValue(true);

      ch.recordReceived({
        _channel_type: 'request',
        _channel_request_id: 'req-123',
        data: 'work',
      }, 'swarm-2');

      // Allow the async handler to complete
      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({ _channel_type: 'request', _channel_request_id: 'req-123', data: 'work' }),
          'swarm-2',
        );
      });

      // The response should have been sent back
      await vi.waitFor(() => {
        expect(mockSendToSwarm).toHaveBeenCalledWith('swarm-2', expect.objectContaining({
          _channel_type: 'response',
          _channel_request_id: 'req-123',
          result: { computed: 'value' },
        }));
      });
    });

    it('sends error response when requestHandler throws', async () => {
      const ch = new HubChannel('ch');
      const handler = vi.fn().mockRejectedValue(new Error('boom'));
      ch.onRequest(handler);

      mockSendToSwarm.mockReturnValue(true);

      ch.recordReceived({
        _channel_type: 'request',
        _channel_request_id: 'req-456',
      }, 'swarm-3');

      await vi.waitFor(() => {
        expect(mockSendToSwarm).toHaveBeenCalledWith('swarm-3', expect.objectContaining({
          _channel_type: 'response',
          _channel_request_id: 'req-456',
          error: 'Request handler failed',
        }));
      });
    });

    it('ignores RPC request if no requestHandler is registered', () => {
      const ch = new HubChannel('ch');
      // No handler registered — should not throw
      ch.recordReceived({
        _channel_type: 'request',
        _channel_request_id: 'req-789',
      }, 'swarm-4');

      expect(ch.getStats().messagesReceived).toBe(1);
      expect(mockSendToSwarm).not.toHaveBeenCalled();
    });

    it('ignores unmatched RPC response', () => {
      const ch = new HubChannel('ch');
      ch.recordReceived({
        _channel_type: 'response',
        _channel_request_id: 'nonexistent',
      }, 'swarm-1');

      expect(ch.getStats().messagesReceived).toBe(1);
      expect(ch.getStats().rpcResponsesReceived).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // recordSent()
  // --------------------------------------------------------------------------

  describe('recordSent()', () => {
    it('increments messagesSent', () => {
      const ch = new HubChannel('ch');
      ch.recordSent();
      ch.recordSent();
      expect(ch.getStats().messagesSent).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // flushQueue()
  // --------------------------------------------------------------------------

  describe('flushQueue()', () => {
    it('returns 0 for swarm with no queue', () => {
      const ch = new HubChannel('ch', { enableOfflineQueue: true });
      expect(ch.flushQueue('unknown')).toBe(0);
    });

    it('delivers queued messages and returns flush count', () => {
      const ch = new HubChannel('ch', { enableOfflineQueue: true });
      mockSendToSwarm.mockReturnValue(false);

      // Queue 3 messages
      ch.send('swarm-1', { m: 1 });
      ch.send('swarm-1', { m: 2 });
      ch.send('swarm-1', { m: 3 });
      expect(ch.getStats().queuedMessages).toBe(3);

      // Now flush — send succeeds
      mockSendToSwarm.mockReturnValue(true);
      const flushed = ch.flushQueue('swarm-1');

      expect(flushed).toBe(3);
      expect(ch.getStats().messagesSent).toBe(3);
      expect(ch.getStats().queuedMessages).toBe(0);
    });

    it('skips expired messages and increments failedDeliveries', () => {
      vi.useFakeTimers();
      const ch = new HubChannel('ch', {
        enableOfflineQueue: true,
        offlineQueueTTL: 1000,
      });
      mockSendToSwarm.mockReturnValue(false);

      ch.send('swarm-1', { m: 'will-expire' });
      expect(ch.getStats().queuedMessages).toBe(1);

      // Advance past TTL
      vi.advanceTimersByTime(1500);
      mockSendToSwarm.mockReturnValue(true);

      const flushed = ch.flushQueue('swarm-1');

      expect(flushed).toBe(0);
      expect(ch.getStats().failedDeliveries).toBe(1);
      expect(ch.getStats().queuedMessages).toBe(0);

      vi.useRealTimers();
    });

    it('keeps remaining messages if some fail to send', () => {
      const ch = new HubChannel('ch', { enableOfflineQueue: true });
      mockSendToSwarm.mockReturnValue(false);

      ch.send('swarm-1', { m: 1 });
      ch.send('swarm-1', { m: 2 });

      // Flush — still fails
      const flushed = ch.flushQueue('swarm-1');

      expect(flushed).toBe(0);
      expect(ch.getStats().queuedMessages).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // getStats() / resetStats()
  // --------------------------------------------------------------------------

  describe('getStats() / resetStats()', () => {
    it('returns a copy of stats', () => {
      const ch = new HubChannel('ch');
      mockSendToSwarm.mockReturnValue(true);
      ch.send('swarm-1', { data: 1 });

      const stats = ch.getStats();
      expect(stats.messagesSent).toBe(1);

      // Mutating the copy should not affect internal state
      stats.messagesSent = 999;
      expect(ch.getStats().messagesSent).toBe(1);
    });

    it('resets all stats to zero', () => {
      const ch = new HubChannel('ch');
      mockSendToSwarm.mockReturnValue(true);
      ch.send('s1', {});
      ch.recordReceived({}, 's1');
      ch.recordSent();

      ch.resetStats();
      const stats = ch.getStats();
      expect(stats.messagesSent).toBe(0);
      expect(stats.messagesReceived).toBe(0);
      expect(stats.queuedMessages).toBe(0);
      expect(stats.failedDeliveries).toBe(0);
      expect(stats.rpcRequestsSent).toBe(0);
      expect(stats.rpcResponsesReceived).toBe(0);
      expect(stats.rpcTimeouts).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // close()
  // --------------------------------------------------------------------------

  describe('close()', () => {
    it('rejects pending RPCs with "Channel closed"', async () => {
      const ch = new HubChannel('ch', { rpcTimeout: 60_000 });
      mockSendToSwarm.mockReturnValue(true);

      const p1 = ch.request('swarm-1', { m: 1 });
      const p2 = ch.request('swarm-1', { m: 2 });

      ch.close();

      await expect(p1).rejects.toThrow('Channel closed');
      await expect(p2).rejects.toThrow('Channel closed');
    });

    it('clears queues and resets queuedMessages stat', () => {
      const ch = new HubChannel('ch', { enableOfflineQueue: true });
      mockSendToSwarm.mockReturnValue(false);

      ch.send('swarm-1', { a: 1 });
      ch.send('swarm-2', { a: 2 });
      expect(ch.getStats().queuedMessages).toBe(2);

      ch.close();
      expect(ch.getStats().queuedMessages).toBe(0);
      // Flushing after close returns 0
      expect(ch.flushQueue('swarm-1')).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Offline queue: max size and TTL expiration
  // --------------------------------------------------------------------------

  describe('offline queue limits', () => {
    it('drops oldest messages when max queue size is exceeded', () => {
      const ch = new HubChannel('ch', {
        enableOfflineQueue: true,
        maxQueueSize: 3,
      });
      mockSendToSwarm.mockReturnValue(false);

      ch.send('swarm-1', { m: 1 });
      ch.send('swarm-1', { m: 2 });
      ch.send('swarm-1', { m: 3 });
      expect(ch.getStats().queuedMessages).toBe(3);

      // Adding a 4th should drop the oldest
      ch.send('swarm-1', { m: 4 });
      expect(ch.getStats().queuedMessages).toBe(3);
      expect(ch.getStats().failedDeliveries).toBe(1); // oldest was dropped
    });

    it('tracks per-swarm queues independently', () => {
      const ch = new HubChannel('ch', {
        enableOfflineQueue: true,
        maxQueueSize: 2,
      });
      mockSendToSwarm.mockReturnValue(false);

      ch.send('swarm-1', { m: 1 });
      ch.send('swarm-1', { m: 2 });
      ch.send('swarm-2', { m: 3 });

      expect(ch.getStats().queuedMessages).toBe(3);

      // Flush only swarm-1
      mockSendToSwarm.mockReturnValue(true);
      const flushed = ch.flushQueue('swarm-1');
      expect(flushed).toBe(2);
      expect(ch.getStats().queuedMessages).toBe(1); // swarm-2 still has 1
    });
  });

  // --------------------------------------------------------------------------
  // onRequest / offRequest
  // --------------------------------------------------------------------------

  describe('onRequest / offRequest', () => {
    it('offRequest removes the handler', () => {
      const ch = new HubChannel('ch');
      const handler = vi.fn().mockResolvedValue({});
      ch.onRequest(handler);
      ch.offRequest();

      ch.recordReceived({
        _channel_type: 'request',
        _channel_request_id: 'req-1',
      }, 'swarm-1');

      expect(handler).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Channel Registry
// ============================================================================

describe('Channel Registry', () => {
  afterEach(() => {
    closeAllChannels();
  });

  describe('createChannel()', () => {
    it('creates a new channel', () => {
      const ch = createChannel('test-ch');
      expect(ch).toBeInstanceOf(HubChannel);
      expect(ch.name).toBe('test-ch');
    });

    it('returns existing channel for same name', () => {
      const ch1 = createChannel('same', { rpcTimeout: 1000 });
      const ch2 = createChannel('same', { rpcTimeout: 9999 });
      expect(ch2).toBe(ch1); // Same reference
    });
  });

  describe('getChannel()', () => {
    it('returns channel if it exists', () => {
      const ch = createChannel('existing');
      expect(getChannel('existing')).toBe(ch);
    });

    it('returns undefined if channel does not exist', () => {
      expect(getChannel('nonexistent')).toBeUndefined();
    });
  });

  describe('listChannels()', () => {
    it('returns all channels', () => {
      createChannel('a');
      createChannel('b');
      createChannel('c');

      const list = listChannels();
      expect(list).toHaveLength(3);
      expect(list.map((c) => c.name).sort()).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array when no channels exist', () => {
      expect(listChannels()).toEqual([]);
    });
  });

  describe('getAllChannelStats()', () => {
    it('returns stats map keyed by channel name', () => {
      const ch1 = createChannel('x');
      const ch2 = createChannel('y');
      mockSendToSwarm.mockReturnValue(true);
      ch1.send('s1', {});
      ch2.send('s2', {});
      ch2.send('s3', {});

      const allStats = getAllChannelStats();
      expect(allStats['x'].messagesSent).toBe(1);
      expect(allStats['y'].messagesSent).toBe(2);
    });
  });

  describe('flushAllQueues()', () => {
    it('flushes across all channels', () => {
      const ch1 = createChannel('q1', { enableOfflineQueue: true });
      const ch2 = createChannel('q2', { enableOfflineQueue: true });

      mockSendToSwarm.mockReturnValue(false);
      ch1.send('swarm-1', { a: 1 });
      ch2.send('swarm-1', { b: 2 });

      mockSendToSwarm.mockReturnValue(true);
      const total = flushAllQueues('swarm-1');
      expect(total).toBe(2);
    });
  });

  describe('closeAllChannels()', () => {
    it('cleans up all channels and empties the registry', () => {
      createChannel('c1');
      createChannel('c2');
      expect(listChannels()).toHaveLength(2);

      closeAllChannels();
      expect(listChannels()).toEqual([]);
      expect(getChannel('c1')).toBeUndefined();
    });
  });

  describe('initDefaultChannels()', () => {
    it('creates the 4 default channels with correct configs', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      initDefaultChannels();

      const channels = listChannels();
      expect(channels).toHaveLength(4);

      const names = channels.map((c) => c.name).sort();
      expect(names).toEqual([
        'proto:coordination',
        'proto:federation',
        'proto:mail',
        'proto:resource-sync',
      ]);

      // Verify resource-sync has offline queue enabled
      const resourceSync = getChannel('proto:resource-sync')!;
      mockSendToSwarm.mockReturnValue(false);
      resourceSync.send('s1', {});
      expect(resourceSync.getStats().queuedMessages).toBe(1);

      // Verify coordination has offline queue disabled
      const coordination = getChannel('proto:coordination')!;
      coordination.send('s1', {});
      expect(coordination.getStats().failedDeliveries).toBe(1);
      expect(coordination.getStats().queuedMessages).toBe(0);

      // Verify mail has offline queue enabled
      const mail = getChannel('proto:mail')!;
      mail.send('s1', {});
      expect(mail.getStats().queuedMessages).toBe(1);

      // Verify federation has offline queue enabled
      const federation = getChannel('proto:federation')!;
      federation.send('s1', {});
      expect(federation.getStats().queuedMessages).toBe(1);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Initialized 4 protocol channels'),
      );

      consoleSpy.mockRestore();
    });
  });
});

// ============================================================================
// classifyMethod()
// ============================================================================

describe('classifyMethod()', () => {
  describe('resource sync methods', () => {
    it.each([
      'x-openhive/memory.read',
      'x-openhive/memory.write',
      'x-openhive/skill.list',
      'x-openhive/skill.update',
      'x-openhive/trajectory.append',
    ])('classifies "%s" as proto:resource-sync', (method) => {
      expect(classifyMethod(method)).toBe('proto:resource-sync');
    });
  });

  describe('coordination methods', () => {
    it.each([
      'x-openhive/task.assign',
      'x-openhive/task.complete',
      'x-openhive/context.share',
      'x-openhive/message.send',
    ])('classifies "%s" as proto:coordination', (method) => {
      expect(classifyMethod(method)).toBe('proto:coordination');
    });
  });

  describe('mail methods', () => {
    it.each([
      'mail/send',
      'mail/list',
      'mail/read',
    ])('classifies "%s" as proto:mail', (method) => {
      expect(classifyMethod(method)).toBe('proto:mail');
    });
  });

  describe('federation methods', () => {
    it.each([
      'map/federation/announce',
      'map/federation/sync',
      'map/federation/peers',
    ])('classifies "%s" as proto:federation', (method) => {
      expect(classifyMethod(method)).toBe('proto:federation');
    });
  });

  describe('unclassified methods', () => {
    it.each([
      'unknown.method',
      'x-openhive/unknown.method',
      'map/swarms',
      '',
      'mail',
      'map/federation',
    ])('returns null for "%s"', (method) => {
      expect(classifyMethod(method)).toBeNull();
    });
  });
});
