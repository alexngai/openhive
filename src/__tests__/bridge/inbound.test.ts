import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as bridgeDAL from '../../db/dal/bridge.js';
import { findPostById } from '../../db/dal/posts.js';
import { findCommentById } from '../../db/dal/comments.js';
import { processInboundMessage } from '../../bridge/inbound.js';
import type { InboundMessage } from '../../bridge/types.js';

// Mock broadcastToChannel to avoid WebSocket setup
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_DB_PATH = path.join(process.cwd(), 'test-inbound.db');

function createTestAgent(db: ReturnType<typeof import('better-sqlite3')>, name: string): string {
  const id = `agent_${name}`;
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, account_type) VALUES (?, ?, 'human')
  `).run(id, name);
  return id;
}

function makeInboundMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platformMessageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    platform: 'slack',
    platformChannelId: 'C0ABC123',
    author: {
      platformUserId: 'U0USER1',
      displayName: 'Test User',
      avatarUrl: 'https://example.com/avatar.png',
    },
    content: {
      text: 'Hello from Slack!',
    },
    timestamp: new Date().toISOString(),
    platformMeta: {},
    ...overrides,
  };
}

describe('Inbound Pipeline', () => {
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;
  let bridgeId: string;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = initDatabase(TEST_DB_PATH);
    testAgentId = createTestAgent(db, 'inbound-test-owner');

    // Create a bridge
    const bridge = bridgeDAL.createBridge({
      name: 'inbound-test-slack',
      platform: 'slack',
      transport_mode: 'outbound',
      credentials_encrypted: 'encrypted',
      owner_agent_id: testAgentId,
    });
    bridgeId = bridge.id;
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  // ── Skipped scenarios ──

  describe('skip conditions', () => {
    it('skips when no channel mapping exists', () => {
      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformChannelId: 'C_UNMAPPED',
      }));
      expect(result.action).toBe('skipped');
      expect(result.reason).toBe('no_channel_mapping');
    });

    it('skips outbound-only channels', () => {
      bridgeDAL.addChannelMapping(bridgeId, {
        platform_channel_id: 'C_OUTONLY',
        hive_name: 'general',
        direction: 'outbound',
      });

      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformChannelId: 'C_OUTONLY',
      }));
      expect(result.action).toBe('skipped');
      expect(result.reason).toBe('outbound_only_channel');
    });

    it('skips when hive does not exist', () => {
      bridgeDAL.addChannelMapping(bridgeId, {
        platform_channel_id: 'C_NOHIVE',
        hive_name: 'nonexistent-hive',
      });

      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformChannelId: 'C_NOHIVE',
      }));
      expect(result.action).toBe('skipped');
      expect(result.reason).toBe('hive_not_found');
    });

    it('skips explicit_only thread mode', () => {
      bridgeDAL.addChannelMapping(bridgeId, {
        platform_channel_id: 'C_EXPLICIT',
        hive_name: 'general',
        thread_mode: 'explicit_only',
      });

      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformChannelId: 'C_EXPLICIT',
      }));
      expect(result.action).toBe('skipped');
      expect(result.reason).toBe('explicit_only_not_triggered');
    });
  });

  // ── post_per_message mode ──

  describe('post_per_message mode', () => {
    beforeAll(() => {
      bridgeDAL.addChannelMapping(bridgeId, {
        platform_channel_id: 'C0ABC123',
        platform_channel_name: '#general',
        hive_name: 'general',
        thread_mode: 'post_per_message',
      });
    });

    it('creates a post for a top-level message', () => {
      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_toplevel_1',
        content: { text: 'New message from Slack' },
      }));

      expect(result.action).toBe('post_created');
      expect(result.postId).toBeDefined();
      expect(result.proxyAgentId).toBeDefined();

      // Verify the post was created
      const post = findPostById(result.postId!);
      expect(post).not.toBeNull();
      expect(post!.title).toBe('New message from Slack');
      expect(post!.content).toBe('New message from Slack');
    });

    it('creates a proxy agent on first message', () => {
      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_proxy_test',
        author: {
          platformUserId: 'U_NEWUSER',
          displayName: 'New User',
        },
      }));

      expect(result.proxyAgentId).toBeDefined();

      // Verify proxy agent was created
      const proxy = bridgeDAL.getProxyAgentByPlatformUser(bridgeId, 'U_NEWUSER');
      expect(proxy).not.toBeNull();
      expect(proxy!.platform_display_name).toBe('New User');
      expect(proxy!.agent_id).toBe(result.proxyAgentId);
    });

    it('reuses existing proxy agent on subsequent messages', () => {
      const msg1 = makeInboundMessage({
        platformMessageId: 'msg_reuse_1',
        author: { platformUserId: 'U_REUSE', displayName: 'Reuse User' },
      });
      const msg2 = makeInboundMessage({
        platformMessageId: 'msg_reuse_2',
        author: { platformUserId: 'U_REUSE', displayName: 'Reuse User' },
      });

      const result1 = processInboundMessage(bridgeId, msg1);
      const result2 = processInboundMessage(bridgeId, msg2);

      expect(result1.proxyAgentId).toBe(result2.proxyAgentId);
    });

    it('creates a comment for a thread reply', () => {
      // First, create a top-level message
      const parentResult = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_parent',
        content: { text: 'Parent message' },
      }));
      expect(parentResult.action).toBe('post_created');

      // Now send a thread reply
      const replyResult = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_reply_1',
        content: { text: 'Thread reply' },
        thread: { parentMessageId: 'msg_parent' },
      }));

      expect(replyResult.action).toBe('comment_created');
      expect(replyResult.postId).toBe(parentResult.postId);
      expect(replyResult.commentId).toBeDefined();

      // Verify the comment
      const comment = findCommentById(replyResult.commentId!);
      expect(comment).not.toBeNull();
      expect(comment!.content).toBe('Thread reply');
      expect(comment!.post_id).toBe(parentResult.postId);
    });

    it('creates a post when thread parent is unknown', () => {
      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_orphan_reply',
        content: { text: 'Reply to unknown parent' },
        thread: { parentMessageId: 'msg_nonexistent' },
      }));

      // Should fall through to creating a post
      expect(result.action).toBe('post_created');
      expect(result.postId).toBeDefined();
    });

    it('extracts mentions from message text', () => {
      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_mentions',
        content: { text: '@infra-swarm check worker-3' },
      }));

      expect(result.mentions).toContain('infra-swarm');
    });

    it('merges adapter-provided mentions', () => {
      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_adapter_mentions',
        content: { text: 'check this out' },
        mentions: ['research-bot'],
      }));

      expect(result.mentions).toContain('research-bot');
    });

    it('records message mapping for posts', () => {
      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_mapping_test',
        content: { text: 'Mapping test' },
      }));

      const mapping = bridgeDAL.getMessageMapping(bridgeId, 'msg_mapping_test');
      expect(mapping).not.toBeNull();
      expect(mapping!.post_id).toBe(result.postId);
      expect(mapping!.comment_id).toBeNull();
    });

    it('records message mapping for comments', () => {
      // Create parent
      processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_map_parent',
        content: { text: 'Parent for mapping' },
      }));

      // Create reply
      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_map_reply',
        content: { text: 'Reply for mapping' },
        thread: { parentMessageId: 'msg_map_parent' },
      }));

      const mapping = bridgeDAL.getMessageMapping(bridgeId, 'msg_map_reply');
      expect(mapping).not.toBeNull();
      expect(mapping!.post_id).toBe(result.postId);
      expect(mapping!.comment_id).toBe(result.commentId);
    });

    it('truncates long titles', () => {
      const longText = 'A'.repeat(300);
      const result = processInboundMessage(bridgeId, makeInboundMessage({
        platformMessageId: 'msg_long_title',
        content: { text: longText },
      }));

      const post = findPostById(result.postId!);
      expect(post!.title.length).toBeLessThanOrEqual(200);
      expect(post!.title.endsWith('...')).toBe(true);
    });
  });

  // ── single_thread mode ──

  describe('single_thread mode', () => {
    let singleThreadBridgeId: string;

    beforeAll(() => {
      const bridge = bridgeDAL.createBridge({
        name: 'single-thread-test',
        platform: 'discord',
        transport_mode: 'outbound',
        credentials_encrypted: 'encrypted',
        owner_agent_id: testAgentId,
      });
      singleThreadBridgeId = bridge.id;

      bridgeDAL.addChannelMapping(singleThreadBridgeId, {
        platform_channel_id: 'C_SINGLE',
        platform_channel_name: '#single-thread',
        hive_name: 'general',
        thread_mode: 'single_thread',
      });
    });

    it('creates an anchor post on first message', () => {
      const result = processInboundMessage(singleThreadBridgeId, makeInboundMessage({
        platformMessageId: 'msg_st_1',
        platformChannelId: 'C_SINGLE',
        content: { text: 'First single-thread message' },
      }));

      expect(result.action).toBe('comment_created');
      expect(result.postId).toBeDefined();
      expect(result.commentId).toBeDefined();

      // Verify anchor post was created
      const post = findPostById(result.postId!);
      expect(post).not.toBeNull();
      expect(post!.title).toContain('Bridge:');
    });

    it('adds comments to the same anchor post', () => {
      const result1 = processInboundMessage(singleThreadBridgeId, makeInboundMessage({
        platformMessageId: 'msg_st_2',
        platformChannelId: 'C_SINGLE',
        content: { text: 'Second message' },
      }));

      const result2 = processInboundMessage(singleThreadBridgeId, makeInboundMessage({
        platformMessageId: 'msg_st_3',
        platformChannelId: 'C_SINGLE',
        content: { text: 'Third message' },
      }));

      // Both should be comments on the same post
      expect(result1.action).toBe('comment_created');
      expect(result2.action).toBe('comment_created');
      expect(result1.postId).toBe(result2.postId);
      expect(result1.commentId).not.toBe(result2.commentId);
    });
  });
});
