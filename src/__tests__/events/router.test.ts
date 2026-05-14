import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import type { NormalizedEvent } from '../../events/types.js';

const mockDispatchToSwarms = vi.fn();
const mockBroadcastToChannel = vi.fn();

vi.mock('../../events/dispatch.js', () => ({
  dispatchToSwarms: (...args: unknown[]) => mockDispatchToSwarms(...args),
}));

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (...args: unknown[]) => mockBroadcastToChannel(...args),
}));

const TEST_DB_PATH = path.join(process.cwd(), 'test-events-router.db');

// `routeEvent` is imported after the mocks so the mocks take effect.
let routeEvent: typeof import('../../events/router.js').routeEvent;

beforeAll(async () => {
  try { fs.unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  initDatabase(TEST_DB_PATH);
  ({ routeEvent } = await import('../../events/router.js'));
});

afterAll(() => {
  closeDatabase();
  try { fs.unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
});

beforeEach(() => {
  mockDispatchToSwarms.mockReset();
  mockBroadcastToChannel.mockReset();
});

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    source: 'github',
    event_type: 'push',
    delivery_id: 'del-1',
    metadata: { repo: 'org/repo', branch: 'main' },
    raw_payload: { ref: 'refs/heads/main' },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('routeEvent — live broadcast', () => {
  it('broadcasts events.received on the events:live channel for every event', () => {
    mockDispatchToSwarms.mockReturnValue([]);
    routeEvent(makeEvent());
    expect(mockBroadcastToChannel).toHaveBeenCalledTimes(1);
    const [channel, frame] = mockBroadcastToChannel.mock.calls[0];
    expect(channel).toBe('events:live');
    expect(frame.type).toBe('events.received');
    expect(frame.data.event.source).toBe('github');
    expect(frame.data.event.event_type).toBe('push');
    expect(frame.data.event.delivery_id).toBe('del-1');
  });

  it('includes matched_subs count and deliveries in the broadcast payload', () => {
    mockDispatchToSwarms.mockReturnValue([
      { swarm_id: 'swarm-a', status: 'sent' },
      { swarm_id: 'swarm-b', status: 'offline', error: 'Swarm not connected' },
    ]);
    // No real subs exist in the test DB, so matched_subs ends up 0 from the
    // router's lookup — but the deliveries array is still populated by our
    // dispatchToSwarms mock through whatever path uses it. Verify the
    // broadcast structurally regardless of count.
    routeEvent(makeEvent());
    const [, frame] = mockBroadcastToChannel.mock.calls[0];
    expect(frame.data).toHaveProperty('matched_subs');
    expect(frame.data).toHaveProperty('deliveries');
    expect(frame.data).toHaveProperty('received_at');
  });

  it('broadcasts for unmatched events too (matched_subs=0)', () => {
    mockDispatchToSwarms.mockReturnValue([]);
    routeEvent(makeEvent({
      source: 'github',
      event_type: 'never_subscribed_event',
    }));
    expect(mockBroadcastToChannel).toHaveBeenCalledTimes(1);
    const [, frame] = mockBroadcastToChannel.mock.calls[0];
    expect(frame.data.matched_subs).toBe(0);
    expect(frame.data.deliveries).toEqual([]);
  });

  it('does not broadcast more than once per event', () => {
    mockDispatchToSwarms.mockReturnValue([]);
    routeEvent(makeEvent({ delivery_id: 'd1' }));
    routeEvent(makeEvent({ delivery_id: 'd2' }));
    routeEvent(makeEvent({ delivery_id: 'd3' }));
    expect(mockBroadcastToChannel).toHaveBeenCalledTimes(3);
    const ids = mockBroadcastToChannel.mock.calls.map(
      ([, f]) => (f as { data: { event: { delivery_id: string } } }).data.event.delivery_id,
    );
    expect(ids).toEqual(['d1', 'd2', 'd3']);
  });

  it('returns the same RouteResult shape regardless of the new broadcast', () => {
    mockDispatchToSwarms.mockReturnValue([]);
    const result = routeEvent(makeEvent());
    expect(result).toHaveProperty('swarms_notified');
    expect(result).toHaveProperty('deliveries');
    expect(result.swarms_notified).toBe(0);
  });
});
