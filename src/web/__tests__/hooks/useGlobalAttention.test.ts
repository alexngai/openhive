// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useSessionAttentionStore,
  sessionThreadKey,
  hostedChatThreadKey,
  streamThreadKey,
  dispatchThreadKey,
} from '../../stores/session-attention';

// ── Mocks: WS plumbing + hosted swarms query + toasts ──

const mockUseSubscribe = vi.fn();
const eventHandlers = new Map<string, (...args: unknown[]) => void>();

const mockUseWSEvent = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
  eventHandlers.set(event, handler);
});

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: (...args: unknown[]) => mockUseSubscribe(...args),
  useWSEvent: (...args: unknown[]) => mockUseWSEvent(...args),
}));

let mockHostedSwarms: Array<{ id: string; name?: string; mode?: string; state?: string }> = [];
vi.mock('../../hooks/useApi', () => ({
  useHostedSwarms: () => ({ data: mockHostedSwarms }),
}));

vi.mock('../../stores/toast', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// Hydration endpoint (GET /sessions/pending-attention) — default empty.
let mockPendingItems: Array<Record<string, unknown>> = [];
vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(async () => ({ items: mockPendingItems })),
  },
}));

import { useGlobalAttention } from '../../hooks/useGlobalAttention';

// ── Helpers ──

let queryClient: QueryClient;

function createWrapper() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function seedSessionsCache(sessions: Array<Partial<{
  id: string; name: string; source_swarm_id: string | null;
  source_swarm_ids: string[]; acp_stream_id: string | null;
}>>) {
  queryClient.setQueryData(['sessions-overview', { limit: 50, swarm_id: undefined }], {
    data: sessions,
    total: sessions.length,
  });
}

const store = () => useSessionAttentionStore.getState();

