/**
 * Bridge Data Access Layer
 *
 * CRUD operations for bridge configs, channel mappings,
 * proxy agents, and message mappings.
 */

import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type {
  BridgeConfig,
  ChannelMapping,
  ProxyAgent,
  MessageMapping,
  BridgePlatform,
  TransportMode,
  BridgeDirection,
  ThreadMode,
  BridgeStatusType,
} from '../../bridge/types.js';

// ============================================================================
// Helpers
// ============================================================================

function rowToBridgeConfig(row: Record<string, unknown>): BridgeConfig {
  return {
    id: row.id as string,
    name: row.name as string,
    platform: row.platform as BridgePlatform,
    transport_mode: row.transport_mode as TransportMode,
    credentials_encrypted: row.credentials_encrypted as string,
    status: row.status as BridgeStatusType,
    error_message: row.error_message as string | null,
    owner_agent_id: row.owner_agent_id as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToChannelMapping(row: Record<string, unknown>): ChannelMapping {
  return {
    id: row.id as string,
    bridge_id: row.bridge_id as string,
    platform_channel_id: row.platform_channel_id as string,
    platform_channel_name: row.platform_channel_name as string | null,
    hive_name: row.hive_name as string,
    direction: row.direction as BridgeDirection,
    thread_mode: row.thread_mode as ThreadMode,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToProxyAgent(row: Record<string, unknown>): ProxyAgent {
  return {
    id: row.id as string,
    bridge_id: row.bridge_id as string,
    platform_user_id: row.platform_user_id as string,
    agent_id: row.agent_id as string,
    platform_display_name: row.platform_display_name as string | null,
    platform_avatar_url: row.platform_avatar_url as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToMessageMapping(row: Record<string, unknown>): MessageMapping {
  return {
    id: row.id as string,
    bridge_id: row.bridge_id as string,
    platform_message_id: row.platform_message_id as string,
    platform_channel_id: row.platform_channel_id as string,
    post_id: row.post_id as string | null,
    comment_id: row.comment_id as string | null,
    created_at: row.created_at as string,
  };
}

// ============================================================================
// Bridge Configs
// ============================================================================

export function createBridge(input: {
  name: string;
  platform: BridgePlatform;
  transport_mode: TransportMode;
  credentials_encrypted: string;
  owner_agent_id: string;
}): BridgeConfig {
  const db = getDatabase();
  const id = `bridge_${nanoid()}`;

  db.prepare(`
    INSERT INTO bridge_configs (id, name, platform, transport_mode, credentials_encrypted, owner_agent_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.name, input.platform, input.transport_mode, input.credentials_encrypted, input.owner_agent_id);

  return getBridge(id)!;
}

export function getBridge(id: string): BridgeConfig | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM bridge_configs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToBridgeConfig(row) : null;
}

export function getBridgeByName(name: string): BridgeConfig | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM bridge_configs WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  return row ? rowToBridgeConfig(row) : null;
}

export function listBridges(ownerId?: string): BridgeConfig[] {
  const db = getDatabase();
  if (ownerId) {
    const rows = db.prepare(
      'SELECT * FROM bridge_configs WHERE owner_agent_id = ? ORDER BY created_at DESC'
    ).all(ownerId) as Record<string, unknown>[];
    return rows.map(rowToBridgeConfig);
  }
  const rows = db.prepare('SELECT * FROM bridge_configs ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToBridgeConfig);
}

export function updateBridge(id: string, updates: {
  name?: string;
  transport_mode?: TransportMode;
  credentials_encrypted?: string;
  status?: BridgeStatusType;
  error_message?: string | null;
}): BridgeConfig | null {
  const db = getDatabase();
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
  if (updates.transport_mode !== undefined) { sets.push('transport_mode = ?'); values.push(updates.transport_mode); }
  if (updates.credentials_encrypted !== undefined) { sets.push('credentials_encrypted = ?'); values.push(updates.credentials_encrypted); }
  if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
  if (updates.error_message !== undefined) { sets.push('error_message = ?'); values.push(updates.error_message); }

  values.push(id);
  db.prepare(`UPDATE bridge_configs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getBridge(id);
}

export function deleteBridge(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM bridge_configs WHERE id = ?').run(id);
  return result.changes > 0;
}

// ============================================================================
// Channel Mappings
// ============================================================================

export function addChannelMapping(bridgeId: string, input: {
  platform_channel_id: string;
  platform_channel_name?: string;
  hive_name: string;
  direction?: BridgeDirection;
  thread_mode?: ThreadMode;
}): ChannelMapping {
  const db = getDatabase();
  const id = `cm_${nanoid()}`;

  db.prepare(`
    INSERT INTO bridge_channel_mappings (id, bridge_id, platform_channel_id, platform_channel_name, hive_name, direction, thread_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    bridgeId,
    input.platform_channel_id,
    input.platform_channel_name || null,
    input.hive_name,
    input.direction || 'bidirectional',
    input.thread_mode || 'post_per_message',
  );

  return getChannelMapping(id)!;
}

export function getChannelMapping(id: string): ChannelMapping | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM bridge_channel_mappings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToChannelMapping(row) : null;
}

export function getChannelMappings(bridgeId: string): ChannelMapping[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM bridge_channel_mappings WHERE bridge_id = ? ORDER BY created_at'
  ).all(bridgeId) as Record<string, unknown>[];
  return rows.map(rowToChannelMapping);
}

export function getChannelMappingByPlatformChannel(
  bridgeId: string,
  platformChannelId: string,
): ChannelMapping | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM bridge_channel_mappings WHERE bridge_id = ? AND platform_channel_id = ?'
  ).get(bridgeId, platformChannelId) as Record<string, unknown> | undefined;
  return row ? rowToChannelMapping(row) : null;
}

export function getChannelMappingsByHive(
  bridgeId: string,
  hiveName: string,
): ChannelMapping[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM bridge_channel_mappings WHERE bridge_id = ? AND hive_name = ?'
  ).all(bridgeId, hiveName) as Record<string, unknown>[];
  return rows.map(rowToChannelMapping);
}

export function deleteChannelMapping(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM bridge_channel_mappings WHERE id = ?').run(id);
  return result.changes > 0;
}

// ============================================================================
// Proxy Agents
// ============================================================================

export function getProxyAgentByPlatformUser(
  bridgeId: string,
  platformUserId: string,
): ProxyAgent | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM bridge_proxy_agents WHERE bridge_id = ? AND platform_user_id = ?'
  ).get(bridgeId, platformUserId) as Record<string, unknown> | undefined;
  return row ? rowToProxyAgent(row) : null;
}

export function createProxyAgent(input: {
  bridge_id: string;
  platform_user_id: string;
  agent_id: string;
  platform_display_name?: string;
  platform_avatar_url?: string;
}): ProxyAgent {
  const db = getDatabase();
  const id = `bpa_${nanoid()}`;

  db.prepare(`
    INSERT INTO bridge_proxy_agents (id, bridge_id, platform_user_id, agent_id, platform_display_name, platform_avatar_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.bridge_id,
    input.platform_user_id,
    input.agent_id,
    input.platform_display_name || null,
    input.platform_avatar_url || null,
  );

  const row = db.prepare('SELECT * FROM bridge_proxy_agents WHERE id = ?').get(id) as Record<string, unknown>;
  return rowToProxyAgent(row);
}

export function listProxyAgents(bridgeId: string): ProxyAgent[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM bridge_proxy_agents WHERE bridge_id = ? ORDER BY created_at'
  ).all(bridgeId) as Record<string, unknown>[];
  return rows.map(rowToProxyAgent);
}

/**
 * Check if a given agent ID is a proxy agent for a specific bridge.
 */
export function isProxyAgentForBridge(bridgeId: string, agentId: string): boolean {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT 1 FROM bridge_proxy_agents WHERE bridge_id = ? AND agent_id = ?'
  ).get(bridgeId, agentId);
  return !!row;
}

// ============================================================================
// Message Mappings
// ============================================================================

export function recordMessageMapping(input: {
  bridge_id: string;
  platform_message_id: string;
  platform_channel_id: string;
  post_id?: string;
  comment_id?: string;
}): MessageMapping {
  const db = getDatabase();
  const id = `bmm_${nanoid()}`;

  db.prepare(`
    INSERT INTO bridge_message_mappings (id, bridge_id, platform_message_id, platform_channel_id, post_id, comment_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.bridge_id,
    input.platform_message_id,
    input.platform_channel_id,
    input.post_id || null,
    input.comment_id || null,
  );

  const row = db.prepare('SELECT * FROM bridge_message_mappings WHERE id = ?').get(id) as Record<string, unknown>;
  return rowToMessageMapping(row);
}

export function getMessageMapping(
  bridgeId: string,
  platformMessageId: string,
): MessageMapping | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM bridge_message_mappings WHERE bridge_id = ? AND platform_message_id = ?'
  ).get(bridgeId, platformMessageId) as Record<string, unknown> | undefined;
  return row ? rowToMessageMapping(row) : null;
}

export function getMessageMappingByPost(
  bridgeId: string,
  postId: string,
): MessageMapping | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM bridge_message_mappings WHERE bridge_id = ? AND post_id = ? AND comment_id IS NULL'
  ).get(bridgeId, postId) as Record<string, unknown> | undefined;
  return row ? rowToMessageMapping(row) : null;
}
