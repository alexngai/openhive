import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Messages } from '../../pages/Messages';

// ── Mock data ──

const mockConversations = [
  {
    id: 'conv-1',
    scope: 'default',
    subject: 'Debug session with agent-alpha',
    status: 'active' as const,
    participants: [
      { agent_id: 'agent-alpha', joined_at: '2025-01-01T00:00:00Z' },
      { agent_id: 'agent-beta', role: 'observer', joined_at: '2025-01-01T00:01:00Z' },
    ],
    metadata: {},
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T01:00:00Z',
  },
  {
    id: 'conv-2',
    scope: 'default',
    subject: 'Task planning',
    status: 'completed' as const,
    participants: [
      { agent_id: 'agent-gamma', joined_at: '2025-01-02T00:00:00Z' },
    ],
    metadata: {},
    created_at: '2025-01-02T00:00:00Z',
    updated_at: '2025-01-02T02:00:00Z',
  },
  {
    id: 'conv-3',
    scope: 'default',
    status: 'active' as const,
    participants: [],
    metadata: {},
    created_at: '2025-01-03T00:00:00Z',
    updated_at: '2025-01-03T00:00:00Z',
  },
];

// ── Mock hooks ──

const mockUseMailConversations = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useMailConversations: (...args: unknown[]) => mockUseMailConversations(...args),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: vi.fn(),
  useWSEvent: vi.fn(),
}));

// ── Helpers ──

function renderMessages() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Messages />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// ── Tests ──

describe('Messages Page', () => {
  beforeEach(() => {
    mockUseMailConversations.mockReturnValue({
      data: mockConversations,
      isLoading: false,
    });
  });

  // ── Header ──

  describe('Header', () => {
    it('renders the Messages heading', () => {
      renderMessages();
      expect(screen.getByRole('heading', { name: 'Messages' })).toBeDefined();
    });

    it('shows conversation count in description', () => {
      renderMessages();
      expect(screen.getByText(/3 conversations/)).toBeDefined();
    });

    it('shows singular "conversation" for count of 1', () => {
      mockUseMailConversations.mockReturnValue({
        data: [mockConversations[0]],
        isLoading: false,
      });
      renderMessages();
      expect(screen.getByText(/1 conversation\./)).toBeDefined();
    });
  });

  // ── Loading state ──

  describe('Loading state', () => {
    it('shows loading spinner when loading', () => {
      mockUseMailConversations.mockReturnValue({
        data: undefined,
        isLoading: true,
      });
      renderMessages();
      // PageLoader renders a spinner
      expect(screen.queryByRole('heading', { name: 'Messages' })).toBeNull();
    });
  });

  // ── Empty state ──

  describe('Empty state', () => {
    it('shows empty state when no conversations', () => {
      mockUseMailConversations.mockReturnValue({
        data: [],
        isLoading: false,
      });
      renderMessages();
      expect(screen.getByText('No conversations yet')).toBeDefined();
      expect(screen.getByText(/Agent mail conversations will appear here/)).toBeDefined();
    });
  });

  // ── Conversation cards ──

  describe('Conversation cards', () => {
    it('renders all conversation cards', () => {
      renderMessages();
      expect(screen.getByText('Debug session with agent-alpha')).toBeDefined();
      expect(screen.getByText('Task planning')).toBeDefined();
      expect(screen.getByText('Untitled conversation')).toBeDefined();
    });

    it('shows participant names', () => {
      renderMessages();
      expect(screen.getByText('agent-alpha, agent-beta')).toBeDefined();
    });

    it('shows participant count', () => {
      renderMessages();
      // Conv-1 has 2 participants
      const cards = screen.getAllByTitle('Participants');
      expect(cards.length).toBeGreaterThan(0);
    });

    it('shows status badges', () => {
      renderMessages();
      const activeBadges = screen.getAllByText('active');
      expect(activeBadges.length).toBe(2); // conv-1 and conv-3
      expect(screen.getByText('completed')).toBeDefined();
    });

    it('renders conversation links', () => {
      renderMessages();
      const link = screen.getByText('Debug session with agent-alpha').closest('a');
      expect(link?.getAttribute('href')).toBe('/messages/conv-1');
    });

    it('shows "Untitled conversation" for conversations without subject', () => {
      renderMessages();
      expect(screen.getByText('Untitled conversation')).toBeDefined();
    });
  });

  // ── Filters ──

  describe('Status filters', () => {
    it('renders all filter buttons', () => {
      renderMessages();
      expect(screen.getByText('All')).toBeDefined();
      expect(screen.getByText('Active')).toBeDefined();
      expect(screen.getByText('Completed')).toBeDefined();
      expect(screen.getByText('Archived')).toBeDefined();
    });

    it('calls hook with status filter when clicking a filter', () => {
      renderMessages();
      fireEvent.click(screen.getByText('Active'));
      expect(mockUseMailConversations).toHaveBeenCalledWith({ status: 'active' });
    });

    it('clears filter when clicking All', () => {
      renderMessages();
      // Click Active first
      fireEvent.click(screen.getByText('Active'));
      // Then click All
      fireEvent.click(screen.getByText('All'));
      expect(mockUseMailConversations).toHaveBeenCalledWith({ status: undefined });
    });
  });

  // ── WebSocket integration ──

  describe('WebSocket integration', () => {
    it('subscribes to mail:conversations channel', async () => {
      const { useSubscribe } = await import('../../hooks/useWebSocket');
      renderMessages();
      expect(useSubscribe).toHaveBeenCalledWith(['mail:conversations']);
    });

    it('registers event handlers for live updates', async () => {
      const { useWSEvent } = await import('../../hooks/useWebSocket');
      renderMessages();
      const eventTypes = (useWSEvent as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0]
      );
      expect(eventTypes).toContain('mail.created');
      expect(eventTypes).toContain('mail.turn.added');
      expect(eventTypes).toContain('mail.closed');
    });
  });
});
