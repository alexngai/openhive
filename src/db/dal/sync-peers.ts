import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type { SyncPeerState } from '../../sync/types.js';

export interface CreateSyncPeerInput {
  sync_group_id: string;
  peer_swarm_id: string;
  peer_endpoint: string;
  peer_signing_key?: string | null;
  sync_token?: string | null;
}

function rowToSyncPeer(row: Record<string, unknown>): SyncPeerState {
  return row as unknown as SyncPeerState;
}

export function createSyncPeer(input: CreateSyncPeerInput): SyncPeerState {
  const db = getDatabase();
  const id = `sp_${nanoid()}`;

  db.prepare(`
    INSERT INTO hive_sync_peers
      (id, sync_group_id, peer_swarm_id, peer_endpoint, peer_signing_key, sync_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.sync_group_id, input.peer_swarm_id, input.peer_endpoint, input.peer_signing_key ?? null, input.sync_token ?? null);

  return findSyncPeerById(id)!;
}

export function findSyncPeerById(id: string): SyncPeerState | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hive_sync_peers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSyncPeer(row) : null;
}

export function findSyncPeer(syncGroupId: string, peerSwarmId: string): SyncPeerState | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM hive_sync_peers WHERE sync_group_id = ? AND peer_swarm_id = ?'
  ).get(syncGroupId, peerSwarmId) as Record<string, unknown> | undefined;
  return row ? rowToSyncPeer(row) : null;
}

export function listSyncPeers(syncGroupId: string): SyncPeerState[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM hive_sync_peers WHERE sync_group_id = ? ORDER BY created_at DESC'
  ).all(syncGroupId) as Record<string, unknown>[];
  return rows.map(rowToSyncPeer);
}

export function updateSyncPeerSeqSent(peerId: string, seq: number): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE hive_sync_peers SET last_seq_sent = ?, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(seq, peerId);
}

export function updateSyncPeerSeqReceived(peerId: string, seq: number): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE hive_sync_peers SET last_seq_received = ?, last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(seq, peerId);
}

export function updateSyncPeerStatus(peerId: string, status: string, error?: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE hive_sync_peers SET status = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, error ?? null, peerId);
}

export function updateSyncPeerToken(peerId: string, token: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE hive_sync_peers SET sync_token = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(token, peerId);
}

export function updateSyncPeerSigningKey(peerId: string, signingKey: string): void {
  const db = getDatabase();
  db.prepare(
    "UPDATE hive_sync_peers SET peer_signing_key = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(signingKey, peerId);
}

export function deleteSyncPeer(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM hive_sync_peers WHERE id = ?').run(id);
  return result.changes > 0;
}

export function listActivePeers(syncGroupId: string): SyncPeerState[] {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT * FROM hive_sync_peers WHERE sync_group_id = ? AND status IN ('active', 'backfilling')"
  ).all(syncGroupId) as Record<string, unknown>[];
  return rows.map(rowToSyncPeer);
}
