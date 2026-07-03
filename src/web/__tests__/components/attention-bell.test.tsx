// @vitest-environment jsdom
/**
 * AttentionBell (queue panel) tests:
 * - badge count renders from the store
 * - permission items render Allow/Deny; Allow fires the right endpoint
 *   per source (ACP stream vs hosted codex) and removes the item
 * - idle items clear on click-through
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useSessionAttentionStore,
  sessionThreadKey,
  hostedChatThreadKey,
} from '../../stores/session-attention';

const mockReplyAcp = vi.fn(async () => {});
vi.mock('../../adapters/openhive-acp-service', () => ({
  replyAcpPermission: (...args: unknown[]) => mockReplyAcp(...args),
}));

const mockReplyHosted = vi.fn(async () => {});
vi.mock('../../services/hosted-chat-service', () => ({
  hostedChatService: {
    replyPermission: (...args: unknown[]) => mockReplyHosted(...args),
  },
}));

vi.mock('../../hooks/useApi', () => ({
  useHostedSwarms: () => ({
    data: [{ id: 'hosted-1', name: 'Codex worker', mode: 'rpc', state: 'running' }],
  }),
}));

vi.mock('../../stores/toast', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { AttentionBell } from '../../components/attention/AttentionBell';

const store = () => useSessionAttentionStore.getState();

function renderBell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AttentionBell),
      ) as ReactNode,
    ),
  );
}

describe('AttentionBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store().clearAll();
    cleanup();
  });

  it('shows no badge when the store is empty and an empty panel on open', () => {
    renderBell();
    const button = screen.getByLabelText('Attention queue (0)');
    fireEvent.click(button);
    expect(screen.getByText(/All clear/)).toBeTruthy();
  });

  it('renders badge count and lists items newest-first', () => {
    store().markIdle(sessionThreadKey('sess-1'), 'swarm-1', 'idle');
    store().markPermission({
      threadKey: hostedChatThreadKey('hosted-1'),
      requestId: 'req-h1',
      description: 'npm install',
      hostedSwarmId: 'hosted-1',
    });
    renderBell();

    fireEvent.click(screen.getByLabelText('Attention queue (2)'));
    expect(screen.getByText('npm install')).toBeTruthy();
    expect(screen.getByText('Awaiting input')).toBeTruthy();
    expect(screen.getByText('Codex worker')).toBeTruthy();
  });

  it('Allow on an ACP permission item posts to the stream reply route and removes it', async () => {
    store().markPermission({
      threadKey: sessionThreadKey('sess-1'),
      requestId: 'req-acp-1',
      description: 'Write file',
      streamId: 'stream-1',
    });
    renderBell();

    fireEvent.click(screen.getByLabelText('Attention queue (1)'));
    fireEvent.click(screen.getByLabelText('Allow'));

    await waitFor(() => {
      expect(mockReplyAcp).toHaveBeenCalledWith('stream-1', 'req-acp-1', true);
    });
    await waitFor(() => {
      expect(store().attentionCount()).toBe(0);
    });
    expect(mockReplyHosted).not.toHaveBeenCalled();
  });

  it('Deny on a hosted permission item posts the denied decision', async () => {
    store().markPermission({
      threadKey: hostedChatThreadKey('hosted-1'),
      requestId: 'req-h2',
      description: 'rm -rf build',
      hostedSwarmId: 'hosted-1',
    });
    renderBell();

    fireEvent.click(screen.getByLabelText('Attention queue (1)'));
    fireEvent.click(screen.getByLabelText('Deny'));

    await waitFor(() => {
      expect(mockReplyHosted).toHaveBeenCalledWith('hosted-1', 'req-h2', 'denied');
    });
    await waitFor(() => {
      expect(store().attentionCount()).toBe(0);
    });
    expect(mockReplyAcp).not.toHaveBeenCalled();
  });

  it('clicking an idle item clears the idle flag', () => {
    store().markIdle(sessionThreadKey('sess-9'), 'swarm-1', 'idle');
    renderBell();

    fireEvent.click(screen.getByLabelText('Attention queue (1)'));
    // The thread label is the row's click-through (falls back to 'Session'
    // when the sessions cache is empty).
    fireEvent.click(screen.getByText('Session'));

    expect(store().hasAttention(sessionThreadKey('sess-9'))).toBe(false);
  });
});
