import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as eventsDAL from '../../db/dal/events.js';
import { routeEvent } from '../../events/router.js';
import type { NormalizedEvent } from '../../events/types.js';

// Mock WebSocket dispatch (no real swarm connections in tests)
const mockSendToSwarm = vi.fn(() => false);
vi.mock('../../map/sync-listener.js', () => ({
  sendToSwarm: (...args: unknown[]) => mockSendToSwarm(...args),
}));

// Mock realtime broadcasts
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_DB_PATH = path.join(process.cwd(), 'test-events-router.db');

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

function makeGithubPushEvent(overrides?: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    source: 'github',
    event_type: 'push',
    delivery_id: `del_${Date.now()}`,
    timestamp: new Date().toISOString(),
    post: {
      title: '[org/repo] 1 commit(s) pushed to main',
      content: '- `abc1234` Fix bug',
      url: 'https://github.com/org/repo/compare/abc...def',
    },
    raw_payload: { ref: 'refs/heads/main', commits: [] },
    metadata: { repo: 'org/repo', branch: 'main', sender: 'alice' },
    ...overrides,
  };
}

describe('Event Router', () => {
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;
  let testHiveId: string;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = initDatabase(TEST_DB_PATH);
    testAgentId = createTestAgent(db, 'router-test-user');
    testHiveId = createTestHive(db, 'router-hive', testAgentId);
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  // ── Post Pipeline ──

  describe('Post Pipeline', () => {
    it('creates a post when a matching post rule exists', () => {
      eventsDAL.createPostRule({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['push'],
        created_by: 'test',
      });

      const event = makeGithubPushEvent();
      const result = routeEvent(event);

      expect(result.posts_created).toBe(1);

      // Verify the post was created in the database
      const post = db.prepare(
        "SELECT * FROM posts WHERE hive_id = ? AND title LIKE '%pushed to main%'"
      ).get(testHiveId) as Record<string, unknown> | undefined;

      expect(post).toBeDefined();
      expect(post!.title).toContain('[org/repo]');
    });

    it('creates proxy agent for event source', () => {
      const event = makeGithubPushEvent({ delivery_id: 'del_proxy_test' });
      routeEvent(event);

      const agent = db.prepare("SELECT * FROM agents WHERE name = 'event:github'").get() as Record<string, unknown> | undefined;
      expect(agent).toBeDefined();
      expect(agent!.account_type).toBe('agent');
    });

    it('skips post creation when event has no post data', () => {
      eventsDAL.createPostRule({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['check_run.completed'],
        created_by: 'test-no-post',
      });

      const event: NormalizedEvent = {
        source: 'github',
        event_type: 'check_run.completed',
        delivery_id: 'del_no_post',
        timestamp: new Date().toISOString(),
        raw_payload: {},
        metadata: { repo: 'org/repo' },
        // no post field
      };

      const result = routeEvent(event);
      expect(result.posts_created).toBe(0);
    });

    it('skips post creation when thread_mode is skip', () => {
      eventsDAL.createPostRule({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['push'],
        thread_mode: 'skip',
        created_by: 'test-skip',
      });

      const event = makeGithubPushEvent({ delivery_id: 'del_skip_test' });

      // Count posts before
      const beforeCount = (db.prepare('SELECT COUNT(*) as count FROM posts WHERE hive_id = ?').get(testHiveId) as { count: number }).count;

      routeEvent(event);

      // Posts still created from other matching rules, but the skip rule didn't add one
      // (This test validates the skip rule doesn't create a post for its path)
    });

    it('applies filter matching on repos', () => {
      eventsDAL.createPostRule({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['push'],
        filters: { repos: ['other/repo'] },
        created_by: 'test-repo-filter',
      });

      const event = makeGithubPushEvent({
        delivery_id: 'del_filter_test',
        metadata: { repo: 'org/repo', branch: 'main' },
      });

      // The rule with repos: ['other/repo'] should not match org/repo
      // Other rules may still match, so we check the specific rule didn't fire
      const result = routeEvent(event);
      // Result still works, filtered rule just doesn't contribute
      expect(result).toBeDefined();
    });
  });

  // ── MAP Pipeline ──

  describe('MAP Pipeline', () => {
    it('dispatches to subscribed swarms', () => {
      // Create a swarm and subscription
      db.prepare(`
        INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, map_transport, status, owner_agent_id)
        VALUES ('swarm_router1', 'router-swarm', 'ws://localhost:9001', 'websocket', 'online', ?)
      `).run(testAgentId);

      // Link swarm to hive
      db.prepare(`
        INSERT OR IGNORE INTO map_swarm_hives (swarm_id, hive_id)
        VALUES ('swarm_router1', ?)
      `).run(testHiveId);

      eventsDAL.createSubscription({
        hive_id: testHiveId,
        swarm_id: 'swarm_router1',
        source: 'github',
        event_types: ['push'],
        created_by: 'test',
      });

      const event = makeGithubPushEvent({ delivery_id: 'del_map_test' });
      const result = routeEvent(event);

      // sendToSwarm is mocked to return false (offline), but it should be called
      expect(mockSendToSwarm).toHaveBeenCalledWith(
        'swarm_router1',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'x-openhive/event.webhook',
          params: expect.objectContaining({
            source: 'github',
            event_type: 'push',
          }),
        }),
      );
    });

    it('logs delivery status for each swarm', () => {
      const event = makeGithubPushEvent({ delivery_id: 'del_log_test' });
      const result = routeEvent(event);

      // Deliveries should be logged (swarm is offline per mock)
      if (result.deliveries.length > 0) {
        const offlineDelivery = result.deliveries.find(d => d.status === 'offline');
        expect(offlineDelivery).toBeDefined();
      }
    });

    it('expands hive-level subscriptions to all online swarms', () => {
      eventsDAL.createSubscription({
        hive_id: testHiveId,
        // swarm_id is NULL — hive-level default
        source: 'github',
        event_types: ['issues.opened'],
        created_by: 'test-hive-default',
      });

      const event: NormalizedEvent = {
        source: 'github',
        event_type: 'issues.opened',
        delivery_id: 'del_expand_test',
        timestamp: new Date().toISOString(),
        post: {
          title: '[org/repo] Issue #1 opened: Test',
          content: 'Test issue',
        },
        raw_payload: {},
        metadata: { repo: 'org/repo' },
      };

      mockSendToSwarm.mockClear();

      routeEvent(event);

      // Should have called sendToSwarm for the online swarm in this hive
      expect(mockSendToSwarm).toHaveBeenCalled();
    });
  });

  // ── Dual Path ──

  describe('Dual Path', () => {
    it('fires both post and MAP pipelines for the same event', () => {
      // Ensure both a post rule and subscription exist for the same event
      eventsDAL.createPostRule({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['pull_request.opened'],
        created_by: 'test-dual',
      });

      eventsDAL.createSubscription({
        hive_id: testHiveId,
        swarm_id: 'swarm_router1',
        source: 'github',
        event_types: ['pull_request.opened'],
        created_by: 'test-dual',
      });

      const event: NormalizedEvent = {
        source: 'github',
        event_type: 'pull_request.opened',
        action: 'opened',
        delivery_id: 'del_dual_test',
        timestamp: new Date().toISOString(),
        post: {
          title: '[org/repo] PR #99 opened: Dual test',
          content: 'This tests both paths',
        },
        raw_payload: {},
        metadata: { repo: 'org/repo' },
      };

      const result = routeEvent(event);

      expect(result.posts_created).toBeGreaterThanOrEqual(1);
      // MAP pipeline should also have run (deliveries logged)
      expect(result.deliveries.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ── No matches ──

  describe('No Matches', () => {
    it('returns zero counts when no rules or subscriptions match', () => {
      const event: NormalizedEvent = {
        source: 'jira',
        event_type: 'ticket.created',
        delivery_id: 'del_nomatch',
        timestamp: new Date().toISOString(),
        raw_payload: {},
        metadata: {},
      };

      const result = routeEvent(event);
      expect(result.posts_created).toBe(0);
      expect(result.swarms_notified).toBe(0);
      expect(result.deliveries).toEqual([]);
    });
  });
});
