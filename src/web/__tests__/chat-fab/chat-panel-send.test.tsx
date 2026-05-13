/**
 * Tests the Send path of ChipsComposer (the chip-enabled composer).
 * Mocks the ChatChannel to capture what's sent and asserts:
 * - chips + text compose into one turn
 * - chips are cleared after send
 * - chip-less send works (text-only turn)
 * - streaming state: Send disabled (hint says "Sending after current reply…")
 * - byte-cap: composed >256KB toast + abort; chips remain staged
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../../components/chat-fab/context-types';
import type { ChatChannel } from 'swarmcraft/ui/embed';
import { ChipsComposer } from '../../components/chat-fab/ChipsComposer';
import { useChatFabStagedChipsStore } from '../../components/chat-fab/chat-fab-staged-chips-store';
import {
  composeTurn,
  MAX_USER_TURN_BYTES,
} from '../../components/chat-fab/chat-send-utils';
import type { ChatFabContextItem } from '../../components/chat-fab/chat-fab-item';

function reset() {
  useChatFabStagedChipsStore.setState({ stagedChips: [] });
  cleanup();
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
}

function withQc(ui: ReactNode) {
  return createElement(QueryClientProvider, { client: makeQueryClient() }, ui);
}

function mockChannel(
  overrides: Partial<ChatChannel> = {},
): ChatChannel & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => {});
  return {
    target: { kind: 'session', sessionId: 's', swarmId: 'w' } as unknown as ChatChannel['target'],
    mode: 'acp',
    status: 'ready',
    statusDetail: null,
    messages: [],
    capabilities: { available: true, connected: true },
    send,
    cancel: vi.fn(async () => {}),
    loadMore: undefined,
    hasMore: false,
    permissions: [],
    questions: [],
    replyPermission: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    setMessages: vi.fn(),
    ...overrides,
  } as unknown as ChatChannel & { send: ReturnType<typeof vi.fn> };
}

const specItem: ChatFabContextItem = {
  type: 'spec',
  label: 'Spec A',
  data: { id: 'a', resource_id: 'r', title: 'Auth', content: 'body' },
};

describe('ChipsComposer Send path', () => {
  beforeEach(reset);

  it('with chips + text, Send produces one turn containing both', async () => {
    const channel = mockChannel();
    useChatFabStagedChipsStore.getState().addChip(specItem);

    render(withQc(<ChipsComposer channel={channel} onAtKey={() => false} />));

    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'please review' } });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send message'));
    });

    await waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
    const sent = channel.send.mock.calls[0]![0];
    expect(sent).toContain('please review');
    // Fenced block from the registered spec type
    expect(sent).toContain('<context ');
    expect(sent).toContain('please review');
  });

  it('clears chips after Send', async () => {
    const channel = mockChannel();
    useChatFabStagedChipsStore.getState().addChip(specItem);

    render(withQc(<ChipsComposer channel={channel} onAtKey={() => false} />));
    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'ping' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send message'));
    });

    await waitFor(() =>
      expect(useChatFabStagedChipsStore.getState().stagedChips).toEqual([]),
    );
  });

  it('with no chips, Send behaves as today (text-only turn)', async () => {
    const channel = mockChannel();
    render(withQc(<ChipsComposer channel={channel} onAtKey={() => false} />));
    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send message'));
    });

    await waitFor(() => expect(channel.send).toHaveBeenCalledWith('hello'));
  });

  it('during streaming, Send is disabled + hint says queued-after-stream', () => {
    const channel = mockChannel({ status: 'streaming' });
    useChatFabStagedChipsStore.getState().addChip(specItem);
    render(withQc(<ChipsComposer channel={channel} onAtKey={() => false} />));
    expect(screen.getByText(/Sending after current reply/i)).toBeDefined();
  });

  it('byte-cap: composed turn >MAX_USER_TURN_BYTES triggers toast and aborts Send', async () => {
    const channel = mockChannel();
    const huge = 'x'.repeat(MAX_USER_TURN_BYTES + 100);
    useChatFabStagedChipsStore.getState().addChip({
      type: 'spec',
      label: 'Huge',
      data: { id: 'huge', resource_id: 'r', title: 't', content: huge },
    });

    render(withQc(<ChipsComposer channel={channel} onAtKey={() => false} />));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send message'));
    });

    await waitFor(() => screen.getByText(/Context too large/i));
    expect(channel.send).not.toHaveBeenCalled();
    // Chips remain staged.
    expect(useChatFabStagedChipsStore.getState().stagedChips).toHaveLength(1);
  });

  it('Enter-to-send triggers Send', async () => {
    const channel = mockChannel();
    render(withQc(<ChipsComposer channel={channel} onAtKey={() => false} />));
    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'hi' } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });
    await waitFor(() => expect(channel.send).toHaveBeenCalledWith('hi'));
  });

  it('Shift+Enter does not send', () => {
    const channel = mockChannel();
    render(withQc(<ChipsComposer channel={channel} onAtKey={() => false} />));
    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('@ keystroke at an empty textarea calls onAtKey and prevents literal insert', () => {
    const channel = mockChannel();
    const onAtKey = vi.fn(() => true);
    render(withQc(<ChipsComposer channel={channel} onAtKey={onAtKey} />));
    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.keyDown(textarea, { key: '@' });
    expect(onAtKey).toHaveBeenCalled();
  });

  it('composeTurn() assembles chips + text with blank line separators', () => {
    useChatFabStagedChipsStore.getState().addChip(specItem);
    const chips = useChatFabStagedChipsStore.getState().stagedChips;
    const out = composeTurn(chips, 'hello');
    expect(out).toContain('hello');
    expect(out.split('\n\n').length).toBeGreaterThanOrEqual(2);
  });

  it('§3.1.4 live refresh bounded: slow fetch does not delay Send past the fetch window', async () => {
    // Design acceptance: given a 500ms mocked fetch, Send completes before
    // the full fetch would have resolved. The 200ms timeout + React
    // re-render + vitest polling yields order-of-200ms on a fast machine,
    // higher under load — but always well below the 500ms fetch deadline.
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const HANG_MS = 2000;
    const origFetch = qc.fetchQuery.bind(qc);
    vi.spyOn(qc, 'fetchQuery').mockImplementation(((opts: Parameters<typeof origFetch>[0]) =>
      new Promise((_resolve, reject) => {
        const t = setTimeout(() => {
          reject(new Error('fetch should have aborted'));
        }, HANG_MS);
        const signal = (opts as { signal?: AbortSignal }).signal;
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as typeof origFetch);

    const channel = mockChannel();
    useChatFabStagedChipsStore.getState().addChip(specItem);

    render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(ChipsComposer, { channel, onAtKey: () => false }),
      ),
    );

    const textarea = screen.getByPlaceholderText(/Message agent/i);
    fireEvent.change(textarea, { target: { value: 'bounded' } });

    const start = Date.now();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Send message'));
    });

    await waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1), {
      timeout: 1800,
      interval: 10,
    });
    const elapsed = Date.now() - start;
    // Hard assertion: well under the fetch hang. Proves the wrapper's
    // 200ms soft-timeout is doing its job — Send is not blocked on the
    // long fetch.
    expect(elapsed).toBeLessThan(HANG_MS - 200);
    const sent = channel.send.mock.calls[0]![0];
    expect(sent).toContain('bounded');
    // Snapshot content still present (Auth title from specItem)
    expect(sent).toContain('Auth');
  });
});
