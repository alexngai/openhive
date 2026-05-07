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
let capturedHandlers: HostedChatSubscriptionHandlers | null = null;
let lastSubscribedId: string | null = null;

const testService: HostedChatServiceLike = {
  sendTurn: (...args) => sendTurn(...args),
  subscribe: (id, handlers) => {
    lastSubscribedId = id;
    capturedHandlers = handlers;
    return () => {
      capturedHandlers = null;
      lastSubscribedId = null;
    };
  },
};

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

async function awaitHandlers(): Promise<HostedChatSubscriptionHandlers> {
  await waitFor(() => {
    if (!capturedHandlers) throw new Error('subscribe handlers not captured');
  });
  return capturedHandlers!;
}
async function emitMessage(itemId: string, role: 'assistant' | 'user' | 'system'): Promise<void> {
  const h = await awaitHandlers();
  await act(async () => { h.onMessageStart(itemId, role); });
}
async function emitDelta(itemId: string, delta: string): Promise<void> {
  const h = await awaitHandlers();
  await act(async () => { h.onMessageDelta(itemId, delta); });
}
async function emitComplete(itemId: string, finalText?: string): Promise<void> {
  const h = await awaitHandlers();
  await act(async () => { h.onMessageComplete(itemId, finalText); });
}
async function emitError(message: string): Promise<void> {
  const h = await awaitHandlers();
  await act(async () => { h.onError(message); });
}

beforeEach(() => {
  capturedHandlers = null;
  lastSubscribedId = null;
  sendTurn.mockClear();
});

describe('HostedChat (unified channel)', () => {
  it('subscribes to the hosted swarm via the host service on mount', async () => {
    render(<HostedChat hostedSwarmId={HOSTED_ID} label="my-swarm" providerLabel="codex" />);
    await waitFor(() => expect(lastSubscribedId).toBe(HOSTED_ID));
    expect(capturedHandlers).not.toBeNull();
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
    expect(capturedHandlers).toBeNull();
  });
});
