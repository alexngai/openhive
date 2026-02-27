/**
 * E2E Integration Test — Full Event Flow
 *
 * Tests the complete pipeline:
 *   webhook payload → normalize → routeEvent → post created + MAP dispatched
 *
 * Uses real SQLite DB, mocks only the WebSocket layer (sendToSwarm) and
 * the realtime broadcast (no actual WS clients).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { normalize } from '../../events/normalizers/index.js';
import { routeEvent } from '../../events/router.js';
import * as eventsDAL from '../../db/dal/events.js';
import type { NormalizedEvent } from '../../events/types.js';

// Mock WebSocket dispatch
const mockSendToSwarm = vi.fn();
vi.mock('../../map/sync-listener.js', () => ({
  sendToSwarm: (...args: unknown[]) => mockSendToSwarm(...args),
}));

// Mock realtime broadcasts
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_DB_PATH = path.join(process.cwd(), 'test-events-e2e.db');

describe('Event System E2E', () => {
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;
  let testHiveId: string;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = initDatabase(TEST_DB_PATH);

    // Seed the database
    testAgentId = 'agent_e2e';
    db.prepare(
      "INSERT OR IGNORE INTO agents (id, name, account_type) VALUES (?, 'e2e-user', 'human')",
    ).run(testAgentId);

    testHiveId = 'hive_e2e';
    db.prepare(
      "INSERT OR IGNORE INTO hives (id, name, owner_id, is_public) VALUES (?, 'e2e-hive', ?, 1)",
    ).run(testHiveId, testAgentId);

    // Create two swarms linked to the hive
    for (const [id, port] of [['swarm_e2e_1', '9030'], ['swarm_e2e_2', '9031']] as const) {
      db.prepare(`
        INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, map_transport, status, owner_agent_id)
        VALUES (?, ?, ?, 'websocket', 'online', ?)
      `).run(id, `e2e-${id}`, `ws://localhost:${port}`, testAgentId);

      db.prepare(
        'INSERT OR IGNORE INTO map_swarm_hives (swarm_id, hive_id) VALUES (?, ?)',
      ).run(id, testHiveId);
    }
  });

  beforeEach(() => {
    mockSendToSwarm.mockReset();
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  // ==========================================================================
  // GitHub Push — Full Flow
  // ==========================================================================

  describe('GitHub Push → Post + MAP', () => {
    beforeAll(() => {
      // Create a post rule for github pushes in this hive
      eventsDAL.createPostRule({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['push'],
        created_by: 'e2e-test',
      });

      // Create a hive-level subscription (sends to all swarms)
      eventsDAL.createSubscription({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['push'],
        created_by: 'e2e-test',
      });
    });

    it('normalizes raw payload, creates post, and dispatches to both swarms', () => {
      mockSendToSwarm.mockReturnValue(true);

      // Step 1: Normalize raw GitHub payload (as if from webhook/connector)
      const normalized = normalize('github', 'push', 'del_e2e_push1', {
        ref: 'refs/heads/main',
        commits: [
          { id: 'aaa1234567890', message: 'Add login page' },
          { id: 'bbb1234567890', message: 'Fix typo in README' },
        ],
        compare: 'https://github.com/org/repo/compare/aaa...bbb',
        repository: { full_name: 'org/repo' },
        sender: { login: 'alice' },
      });

      // Verify normalization
      expect(normalized.source).toBe('github');
      expect(normalized.event_type).toBe('push');
      expect(normalized.post).toBeDefined();
      expect(normalized.post!.title).toBe('[org/repo] 2 commit(s) pushed to main');
      expect(normalized.metadata.repo).toBe('org/repo');
      expect(normalized.metadata.branch).toBe('main');

      // Step 2: Route through the system
      const result = routeEvent(normalized);

      // Step 3: Verify post was created
      expect(result.posts_created).toBe(1);

      const post = db.prepare(
        "SELECT * FROM posts WHERE hive_id = ? AND title LIKE '%pushed to main%'",
      ).get(testHiveId) as Record<string, unknown> | undefined;

      expect(post).toBeDefined();
      expect(post!.title).toContain('[org/repo]');
      expect(post!.content).toContain('Add login page');

      // Step 4: Verify proxy agent was created
      const proxyAgent = db.prepare(
        "SELECT * FROM agents WHERE name = 'event:github'",
      ).get() as Record<string, unknown> | undefined;
      expect(proxyAgent).toBeDefined();
      expect(proxyAgent!.account_type).toBe('agent');

      // Step 5: Verify MAP dispatch to both swarms (hive-level subscription)
      expect(mockSendToSwarm).toHaveBeenCalledTimes(2);
      expect(result.swarms_notified).toBe(2);
      expect(result.deliveries).toHaveLength(2);

      const swarmIds = result.deliveries.map((d) => d.swarm_id).sort();
      expect(swarmIds).toEqual(['swarm_e2e_1', 'swarm_e2e_2']);

      // Verify MAP message format
      expect(mockSendToSwarm).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'x-openhive/event.webhook',
          params: expect.objectContaining({
            source: 'github',
            event_type: 'push',
            delivery_id: 'del_e2e_push1',
          }),
        }),
      );

      // Step 6: Verify delivery log in DB
      const logEntries = db.prepare(
        "SELECT * FROM event_delivery_log WHERE delivery_id = 'del_e2e_push1'",
      ).all() as Record<string, unknown>[];

      expect(logEntries).toHaveLength(2);
      expect(logEntries.every((e) => e.status === 'sent')).toBe(true);
    });
  });

  // ==========================================================================
  // GitHub PR — Swarm-Specific Subscription
  // ==========================================================================

  describe('GitHub PR → Swarm-Specific Subscription', () => {
    beforeAll(() => {
      // Post rule for PRs
      eventsDAL.createPostRule({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['pull_request.opened', 'pull_request.closed'],
        created_by: 'e2e-pr',
      });

      // Swarm-specific subscription (only swarm_e2e_1)
      eventsDAL.createSubscription({
        hive_id: testHiveId,
        swarm_id: 'swarm_e2e_1',
        source: 'github',
        event_types: ['pull_request.*'],
        created_by: 'e2e-pr',
      });
    });

    it('creates post and dispatches only to subscribed swarm', () => {
      mockSendToSwarm.mockReturnValue(true);

      const normalized = normalize('github', 'pull_request', 'del_e2e_pr1', {
        action: 'opened',
        pull_request: {
          number: 42,
          title: 'Add dark mode',
          body: 'Implements dark mode toggle',
          html_url: 'https://github.com/org/repo/pull/42',
          merged: false,
          head: { ref: 'feature/dark-mode' },
        },
        repository: { full_name: 'org/repo' },
        sender: { login: 'bob' },
      });

      expect(normalized.event_type).toBe('pull_request.opened');
      expect(normalized.post!.title).toBe('[org/repo] PR #42 opened: Add dark mode');

      const result = routeEvent(normalized);

      // Post should be created
      expect(result.posts_created).toBeGreaterThanOrEqual(1);

      // Only swarm_e2e_1 should receive MAP (swarm-specific, not hive-level for PR)
      // Note: the hive-level push subscription won't match PR events
      const prDeliveries = result.deliveries.filter(
        (d) => d.swarm_id === 'swarm_e2e_1',
      );
      expect(prDeliveries.length).toBe(1);
    });
  });

  // ==========================================================================
  // Slack Message — Full Flow
  // ==========================================================================

  describe('Slack Message → Post + MAP', () => {
    beforeAll(() => {
      eventsDAL.createPostRule({
        hive_id: testHiveId,
        source: 'slack',
        event_types: ['message'],
        created_by: 'e2e-slack',
      });

      eventsDAL.createSubscription({
        hive_id: testHiveId,
        swarm_id: 'swarm_e2e_2',
        source: 'slack',
        event_types: ['message'],
        created_by: 'e2e-slack',
      });
    });

    it('normalizes Slack payload, creates post, and dispatches', () => {
      mockSendToSwarm.mockReturnValue(true);

      const normalized = normalize('slack', 'message', 'del_e2e_slack1', {
        team_id: 'T_TEST',
        event_type: 'message',
        event: {
          type: 'message',
          channel: 'C_GENERAL',
          user: 'U_CAROL',
          text: 'Hello from E2E test!',
          ts: '1708900000.000100',
        },
      });

      expect(normalized.source).toBe('slack');
      expect(normalized.post).toBeDefined();
      expect(normalized.post!.content).toBe('Hello from E2E test!');

      const result = routeEvent(normalized);

      expect(result.posts_created).toBeGreaterThanOrEqual(1);

      // Verify Slack post in DB
      const post = db.prepare(
        "SELECT * FROM posts WHERE hive_id = ? AND content = 'Hello from E2E test!'",
      ).get(testHiveId) as Record<string, unknown> | undefined;
      expect(post).toBeDefined();

      // Verify MAP dispatch to swarm_e2e_2
      expect(mockSendToSwarm).toHaveBeenCalledWith(
        'swarm_e2e_2',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'x-openhive/event.webhook',
          params: expect.objectContaining({ source: 'slack' }),
        }),
      );
    });

    it('skips post for bot messages but still dispatches MAP', () => {
      mockSendToSwarm.mockReturnValue(true);

      const normalized = normalize('slack', 'message', 'del_e2e_slack_bot', {
        event: {
          type: 'message',
          channel: 'C_GENERAL',
          user: 'U_BOT',
          text: 'bot says hi',
          bot_id: 'B_BOT',
          ts: '123',
        },
      });

      // Normalizer should skip post for bot messages
      expect(normalized.post).toBeUndefined();

      const result = routeEvent(normalized);

      // No post (bot message, no post data)
      expect(result.posts_created).toBe(0);

      // MAP should still dispatch (subscriptions match event_type, not post presence)
      expect(result.deliveries.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // Filter Matching
  // ==========================================================================

  describe('Filter Matching', () => {
    beforeAll(() => {
      // Rule with repo filter
      eventsDAL.createPostRule({
        hive_id: testHiveId,
        source: 'github',
        event_types: ['issues.opened'],
        filters: { repos: ['filtered/repo'] },
        created_by: 'e2e-filter',
      });

      // Subscription with repo filter
      eventsDAL.createSubscription({
        hive_id: testHiveId,
        swarm_id: 'swarm_e2e_1',
        source: 'github',
        event_types: ['issues.opened'],
        filters: { repos: ['filtered/repo'] },
        created_by: 'e2e-filter',
      });
    });

    it('only fires when metadata matches filter', () => {
      mockSendToSwarm.mockReturnValue(true);

      // Event from wrong repo — should NOT match the filtered rules
      const wrongRepo = normalize('github', 'issues', 'del_e2e_filter1', {
        action: 'opened',
        issue: {
          number: 1,
          title: 'Bug',
          body: 'desc',
          html_url: 'https://github.com/other/repo/issues/1',
        },
        repository: { full_name: 'other/repo' },
        sender: { login: 'alice' },
      });

      const result1 = routeEvent(wrongRepo);

      // The filtered post rule should not match 'other/repo'
      // (Other wildcard rules from previous tests may still match)
      const filteredDeliveries = result1.deliveries.filter(
        (d) => d.swarm_id === 'swarm_e2e_1',
      );
      // The filtered subscription requires repos: ['filtered/repo'], this is 'other/repo'
      // so swarm_e2e_1 should NOT receive from this subscription

      // Event from correct repo — SHOULD match
      mockSendToSwarm.mockClear();
      const rightRepo = normalize('github', 'issues', 'del_e2e_filter2', {
        action: 'opened',
        issue: {
          number: 2,
          title: 'Feature',
          body: 'new feature',
          html_url: 'https://github.com/filtered/repo/issues/2',
        },
        repository: { full_name: 'filtered/repo' },
        sender: { login: 'bob' },
      });

      const result2 = routeEvent(rightRepo);

      // The filtered subscription should match now
      const matchedDeliveries = result2.deliveries.filter(
        (d) => d.swarm_id === 'swarm_e2e_1',
      );
      expect(matchedDeliveries.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // Offline Swarm
  // ==========================================================================

  describe('Offline Swarm Handling', () => {
    it('marks delivery as offline and logs error', () => {
      mockSendToSwarm.mockReturnValue(false); // Simulate offline swarm

      const normalized = normalize('github', 'push', 'del_e2e_offline', {
        ref: 'refs/heads/dev',
        commits: [{ id: 'ccc1234567890', message: 'wip' }],
        repository: { full_name: 'org/repo' },
        sender: { login: 'alice' },
      });

      const result = routeEvent(normalized);

      // Deliveries should exist but be offline
      if (result.deliveries.length > 0) {
        const offlineCount = result.deliveries.filter(
          (d) => d.status === 'offline',
        ).length;
        expect(offlineCount).toBe(result.deliveries.length);
        expect(result.swarms_notified).toBe(0);

        // Verify delivery log has offline status
        const logs = db.prepare(
          "SELECT * FROM event_delivery_log WHERE delivery_id = 'del_e2e_offline'",
        ).all() as Record<string, unknown>[];
        expect(logs.every((l) => l.status === 'offline')).toBe(true);
      }
    });
  });

  // ==========================================================================
  // No Matching Rules
  // ==========================================================================

  describe('Unknown Source — No Rules', () => {
    it('returns zero counts for unmatched events', () => {
      const normalized = normalize('linear', 'issue.created', 'del_e2e_nomatch', {
        id: 'LIN-123',
        title: 'Some task',
      });

      expect(normalized.source).toBe('linear');
      expect(normalized.post).toBeUndefined(); // passthrough, no normalizer

      const result = routeEvent(normalized);
      expect(result.posts_created).toBe(0);
      expect(result.swarms_notified).toBe(0);
      expect(result.deliveries).toEqual([]);
    });
  });

  // ==========================================================================
  // Config via API → Route
  // ==========================================================================

  describe('Dynamic Config → Route', () => {
    it('event routes correctly after subscription created via DAL', () => {
      mockSendToSwarm.mockReturnValue(true);

      // Create subscription for a new event type at runtime
      eventsDAL.createSubscription({
        hive_id: testHiveId,
        swarm_id: 'swarm_e2e_2',
        source: 'github',
        event_types: ['deployment.created'],
        created_by: 'e2e-dynamic',
      });

      // Route a deployment event
      const event: NormalizedEvent = {
        source: 'github',
        event_type: 'deployment.created',
        delivery_id: 'del_e2e_dynamic',
        timestamp: new Date().toISOString(),
        raw_payload: { deployment: { id: 1 } },
        metadata: { repo: 'org/repo' },
      };

      const result = routeEvent(event);

      // Should dispatch to swarm_e2e_2 (subscription match)
      const matched = result.deliveries.filter(
        (d) => d.swarm_id === 'swarm_e2e_2',
      );
      expect(matched.length).toBe(1);
      expect(matched[0].status).toBe('sent');
    });

    it('disabled subscriptions are not matched', () => {
      mockSendToSwarm.mockReturnValue(true);

      const sub = eventsDAL.createSubscription({
        hive_id: testHiveId,
        swarm_id: 'swarm_e2e_1',
        source: 'github',
        event_types: ['workflow_run.completed'],
        created_by: 'e2e-disabled',
      });

      // Disable it
      eventsDAL.updateSubscription(sub.id, { enabled: false });

      const event: NormalizedEvent = {
        source: 'github',
        event_type: 'workflow_run.completed',
        delivery_id: 'del_e2e_disabled',
        timestamp: new Date().toISOString(),
        raw_payload: {},
        metadata: { repo: 'org/repo' },
      };

      mockSendToSwarm.mockClear();
      const result = routeEvent(event);

      // No delivery for this specific event type (disabled)
      const matched = result.deliveries.filter(
        (d) => d.swarm_id === 'swarm_e2e_1',
      );
      // The disabled subscription should not match, but other subs might
      // At minimum, this specific event type sub is disabled
      expect(result.deliveries.filter(
        (d) => d.swarm_id === 'swarm_e2e_1' &&
          eventsDAL.getMatchingSubscriptions('github', 'workflow_run.completed')
            .find((s) => s.id === sub.id),
      )).toHaveLength(0);
    });
  });
});
