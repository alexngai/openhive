/**
 * Conversation context-type live loader — reads `['mail-conversation', id]`
 * and projects the conversation + recent turns.
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import '../../components/chat-fab/context-types';
import { getContextType } from '../../components/chat-fab/context-registry';
import type { ConversationData } from '../../components/chat-fab/context-types/conversation';

function freshQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

const snapshot: ConversationData = {
  id: 'conv-1',
  subject: 'stale subject',
  status: 'active',
};

describe('conversation context-type live loader', () => {
  it('reads the cache and projects last N turns from the turn list', async () => {
    const spec = getContextType('conversation')!;
    const qc = freshQc();
    qc.setQueryData(['mail-conversation', 'conv-1'], {
      conversation: {
        id: 'conv-1',
        subject: 'fresh subject',
        status: 'active',
        scope: 'agents',
        participants: [{}, {}, {}],
      },
      turns: [
        { participant_id: 'a', content: { text: 'first' }, created_at: 't1' },
        { participant_id: 'b', content: { text: 'second' }, created_at: 't2' },
        { participant_id: 'a', content: { text: 'third' }, created_at: 't3' },
        { participant_id: 'c', content: { text: 'fourth' }, created_at: 't4' },
      ],
      turn_count: 4,
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as ConversationData | null;

    expect(result).not.toBeNull();
    expect(result?.subject).toBe('fresh subject');
    expect(result?.participant_count).toBe(3);
    expect(result?.turn_count).toBe(4);
    // Keep last 3 per MAX_TURNS.
    expect(result?.recent_turns?.length).toBe(3);
    expect(result?.recent_turns?.[0]?.content_text).toBe('second');
    expect(result?.recent_turns?.[2]?.content_text).toBe('fourth');
  });

  it('falls back to fetchQuery({signal}) on cache miss', async () => {
    const spec = getContextType('conversation')!;
    const qc = freshQc();
    const fetchSpy = vi.spyOn(qc, 'fetchQuery').mockResolvedValueOnce({
      conversation: { id: 'conv-1', subject: 'fetched', status: 'active' },
      turns: [],
      turn_count: 0,
    });

    const controller = new AbortController();
    const result = (await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    })) as ConversationData | null;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArg = fetchSpy.mock.calls[0]![0]!;
    expect(callArg.queryKey).toEqual(['mail-conversation', 'conv-1']);
    expect(callArg.signal).toBe(controller.signal);
    expect(result?.subject).toBe('fetched');
  });

  it('returns null when the cached record has no conversation.id (tombstone)', async () => {
    const spec = getContextType('conversation')!;
    const qc = freshQc();
    qc.setQueryData(['mail-conversation', 'conv-1'], { conversation: {} });

    const controller = new AbortController();
    const result = await spec.live!(snapshot, {
      queryClient: qc,
      signal: controller.signal,
    });

    expect(result).toBeNull();
  });
});
