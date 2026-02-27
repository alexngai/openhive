import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { handleForwardedSlackEvent, clearManagedBridgeCache } from '../../swarmhub/webhook-handler.js';
import * as bridgeDAL from '../../db/dal/bridge.js';
import { encryptCredentials } from '../../bridge/credentials.js';
import type { ForwardedSlackEvent } from '../../swarmhub/types.js';

// Mock broadcastToChannel and hive lookup
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_DB_PATH = path.join(process.cwd(), 'test-swarmhub-webhook.db');
const ENCRYPTION_KEY = 'test-webhook-encryption-key';

function createTestAgent(db: ReturnType<typeof import('better-sqlite3')>, name: string): string {
  const id = `agent_${name}`;
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, account_type) VALUES (?, ?, 'human')
  `).run(id, name);
  return id;
}

describe('SwarmHub Webhook Handler', () => {
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = initDatabase(TEST_DB_PATH);
    testAgentId = createTestAgent(db, 'webhook-handler-test');
  });

  beforeEach(() => {
    clearManagedBridgeCache();
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  function createManagedBridge(teamId: string): string {
    const encrypted = encryptCredentials({ bot_token: 'xoxb-test' }, ENCRYPTION_KEY);
    const bridge = bridgeDAL.createBridge({
      name: `swarmhub:slack:${teamId}`,
      platform: 'slack',
      transport_mode: 'webhook',
      credentials_encrypted: encrypted,
      owner_agent_id: testAgentId,
    });
    return bridge.id;
  }

  function createChannelMapping(bridgeId: string, channelId: string, hiveName: string): void {
    // Create the hive first
    db.prepare(`
      INSERT OR IGNORE INTO hives (id, name, description, owner_id)
      VALUES (?, ?, 'Test hive', ?)
    `).run(`hive_${hiveName}`, hiveName, testAgentId);

    bridgeDAL.addChannelMapping(bridgeId, {
      platform_channel_id: channelId,
      platform_channel_name: channelId,
      hive_name: hiveName,
      direction: 'bidirectional',
    });
  }

  function makeSlackEvent(overrides?: Partial<ForwardedSlackEvent>): ForwardedSlackEvent {
    return {
      team_id: 'T01234567',
      event_type: 'message',
      event: {
        type: 'message',
        channel: 'C_GENERAL',
        user: 'U_USER123',
        text: 'Hello from Slack!',
        ts: '1708900000.000100',
      },
      event_id: 'Ev_test123',
      ...overrides,
    };
  }

  // ── Basic event processing ──

  describe('handleForwardedSlackEvent', () => {
    it('returns null when no bridge exists for team', () => {
      const result = handleForwardedSlackEvent(makeSlackEvent());
      expect(result).toBeNull();
    });

    it('returns null for non-message events', () => {
      const bridgeId = createManagedBridge('T01234567');
      createChannelMapping(bridgeId, 'C_GENERAL', 'wh-general');

      const result = handleForwardedSlackEvent(makeSlackEvent({
        event_type: 'app_mention',
        event: { type: 'app_mention', channel: 'C_GENERAL', user: 'U1', text: 'hi', ts: '123' },
      }));

      expect(result).toBeNull();
    });

    it('returns null for bot messages', () => {
      const bridgeId = createManagedBridge('T_BOT');
      createChannelMapping(bridgeId, 'C_BOT', 'wh-bot');

      const result = handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_BOT',
        event: {
          type: 'message',
          channel: 'C_BOT',
          user: 'U_BOT',
          text: 'bot message',
          ts: '123',
          bot_id: 'B_BOT',
        },
      }));

      expect(result).toBeNull();
    });

    it('returns null for message edits/deletes (subtypes)', () => {
      const bridgeId = createManagedBridge('T_EDIT');
      createChannelMapping(bridgeId, 'C_EDIT', 'wh-edit');

      const result = handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_EDIT',
        event: {
          type: 'message',
          subtype: 'message_changed',
          channel: 'C_EDIT',
          user: 'U1',
          text: 'edited',
          ts: '123',
        },
      }));

      expect(result).toBeNull();
    });

    it('returns null for messages without user or text', () => {
      const bridgeId = createManagedBridge('T_EMPTY');
      createChannelMapping(bridgeId, 'C_EMPTY', 'wh-empty');

      const result = handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_EMPTY',
        event: { type: 'message', channel: 'C_EMPTY', ts: '123' },
      }));

      expect(result).toBeNull();
    });

    it('processes a message event and creates a post', () => {
      const bridgeId = createManagedBridge('T_POST');
      createChannelMapping(bridgeId, 'C_POST', 'wh-post');

      const result = handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_POST',
        event: {
          type: 'message',
          channel: 'C_POST',
          user: 'U_ALICE',
          text: 'Hello from SwarmHub Slack!',
          ts: '1708900001.000200',
        },
      }));

      expect(result).not.toBeNull();
      expect(result!.action).toBe('post_created');
      expect(result!.postId).toBeDefined();
      expect(result!.proxyAgentId).toBeDefined();
    });

    it('creates a comment for threaded replies', () => {
      const bridgeId = createManagedBridge('T_THREAD');
      createChannelMapping(bridgeId, 'C_THREAD', 'wh-thread');

      // First: create a parent post
      const parentResult = handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_THREAD',
        event: {
          type: 'message',
          channel: 'C_THREAD',
          user: 'U_BOB',
          text: 'Parent message',
          ts: '1708900002.000300',
        },
      }));

      expect(parentResult).not.toBeNull();
      expect(parentResult!.action).toBe('post_created');

      // Then: create a threaded reply
      const replyResult = handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_THREAD',
        event: {
          type: 'message',
          channel: 'C_THREAD',
          user: 'U_CAROL',
          text: 'Reply to parent',
          ts: '1708900003.000400',
          thread_ts: '1708900002.000300',
        },
      }));

      expect(replyResult).not.toBeNull();
      expect(replyResult!.action).toBe('comment_created');
      expect(replyResult!.postId).toBe(parentResult!.postId);
      expect(replyResult!.commentId).toBeDefined();
    });

    it('allows file_share subtype through', () => {
      const bridgeId = createManagedBridge('T_FILE');
      createChannelMapping(bridgeId, 'C_FILE', 'wh-file');

      const result = handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_FILE',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C_FILE',
          user: 'U_DAVE',
          text: 'Check out this file',
          ts: '1708900004.000500',
          files: [{
            url_private: 'https://files.slack.com/test.png',
            name: 'test.png',
            mimetype: 'image/png',
          }],
        },
      }));

      expect(result).not.toBeNull();
      expect(result!.action).toBe('post_created');
    });

    it('skips events for unmapped channels', () => {
      createManagedBridge('T_UNMAPPED');
      // No channel mapping created

      const result = handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_UNMAPPED',
        event: {
          type: 'message',
          channel: 'C_UNMAPPED',
          user: 'U1',
          text: 'no mapping',
          ts: '123',
        },
      }));

      // The bridge exists but channel has no mapping
      expect(result).not.toBeNull();
      expect(result!.action).toBe('skipped');
      expect(result!.reason).toBe('no_channel_mapping');
    });

    it('caches bridge lookup across calls', () => {
      const bridgeId = createManagedBridge('T_CACHE');
      createChannelMapping(bridgeId, 'C_CACHE', 'wh-cache');

      // First call
      handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_CACHE',
        event: {
          type: 'message',
          channel: 'C_CACHE',
          user: 'U1',
          text: 'msg 1',
          ts: '100.001',
        },
      }));

      // Second call (should use cached bridge ID)
      const result = handleForwardedSlackEvent(makeSlackEvent({
        team_id: 'T_CACHE',
        event: {
          type: 'message',
          channel: 'C_CACHE',
          user: 'U1',
          text: 'msg 2',
          ts: '100.002',
        },
      }));

      expect(result).not.toBeNull();
      expect(result!.action).toBe('post_created');
    });
  });
});
