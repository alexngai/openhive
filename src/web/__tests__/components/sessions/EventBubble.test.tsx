import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventBubble } from '../../../components/sessions/EventBubble';
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

// Mock MarkdownContent to simplify
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

    it('renders boring-avatar when agentIdentity provided without avatarUrl', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'Hello' }],
      });
      render(<EventBubble event={event} agentIdentity={mockAgent} />);
      const avatar = screen.getByTestId('boring-avatar');
      expect(avatar.getAttribute('data-name')).toBe('my-agent');
    });

    it('renders default Bot icon when no agentIdentity', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: 'Hello' }],
      });
      const { container } = render(<EventBubble event={event} />);
      // Should not have boring-avatar
      expect(screen.queryByTestId('boring-avatar')).toBeNull();
      // Should have the default bot icon container
      const botContainer = container.querySelector('[style*="rgba(245, 158, 11"]');
      expect(botContainer).not.toBeNull();
    });

    it('renders markdown content for assistant text', () => {
      const event = makeEvent({
        type: 'assistant_message',
        content: [{ type: 'text', text: '**bold**' }],
      });
      render(<EventBubble event={event} />);
      const md = screen.getByTestId('markdown');
      expect(md.textContent).toBe('**bold**');
    });
  });

  describe('user_message', () => {
    it('renders user message with markdown', () => {
      const event = makeEvent({
        type: 'user_message',
        content: [{ type: 'text', text: 'Hello from user' }],
      });
      render(<EventBubble event={event} />);
      const md = screen.getByTestId('markdown');
      expect(md.textContent).toBe('Hello from user');
    });

    it('shows (empty) for empty user message', () => {
      const event = makeEvent({
        type: 'user_message',
        content: [],
      });
      render(<EventBubble event={event} />);
      expect(screen.getByText('(empty)')).toBeDefined();
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
  });
});
