import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '../../../lib/api';
import {
  formatTokens,
  extractText,
  truncate,
  getEventAuthor,
  isToolUseOnlyMessage,
  isToolRunEvent,
  countToolCalls,
  groupEventsForDisplay,
  groupConsecutiveCustomEvents,
  HIDDEN_CUSTOM_EVENTS,
} from '../../../components/events/event-utils';

function makeEvent(overrides: Partial<SessionEvent> & { type: SessionEvent['type'] }): SessionEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: '2025-01-01T00:00:00Z',
    sequence: 0,
    ...overrides,
  } as SessionEvent;
}

// ── formatTokens ───────────────────────────────────────────────────────────

describe('formatTokens', () => {
  it('formats millions', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('formats thousands', () => {
    expect(formatTokens(2_300)).toBe('2.3k');
  });

  it('returns raw number below 1000', () => {
    expect(formatTokens(42)).toBe('42');
  });

  it('handles zero', () => {
    expect(formatTokens(0)).toBe('0');
  });
});

// ── extractText ────────────────────────────────────────────────────────────

describe('extractText', () => {
  it('extracts text from content blocks', () => {
    const blocks = [
      { type: 'text' as const, text: 'Hello' },
      { type: 'tool_call' as const, toolName: 'read' },
      { type: 'text' as const, text: 'World' },
    ];
    expect(extractText(blocks)).toBe('Hello\nWorld');
  });

  it('returns empty string for undefined', () => {
    expect(extractText(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(extractText([])).toBe('');
  });
});

// ── truncate ───────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns string as-is if within limit', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('truncates with ellipsis', () => {
    expect(truncate('a long string', 6)).toBe('a long...');
  });

  it('handles exact boundary', () => {
    expect(truncate('exact', 5)).toBe('exact');
  });
});

// ── getEventAuthor ─────────────────────────────────────────────────────────

describe('getEventAuthor', () => {
  it('returns user for user_message', () => {
    expect(getEventAuthor(makeEvent({ type: 'user_message' }))).toBe('user');
  });

  it('returns assistant for assistant_message', () => {
    expect(getEventAuthor(makeEvent({ type: 'assistant_message' }))).toBe('assistant');
  });

  it('returns assistant for assistant_thinking', () => {
    expect(getEventAuthor(makeEvent({ type: 'assistant_thinking' }))).toBe('assistant');
  });

  it('returns assistant for tool_call', () => {
    expect(getEventAuthor(makeEvent({ type: 'tool_call' }))).toBe('assistant');
  });

  it('returns assistant for tool_result', () => {
    expect(getEventAuthor(makeEvent({ type: 'tool_result' }))).toBe('assistant');
  });

  it('returns null for token_usage', () => {
    expect(getEventAuthor(makeEvent({ type: 'token_usage' }))).toBeNull();
  });

  it('returns null for custom', () => {
    expect(getEventAuthor(makeEvent({ type: 'custom' }))).toBeNull();
  });

  it('returns null for error', () => {
    expect(getEventAuthor(makeEvent({ type: 'error' }))).toBeNull();
  });
});

// ── isToolUseOnlyMessage ───────────────────────────────────────────────────

describe('isToolUseOnlyMessage', () => {
  it('returns true for assistant_message with only tool_call blocks', () => {
    const event = makeEvent({
      type: 'assistant_message',
      content: [{ type: 'tool_call', toolName: 'read' }],
    });
    expect(isToolUseOnlyMessage(event)).toBe(true);
  });

  it('returns false for assistant_message with text content', () => {
    const event = makeEvent({
      type: 'assistant_message',
      content: [
        { type: 'text', text: 'Let me check' },
        { type: 'tool_call', toolName: 'read' },
      ],
    });
    expect(isToolUseOnlyMessage(event)).toBe(false);
  });

  it('returns false for assistant_message without tool calls', () => {
    const event = makeEvent({
      type: 'assistant_message',
      content: [{ type: 'text', text: 'Hello' }],
    });
    expect(isToolUseOnlyMessage(event)).toBe(false);
  });

  it('returns false for non-assistant_message types', () => {
    expect(isToolUseOnlyMessage(makeEvent({ type: 'user_message' }))).toBe(false);
    expect(isToolUseOnlyMessage(makeEvent({ type: 'tool_call' }))).toBe(false);
  });
});

