import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EventBubble } from '../../../components/events/EventBubble';
import type { SessionEvent, AgentIdentity } from '../../../lib/api';

// Mock boring-avatars
vi.mock('boring-avatars', () => ({
  default: ({ name }: { name: string }) => (
    <svg data-testid="boring-avatar" data-name={name} />
  ),
}));

vi.mock('swarmcraft/ui/embed', () => ({
  generateAgentPalette: () => ['#000', '#111', '#222', '#333', '#444'],
}));

vi.mock('../../../components/sessions/MarkdownContent', () => ({
  MarkdownContent: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

function makeEvent(overrides: Partial<SessionEvent> & { type: SessionEvent['type'] }): SessionEvent {
  return {
    id: 'evt-1',
    timestamp: '2025-01-01T00:00:00Z',
    sequence: 0,
    ...overrides,
  } as SessionEvent;
}

const mockAgent: AgentIdentity = {
  id: 'agent-123',
  name: 'my-agent',
  avatarUrl: null,
};

describe('EventBubble', () => {
  describe('user_message', () => {
    it('renders user message with markdown', () => {
      const event = makeEvent({
        type: 'user_message',
        content: [{ type: 'text', text: 'Hello from user' }],
      });
      render(<EventBubble event={event} />);
      expect(screen.getByTestId('markdown').textContent).toBe('Hello from user');
    });

    it('shows (empty) for empty user message', () => {
      const event = makeEvent({ type: 'user_message', content: [] });
      render(<EventBubble event={event} />);
      expect(screen.getByText('(empty)')).toBeDefined();
    });

    it('shows User label with header', () => {
      const event = makeEvent({
        type: 'user_message',
        content: [{ type: 'text', text: 'hi' }],
      });
      render(<EventBubble event={event} showHeader={true} />);
      expect(screen.getByText('User')).toBeDefined();
    });

    it('hides avatar when showHeader is false', () => {
      const event = makeEvent({
        type: 'user_message',
        content: [{ type: 'text', text: 'hi' }],
      });
      render(<EventBubble event={event} showHeader={false} />);
      expect(screen.queryByText('User')).toBeNull();
    });
  });

  describe('assistant_message', () => {
    it('shows "Assistant" label when no agentIdentity', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'Hello' }],
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('Assistant')).toBeDefined();
    });

    it('shows agent name when agentIdentity provided', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'Hello' }],
      });
      render(<EventBubble event={event} agentIdentity={mockAgent} />);
      expect(screen.getByText('my-agent')).toBeDefined();
    });

    it('renders boring-avatar when agentIdentity provided', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'Hello' }],
      });
      render(<EventBubble event={event} agentIdentity={mockAgent} />);
      expect(screen.getByTestId('boring-avatar').getAttribute('data-name')).toBe('my-agent');
    });

    it('renders markdown content', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: '**bold**' }],
      });
      render(<EventBubble event={event} />);
      expect(screen.getByTestId('markdown').textContent).toBe('**bold**');
    });

    it('hides header when showHeader is false', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'Hello' }],
      });
      render(<EventBubble event={event} showHeader={false} />);
      expect(screen.queryByText('Assistant')).toBeNull();
    });

    it('renders stopReason badge when not end_turn', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'Hello' }],
        stopReason: 'max_tokens',
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('max_tokens')).toBeDefined();
    });

    it('does not render stopReason badge for end_turn', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'Hello' }],
        stopReason: 'end_turn',
      });
      render(<EventBubble event={event} />);
      expect(screen.queryByText('end_turn')).toBeNull();
    });
  });

  describe('token_usage', () => {
    it('renders token counts', () => {
      const event = makeEvent({
        type: 'token_usage',
        inputTokens: 1500,
        outputTokens: 500,
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('1.5k in / 500 out')).toBeDefined();
    });
  });

  describe('assistant_thinking', () => {
    it('renders thinking label', () => {
      const event = makeEvent({
        type: 'assistant_thinking',
        thinking: 'Let me think...',
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('Thinking')).toBeDefined();
    });

    it('shows thinking content when expanded', () => {
      const event = makeEvent({
        type: 'assistant_thinking',
        thinking: 'Deep thought here',
      });
      render(<EventBubble event={event} />);
      // Click to expand
      fireEvent.click(screen.getByText('Thinking'));
      expect(screen.getByTestId('markdown').textContent).toBe('Deep thought here');
    });
  });

  describe('tool_call', () => {
    it('renders tool name', () => {
      const event = makeEvent({
        type: 'tool_call',
        toolName: 'Read',
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('Read')).toBeDefined();
    });
  });

  describe('tool_result', () => {
    it('renders Result label for success', () => {
      const event = makeEvent({
        type: 'tool_result',
        content: [{ type: 'text', text: 'file contents here' }],
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('Result')).toBeDefined();
    });

    it('renders Error label for error results', () => {
      const event = makeEvent({
        type: 'tool_result',
        isError: true,
        content: [{ type: 'text', text: 'something failed' }],
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('Error')).toBeDefined();
    });
  });

  describe('error', () => {
    it('renders error message', () => {
      const event = makeEvent({
        type: 'error',
        message: 'Something went wrong',
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText(/Something went wrong/)).toBeDefined();
    });

    it('renders error code when present', () => {
      const event = makeEvent({
        type: 'error',
        message: 'Failed',
        code: 500,
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText(/500/)).toBeDefined();
    });
  });

  describe('custom/unknown events', () => {
    it('renders event type as badge', () => {
      const event = makeEvent({
        type: 'custom',
        eventType: 'progress',
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('progress')).toBeDefined();
    });

    it('renders count when available', () => {
      const event = makeEvent({
        type: 'custom',
        eventType: 'file-ops',
        data: { count: 5 },
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('file-ops (5)')).toBeDefined();
    });
  });

  describe('customEvents prop', () => {
    it('renders custom event badges in header', () => {
      const event = makeEvent({
        type: 'user_message',
        content: [{ type: 'text', text: 'hi' }],
      });
      const customEvents = [
        makeEvent({ id: 'c1', type: 'custom', eventType: 'progress' }),
      ];
      render(<EventBubble event={event} customEvents={customEvents} />);
      expect(screen.getByText('progress')).toBeDefined();
    });
  });
});
