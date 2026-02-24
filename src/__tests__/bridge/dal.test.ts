import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as bridgeDAL from '../../db/dal/bridge.js';

const TEST_DB_PATH = path.join(process.cwd(), 'test-bridge-dal.db');

// Create a test agent directly since we need a valid agent_id for foreign keys
function createTestAgent(db: ReturnType<typeof import('better-sqlite3')>, name: string): string {
  const id = `agent_${name}`;
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, account_type) VALUES (?, ?, 'human')
  `).run(id, name);
  return id;
}

function createTestHive(db: ReturnType<typeof import('better-sqlite3')>, name: string): string {
  const id = `hive_${name}`;
  db.prepare(`
    INSERT OR IGNORE INTO hives (id, name, is_public) VALUES (?, ?, 1)
  `).run(id, name);
  return id;
}

describe('Bridge DAL', () => {
  let db: ReturnType<typeof import('better-sqlite3')>;
  let testAgentId: string;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = initDatabase(TEST_DB_PATH);
    testAgentId = createTestAgent(db, 'bridge-test-user');
    createTestHive(db, 'general');
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  // ── Bridge Configs ──

  describe('Bridge Configs', () => {
    it('creates a bridge config', () => {
      const bridge = bridgeDAL.createBridge({
        name: 'team-slack',
        platform: 'slack',
        transport_mode: 'outbound',
        credentials_encrypted: 'encrypted-data-here',
        owner_agent_id: testAgentId,
      });

      expect(bridge.id).toMatch(/^bridge_/);
      expect(bridge.name).toBe('team-slack');
      expect(bridge.platform).toBe('slack');
      expect(bridge.transport_mode).toBe('outbound');
      expect(bridge.status).toBe('inactive');
      expect(bridge.error_message).toBeNull();
    });

    it('gets a bridge by ID', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const fetched = bridgeDAL.getBridge(bridge.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('team-slack');
    });

    it('lists bridges', () => {
      bridgeDAL.createBridge({
        name: 'ops-discord',
        platform: 'discord',
        transport_mode: 'outbound',
        credentials_encrypted: 'encrypted',
        owner_agent_id: testAgentId,
      });

      const all = bridgeDAL.listBridges();
      expect(all.length).toBeGreaterThanOrEqual(2);

      const byOwner = bridgeDAL.listBridges(testAgentId);
      expect(byOwner.length).toBeGreaterThanOrEqual(2);
    });

    it('updates a bridge', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const updated = bridgeDAL.updateBridge(bridge.id, {
        status: 'active',
        error_message: null,
      });
      expect(updated!.status).toBe('active');
    });

    it('deletes a bridge', () => {
      const bridge = bridgeDAL.createBridge({
        name: 'to-delete',
        platform: 'telegram',
        transport_mode: 'outbound',
        credentials_encrypted: 'encrypted',
        owner_agent_id: testAgentId,
      });

      expect(bridgeDAL.deleteBridge(bridge.id)).toBe(true);
      expect(bridgeDAL.getBridge(bridge.id)).toBeNull();
    });
  });

  // ── Channel Mappings ──

  describe('Channel Mappings', () => {
    it('adds a channel mapping', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const mapping = bridgeDAL.addChannelMapping(bridge.id, {
        platform_channel_id: 'C0ABC123',
        platform_channel_name: '#general',
        hive_name: 'general',
      });

      expect(mapping.id).toMatch(/^cm_/);
      expect(mapping.platform_channel_id).toBe('C0ABC123');
      expect(mapping.hive_name).toBe('general');
      expect(mapping.direction).toBe('bidirectional');
      expect(mapping.thread_mode).toBe('post_per_message');
    });

    it('gets mappings for a bridge', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const mappings = bridgeDAL.getChannelMappings(bridge.id);
      expect(mappings.length).toBeGreaterThanOrEqual(1);
    });

    it('looks up by platform channel', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const mapping = bridgeDAL.getChannelMappingByPlatformChannel(bridge.id, 'C0ABC123');
      expect(mapping).not.toBeNull();
      expect(mapping!.hive_name).toBe('general');
    });

    it('looks up by hive name', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const mappings = bridgeDAL.getChannelMappingsByHive(bridge.id, 'general');
      expect(mappings.length).toBeGreaterThanOrEqual(1);
    });

    it('deletes a channel mapping', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const mapping = bridgeDAL.addChannelMapping(bridge.id, {
        platform_channel_id: 'C0DELETE',
        hive_name: 'general',
      });
      expect(bridgeDAL.deleteChannelMapping(mapping.id)).toBe(true);
      expect(bridgeDAL.getChannelMapping(mapping.id)).toBeNull();
    });
  });

  // ── Proxy Agents ──

  describe('Proxy Agents', () => {
    it('creates a proxy agent', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const proxyAgentId = createTestAgent(db, 'slack-jane-doe');

      const proxy = bridgeDAL.createProxyAgent({
        bridge_id: bridge.id,
        platform_user_id: 'U0XYZ789',
        agent_id: proxyAgentId,
        platform_display_name: 'Jane Doe',
        platform_avatar_url: 'https://example.com/avatar.png',
      });

      expect(proxy.id).toMatch(/^bpa_/);
      expect(proxy.platform_user_id).toBe('U0XYZ789');
      expect(proxy.agent_id).toBe(proxyAgentId);
    });

    it('looks up proxy agent by platform user', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const proxy = bridgeDAL.getProxyAgentByPlatformUser(bridge.id, 'U0XYZ789');
      expect(proxy).not.toBeNull();
      expect(proxy!.platform_display_name).toBe('Jane Doe');
    });

    it('lists proxy agents for a bridge', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const proxies = bridgeDAL.listProxyAgents(bridge.id);
      expect(proxies.length).toBeGreaterThanOrEqual(1);
    });

    it('checks if agent is a proxy for a bridge', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const proxy = bridgeDAL.getProxyAgentByPlatformUser(bridge.id, 'U0XYZ789')!;

      expect(bridgeDAL.isProxyAgentForBridge(bridge.id, proxy.agent_id)).toBe(true);
      expect(bridgeDAL.isProxyAgentForBridge(bridge.id, 'nonexistent')).toBe(false);
    });
  });

  // ── Message Mappings ──

  describe('Message Mappings', () => {
    it('records a message mapping for a post', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;

      // Create a test post (use the default seeded hive ID)
      const hive = db.prepare("SELECT id FROM hives WHERE name = 'general'").get() as { id: string };
      db.prepare(`
        INSERT INTO posts (id, hive_id, author_id, title) VALUES ('post_test1', ?, ?, 'Test')
      `).run(hive.id, testAgentId);

      const mapping = bridgeDAL.recordMessageMapping({
        bridge_id: bridge.id,
        platform_message_id: '1708444800.001200',
        platform_channel_id: 'C0ABC123',
        post_id: 'post_test1',
      });

      expect(mapping.id).toMatch(/^bmm_/);
      expect(mapping.post_id).toBe('post_test1');
      expect(mapping.comment_id).toBeNull();
    });

    it('looks up message mapping by platform message ID', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const mapping = bridgeDAL.getMessageMapping(bridge.id, '1708444800.001200');
      expect(mapping).not.toBeNull();
      expect(mapping!.post_id).toBe('post_test1');
    });

    it('looks up message mapping by post ID', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const mapping = bridgeDAL.getMessageMappingByPost(bridge.id, 'post_test1');
      expect(mapping).not.toBeNull();
      expect(mapping!.platform_message_id).toBe('1708444800.001200');
    });

    it('returns null for unknown platform message', () => {
      const bridge = bridgeDAL.getBridgeByName('team-slack')!;
      const mapping = bridgeDAL.getMessageMapping(bridge.id, 'nonexistent');
      expect(mapping).toBeNull();
    });
  });

  // ── Cascade Deletes ──

  describe('Cascade Deletes', () => {
    it('deleting a bridge cascades to mappings and proxy agents', () => {
      const proxyAgentId = createTestAgent(db, 'slack-cascade-user');
      const bridge = bridgeDAL.createBridge({
        name: 'cascade-test',
        platform: 'slack',
        transport_mode: 'outbound',
        credentials_encrypted: 'encrypted',
        owner_agent_id: testAgentId,
      });

      bridgeDAL.addChannelMapping(bridge.id, {
        platform_channel_id: 'C_CASCADE',
        hive_name: 'general',
      });

      bridgeDAL.createProxyAgent({
        bridge_id: bridge.id,
        platform_user_id: 'U_CASCADE',
        agent_id: proxyAgentId,
      });

      // Verify they exist
      expect(bridgeDAL.getChannelMappings(bridge.id).length).toBe(1);
      expect(bridgeDAL.listProxyAgents(bridge.id).length).toBe(1);

      // Delete bridge
      bridgeDAL.deleteBridge(bridge.id);

      // Verify cascade
      expect(bridgeDAL.getChannelMappings(bridge.id).length).toBe(0);
      expect(bridgeDAL.listProxyAgents(bridge.id).length).toBe(0);
    });
  });
});
