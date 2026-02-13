import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import { generateSigningKeyPair } from '../../sync/crypto.js';
import type { SyncGroup } from '../../sync/types.js';

function rowToSyncGroup(row: Record<string, unknown>): SyncGroup {
  return row as unknown as SyncGroup;
}

export function createSyncGroup(hiveId: string, syncGroupName: string, instanceId: string): SyncGroup {
  const db = getDatabase();
  const id = `sg_${nanoid()}`;
  const keypair = generateSigningKeyPair();

  db.prepare(`
    INSERT INTO hive_sync_groups
      (id, hive_id, sync_group_name, created_by_instance_id, instance_signing_key, instance_signing_key_private, seq)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(id, hiveId, syncGroupName, instanceId, keypair.publicKey, keypair.privateKey);

  return findSyncGroupById(id)!;
}

export function findSyncGroupById(id: string): SyncGroup | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hive_sync_groups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSyncGroup(row) : null;
}

export function findSyncGroupByHive(hiveId: string): SyncGroup | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hive_sync_groups WHERE hive_id = ?').get(hiveId) as Record<string, unknown> | undefined;
  return row ? rowToSyncGroup(row) : null;
}

export function findSyncGroupByName(name: string): SyncGroup | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hive_sync_groups WHERE sync_group_name = ?').get(name) as Record<string, unknown> | undefined;
  return row ? rowToSyncGroup(row) : null;
}

export function listSyncGroups(): SyncGroup[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM hive_sync_groups ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToSyncGroup);
}

export function deleteSyncGroup(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM hive_sync_groups WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Atomically increment the sequence number and return the new value */
export function incrementSeq(syncGroupId: string): number {
  const db = getDatabase();
  db.prepare('UPDATE hive_sync_groups SET seq = seq + 1 WHERE id = ?').run(syncGroupId);
  const row = db.prepare('SELECT seq FROM hive_sync_groups WHERE id = ?').get(syncGroupId) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

export function getSeq(syncGroupId: string): number {
  const db = getDatabase();
  const row = db.prepare('SELECT seq FROM hive_sync_groups WHERE id = ?').get(syncGroupId) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

/** Rotate the signing key for a sync group.
 *  Moves current key to previous_signing_key and generates a fresh keypair. */
export function rotateGroupKey(syncGroupId: string): SyncGroup {
  const db = getDatabase();
  const group = findSyncGroupById(syncGroupId);
  if (!group) throw new Error(`Sync group ${syncGroupId} not found`);

  const newKeypair = generateSigningKeyPair();

  db.prepare(`
    UPDATE hive_sync_groups
    SET previous_signing_key = instance_signing_key,
        previous_signing_key_private = instance_signing_key_private,
        instance_signing_key = ?,
        instance_signing_key_private = ?,
        key_version = key_version + 1,
        key_rotated_at = datetime('now')
    WHERE id = ?
  `).run(newKeypair.publicKey, newKeypair.privateKey, syncGroupId);

  return findSyncGroupById(syncGroupId)!;
}

/** Clear the previous key after all peers have acknowledged the rotation */
export function clearPreviousKey(syncGroupId: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE hive_sync_groups
    SET previous_signing_key = NULL,
        previous_signing_key_private = NULL
    WHERE id = ?
  `).run(syncGroupId);
}
