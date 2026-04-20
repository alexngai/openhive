/**
 * useEnrichedUserTurns — wrap a ChatMessage array with identity decoration
 * for user/supervisor turns, resolved against openhive's Agent registry.
 *
 * Usage: at each chat-consuming surface, feed the raw messages through
 * this hook before passing them to `ChatMessageList`.
 *
 *     const messages = useEnrichedUserTurns(channel.messages);
 *     <ChatMessageList channel={channel} messages={messages} />
 *
 * The hook extracts distinct user-turn sender ids, fetches their Agent
 * profiles in one batched request, then runs the pure `enrichUserTurns`
 * helper. Returns the original array when there's nothing to decorate so
 * downstream memoization doesn't invalidate.
 */

import { useMemo } from 'react';
import type { ChatMessage } from 'swarmcraft/ui/embed';
import { useAgentLookup } from './useApi';
import { enrichUserTurns, extractUserSenderIds } from '../lib/chat/enrich-user-turns';

export function useEnrichedUserTurns(messages: ChatMessage[]): ChatMessage[] {
  const senderIds = useMemo(() => extractUserSenderIds(messages), [messages]);
  const { data: lookup } = useAgentLookup(senderIds);
  return useMemo(
    () => enrichUserTurns(messages, lookup ?? {}),
    [messages, lookup],
  );
}
