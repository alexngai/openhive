/**
 * Tests for SessionChatAdapter — the mail-based chat adapter for sessions.
 *
 * Tests the full adapter lifecycle: isAvailable, connect, send, getMessages.
 * Uses mocked fetch to simulate the backend API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionChatAdapter } from '../../adapters/session-chat-adapter';

// ── Fetch mocking ──────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchResponse(data: unknown, ok = true, status = 200) {
  fetchMock.mockResolvedValueOnce({
    json: () => Promise.resolve(data),
    ok,
    status,
  });
}

function mockFetchError(message: string) {
  fetchMock.mockRejectedValueOnce(new Error(message));
}

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('test-token');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SessionChatAdapter', () => {
  const SESSION_ID = 'res_test123';

  describe('factory', () => {
    it('creates adapter with mail mode', () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });
      expect(adapter.mode).toBe('mail');
    });

    it('has default poll interval of 5000ms', () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });
      expect(adapter.pollIntervalMs).toBe(5000);
    });

    it('accepts custom poll interval', () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID, pollIntervalMs: 2000 });
      expect(adapter.pollIntervalMs).toBe(2000);
    });
  });

  describe('isAvailable', () => {
    it('always returns true (lazy conversation creation)', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });
      const result = await adapter.isAvailable('agent-1');
      expect(result).toBe(true);
      // Should NOT call fetch — availability doesn't depend on server state
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('connect', () => {
    it('fetches linked conversation ID from GET /sessions/:id/chat', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });

      // First call: GET /sessions/:id/chat → returns conversation_id
      mockFetchResponse({ conversation_id: 'conv-abc' });
      // Second call: GET /mail/conversations/:id/turns → returns turns
      mockFetchResponse({ turns: [
        { id: 't1', conversation_id: 'conv-abc', participant_id: 'agent-1', content_type: 'text', content: { type: 'text', text: 'Hello' }, created_at: '2025-01-01T00:00:00Z' },
      ]});

      const messages = await adapter.connect('agent-1');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain(`/sessions/${SESSION_ID}/chat`);
      expect(fetchMock.mock.calls[1][0]).toContain('/mail/conversations/conv-abc/turns');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello');
    });

    it('returns empty array when no conversation linked', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });
      mockFetchResponse({ conversation_id: null });

      const messages = await adapter.connect('agent-1');
      expect(messages).toEqual([]);
    });

    it('returns empty array on fetch error', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });
      mockFetchError('Network error');

      const messages = await adapter.connect('agent-1');
      expect(messages).toEqual([]);
    });

    it('includes auth header', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });
      mockFetchResponse({ conversation_id: null });

      await adapter.connect('agent-1');

      const headers = fetchMock.mock.calls[0][1]?.headers;
      expect(headers).toHaveProperty('Authorization', 'Bearer test-token');
    });
  });

  describe('send', () => {
    it('POSTs to /sessions/:id/chat and caches conversation_id', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });

      mockFetchResponse({ ok: true, conversation_id: 'conv-new' });

      await adapter.send('agent-1', 'Hello agent!');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain(`/sessions/${SESSION_ID}/chat`);
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ content: 'Hello agent!' });
    });

    it('caches conversation_id for subsequent getMessages calls', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });

      // send → creates conversation
      mockFetchResponse({ ok: true, conversation_id: 'conv-cached' });
      await adapter.send('agent-1', 'First message');

      // getMessages → uses cached conversation_id
      mockFetchResponse({ turns: [] });
      await adapter.getMessages('agent-1');

      // Should query the cached conversation
      expect(fetchMock.mock.calls[1][0]).toContain('/mail/conversations/conv-cached/turns');
    });

    it('throws on fetch failure', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ error: 'Server error' }) });

      await expect(adapter.send('agent-1', 'Hello')).rejects.toThrow();
    });
  });

  describe('getMessages', () => {
    it('returns empty array when no conversation cached', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });

      // getMessages tries to resolve conversation from API
      mockFetchResponse({ conversation_id: null });

      const messages = await adapter.getMessages('agent-1');
      expect(messages).toEqual([]);
    });

    it('resolves conversation from API if not cached', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });

      // First call: resolve conversation from GET /sessions/:id/chat
      mockFetchResponse({ conversation_id: 'conv-resolved' });
      // Second call: GET /mail/conversations/:id/turns
      mockFetchResponse({ turns: [
        { id: 't1', conversation_id: 'conv-resolved', participant_id: 'agent-1', content_type: 'text', content: { type: 'text', text: 'Reply' }, created_at: '2025-01-01T00:00:00Z' },
      ]});

      const messages = await adapter.getMessages('agent-1');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Reply');
    });

    it('returns empty array on API error', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });
      mockFetchError('Network down');

      const messages = await adapter.getMessages('agent-1');
      expect(messages).toEqual([]);
    });
  });

  describe('mailTurnToChat conversion', () => {
    it('converts text turns to ChatMessages', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });

      mockFetchResponse({ conversation_id: 'conv-1' });
      mockFetchResponse({ turns: [{
        id: 't1',
        conversation_id: 'conv-1',
        participant_id: 'agent-1',
        content_type: 'text',
        content: { type: 'text', text: 'Hello world' },
        created_at: '2025-01-01T12:00:00Z',
      }]});

      const messages = await adapter.connect('agent-1');
      expect(messages[0]).toMatchObject({
        id: 't1',
        role: 'agent',
        content: 'Hello world',
        contentType: 'text',
      });
    });

    it('marks supervisor turns correctly', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });

      mockFetchResponse({ conversation_id: 'conv-1' });
      mockFetchResponse({ turns: [{
        id: 't1',
        conversation_id: 'conv-1',
        participant_id: 'user-1',
        content_type: 'supervisor',
        content: { type: 'text', text: 'User message' },
        created_at: '2025-01-01T12:00:00Z',
      }]});

      const messages = await adapter.connect('agent-1');
      expect(messages[0].role).toBe('supervisor');
      expect(messages[0].senderName).toBe('You');
    });

    it('handles string content (fallback)', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });

      mockFetchResponse({ conversation_id: 'conv-1' });
      mockFetchResponse({ turns: [{
        id: 't1',
        conversation_id: 'conv-1',
        participant_id: 'agent-1',
        content_type: 'text',
        content: 'plain string',
        created_at: '2025-01-01T12:00:00Z',
      }]});

      const messages = await adapter.connect('agent-1');
      expect(messages[0].content).toBe('plain string');
    });

    it('handles JSON content (fallback)', async () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });

      mockFetchResponse({ conversation_id: 'conv-1' });
      mockFetchResponse({ turns: [{
        id: 't1',
        conversation_id: 'conv-1',
        participant_id: 'agent-1',
        content_type: 'data',
        content: { custom: 'data' },
        created_at: '2025-01-01T12:00:00Z',
      }]});

      const messages = await adapter.connect('agent-1');
      expect(messages[0].content).toBe('{"custom":"data"}');
    });
  });

  describe('disconnect', () => {
    it('is a no-op', () => {
      const adapter = createSessionChatAdapter({ sessionId: SESSION_ID });
      // Should not throw
      adapter.disconnect?.('agent-1');
    });
  });
});