describe('useGlobalAttention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    mockHostedSwarms = [];
    mockPendingItems = [];
    store().clearAll();
  });

  it('subscribes to global and per-swarm hosted-chat channels for running rpc swarms', () => {
    mockHostedSwarms = [
      { id: 'hosted-1', mode: 'rpc', state: 'running' },
      { id: 'hosted-2', mode: 'tui', state: 'running' },
    ];
    renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });

    expect(mockUseSubscribe).toHaveBeenCalledWith(['global', 'map:dispatches']);
    expect(mockUseSubscribe).toHaveBeenCalledWith(['hosted-chat:hosted-1']);
  });

  describe('idle attention', () => {
    it('marks idle on trajectory:sync with idle agent_state', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });
      seedSessionsCache([{ id: 'sess-1', name: 'My session', source_swarm_id: 'swarm-1' }]);

      eventHandlers.get('trajectory:sync')!({
        type: 'trajectory:sync',
        data: { resource_id: 'sess-1', source_swarm_id: 'swarm-1', agent_state: 'idle' },
      });

      expect(store().hasAttention(sessionThreadKey('sess-1'))).toBe(true);
      expect(store().itemsForThread(sessionThreadKey('sess-1'))[0].kind).toBe('idle');
    });

    it('ignores trajectory:sync without idle signals', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });

      eventHandlers.get('trajectory:sync')!({
        type: 'trajectory:sync',
        data: { resource_id: 'sess-1', agent_state: 'active' },
      });

      expect(store().attentionCount()).toBe(0);
    });

    it('marks idle for cached sessions of the swarm on node_state_changed', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });
      seedSessionsCache([
        { id: 'sess-1', name: 'A', source_swarm_id: 'swarm-1', source_swarm_ids: ['swarm-1'] },
        { id: 'sess-2', name: 'B', source_swarm_id: 'swarm-2', source_swarm_ids: ['swarm-2'] },
      ]);

      eventHandlers.get('node_state_changed')!({
        type: 'node_state_changed',
        data: { swarm_id: 'swarm-1', new_state: 'idle', needs_attention: true },
      });

      expect(store().hasAttention(sessionThreadKey('sess-1'))).toBe(true);
      expect(store().hasAttention(sessionThreadKey('sess-2'))).toBe(false);
    });
  });

  describe('ACP permissions', () => {
    it('maps streamId to a cached session and records a permission item', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });
      seedSessionsCache([
        { id: 'sess-1', name: 'My session', source_swarm_id: 'swarm-1', acp_stream_id: 'stream-1' },
      ]);

      eventHandlers.get('acp.permission.request')!({
        type: 'acp.permission.request',
        data: { streamId: 'stream-1', requestId: 'req-1', toolCall: { name: 'Bash' } },
      });

      const key = sessionThreadKey('sess-1');
      expect(store().hasPermission(key)).toBe(true);
      const item = store().itemsForThread(key)[0];
      expect(item.requestId).toBe('req-1');
      expect(item.streamId).toBe('stream-1');
      expect(item.description).toBe('Bash');
    });

    it('falls back to a stream-keyed item when the session is not in cache', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });

      eventHandlers.get('acp.permission.request')!({
        type: 'acp.permission.request',
        data: { streamId: 'stream-x', requestId: 'req-9', description: 'Run tests' },
      });

      expect(store().hasPermission(streamThreadKey('stream-x'))).toBe(true);
    });

    it('drops the item on acp.permission.resolved (answered in any tab)', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });

      eventHandlers.get('acp.permission.request')!({
        type: 'acp.permission.request',
        data: { streamId: 'stream-1', requestId: 'req-1', description: 'Run ls' },
      });
      expect(store().attentionCount()).toBe(1);

      eventHandlers.get('acp.permission.resolved')!({
        type: 'acp.permission.resolved',
        data: { streamId: 'stream-1', requestId: 'req-1' },
      });
      expect(store().attentionCount()).toBe(0);
    });
  });

  describe('hydration from GET /sessions/pending-attention', () => {
    it('seeds permission items from the snapshot (session-mapped, hosted, and stream fallback)', async () => {
      mockPendingItems = [
        {
          kind: 'permission', source: 'acp', request_id: 'req-a',
          description: 'Write file', stream_id: 'stream-1',
          session_resource_id: 'sess-1', swarm_id: 'swarm-1', requested_at: 1,
        },
        {
          kind: 'permission', source: 'acp', request_id: 'req-b',
          description: 'Run tests', stream_id: 'stream-orphan',
          session_resource_id: null, requested_at: 2,
        },
        {
          kind: 'permission', source: 'hosted', request_id: 'req-c',
          description: 'npm install', hosted_swarm_id: 'hosted-1', requested_at: 3,
        },
      ];
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });

      await vi.waitFor(() => {
        expect(store().attentionCount()).toBe(3);
      });
      expect(store().hasPermission(sessionThreadKey('sess-1'))).toBe(true);
      expect(store().hasPermission(streamThreadKey('stream-orphan'))).toBe(true);
      expect(store().hasPermission(hostedChatThreadKey('hosted-1'))).toBe(true);

      const acpItem = store().itemsForThread(sessionThreadKey('sess-1'))[0];
      expect(acpItem.streamId).toBe('stream-1');
      expect(acpItem.requestId).toBe('req-a');
    });
  });

  describe('hosted (codex rpc) permissions', () => {
    it('records and resolves hosted permission items', () => {
      mockHostedSwarms = [{ id: 'hosted-1', name: 'Codex', mode: 'rpc', state: 'running' }];
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });

      eventHandlers.get('hosted-chat.event')!({
        type: 'hosted-chat.event',
        data: {
          hosted_swarm_id: 'hosted-1',
          provider: 'codex',
          event: {
            kind: 'permission.request',
            request: { requestId: 'req-h1', flavor: 'exec', summary: 'npm test' },
          },
        },
      });

      const key = hostedChatThreadKey('hosted-1');
      expect(store().hasPermission(key)).toBe(true);
      const item = store().itemsForThread(key)[0];
      expect(item.hostedSwarmId).toBe('hosted-1');
      expect(item.description).toBe('npm test');

      eventHandlers.get('hosted-chat.event')!({
        type: 'hosted-chat.event',
        data: {
          hosted_swarm_id: 'hosted-1',
          provider: 'codex',
          event: { kind: 'permission.resolved', requestId: 'req-h1', decision: 'approved' },
        },
      });
      expect(store().hasPermission(key)).toBe(false);
    });

    it('ignores non-permission hosted events', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });

      eventHandlers.get('hosted-chat.event')!({
        type: 'hosted-chat.event',
        data: {
          hosted_swarm_id: 'hosted-1',
          provider: 'codex',
          event: { kind: 'message.delta', itemId: 'i1', delta: 'hello' },
        },
      });

      expect(store().attentionCount()).toBe(0);
    });
  });

  describe('dispatch completion (P5.4)', () => {
    it('adds a dispatch attention item on dispatch.completed', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });

      eventHandlers.get('dispatch.completed')!({
        type: 'dispatch.completed',
        data: {
          dispatch: { id: 'disp-77', status: 'complete' },
          target_swarm_id: 'swarm-9',
        },
      });

      const key = dispatchThreadKey('disp-77');
      expect(store().hasAttention(key)).toBe(true);
      const item = store().itemsForThread(key)[0];
      expect(item.kind).toBe('dispatch');
      expect(item.description).toBe('Completed — review outcome');
      expect(item.swarmId).toBe('swarm-9');
    });

    it('labels a failed completion for review', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });
      eventHandlers.get('dispatch.completed')!({
        type: 'dispatch.completed',
        data: { dispatch: { id: 'disp-88', status: 'failed' }, target_swarm_id: 'swarm-1' },
      });
      expect(store().itemsForThread(dispatchThreadKey('disp-88'))[0].description).toBe(
        'Failed — needs review',
      );
    });

    it('handles dispatch.dead (taskId payload, no status)', () => {
      renderHook(() => useGlobalAttention(), { wrapper: createWrapper() });
      eventHandlers.get('dispatch.dead')!({
        type: 'dispatch.dead',
        data: { taskId: 'disp-99' },
      });
      const item = store().itemsForThread(dispatchThreadKey('disp-99'))[0];
      expect(item.kind).toBe('dispatch');
      expect(item.description).toBe('Ended — review');
    });
  });
});
