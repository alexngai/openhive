import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type { SyncPeerConfig, PeerSource, PeerConfigStatus } from '../../sync/types.js';

export interface CreatePeerConfigInput {
  name: string;
  sync_endpoint: string;
  shared_hives: string[];
  signing_key?: string | null;
  sync_token?: string | null;
  is_manual?: boolean;
  source?: PeerSource;
  gossip_ttl?: number;
  discovered_via?: string | null;
}

function rowToPeerConfig(row: Record<string, unknown>): SyncPeerConfig {
  return {
    ...row,
    shared_hives: JSON.parse(row.shared_hives as string),
    is_manual: Boolean(row.is_manual),
  } as SyncPeerConfig;
}

export function createPeerConfig(input: CreatePeerConfigInput): SyncPeerConfig {
  const db = getDatabase();
  const id = `pc_${nanoid()}`;

  db.prepare(`
    INSERT INTO sync_peer_configs
      (id, name, sync_endpoint, shared_hives, signing_key, sync_token, is_manual, source, gossip_ttl, discovered_via)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.sync_endpoint,
    JSON.stringify(input.shared_hives),
    input.signing_key ?? null,
    input.sync_token ?? null,
    input.is_manual !== false ? 1 : 0,
    input.source ?? 'manual',
    input.gossip_ttl ?? 0,
    input.discovered_via ?? null,
  );

  return findPeerConfigById(id)!;
}

export function upsertPeerConfig(input: CreatePeerConfigInput): SyncPeerConfig {
  const db = getDatabase();
  const id = `pc_${nanoid()}`;
  const source = input.source ?? 'manual';
  const isManual = input.is_manual !== false ? 1 : 0;

  // If source is manual, overwrite everything; otherwise don't overwrite manual configs
  if (source === 'manual') {
    db.prepare(`
      INSERT INTO sync_peer_configs
        (id, name, sync_endpoint, shared_hives, signing_key, sync_token, is_manual, source, gossip_ttl, discovered_via)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sync_endpoint) DO UPDATE SET
        name = excluded.name,
        shared_hives = excluded.shared_hives,
        signing_key = COALESCE(excluded.signing_key, signing_key),
        sync_token = COALESCE(excluded.sync_token, sync_token),
        is_manual = excluded.is_manual,
        source = excluded.source,
        updated_at = datetime('now')
    `).run(id, input.name, input.sync_endpoint, JSON.stringify(input.shared_hives), input.signing_key ?? null, input.sync_token ?? null, isManual, source, input.gossip_ttl ?? 0, input.discovered_via ?? null);
  } else {
    // Hub/gossip: don't overwrite if manual entry exists
    db.prepare(`
      INSERT INTO sync_peer_configs
        (id, name, sync_endpoint, shared_hives, signing_key, sync_token, is_manual, source, gossip_ttl, discovered_via)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sync_endpoint) DO UPDATE SET
        name = CASE WHEN source = 'manual' THEN name ELSE excluded.name END,
        shared_hives = CASE WHEN source = 'manual' THEN shared_hives ELSE excluded.shared_hives END,
        signing_key = CASE WHEN source = 'manual' THEN signing_key ELSE COALESCE(excluded.signing_key, signing_key) END,
        gossip_ttl = CASE WHEN source = 'manual' THEN gossip_ttl ELSE excluded.gossip_ttl END,
        discovered_via = CASE WHEN source = 'manual' THEN discovered_via ELSE excluded.discovered_via END,
        updated_at = datetime('now')
    `).run(id, input.name, input.sync_endpoint, JSON.stringify(input.shared_hives), input.signing_key ?? null, input.sync_token ?? null, isManual, source, input.gossip_ttl ?? 0, input.discovered_via ?? null);
  }

  return findPeerConfigByEndpoint(input.sync_endpoint)!;
}

export function findPeerConfigById(id: string): SyncPeerConfig | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM sync_peer_configs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToPeerConfig(row) : null;
}

export function findPeerConfigByEndpoint(endpoint: string): SyncPeerConfig | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM sync_peer_configs WHERE sync_endpoint = ?').get(endpoint) as Record<string, unknown> | undefined;
  return row ? rowToPeerConfig(row) : null;
}

export function listPeerConfigs(filter?: { source?: PeerSource; status?: PeerConfigStatus }): SyncPeerConfig[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.source) {
    conditions.push('source = ?');
    values.push(filter.source);
  }
  if (filter?.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }

  let query = 'SELECT * FROM sync_peer_configs';
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...values) as Record<string, unknown>[];
  return rows.map(rowToPeerConfig);
}

export function updatePeerConfig(id: string, input: Partial<CreatePeerConfigInput>): SyncPeerConfig | null {
  const db = getDatabase();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) { updates.push('name = ?'); values.push(input.name); }
  if (input.sync_endpoint !== undefined) { updates.push('sync_endpoint = ?'); values.push(input.sync_endpoint); }
  if (input.shared_hives !== undefined) { updates.push('shared_hives = ?'); values.push(JSON.stringify(input.shared_hives)); }
  if (input.signing_key !== undefined) { updates.push('signing_key = ?'); values.push(input.signing_key); }
  if (input.sync_token !== undefined) { updates.push('sync_token = ?'); values.push(input.sync_token); }
  if (input.gossip_ttl !== undefined) { updates.push('gossip_ttl = ?'); values.push(input.gossip_ttl); }

  if (updates.length === 0) return findPeerConfigById(id);

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE sync_peer_configs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return findPeerConfigById(id);
}

export function updatePeerConfigStatus(id: string, status: PeerConfigStatus, error?: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE sync_peer_configs SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, error ?? null, id);
}

export function updatePeerConfigHeartbeat(id: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE sync_peer_configs SET last_heartbeat_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function deletePeerConfig(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM sync_peer_configs WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Increment failure count for a peer config */
export function incrementFailureCount(id: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE sync_peer_configs SET failure_count = failure_count + 1, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

/** Reset failure count for a peer config (on successful contact) */
export function resetFailureCount(id: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE sync_peer_configs SET failure_count = 0, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

/** Remove gossip-sourced peers that are unresponsive or have exceeded max failures */
export function cleanupStaleGossipPeers(staleTimeoutMs: number, maxFailures: number): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - staleTimeoutMs).toISOString();

  const result = db.prepare(`
    DELETE FROM sync_peer_configs
    WHERE source = 'gossip'
    AND (
      (
        (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?)
        OR (last_heartbeat_at IS NULL AND created_at < ?)
      )
      AND status IN ('unreachable', 'error')
    )
    OR (failure_count >= ?)
  `).run(cutoff, cutoff, maxFailures);
  return result.changes;
}
