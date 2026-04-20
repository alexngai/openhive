import { describe, it, expect } from 'vitest';
import type { ChatMessage } from 'swarmcraft/ui/embed';
import type { Agent } from '../../../lib/api';
import {
  enrichUserTurns,
  extractUserSenderIds,
} from '../../../lib/chat/enrich-user-turns';

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    sender: 'agent-a',
    content: 'hi',
    contentType: 'text',
    timestamp: 0,
    ...over,
  };
}

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-a',
    name: 'Alice',
    description: null,
    avatar_url: null,
    is_verified: false,
    account_type: 'human',
    created_at: '',
    ...over,
  };
}

describe('enrich-user-turns', () => {
  describe('extractUserSenderIds', () => {
    it('returns distinct non-sentinel user senders only', () => {
      const msgs: ChatMessage[] = [
        message({ sender: 'agent-a' }),
        message({ sender: 'agent-b' }),
        message({ sender: 'agent-a' }),           // duplicate
        message({ sender: 'user' }),              // sentinel — drop
        message({ sender: 'local-user-12345' }),  // optimistic — drop
        message({ role: 'agent', sender: 'claude' }), // not user role — drop
      ];
      expect(extractUserSenderIds(msgs)).toEqual(['agent-a', 'agent-b']);
    });

    it('returns empty for all-sentinel inputs', () => {
      const msgs: ChatMessage[] = [
        message({ sender: 'user' }),
        message({ sender: 'local-user-1' }),
      ];
      expect(extractUserSenderIds(msgs)).toEqual([]);
    });
  });

  describe('enrichUserTurns', () => {
    it('decorates user turn with name + avatar from lookup', () => {
      const lookup = { 'agent-a': agent({ avatar_url: 'https://cdn/a.png' }) };
      const [m] = enrichUserTurns([message()], lookup);
      expect(m.senderName).toBe('Alice');
      expect(m.agentIdentity?.name).toBe('Alice');
      expect(m.agentIdentity?.avatar).toBe('https://cdn/a.png');
      // No tint when avatar URL is present — ChatBubble's img path wins.
      expect(m.agentIdentity?.color).toBeUndefined();
    });

    it('applies honey tint when sender has no avatar_url', () => {
      const lookup = { 'agent-a': agent() };
      const [m] = enrichUserTurns([message()], lookup);
      expect(m.agentIdentity?.color).toBe('#f59e0b');
      expect(m.agentIdentity?.avatar).toBeUndefined();
    });

    it('falls back to "user" when sender is a generic sentinel', () => {
      const [m] = enrichUserTurns([message({ sender: 'user' })], {});
      expect(m.senderName).toBe('user');
      expect(m.agentIdentity?.name).toBe('user');
      expect(m.agentIdentity?.color).toBe('#f59e0b');
    });

    it('falls back to "user" when sender is an optimistic local-user-* id', () => {
      const [m] = enrichUserTurns(
        [message({ sender: 'local-user-1234567890' })],
        { 'local-user-1234567890': agent() }, // ignored — sentinel filter applies first
      );
      expect(m.senderName).toBe('user');
    });

    it('falls back to "user" when sender id is not in the lookup', () => {
      const [m] = enrichUserTurns(
        [message({ sender: 'agent-unknown' })],
        { 'agent-a': agent() },
      );
      expect(m.senderName).toBe('user');
      expect(m.agentIdentity?.color).toBe('#f59e0b');
    });

    it('normalizes supervisor role to user so icon stays consistent across surfaces', () => {
      // Mail adapter stamps supervisor → Shield icon; trajectory stamps
      // user → User icon. Enrichment forces 'user' so the same person has
      // the same icon regardless of which surface rendered the turn.
      const [m] = enrichUserTurns(
        [message({ role: 'supervisor', sender: 'agent-a' })],
        { 'agent-a': agent() },
      );
      expect(m.role).toBe('user');
    });

    it('normalizes role even when the sender does not resolve to an Agent', () => {
      const [m] = enrichUserTurns(
        [message({ role: 'supervisor', sender: 'agent-unknown' })],
        {},
      );
      expect(m.role).toBe('user');
    });

    it('leaves agent/assistant messages untouched', () => {
      const msgs: ChatMessage[] = [
        message({ role: 'assistant', sender: 'claude', senderName: 'Claude' }),
      ];
      const [m] = enrichUserTurns(msgs, { claude: agent({ name: 'Override' }) });
      expect(m.senderName).toBe('Claude');
      expect(m.role).toBe('assistant');
    });

    it('preserves an already-set explicit senderName that is not "You"', () => {
      const [m] = enrichUserTurns(
        [message({ senderName: 'Alias' })],
        { 'agent-a': agent() },
      );
      // When an upstream layer set a real name, don't clobber it.
      expect(m.senderName).toBe('Alias');
      // But the avatar/tint still get applied.
      expect(m.agentIdentity?.color).toBe('#f59e0b');
    });

    it('overrides the hardcoded mail-adapter "You" with the resolved name', () => {
      const [m] = enrichUserTurns(
        [message({ senderName: 'You' })],
        { 'agent-a': agent() },
      );
      // Viewer independence: "You" gets replaced with the real name so a
      // different viewer sees the same thing.
      expect(m.senderName).toBe('Alice');
    });

    it('returns the original array reference when input is empty', () => {
      const input: ChatMessage[] = [];
      expect(enrichUserTurns(input, {})).toBe(input);
    });
  });
});
