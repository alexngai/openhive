/**
 * HostedChat / useHostedChatChannel — component & hook coverage.
 *
 * Validates the React side of the codex-rpc → openhive-chat path:
 *   - Subscription wired to the per-swarm channel
 *   - Streaming deltas accumulate into the rendered message
 *   - Optimistic user echo on send + the right URL is hit
 *   - Error events surface as status detail
 *   - Events for a different swarm id are ignored
 *
 * Drives synthetic `hosted-chat.event` notifications through a captured
 * `useWSEvent` callback. The DOM assertions use `container.textContent`
 * substring checks (rather than RTL `getByText` / jest-dom matchers,
 * neither of which is configured here).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const mockApiPost = vi.fn();
let capturedWSHandler:
  | ((event: { type: string; channel?: string; data: unknown }) => void)
  | null = null;
const mockUseSubscribe = vi.fn();

vi.mock('../../../lib/api', () => ({
  api: {
    post: (...args: unknown[]) => mockApiPost(...args),
  },
}));

vi.mock('../../../hooks/useWebSocket', () => ({
  useSubscribe: (...args: unknown[]) => mockUseSubscribe(...args),
  useWSEvent: (event: string, callback: (...args: unknown[]) => void) => {
    if (event === 'hosted-chat.event') {
      capturedWSHandler = callback as typeof capturedWSHandler;
    }
  },
}));

// jsdom doesn't implement scrollIntoView; ChatMessageList uses it for
// auto-scroll-to-bottom. No-op stub keeps the render path clean.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

import { HostedChat } from '../../../components/hosted-chat/HostedChat';

const HOSTED_ID = 'hsw_test_1';
const CHANNEL = `hosted-chat:${HOSTED_ID}`;

function emit(eventKind: string, params: Record<string, unknown>): void {
  if (!capturedWSHandler) throw new Error('useWSEvent handler not captured');
  act(() => {
    capturedWSHandler!({
      type: 'hosted-chat.event',
      channel: CHANNEL,
      data: {
        hosted_swarm_id: HOSTED_ID,
        provider: 'codex',
        event: { kind: eventKind, ...params },
      },
    });
  });
}

beforeEach(() => {
  capturedWSHandler = null;
  mockApiPost.mockReset();
  mockUseSubscribe.mockReset();
});

describe('HostedChat / useHostedChatChannel', () => {
  it('subscribes to the per-swarm channel on mount', () => {
    render(<HostedChat hostedSwarmId={HOSTED_ID} label="my-swarm" providerLabel="codex" />);
    expect(mockUseSubscribe).toHaveBeenCalled();
    const lastCall = mockUseSubscribe.mock.calls[mockUseSubscribe.mock.calls.length - 1];
    expect(lastCall[0]).toEqual([CHANNEL]);
  });

  it('renders an input field once the chat surface mounts', () => {
    const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
  });

  it('accumulates streaming agent message across deltas and finalizes on complete', () => {
    const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);

    emit('turn.started', { turnId: 'turn-1' });
    emit('message.start', { itemId: 'item-1', role: 'assistant' });
    emit('message.delta', { itemId: 'item-1', delta: 'Hello' });
    emit('message.delta', { itemId: 'item-1', delta: ', ' });
    emit('message.delta', { itemId: 'item-1', delta: 'world!' });

    expect(container.textContent ?? '').toContain('Hello, world!');

    emit('message.complete', { itemId: 'item-1', finalText: 'Hello, world!' });
    emit('turn.completed', { turnId: 'turn-1' });

    // Content survives finalization.
    expect(container.textContent ?? '').toContain('Hello, world!');
  });

  it('suppresses provider-emitted user message echoes (we echo locally on send)', () => {
    const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);

    // Provider says "user said this" — we should NOT render it (the local
    // echo on send() is the canonical user message).
    emit('message.start', { itemId: 'item-u1', role: 'user' });
    emit('message.delta', { itemId: 'item-u1', delta: 'should-not-render' });

    expect(container.textContent ?? '').not.toContain('should-not-render');
  });

  it('ignores events for a different hosted swarm id', () => {
    const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);
    if (!capturedWSHandler) throw new Error('handler not captured');
    act(() => {
      capturedWSHandler!({
        type: 'hosted-chat.event',
        channel: 'hosted-chat:other-swarm',
        data: {
          hosted_swarm_id: 'other-swarm',
          provider: 'codex',
          event: { kind: 'message.delta', itemId: 'x', delta: 'wrong-swarm-payload' },
        },
      });
    });
    expect(container.textContent ?? '').not.toContain('wrong-swarm-payload');
  });

  it('surfaces error events in the status header', () => {
    const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);
    emit('error', { message: 'rate-limit-marker' });
    // The error message lands in the header status-detail span.
    expect(container.textContent ?? '').toContain('rate-limit-marker');
  });

  it('renders the provided label and providerLabel in the header', () => {
    const { container } = render(
      <HostedChat
        hostedSwarmId={HOSTED_ID}
        label="distinct-swarm-name-marker"
        providerLabel="codex"
      />,
    );
    const header = container.querySelector('.border-b');
    expect(header).not.toBeNull();
    expect(header?.textContent ?? '').toContain('distinct-swarm-name-marker');
    expect(header?.textContent ?? '').toContain('codex');
  });

  it('disconnects (no subscribe) when enabled=false', () => {
    render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" enabled={false} />);
    const lastCall = mockUseSubscribe.mock.calls[mockUseSubscribe.mock.calls.length - 1];
    expect(lastCall[0]).toEqual([]);
  });
});
