import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventStream } from '../../../components/events/EventStream';
import type { SessionEvent, AgentIdentity } from '../../../lib/api';

vi.mock('boring-avatars', () => ({
  default: ({ name }: { name: string }) => <svg data-testid="boring-avatar" data-name={name} />,
}));

vi.mock('swarmcraft/ui/embed', () => ({
  generateAgentPalette: () => ['#000', '#111', '#222', '#333', '#444'],
}));

vi.mock('../../../components/sessions/MarkdownContent', () => ({
  MarkdownContent: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

function makeEvent(overrides: Partial<SessionEvent> & { type: SessionEvent['type'] }): SessionEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: '2025-01-01T00:00:00Z',
    sequence: 0,
    ...overrides,
  } as SessionEvent;
}

const mockAgent: AgentIdentity = {
  id: 'agent-1',
  name: 'test-agent',
  avatarUrl: null,
};

describe('EventStream', () => {
  describe('empty/loading states', () => {
    it('shows loading spinner when isLoading', () => {
      const { container } = render(<EventStream events={[]} isLoading={true} />);
      // LoadingSpinner renders a spinning element
      expect(container.querySelector('.animate-spin')).not.toBeNull();
    });

    it('shows empty message when no events', () => {
      render(<EventStream events={[]} />);
      expect(screen.getByText('No events found.')).toBeDefined();
    });

    it('shows custom empty message', () => {
      render(<EventStream events={[]} emptyMessage="Nothing here yet." />);
      expect(screen.getByText('Nothing here yet.')).toBeDefined();
    });
  });

  describe('event rendering', () => {
    it('renders events in chronological order (reverses API order)', () => {
      // API returns newest-first, EventStream reverses to chronological
      const events = [
        makeEvent({ id: '2', type: 'assistant_message', content: [{ type: 'text', text: 'response' }], timestamp: '2025-01-01T00:00:02Z' }),
        makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'question' }], timestamp: '2025-01-01T00:00:01Z' }),
      ];
      render(<EventStream events={events} />);
      const markdowns = screen.getAllByTestId('markdown');
      // First rendered should be 'question' (oldest), then 'response'
      expect(markdowns[0].textContent).toBe('question');
      expect(markdowns[1].textContent).toBe('response');
    });

    it('renders user and assistant messages', () => {
      const events = [
        makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
      ];
      render(<EventStream events={events} />);
      expect(screen.getByText('User')).toBeDefined();
      expect(screen.getByTestId('markdown').textContent).toBe('hi');
    });

    it('passes agentIdentity to EventBubbles', () => {
      const events = [
        makeEvent({ id: '1', type: 'assistant_message', content: [{ type: 'text', text: 'hello' }] }),
      ];
      render(<EventStream events={events} agentIdentity={mockAgent} />);
      expect(screen.getByText('test-agent')).toBeDefined();
    });

    it('groups consecutive tool-use runs into collapsible blocks', () => {
      const events = [
        // Newest-first (API order) — will be reversed internally
        makeEvent({ id: '4', type: 'tool_result', content: [{ type: 'text', text: 'done' }], timestamp: '2025-01-01T00:00:04Z' }),
        makeEvent({ id: '3', type: 'assistant_message', content: [{ type: 'tool_call', toolName: 'Write' }], timestamp: '2025-01-01T00:00:03Z' }),
        makeEvent({ id: '2', type: 'tool_result', content: [{ type: 'text', text: 'ok' }], timestamp: '2025-01-01T00:00:02Z' }),
        makeEvent({ id: '1', type: 'assistant_message', content: [{ type: 'tool_call', toolName: 'Read' }], timestamp: '2025-01-01T00:00:01Z' }),
      ];
      render(<EventStream events={events} />);
      // Should show grouped tool calls
      expect(screen.getByText('2 tool calls')).toBeDefined();
    });
  });

  describe('header', () => {
    it('renders event count in header', () => {
      const events = [
        makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
      ];
      render(<EventStream events={events} total={42} />);
      expect(screen.getByText('(42 events)')).toBeDefined();
    });

    it('renders format badge', () => {
      const events = [
        makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
      ];
      render(<EventStream events={events} formatId="claude_jsonl_v1" />);
      expect(screen.getByText('claude_jsonl_v1')).toBeDefined();
    });
  });

  describe('pagination', () => {
    it('shows "Load older events" button when hasMore', () => {
      const events = [
        makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
      ];
      const onLoadMore = vi.fn();
      render(<EventStream events={events} hasMore={true} onLoadMore={onLoadMore} total={50} />);
      const btn = screen.getByText(/Load older events/);
      expect(btn).toBeDefined();
      fireEvent.click(btn);
      expect(onLoadMore).toHaveBeenCalledOnce();
    });

    it('shows loading indicator when isLoadingMore', () => {
      const events = [
        makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
      ];
      render(<EventStream events={events} isLoadingMore={true} />);
      expect(screen.getByText('Loading older events…')).toBeDefined();
    });

    it('hides load button when no more pages', () => {
      const events = [
        makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
      ];
      render(<EventStream events={events} hasMore={false} />);
      expect(screen.queryByText(/Load older events/)).toBeNull();
    });
  });

  describe('children slot', () => {
    it('renders children after event stream', () => {
      const events = [
        makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
      ];
      render(
        <EventStream events={events}>
          <div data-testid="chat-input">Chat input here</div>
        </EventStream>
      );
      expect(screen.getByTestId('chat-input')).toBeDefined();
    });
  });

  describe('author grouping (showHeader)', () => {
    it('suppresses header for consecutive same-author messages', () => {
      const events = [
        // Newest-first — reversed internally
        makeEvent({ id: '2', type: 'assistant_message', content: [{ type: 'text', text: 'more' }], timestamp: '2025-01-01T00:00:02Z' }),
        makeEvent({ id: '1', type: 'assistant_message', content: [{ type: 'text', text: 'hello' }], timestamp: '2025-01-01T00:00:01Z' }),
      ];
      render(<EventStream events={events} agentIdentity={mockAgent} />);
      // Only one header should show the agent name (second message continues without header)
      const agentLabels = screen.getAllByText('test-agent');
      expect(agentLabels).toHaveLength(1);
    });

    it('shows headers when author changes', () => {
      const events = [
        // Newest-first
        makeEvent({ id: '2', type: 'assistant_message', content: [{ type: 'text', text: 'response' }], timestamp: '2025-01-01T00:00:02Z' }),
        makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'question' }], timestamp: '2025-01-01T00:00:01Z' }),
      ];
      render(<EventStream events={events} />);
      expect(screen.getByText('User')).toBeDefined();
      expect(screen.getByText('Assistant')).toBeDefined();
    });
  });
});
