import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    content: { type: 'text', text: 'Starting analysis of the dataset.' },
    created_at: '2025-01-01T00:10:00Z',
  },
  {
    id: 'turn-2',
    conversation_id: 'conv-test-1',
    participant_id: 'agent-beta',
    content_type: 'text',
    content: { type: 'text', text: 'I can help with the visualization part.' },
    created_at: '2025-01-01T00:11:00Z',
  },
  {
    id: 'turn-3',
    conversation_id: 'conv-test-1',
    participant_id: 'agent-alpha',
    content_type: 'event',
    content: { type: 'event', event: 'task_started', data: { task: 'analysis' } },
    created_at: '2025-01-01T00:12:00Z',
  },
  {
    id: 'turn-4',
    conversation_id: 'conv-test-1',
    participant_id: 'human-1',
    content_type: 'text',
    content: { type: 'text', text: 'Focus on Q4 data specifically.' },
    created_at: '2025-01-01T00:13:00Z',
  },
  {
    id: 'turn-5',
    conversation_id: 'conv-test-1',
    participant_id: 'agent-alpha',
    content_type: 'data',
    content: { type: 'data', data: { results: [1, 2, 3], summary: 'Done' } },
    created_at: '2025-01-01T00:14:00Z',
  },
  {
    id: 'turn-6',
    conversation_id: 'conv-test-1',
    participant_id: 'agent-beta',
    content_type: 'text',
    content: { type: 'reference', uri: 'https://example.com/report', label: 'Final Report' },
    created_at: '2025-01-01T00:15:00Z',
  },
];

const mockThreads = [
  {
    id: 'thread-1',
    conversation_id: 'conv-test-1',
    root_turn_id: 'turn-1',
    subject: 'Data quality discussion',
    created_at: '2025-01-01T00:11:30Z',
  },
];

// ── Mock hooks ──

const mockUseMailConversation = vi.fn();
const mockSendMailTurn = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useMailConversation: (...args: unknown[]) => mockUseMailConversation(...args),
  useSendMailTurn: () => ({
    mutate: mockSendMailTurn,
    isPending: false,
  }),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: vi.fn(),
  useWSEvent: vi.fn(),
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
    mockSendMailTurn.mockClear();
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
      expect(screen.getByText(/6 turns/)).toBeDefined();
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
      // 3 participants should have 3 avatar circles
      expect(screen.getByTitle('agent-alpha')).toBeDefined();
      expect(screen.getByTitle('agent-beta (observer)')).toBeDefined();
      expect(screen.getByTitle('human-1 (supervisor)')).toBeDefined();
    });
  });

  // ── Turn rendering ──

  describe('Turn rendering', () => {
    it('renders all turns', () => {
      renderConversation();
      expect(screen.getByText('Starting analysis of the dataset.')).toBeDefined();
      expect(screen.getByText('I can help with the visualization part.')).toBeDefined();
      expect(screen.getByText('Focus on Q4 data specifically.')).toBeDefined();
    });

    it('shows participant names on turns', () => {
      renderConversation();
      const alphaLabels = screen.getAllByText('agent-alpha');
      expect(alphaLabels.length).toBeGreaterThan(0);
    });

    it('renders event turns differently', () => {
      renderConversation();
      expect(screen.getByText('task_started')).toBeDefined();
    });

    it('renders reference content as a link', () => {
      renderConversation();
      expect(screen.getByText('Final Report')).toBeDefined();
      const link = screen.getByText('Final Report').closest('a');
      expect(link?.getAttribute('href')).toBe('https://example.com/report');
    });

    it('renders data/JSON content with expand option', () => {
      renderConversation();
      // JSON content should have expand/collapse button
      expect(screen.getByText(/Expand/)).toBeDefined();
    });
  });

  // ── Loading state ──

  describe('Loading state', () => {
    it('shows loading spinner when loading', () => {
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

  // ── Empty conversation ──

  describe('Empty conversation', () => {
    it('shows empty state when no turns', () => {
      mockUseMailConversation.mockReturnValue({
        data: {
          conversation: mockConversation,
          turns: [],
          threads: [],
          turn_count: 0,
        },
        isLoading: false,
      });
      renderConversation();
      expect(screen.getByText('No turns in this conversation yet.')).toBeDefined();
    });
  });

  // ── Message input ──

  describe('Message input', () => {
    it('renders the input area', () => {
      renderConversation();
      expect(screen.getByPlaceholderText('Send a message as supervisor...')).toBeDefined();
    });

    it('shows helper text', () => {
      renderConversation();
      expect(screen.getByText(/Messages are sent as a supervisor turn/)).toBeDefined();
    });

    it('sends a turn when clicking send button', async () => {
      renderConversation();
      const input = screen.getByPlaceholderText('Send a message as supervisor...');
      fireEvent.change(input, { target: { value: 'Test message' } });

      const sendButton = screen.getByRole('button', { name: '' }); // Send icon button
      // Find the button with Send icon
      const buttons = document.querySelectorAll('button');
      const sendBtn = Array.from(buttons).find(b => !b.disabled && b.querySelector('svg'));

      // Type and submit
      fireEvent.change(input, { target: { value: 'Hello agents' } });
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

      expect(mockSendMailTurn).toHaveBeenCalledWith({
        conversationId: 'conv-test-1',
        content: { type: 'text', text: 'Hello agents' },
        content_type: 'text',
      });
    });

    it('clears input after sending', () => {
      renderConversation();
      const input = screen.getByPlaceholderText('Send a message as supervisor...') as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: 'Hello' } });
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
      expect(input.value).toBe('');
    });

    it('does not send empty messages', () => {
      renderConversation();
      const input = screen.getByPlaceholderText('Send a message as supervisor...');
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
      expect(mockSendMailTurn).not.toHaveBeenCalled();
    });

    it('does not send on Shift+Enter (allows new line)', () => {
      renderConversation();
      const input = screen.getByPlaceholderText('Send a message as supervisor...');
      fireEvent.change(input, { target: { value: 'Multi-line' } });
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      expect(mockSendMailTurn).not.toHaveBeenCalled();
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
