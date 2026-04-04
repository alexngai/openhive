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

// Mock AgentChat — the chat UI itself is tested in swarmcraft (101 tests).
// Here we only verify that Conversation.tsx renders the header correctly
// and passes the right props.
vi.mock('swarmcraft/ui/embed', () => ({
  AgentChat: ({ agentId, showHeader }: { agentId: string | null; showHeader?: boolean }) => (
    <div data-testid="agent-chat" data-agent-id={agentId} data-show-header={showHeader}>
      AgentChat mock
    </div>
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

  // ── AgentChat integration ──

  describe('AgentChat integration', () => {
    it('renders AgentChat with the first participant as agentId', () => {
      renderConversation();
      const chat = screen.getByTestId('agent-chat');
      expect(chat.getAttribute('data-agent-id')).toBe('agent-alpha');
    });

    it('passes showHeader=false to AgentChat (header is rendered by Conversation)', () => {
      renderConversation();
      const chat = screen.getByTestId('agent-chat');
      expect(chat.getAttribute('data-show-header')).toBe('false');
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
