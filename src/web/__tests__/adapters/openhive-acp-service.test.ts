// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOpenHiveAcpServiceLike, ensureAcpListenersRegistered } from '../../adapters/openhive-acp-service';
import { useWSStore } from '../../hooks/useWebSocket';

describe('OpenHive ACP service websocket handling', () => {
  beforeEach(() => {
    useWSStore.setState({
      listeners: new Map(),
      channels: new Set(),
      channelRefs: new Map(),
      isConnected: false,
    });
  });

  it('surfaces permission_request updates delivered through acp.session.update', () => {
    ensureAcpListenersRegistered();
    const service = createOpenHiveAcpServiceLike();
    const onPermission = vi.fn();

    service.prepareSubscription('stream-chat-1');
    const handlers = {
      onMessages: vi.fn(),
      onStatus: vi.fn(),
      onPermission,
      onQuestion: vi.fn(),
      onError: vi.fn(),
    } as Parameters<typeof service.subscribe>[1];
    const unsubscribe = service.subscribe('stream-chat-1', handlers);

    useWSStore.getState().emit('acp.session.update', {
      type: 'acp.session.update',
      data: {
        streamId: 'stream-chat-1',
        sessionId: 'sess-chat-1',
        update: {
          sessionUpdate: 'permission_request',
          requestId: 'perm-1',
          toolCall: {
            toolCallId: 'toolu_1',
            title: 'Read /tmp/sensitive.txt',
            kind: 'read',
            status: 'pending',
            rawInput: { file_path: '/tmp/sensitive.txt' },
          },
        },
      },
    });

    expect(onPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'perm-1',
        streamId: 'stream-chat-1',
        description: 'Read /tmp/sensitive.txt',
        status: 'pending',
      }),
    );

    unsubscribe();
  });
});