// ── isToolRunEvent ─────────────────────────────────────────────────────────

describe('isToolRunEvent', () => {
  it('returns true for tool_call', () => {
    expect(isToolRunEvent(makeEvent({ type: 'tool_call' }))).toBe(true);
  });

  it('returns true for tool_result', () => {
    expect(isToolRunEvent(makeEvent({ type: 'tool_result' }))).toBe(true);
  });

  it('returns true for assistant_thinking', () => {
    expect(isToolRunEvent(makeEvent({ type: 'assistant_thinking' }))).toBe(true);
  });

  it('returns true for custom', () => {
    expect(isToolRunEvent(makeEvent({ type: 'custom' }))).toBe(true);
  });

  it('returns true for tool-use-only assistant_message', () => {
    const event = makeEvent({
      type: 'assistant_message',
      content: [{ type: 'tool_call', toolName: 'read' }],
    });
    expect(isToolRunEvent(event)).toBe(true);
  });

  it('returns false for user_message', () => {
    expect(isToolRunEvent(makeEvent({ type: 'user_message' }))).toBe(false);
  });

  it('returns false for assistant_message with text', () => {
    const event = makeEvent({
      type: 'assistant_message',
      content: [{ type: 'text', text: 'Hello' }],
    });
    expect(isToolRunEvent(event)).toBe(false);
  });
});

// ── countToolCalls ─────────────────────────────────────────────────────────

describe('countToolCalls', () => {
  it('counts tool_call blocks in assistant_messages', () => {
    const events = [
      makeEvent({
        type: 'assistant_message',
        content: [
          { type: 'tool_call', toolName: 'read' },
          { type: 'tool_call', toolName: 'write' },
        ],
      }),
    ];
    expect(countToolCalls(events)).toBe(2);
  });

  it('counts standalone tool_call events', () => {
    const events = [
      makeEvent({ type: 'tool_call', toolName: 'read' }),
      makeEvent({ type: 'tool_call', toolName: 'write' }),
    ];
    expect(countToolCalls(events)).toBe(2);
  });

  it('counts mixed assistant_message and standalone tool_calls', () => {
    const events = [
      makeEvent({
        type: 'assistant_message',
        content: [{ type: 'tool_call', toolName: 'read' }],
      }),
      makeEvent({ type: 'tool_call', toolName: 'write' }),
    ];
    expect(countToolCalls(events)).toBe(2);
  });

  it('returns 0 for events without tool calls', () => {
    const events = [
      makeEvent({ type: 'assistant_thinking', thinking: 'hmm' }),
      makeEvent({ type: 'tool_result' }),
    ];
    expect(countToolCalls(events)).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(countToolCalls([])).toBe(0);
  });
});

// ── HIDDEN_CUSTOM_EVENTS ───────────────────────────────────────────────────

describe('HIDDEN_CUSTOM_EVENTS', () => {
  it('contains expected noise events', () => {
    expect(HIDDEN_CUSTOM_EVENTS.has('system')).toBe(true);
    expect(HIDDEN_CUSTOM_EVENTS.has('file-history-snapshot')).toBe(true);
    expect(HIDDEN_CUSTOM_EVENTS.has('login')).toBe(true);
    expect(HIDDEN_CUSTOM_EVENTS.has('init')).toBe(true);
  });

  it('does not contain regular custom events', () => {
    expect(HIDDEN_CUSTOM_EVENTS.has('progress')).toBe(false);
  });
});

// ── groupEventsForDisplay ──────────────────────────────────────────────────

