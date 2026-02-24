import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as bridgeDAL from '../../db/dal/bridge.js';
import { processOutboundEvent, type HiveEvent } from '../../bridge/outbound.js';
import type { BridgeConfig, ChannelMapping } from '../../bridge/types.js';

const TEST_DB_PATH = path.join(process.cwd(), 'test-outbound.db');

function createTestAgent(db: ReturnType<typeof import('better-sqlite3')>, name: string): string {
  const id = `agent_${name}`;
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, account_type) VALUES (?, ?, 'human')
  `).run(id, name);
  return id;
}

describe('Outbound Pipeline', () => {
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;
  let proxyAgentId: string;
  let bridgeConfig: BridgeConfig;
  let mappings: ChannelMapping[];

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = initDatabase(TEST_DB_PATH);
    testAgentId = createTestAgent(db, 'outbound-test-owner');
    proxyAgentId = createTestAgent(db, 'proxy-slack-user');

    // Create a bridge
    bridgeConfig = bridgeDAL.createBridge({
      name: 'outbound-test-slack',
      platform: 'slack',
      transport_mode: 'outbound',
      credentials_encrypted: 'encrypted',
      owner_agent_id: testAgentId,
    });

    // Create channel mappings
    const bidir = bridgeDAL.addChannelMapping(bridgeConfig.id, {
      platform_channel_id: 'C_BIDIR',
      platform_channel_name: '#general',
      hive_name: 'general',
      direction: 'bidirectional',
    });

    const inboundOnly = bridgeDAL.addChannelMapping(bridgeConfig.id, {
      platform_channel_id: 'C_INONLY',
      hive_name: 'general',
      direction: 'inbound',
    });

    const outboundOnly = bridgeDAL.addChannelMapping(bridgeConfig.id, {
      platform_channel_id: 'C_OUTONLY',
      hive_name: 'general',
      direction: 'outbound',
    });

    mappings = [bidir, inboundOnly, outboundOnly];

    // Register the proxy agent
    bridgeDAL.createProxyAgent({
      bridge_id: bridgeConfig.id,
      platform_user_id: 'U_PROXY',
      agent_id: proxyAgentId,
      platform_display_name: 'Slack User',
    });
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  function makeEvent(overrides: Partial<HiveEvent> = {}): HiveEvent {
    return {
      type: 'new_post',
      postId: 'post_123',
      authorId: testAgentId,
      authorName: 'Test Agent',
      hiveName: 'general',
      title: 'Test Post',
      content: 'Test content from OpenHive',
      ...overrides,
    };
  }

  // ── Echo prevention ──

  it('skips events from proxy agents (echo prevention)', () => {
    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent({
      authorId: proxyAgentId,
    }));
    expect(actions).toHaveLength(0);
  });

  // ── Direction filtering ──

  it('skips inbound-only channel mappings', () => {
    // Only bidirectional and outbound mappings should produce actions
    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent());
    const channelIds = actions.map(a => a.destination.platformChannelId);
    expect(channelIds).not.toContain('C_INONLY');
  });

  it('includes bidirectional channel mappings', () => {
    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent());
    const channelIds = actions.map(a => a.destination.platformChannelId);
    expect(channelIds).toContain('C_BIDIR');
  });

  it('includes outbound-only channel mappings', () => {
    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent());
    const channelIds = actions.map(a => a.destination.platformChannelId);
    expect(channelIds).toContain('C_OUTONLY');
  });

  // ── Post formatting ──

  it('formats a post with title and content', () => {
    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent({
      title: 'My Title',
      content: 'My Content',
    }));
    expect(actions.length).toBeGreaterThan(0);
    const msg = actions[0].message;
    expect(msg.text).toContain('**Test Agent**');
    expect(msg.text).toContain('*My Title*');
    expect(msg.text).toContain('My Content');
  });

  it('formats a post where title equals content', () => {
    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent({
      title: 'Same text',
      content: 'Same text',
    }));
    expect(actions.length).toBeGreaterThan(0);
    const msg = actions[0].message;
    expect(msg.text).toBe('**Test Agent**: Same text');
  });

  // ── Comment formatting ──

  it('formats a comment event', () => {
    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent({
      type: 'new_comment',
      commentId: 'comment_456',
      content: 'A comment',
    }));
    expect(actions.length).toBeGreaterThan(0);
    const msg = actions[0].message;
    expect(msg.text).toBe('**Test Agent**: A comment');
  });

  // ── Thread context ──

  it('includes thread context for comments when mapping exists', () => {
    // Look up the actual hive ID from seed data
    const hive = db.prepare("SELECT id FROM hives WHERE name = 'general'").get() as { id: string };

    // Create a post that has a message mapping
    db.prepare(`
      INSERT OR IGNORE INTO posts (id, hive_id, author_id, title) VALUES ('post_thread_test', ?, ?, 'Thread Test')
    `).run(hive.id, testAgentId);

    bridgeDAL.recordMessageMapping({
      bridge_id: bridgeConfig.id,
      platform_message_id: 'slack_msg_parent',
      platform_channel_id: 'C_BIDIR',
      post_id: 'post_thread_test',
    });

    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent({
      type: 'new_comment',
      postId: 'post_thread_test',
      commentId: 'comment_789',
      content: 'Threaded reply',
    }));

    const bidirAction = actions.find(a => a.destination.platformChannelId === 'C_BIDIR');
    expect(bidirAction).toBeDefined();
    expect(bidirAction!.destination.threadId).toBe('slack_msg_parent');
  });

  it('sends without thread context when no mapping exists', () => {
    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent({
      type: 'new_comment',
      postId: 'post_no_mapping',
      commentId: 'comment_no_map',
      content: 'No thread context',
    }));

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.destination.threadId).toBeUndefined();
    }
  });

  // ── Non-matching hive ──

  it('returns no actions for unmapped hives', () => {
    const actions = processOutboundEvent(bridgeConfig, mappings, makeEvent({
      hiveName: 'some-other-hive',
    }));
    expect(actions).toHaveLength(0);
  });
});
