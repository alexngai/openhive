/**
 * HostedChat — component coverage.
 *
 * Validates the React side of the codex-rpc → openhive-chat path now that
 * HostedChat is driven by swarmcraft's `useChatChannel` + the
 * `createHostedChatAdapter` factory backed by openhive's host service.
 *
 * Strategy: mock `useOpenHiveAdapters` to return a single hosted-chat
 * adapter wired against a controllable test service that captures the
 * subscription handlers, then drive synthetic events through those
 * handlers. The capability resolver is mocked to grant `hostedChat.canSend`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import {
  createHostedChatAdapter,
  type HostedChatServiceLike,
  type HostedChatSubscriptionHandlers,
} from 'swarmcraft/ui/embed';

const sendTurn = vi.fn().mockResolvedValue({ turnId: 't-1' });
// The component now opens TWO subscriptions on the service: the adapter's
// (message/turn events → channel) and its own (turn-id tracking for the
// stop control). Capture all handler sets and fan emits out to every one,
// mirroring the real ref-counted service behavior.
const handlerSets = new Set<HostedChatSubscriptionHandlers>();
let lastSubscribedId: string | null = null;

const testService: HostedChatServiceLike = {
  sendTurn: (...args) => sendTurn(...args),
  subscribe: (id, handlers) => {
    lastSubscribedId = id;
    handlerSets.add(handlers);
    return () => {
      handlerSets.delete(handlers);
      if (handlerSets.size === 0) lastSubscribedId = null;
    };
  },
};

const mockInterruptHostedTurn = vi.fn(async () => {});
vi.mock('../../../services/hosted-chat-service', () => ({
  get hostedChatService() { return testService; },
  interruptHostedTurn: (...args: unknown[]) => mockInterruptHostedTurn(...args),
}));

vi.mock('../../../adapters/openhive-adapters', () => ({
  useOpenHiveAdapters: () => [createHostedChatAdapter({ service: testService })],
}));

vi.mock('../../../lib/chat/resolvers', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    useHostedChatCapabilityResolver: () => () => ({
      available: true,
      connected: true,
      hostedChat: { canSend: true },
    }),
  };
});

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

import { HostedChat } from '../../../components/hosted-chat/HostedChat';

const HOSTED_ID = 'hsw_test_1';

async function awaitHandlers(): Promise<void> {
  await waitFor(() => {
    if (handlerSets.size === 0) throw new Error('subscribe handlers not captured');
  });
}
async function emitMessage(itemId: string, role: 'assistant' | 'user' | 'system'): Promise<void> {
  await awaitHandlers();
  await act(async () => { for (const h of handlerSets) h.onMessageStart(itemId, role); });
}
async function emitDelta(itemId: string, delta: string): Promise<void> {
  await awaitHandlers();
  await act(async () => { for (const h of handlerSets) h.onMessageDelta(itemId, delta); });
}
async function emitComplete(itemId: string, finalText?: string): Promise<void> {
  await awaitHandlers();
  await act(async () => { for (const h of handlerSets) h.onMessageComplete(itemId, finalText); });
}
async function emitError(message: string): Promise<void> {
  await awaitHandlers();
  await act(async () => { for (const h of handlerSets) h.onError(message); });
}
async function emitTurnStarted(turnId: string): Promise<void> {
  await awaitHandlers();
  await act(async () => { for (const h of handlerSets) h.onTurnStarted(turnId); });
}
async function emitTurnCompleted(turnId: string): Promise<void> {
  await awaitHandlers();
  await act(async () => { for (const h of handlerSets) h.onTurnCompleted(turnId); });
}

beforeEach(() => {
  handlerSets.clear();
  lastSubscribedId = null;
  sendTurn.mockClear();
  mockInterruptHostedTurn.mockClear();
});

describe('HostedChat (unified channel)', () => {
  it('subscribes to the hosted swarm via the host service on mount', async () => {
    render(<HostedChat hostedSwarmId={HOSTED_ID} label="my-swarm" providerLabel="codex" />);
    await waitFor(() => expect(lastSubscribedId).toBe(HOSTED_ID));
    expect(handlerSets.size).toBeGreaterThan(0);
  });

  it('renders an input field once the chat surface mounts', () => {
    const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
  });

  it('accumulates streaming agent message across deltas and finalizes on complete', async () => {
    const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);

    await emitMessage('item-1', 'assistant');
    await emitDelta('item-1', 'Hello');
    await emitDelta('item-1', ', ');
    await emitDelta('item-1', 'world!');

    await waitFor(() => expect(container.textContent ?? '').toContain('Hello, world!'));

    await emitComplete('item-1', 'Hello, world!');
    expect(container.textContent ?? '').toContain('Hello, world!');
  });

  it('suppresses provider-emitted user message echoes', async () => {
    const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);
    await emitMessage('item-u1', 'user');
    await emitDelta('item-u1', 'should-not-render');
    expect(container.textContent ?? '').not.toContain('should-not-render');
  });

  it('surfaces error events in the channel status', async () => {
    const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);
    await emitError('rate-limit-marker');
    await waitFor(() => expect(container.textContent ?? '').toContain('rate-limit-marker'));
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

  it('does not subscribe when enabled=false', async () => {
    render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" enabled={false} />);
    // Give effects a chance to settle without subscribing.
    await new Promise((r) => setTimeout(r, 50));
    expect(lastSubscribedId).toBeNull();
    expect(handlerSets.size).toBe(0);
  });

  describe('stop control', () => {
    it('appears on turn.started and interrupts the active turn', async () => {
      const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);

      // No stop strip before a turn starts.
      expect(container.textContent ?? '').not.toContain('Stop');

      await emitTurnStarted('turn-42');
      await waitFor(() => expect(container.textContent ?? '').toContain('Stop'));

      const stopButton = Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('Stop'))!;
      await act(async () => { stopButton.click(); });

      await waitFor(() => {
        expect(mockInterruptHostedTurn).toHaveBeenCalledWith(HOSTED_ID, 'turn-42');
      });
    });

    it('disappears on turn.completed', async () => {
      const { container } = render(<HostedChat hostedSwarmId={HOSTED_ID} label="t" />);

      await emitTurnStarted('turn-43');
      await waitFor(() => expect(container.textContent ?? '').toContain('Stop'));

      await emitTurnCompleted('turn-43');
      await waitFor(() => expect(container.textContent ?? '').not.toContain('Stop'));
      expect(mockInterruptHostedTurn).not.toHaveBeenCalled();
    });
  });
});
