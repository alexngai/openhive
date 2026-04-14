import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Conversation } from '../../pages/Conversation';

// ── Mock data ──

const mockConversation = {
  id: 'conv-test-1',
  scope: 'default',
  subject: 'Agent coordination',
  status: 'active' as const,
  participants: [
    { agent_id: 'agent-alpha', joined_at: '2025-01-01T00:00:00Z' },
    { agent_id: 'agent-beta', role: 'observer', joined_at: '2025-01-01T00:01:00Z' },
    { agent_id: 'human-1', role: 'supervisor', joined_at: '2025-01-01T00:02:00Z' },
  ],
  metadata: {},
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T01:00:00Z',
};

const mockTurns = [
  {
    id: 'turn-1',
    conversation_id: 'conv-test-1',
    participant_id: 'agent-alpha',
    content_type: 'text',
    content: { type: 'text', text: 'Starting analysis.' },
    created_at: '2025-01-01T00:10:00Z',
  },
];

const mockThreads = [
  {
    id: 'thread-1',
    conversation_id: 'conv-test-1',
    root_turn_id: 'turn-1',
    subject: 'Data quality',
    created_at: '2025-01-01T00:11:30Z',
  },
];

// ── Mock hooks ──

const mockUseMailConversation = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useMailConversation: (...args: unknown[]) => mockUseMailConversation(...args),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: vi.fn(),
  useWSEvent: vi.fn(),
}));

// Mock the chat channel wiring. Conversation was refactored from AgentChat to
// the channel-based contract (useChatChannel + openhive adapters). We capture
// the props passed into useChatChannel so tests can assert the wiring.
const mockUseChatChannel = vi.fn(() => ({
  messages: [],
  status: 'idle',
  mode: 'mail',
  sendText: vi.fn(),
  cancel: vi.fn(),
  pendingPermission: null,
  replyPermission: vi.fn(),
  pendingQuestion: null,
  replyQuestion: vi.fn(),
}));

vi.mock('swarmcraft/ui/embed', () => ({
  useChatChannel: (opts: unknown) => mockUseChatChannel(opts),
}));

vi.mock('../../lib/chat/resolvers', () => ({
  useConversationCapabilityResolver: vi.fn(() => () => undefined),
  conversationTarget: (id: string) => ({ kind: 'conversation', conversationId: id }),
}));

vi.mock('../../adapters/openhive-adapters', () => ({
  useOpenHiveAdapters: vi.fn(() => []),
}));

// The three channel-consumer components render no-op stubs in tests.
vi.mock('../../components/events/EventStream', () => ({
  EventStream: ({ channel }: { channel: unknown }) => (
    <div data-testid="event-stream" data-has-channel={channel ? 'true' : 'false'} />
  ),
}));

vi.mock('../../components/events/SessionChatInput', () => ({
  SessionChatInput: ({ channel }: { channel: unknown }) => (
    <div data-testid="session-chat-input" data-has-channel={channel ? 'true' : 'false'} />
  ),
}));

vi.mock('../../components/events/PermissionDialog', () => ({
  PermissionDialog: ({ channel }: { channel: unknown }) => (
    <div data-testid="permission-dialog" data-has-channel={channel ? 'true' : 'false'} />
  ),
}));

// ── Helpers ──

function renderConversation(id = 'conv-test-1') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/messages/${id}`]}>
        <Routes>
          <Route path="/messages/:id" element={<Conversation />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// ── Tests ──

describe('Conversation Page', () => {
  beforeEach(() => {
    mockUseMailConversation.mockReturnValue({
      data: {
        conversation: mockConversation,
        turns: mockTurns,
        threads: mockThreads,
        turn_count: mockTurns.length,
      },
      isLoading: false,
    });
  });

  // ── Header ──

  describe('Header', () => {
    it('renders conversation subject', () => {
      renderConversation();
      expect(screen.getByText('Agent coordination')).toBeDefined();
    });

    it('shows active status badge', () => {
      renderConversation();
      expect(screen.getByText('active')).toBeDefined();
    });

    it('shows turn count', () => {
      renderConversation();
      expect(screen.getByText(/1 turn/)).toBeDefined();
    });

    it('shows thread count', () => {
      renderConversation();
      expect(screen.getByText(/1 thread/)).toBeDefined();
    });

    it('shows back link to /messages', () => {
      renderConversation();
      const links = document.querySelectorAll('a[href="/messages"]');
      expect(links.length).toBeGreaterThan(0);
    });

    it('shows participant avatars', () => {
      renderConversation();
      expect(screen.getByTitle('agent-alpha')).toBeDefined();
      expect(screen.getByTitle('agent-beta (observer)')).toBeDefined();
      expect(screen.getByTitle('human-1 (supervisor)')).toBeDefined();
    });
  });

  // ── Chat channel integration ──

  describe('Chat channel integration', () => {
    it('wires useChatChannel with a conversation target matching the URL id', () => {
      renderConversation('conv-test-1');
      const opts = mockUseChatChannel.mock.calls.at(-1)?.[0] as
        | { target?: { kind: string; conversationId: string } }
        | undefined;
      expect(opts?.target).toEqual({ kind: 'conversation', conversationId: 'conv-test-1' });
    });

    it('passes the openhive adapter set + capability resolver into the channel', () => {
      renderConversation();
      const opts = mockUseChatChannel.mock.calls.at(-1)?.[0] as
        | { adapters?: unknown; resolveCapabilities?: unknown }
        | undefined;
      expect(opts?.adapters).toBeDefined();
      expect(typeof opts?.resolveCapabilities).toBe('function');
    });

    it('renders the channel-driven EventStream / PermissionDialog / SessionChatInput', () => {
      renderConversation();
      expect(screen.getByTestId('event-stream').getAttribute('data-has-channel')).toBe('true');
      expect(screen.getByTestId('permission-dialog').getAttribute('data-has-channel')).toBe('true');
      expect(screen.getByTestId('session-chat-input').getAttribute('data-has-channel')).toBe('true');
    });
  });

  // ── Loading state ──

  describe('Loading state', () => {
    it('shows loading state when data is loading', () => {
      mockUseMailConversation.mockReturnValue({
        data: undefined,
        isLoading: true,
      });
      renderConversation();
      expect(screen.queryByText('Agent coordination')).toBeNull();
    });
  });

  // ── Not found ──

  describe('Not found', () => {
    it('shows not found message for missing conversation', () => {
      mockUseMailConversation.mockReturnValue({
        data: undefined,
        isLoading: false,
      });
      renderConversation();
      expect(screen.getByText('Conversation not found.')).toBeDefined();
    });
  });

  // ── WebSocket integration ──

  describe('WebSocket integration', () => {
    it('subscribes to conversation-specific channel', async () => {
      const { useSubscribe } = await import('../../hooks/useWebSocket');
      renderConversation();
      expect(useSubscribe).toHaveBeenCalledWith(['mail:conversation:conv-test-1']);
    });

    it('registers event handlers for live updates', async () => {
      const { useWSEvent } = await import('../../hooks/useWebSocket');
      renderConversation();
      const eventTypes = (useWSEvent as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0]
      );
      expect(eventTypes).toContain('mail.turn.added');
      expect(eventTypes).toContain('mail.participant.joined');
      expect(eventTypes).toContain('mail.closed');
    });
  });
});
