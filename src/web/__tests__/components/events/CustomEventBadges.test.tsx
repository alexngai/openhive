import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CustomEventBadges } from '../../../components/events/CustomEventBadges';
import type { SessionEvent } from '../../../lib/api';

function makeCustomEvent(eventType: string, count?: number): SessionEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: '2025-01-01T00:00:00Z',
    sequence: 0,
    type: 'custom',
    eventType,
    data: count != null ? { count } : undefined,
  } as SessionEvent;
}

describe('CustomEventBadges', () => {
  it('renders nothing for undefined events', () => {
    const { container } = render(<CustomEventBadges events={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for empty array', () => {
    const { container } = render(<CustomEventBadges events={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders badge for a custom event', () => {
    render(<CustomEventBadges events={[makeCustomEvent('progress')]} />);
    expect(screen.getByText('progress')).toBeDefined();
  });

  it('aggregates counts for same event type', () => {
    const events = [
      makeCustomEvent('progress'),
      makeCustomEvent('progress'),
    ];
    render(<CustomEventBadges events={events} />);
    expect(screen.getByText('progress ×2')).toBeDefined();
  });

  it('uses count from data field', () => {
    const events = [makeCustomEvent('file-ops', 5)];
    render(<CustomEventBadges events={events} />);
    expect(screen.getByText('file-ops ×5')).toBeDefined();
  });

  it('hides events in HIDDEN_CUSTOM_EVENTS set', () => {
    const events = [
      makeCustomEvent('system'),
      makeCustomEvent('file-history-snapshot'),
      makeCustomEvent('login'),
      makeCustomEvent('init'),
    ];
    const { container } = render(<CustomEventBadges events={events} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders multiple different event types', () => {
    const events = [
      makeCustomEvent('progress'),
      makeCustomEvent('compile'),
    ];
    render(<CustomEventBadges events={events} />);
    expect(screen.getByText('progress')).toBeDefined();
    expect(screen.getByText('compile')).toBeDefined();
  });

  it('strips claude_ prefix from event type', () => {
    const events = [makeCustomEvent('claude_thinking')];
    render(<CustomEventBadges events={events} />);
    expect(screen.getByText('thinking')).toBeDefined();
  });
});
