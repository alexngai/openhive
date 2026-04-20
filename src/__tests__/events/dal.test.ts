import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as eventsDAL from '../../db/dal/events.js';

const TEST_DB_PATH = path.join(process.cwd(), 'test-events-dal.db');

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

describe('Events DAL', () => {
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;
  let testHiveId: string;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = initDatabase(TEST_DB_PATH);
    testAgentId = createTestAgent(db, 'events-test-user');
    testHiveId = createTestHive(db, 'events-test-hive', testAgentId);
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  // ── Post Rules CRUD ──


  // ── Subscriptions CRUD ──

  describe('Event Subscriptions', () => {
    it('creates a hive-level subscription (swarm_id is null)', () => {
      const sub = eventsDAL.createSubscription({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['push', 'pull_request.*'],
        created_by: 'api',
      });

      expect(sub.id).toMatch(/^esub_/);
      expect(sub.hive_id).toBe(testHiveId);
      expect(sub.swarm_id).toBeNull();
      expect(sub.source).toBe('github');
      expect(sub.event_types).toEqual(['push', 'pull_request.*']);
      expect(sub.enabled).toBe(true);
    });

    it('creates a swarm-specific subscription', () => {
      // Create a test swarm first (in map_swarms table)
      db.prepare(`
        INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, map_transport, status, owner_agent_id)
        VALUES ('swarm_test1', 'test-swarm', 'ws://localhost:9000', 'websocket', 'online', ?)
      `).run(testAgentId);

      const sub = eventsDAL.createSubscription({
        hive_id: testHiveId,
        swarm_id: 'swarm_test1',
        source: 'slack',
        event_types: ['message'],
        filters: { channels: ['C_GENERAL'] },
        created_by: 'swarm:swarm_test1',
      });

      expect(sub.swarm_id).toBe('swarm_test1');
      expect(sub.filters).toEqual({ channels: ['C_GENERAL'] });
    });

    it('lists subscriptions by hive_id', () => {
      const subs = eventsDAL.listSubscriptions({ hive_id: testHiveId });
      expect(subs.length).toBeGreaterThanOrEqual(2);
    });

    it('lists subscriptions by swarm_id', () => {
      const subs = eventsDAL.listSubscriptions({ swarm_id: 'swarm_test1' });
      expect(subs.length).toBeGreaterThanOrEqual(1);
      expect(subs.every(s => s.swarm_id === 'swarm_test1')).toBe(true);
    });

    it('updates a subscription', () => {
      const subs = eventsDAL.listSubscriptions({ hive_id: testHiveId });
      const sub = subs[0];

      const updated = eventsDAL.updateSubscription(sub.id, {
        event_types: ['push', 'pull_request.opened', 'issues.opened'],
        enabled: false,
      });

      expect(updated!.event_types).toEqual(['push', 'pull_request.opened', 'issues.opened']);
      expect(updated!.enabled).toBe(false);
    });

    it('deletes a subscription', () => {
      const sub = eventsDAL.createSubscription({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['to_delete'],
      });

      expect(eventsDAL.deleteSubscription(sub.id)).toBe(true);
      expect(eventsDAL.findSubscriptionById(sub.id)).toBeNull();
    });
  });

  // ── Subscription Matching ──

  describe('Subscription Matching', () => {
    beforeAll(() => {
      eventsDAL.createSubscription({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['push', 'pull_request.opened'],
        created_by: 'test-sub-matching',
      });
      eventsDAL.createSubscription({
        hive_id: testHiveId,
        source: '*',
        event_types: ['*'],
        created_by: 'test-sub-wildcard',
      });
    });

    it('matches by exact source and event_type', () => {
      const matches = eventsDAL.getMatchingSubscriptions('github', 'push');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it('matches wildcard source subscriptions', () => {
      const matches = eventsDAL.getMatchingSubscriptions('linear', 'some_event');
      const wildcardMatches = matches.filter(m => m.source === '*');
      expect(wildcardMatches.length).toBeGreaterThanOrEqual(1);
    });

    it('matches glob-style event patterns (pull_request.*)', () => {
      eventsDAL.createSubscription({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['pull_request.*'],
        created_by: 'test-glob',
      });

      const matches = eventsDAL.getMatchingSubscriptions('github', 'pull_request.opened');
      const globMatch = matches.find(m => m.created_by === 'test-glob');
      expect(globMatch).toBeDefined();
    });
  });

  // ── Delivery Log ──

  describe('Delivery Log', () => {
    it('logs a delivery', () => {
      const log = eventsDAL.logEventDelivery({
        delivery_id: 'del_test1',
        subscription_id: null,
        swarm_id: 'swarm_test1',
        source: 'github',
        event_type: 'push',
        status: 'sent',
      });

      expect(log.id).toMatch(/^edl_/);
      expect(log.delivery_id).toBe('del_test1');
      expect(log.status).toBe('sent');
    });

    it('logs a failed delivery with error', () => {
      const log = eventsDAL.logEventDelivery({
        delivery_id: 'del_test2',
        swarm_id: 'swarm_test1',
        source: 'github',
        event_type: 'push',
        status: 'offline',
        error: 'Swarm not connected',
      });

      expect(log.status).toBe('offline');
      expect(log.error).toBe('Swarm not connected');
    });

    it('queries delivery log by delivery_id', () => {
      const result = eventsDAL.getDeliveryLog({ delivery_id: 'del_test1' });
      expect(result.data.length).toBe(1);
      expect(result.data[0].delivery_id).toBe('del_test1');
    });

    it('queries delivery log by swarm_id', () => {
      const result = eventsDAL.getDeliveryLog({ swarm_id: 'swarm_test1' });
      expect(result.data.length).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it('supports pagination', () => {
      const result = eventsDAL.getDeliveryLog({ swarm_id: 'swarm_test1', limit: 1, offset: 0 });
      expect(result.data.length).toBe(1);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });
  });
});
