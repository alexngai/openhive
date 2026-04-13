import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallGroupBlock } from '../../../components/events/ToolCallGroupBlock';
import type { SessionEvent } from '../../../lib/api';

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

describe('ToolCallGroupBlock', () => {
  const toolEvents = [
    makeEvent({
      id: 'e1',
      type: 'assistant_message',
      content: [{ type: 'tool_call', toolName: 'Read', toolCallId: 'tc1' }],
    }),
    makeEvent({
      id: 'e2',
      type: 'tool_result',
      content: [{ type: 'text', text: 'file contents' }],
    }),
    makeEvent({
      id: 'e3',
      type: 'assistant_message',
      content: [{ type: 'tool_call', toolName: 'Write', toolCallId: 'tc2' }],
    }),
    makeEvent({
      id: 'e4',
      type: 'tool_result',
      content: [{ type: 'text', text: 'written' }],
    }),
  ];

  it('shows tool call count', () => {
    render(<ToolCallGroupBlock events={toolEvents} />);
    expect(screen.getByText('2 tool calls')).toBeDefined();
  });

  it('shows unique tool names', () => {
    render(<ToolCallGroupBlock events={toolEvents} />);
    expect(screen.getByText('Read')).toBeDefined();
    expect(screen.getByText('Write')).toBeDefined();
  });

  it('is collapsed by default', () => {
    render(<ToolCallGroupBlock events={toolEvents} />);
    // Should not show individual event details when collapsed
    expect(screen.queryByText('Result')).toBeNull();
  });

  it('expands to show individual events on click', () => {
    render(<ToolCallGroupBlock events={toolEvents} />);
    fireEvent.click(screen.getByText('2 tool calls'));
    // After expanding, should show result labels from tool_result events
    expect(screen.getAllByText('Result')).toHaveLength(2);
  });

  it('renders singular "tool call" for single tool', () => {
    const singleToolEvents = [
      makeEvent({
        id: 'e1',
        type: 'assistant_message',
        content: [{ type: 'tool_call', toolName: 'Read', toolCallId: 'tc1' }],
      }),
    ];
    render(<ToolCallGroupBlock events={singleToolEvents} />);
    expect(screen.getByText('1 tool call')).toBeDefined();
  });

  it('renders custom event badges when provided', () => {
    const customEvents = [
      makeEvent({ type: 'custom', eventType: 'progress' }),
    ];
    render(<ToolCallGroupBlock events={toolEvents} customEvents={customEvents} />);
    expect(screen.getByText('progress')).toBeDefined();
  });

  it('handles standalone tool_call events', () => {
    const events = [
      makeEvent({ id: 'e1', type: 'tool_call', toolName: 'Bash' }),
      makeEvent({ id: 'e2', type: 'tool_call', toolName: 'Read' }),
    ];
    render(<ToolCallGroupBlock events={events} />);
    expect(screen.getByText('2 tool calls')).toBeDefined();
    expect(screen.getByText('Bash')).toBeDefined();
  });
});
