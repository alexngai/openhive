import { describe, it, expect, beforeEach } from 'vitest';
import {
  useSessionAttentionStore,
  sessionThreadKey,
  hostedChatThreadKey,
  streamThreadKey,
  dispatchThreadKey,
} from '../../stores/session-attention';

const store = () => useSessionAttentionStore.getState();

describe('session-attention store', () => {
  beforeEach(() => {
    store().clearAll();
  });

  describe('idle items', () => {
    it('marks and clears a single idle item per thread', () => {
      const key = sessionThreadKey('sess-1');
      store().markIdle(key, 'swarm-1', 'idle');
      expect(store().hasAttention(key)).toBe(true);
      expect(store().attentionCount()).toBe(1);

      // Re-marking upserts, not duplicates
      store().markIdle(key, 'swarm-1', 'stopped');
      expect(store().attentionCount()).toBe(1);
      expect(store().itemsForThread(key)[0].description).toBe('stopped');

      store().clearIdle(key);
      expect(store().hasAttention(key)).toBe(false);
      expect(store().attentionCount()).toBe(0);
    });

    it('clearIdle does not remove permission items', () => {
      const key = sessionThreadKey('sess-1');
      store().markIdle(key, 'swarm-1', 'idle');
      store().markPermission({
        threadKey: key,
        requestId: 'req-1',
        description: 'Run ls',
        streamId: 'stream-1',
      });

      store().clearIdle(key);
      expect(store().hasAttention(key)).toBe(true);
      expect(store().hasPermission(key)).toBe(true);
      expect(store().attentionCount()).toBe(1);
    });
  });

  describe('permission items', () => {
    it('tracks N permissions per thread, keyed by requestId', () => {
      const key = hostedChatThreadKey('hosted-1');
      store().markPermission({ threadKey: key, requestId: 'req-1', description: 'Run ls', hostedSwarmId: 'hosted-1' });
      store().markPermission({ threadKey: key, requestId: 'req-2', description: 'Apply patch', hostedSwarmId: 'hosted-1' });
      // Same requestId upserts
      store().markPermission({ threadKey: key, requestId: 'req-1', description: 'Run ls -la', hostedSwarmId: 'hosted-1' });

      expect(store().attentionCount()).toBe(2);
      expect(store().hasPermission(key)).toBe(true);
      const items = store().itemsForThread(key);
      expect(items.find((i) => i.requestId === 'req-1')?.description).toBe('Run ls -la');
    });

    it('resolvePermission removes the item regardless of thread', () => {
      store().markPermission({
        threadKey: sessionThreadKey('sess-1'),
        requestId: 'req-1',
        description: 'Run ls',
        streamId: 'stream-1',
      });
      store().markPermission({
        threadKey: streamThreadKey('stream-2'),
        requestId: 'req-2',
        description: 'Apply patch',
        streamId: 'stream-2',
      });

      store().resolvePermission('req-1');
      expect(store().hasPermission(sessionThreadKey('sess-1'))).toBe(false);
      expect(store().hasPermission(streamThreadKey('stream-2'))).toBe(true);
      expect(store().attentionCount()).toBe(1);

      // Resolving an unknown request is a no-op
      const before = store().items;
      store().resolvePermission('req-unknown');
      expect(store().items).toBe(before);
    });

    it('carries reply-routing metadata on the item', () => {
      store().markPermission({
        threadKey: sessionThreadKey('sess-1'),
        requestId: 'req-1',
        description: 'Run ls',
        swarmId: 'swarm-1',
        streamId: 'stream-1',
      });
      const item = store().itemsForThread(sessionThreadKey('sess-1'))[0];
      expect(item.kind).toBe('permission');
      expect(item.streamId).toBe('stream-1');
      expect(item.swarmId).toBe('swarm-1');
      expect(item.hostedSwarmId).toBeUndefined();
    });
  });

  describe('dispatch items (P5.4)', () => {
    it('upserts a single dispatch item per dispatch and clears via clearThread', () => {
      const key = dispatchThreadKey('disp-1');
      store().markDispatch(key, 'swarm-1', 'Completed — review outcome');
      expect(store().hasAttention(key)).toBe(true);
      expect(store().attentionCount()).toBe(1);
      const item = store().itemsForThread(key)[0];
      expect(item.kind).toBe('dispatch');
      expect(item.description).toBe('Completed — review outcome');

      // Re-marking upserts, not duplicates.
      store().markDispatch(key, 'swarm-1', 'Failed — needs review');
      expect(store().attentionCount()).toBe(1);
      expect(store().itemsForThread(key)[0].description).toBe('Failed — needs review');

      store().clearThread(key);
      expect(store().hasAttention(key)).toBe(false);
      expect(store().attentionCount()).toBe(0);
    });
  });

  describe('clearThread', () => {
    it('removes idle and permission items for that thread only', () => {
      const a = sessionThreadKey('sess-a');
      const b = sessionThreadKey('sess-b');
      store().markIdle(a, 'swarm-1', 'idle');
      store().markPermission({ threadKey: a, requestId: 'req-1', description: 'x', streamId: 's1' });
      store().markIdle(b, 'swarm-2', 'idle');

      store().clearThread(a);
      expect(store().hasAttention(a)).toBe(false);
      expect(store().hasAttention(b)).toBe(true);
      expect(store().attentionCount()).toBe(1);
    });
  });
});