describe('groupEventsForDisplay', () => {
  it('returns events as-is when no tool runs', () => {
    const events = [
      makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
      makeEvent({ id: '2', type: 'assistant_message', content: [{ type: 'text', text: 'hello' }] }),
    ];
    const result = groupEventsForDisplay(events);
    expect(result).toHaveLength(2);
    expect('_toolGroup' in result[0]).toBe(false);
    expect('_toolGroup' in result[1]).toBe(false);
  });

  it('groups consecutive tool-use events with >1 tool calls into ToolGroup', () => {
    const events = [
      makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'do it' }] }),
      makeEvent({
        id: '2', type: 'assistant_message',
        content: [{ type: 'tool_call', toolName: 'read' }],
      }),
      makeEvent({ id: '3', type: 'tool_result', content: [{ type: 'text', text: 'ok' }] }),
      makeEvent({
        id: '4', type: 'assistant_message',
        content: [{ type: 'tool_call', toolName: 'write' }],
      }),
      makeEvent({ id: '5', type: 'tool_result', content: [{ type: 'text', text: 'ok' }] }),
    ];
    const result = groupEventsForDisplay(events);
    // user_message + ToolGroup
    expect(result).toHaveLength(2);
    expect('_toolGroup' in result[1]).toBe(true);
    if ('_toolGroup' in result[1]) {
      expect(result[1].events).toHaveLength(4);
    }
  });

  it('does not group a single tool call into a ToolGroup', () => {
    const events = [
      makeEvent({
        id: '1', type: 'assistant_message',
        content: [{ type: 'tool_call', toolName: 'read' }],
      }),
      makeEvent({ id: '2', type: 'tool_result', content: [{ type: 'text', text: 'ok' }] }),
    ];
    const result = groupEventsForDisplay(events);
    // Individual events, not grouped
    expect(result.every(item => !('_toolGroup' in item))).toBe(true);
  });

  it('attaches custom events to the next display item', () => {
    const events = [
      makeEvent({ id: '1', type: 'custom', eventType: 'progress' }),
      makeEvent({ id: '2', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
    ];
    const result = groupEventsForDisplay(events);
    expect(result).toHaveLength(1);
    expect(result[0]._customEvents).toHaveLength(1);
    expect(result[0]._customEvents![0].id).toBe('1');
  });

  it('attaches trailing custom events to last item', () => {
    const events = [
      makeEvent({ id: '1', type: 'user_message', content: [{ type: 'text', text: 'hi' }] }),
      makeEvent({ id: '2', type: 'custom', eventType: 'progress' }),
    ];
    const result = groupEventsForDisplay(events);
    expect(result).toHaveLength(1);
    expect(result[0]._customEvents).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(groupEventsForDisplay([])).toHaveLength(0);
  });
});

// ── groupConsecutiveCustomEvents ───────────────────────────────────────────

describe('groupConsecutiveCustomEvents', () => {
  it('groups consecutive custom events into arrays', () => {
    const events = [
      makeEvent({ id: '1', type: 'custom' }),
      makeEvent({ id: '2', type: 'checkpoint' }),
      makeEvent({ id: '3', type: 'user_message' }),
    ];
    const result = groupConsecutiveCustomEvents(events);
    expect(result).toHaveLength(2);
    expect(Array.isArray(result[0])).toBe(true);
    expect((result[0] as SessionEvent[]).length).toBe(2);
  });

  it('does not group a single custom event into an array', () => {
    const events = [
      makeEvent({ id: '1', type: 'custom' }),
      makeEvent({ id: '2', type: 'user_message' }),
    ];
    const result = groupConsecutiveCustomEvents(events);
    expect(result).toHaveLength(2);
    expect(Array.isArray(result[0])).toBe(false);
  });

  it('keeps non-custom events as individual items', () => {
    const events = [
      makeEvent({ id: '1', type: 'user_message' }),
      makeEvent({ id: '2', type: 'assistant_message' }),
    ];
    const result = groupConsecutiveCustomEvents(events);
    expect(result).toHaveLength(2);
    expect(result.every(item => !Array.isArray(item))).toBe(true);
  });

  it('handles empty input', () => {
    expect(groupConsecutiveCustomEvents([])).toHaveLength(0);
  });

  it('groups mode_change and plan_update as custom events', () => {
    const events = [
      makeEvent({ id: '1', type: 'mode_change' }),
      makeEvent({ id: '2', type: 'plan_update' }),
    ];
    const result = groupConsecutiveCustomEvents(events);
    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0])).toBe(true);
  });
});
