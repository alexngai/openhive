import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { dispatchToSwarms } from '../../events/dispatch.js';
import type { NormalizedEvent, EventSubscription } from '../../events/types.js';

// Mock sync-listener
const mockSendToSwarm = vi.fn();
vi.mock('../../map/sync-listener.js', () => ({
  sendToSwarm: (...args: unknown[]) => mockSendToSwarm(...args),
}));

const TEST_DB_PATH = path.join(process.cwd(), 'test-events-dispatch.db');

function createTestAgent(db: ReturnType<typeof import('better-sqlite3')>, name: string): string {
  const id = `agent_${name}`;
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, account_type) VALUES (?, ?, 'human')
  `).run(id, name);
  return id;
}

function createTestHive(db: ReturnType<typeof import('better-sqlite3')>, name: string, ownerId: string): string {
  const id = `hive_${name}`;
  db.prepare(`
    INSERT OR IGNORE INTO hives (id, name, owner_id, is_public) VALUES (?, ?, ?, 1)
  `).run(id, name, ownerId);
  return id;
}

function makeEvent(overrides?: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    source: 'github',
    event_type: 'push',
    delivery_id: `del_${Date.now()}`,
    timestamp: new Date().toISOString(),
    raw_payload: { ref: 'refs/heads/main' },
    metadata: { repo: 'org/repo', branch: 'main' },
    ...overrides,
  };
}

function makeSub(overrides?: Partial<EventSubscription>): EventSubscription {
  return {
    id: 'esub_test',
    hive_id: 'hive_dispatch',
    swarm_id: 'swarm_dispatch1',
    source: 'github',
    event_types: ['push'],
    filters: null,
    priority: 100,
    enabled: true,
    created_by: 'test',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Event Dispatch', () => {
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;
  let testHiveId: string;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = initDatabase(TEST_DB_PATH);
    testAgentId = createTestAgent(db, 'dispatch-test-user');
    testHiveId = createTestHive(db, 'dispatch', testAgentId);

    // Create test swarms
    db.prepare(`
      INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, map_transport, status, owner_agent_id)
      VALUES ('swarm_dispatch1', 'dispatch-swarm-1', 'ws://localhost:9010', 'websocket', 'online', ?)
    `).run(testAgentId);

    db.prepare(`
      INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, map_transport, status, owner_agent_id)
      VALUES ('swarm_dispatch2', 'dispatch-swarm-2', 'ws://localhost:9011', 'websocket', 'online', ?)
    `).run(testAgentId);

    // Link swarms to hive
    db.prepare(`INSERT OR IGNORE INTO map_swarm_hives (swarm_id, hive_id) VALUES ('swarm_dispatch1', ?)`).run(testHiveId);
    db.prepare(`INSERT OR IGNORE INTO map_swarm_hives (swarm_id, hive_id) VALUES ('swarm_dispatch2', ?)`).run(testHiveId);
  });

  beforeEach(() => {
    mockSendToSwarm.mockReset();
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('returns empty deliveries for no subscriptions', () => {
    const result = dispatchToSwarms(makeEvent(), []);
    expect(result).toEqual([]);
    expect(mockSendToSwarm).not.toHaveBeenCalled();
  });

  it('sends MAP message to swarm-specific subscriptions', () => {
    mockSendToSwarm.mockReturnValue(true);

    const sub = makeSub({ swarm_id: 'swarm_dispatch1' });
    const event = makeEvent({ delivery_id: 'del_swarm_specific' });

    const deliveries = dispatchToSwarms(event, [sub]);

    expect(mockSendToSwarm).toHaveBeenCalledWith(
      'swarm_dispatch1',
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'x-openhive/event.webhook',
        params: expect.objectContaining({
          source: 'github',
          event_type: 'push',
          delivery_id: 'del_swarm_specific',
        }),
      }),
    );

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('sent');
    expect(deliveries[0].swarm_id).toBe('swarm_dispatch1');
  });

  it('marks delivery as offline when swarm is not connected', () => {
    mockSendToSwarm.mockReturnValue(false);

    const sub = makeSub({ swarm_id: 'swarm_dispatch1' });
    const deliveries = dispatchToSwarms(makeEvent(), [sub]);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('offline');
    expect(deliveries[0].error).toBe('Swarm not connected');
  });

  it('expands hive-level subscriptions to all online swarms in hive', () => {
    mockSendToSwarm.mockReturnValue(true);

    const hiveSub = makeSub({
      id: 'esub_hive_default',
      hive_id: testHiveId,
      swarm_id: null,  // hive-level default
    });

    const deliveries = dispatchToSwarms(makeEvent(), [hiveSub]);

    // Should send to both swarms linked to this hive
    expect(mockSendToSwarm).toHaveBeenCalledTimes(2);
    expect(deliveries).toHaveLength(2);

    const swarmIds = deliveries.map(d => d.swarm_id).sort();
    expect(swarmIds).toEqual(['swarm_dispatch1', 'swarm_dispatch2']);
  });

  it('deduplicates swarms across multiple subscriptions', () => {
    mockSendToSwarm.mockReturnValue(true);

    // Two subscriptions pointing to the same swarm
    const sub1 = makeSub({ id: 'esub_dup1', swarm_id: 'swarm_dispatch1' });
    const sub2 = makeSub({ id: 'esub_dup2', swarm_id: 'swarm_dispatch1' });

    const deliveries = dispatchToSwarms(makeEvent(), [sub1, sub2]);

    expect(mockSendToSwarm).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
  });

  it('deduplicates swarms between hive-level and swarm-specific subs', () => {
    mockSendToSwarm.mockReturnValue(true);

    const hiveSub = makeSub({ id: 'esub_hive', hive_id: testHiveId, swarm_id: null });
    const swarmSub = makeSub({ id: 'esub_specific', swarm_id: 'swarm_dispatch1' });

    const deliveries = dispatchToSwarms(makeEvent(), [swarmSub, hiveSub]);

    // swarm_dispatch1 should only receive once, swarm_dispatch2 from hive expansion
    expect(mockSendToSwarm).toHaveBeenCalledTimes(2);
    expect(deliveries).toHaveLength(2);
  });

  it('logs deliveries to the event_delivery_log table', () => {
    mockSendToSwarm.mockReturnValue(true);

    const sub = makeSub({ swarm_id: 'swarm_dispatch1' });
    const event = makeEvent({ delivery_id: 'del_log_verify' });

    dispatchToSwarms(event, [sub]);

    // Verify the delivery was logged in DB
    const row = db.prepare(
      "SELECT * FROM event_delivery_log WHERE delivery_id = 'del_log_verify'"
    ).get() as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.swarm_id).toBe('swarm_dispatch1');
    expect(row!.status).toBe('sent');
  });
});
