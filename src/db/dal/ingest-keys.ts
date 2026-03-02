/**
 * DAL for ingest API keys.
 *
 * Operator-generated, reusable Bearer tokens for external agent authentication.
 * Uses SHA-256 hashing for O(1) key lookup (vs bcrypt's O(n) iterate-all).
 */

import { nanoid } from 'nanoid';
import { createHash } from 'crypto';
import { getDatabase } from '../index.js';
import type { IngestKey, IngestKeyScope } from '../../types.js';

// ============================================================================
// Helpers
// ============================================================================

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function rowToIngestKey(row: Record<string, unknown>): IngestKey {
  let scopes: IngestKeyScope[] = ['map'];
  try {
    scopes = JSON.parse(row.scopes as string);
  } catch { /* default to ['map'] */ }

  return {
    id: row.id as string,
    label: row.label as string,
    key_hash: row.key_hash as string,
    key_value: row.key_value as string,
    scopes,
    agent_id: row.agent_id as string,
    revoked: Boolean(row.revoked),
    expires_at: row.expires_at as string | null,
    created_by: row.created_by as string | null,
    created_at: row.created_at as string,
    last_used_at: row.last_used_at as string | null,
  };
}

// ============================================================================
// Types
// ============================================================================

export interface CreateIngestKeyInput {
  label: string;
  agent_id: string;
  scopes?: IngestKeyScope[];
  expires_in_hours?: number;
}

// ============================================================================
// CRUD
// ============================================================================

/**
 * Create a new ingest API key. Returns the key record and the plaintext key
 * (shown once — only the SHA-256 hash is stored).
 */
export function createIngestKey(
  createdBy: string,
  input: CreateIngestKeyInput,
): { key: IngestKey; plaintext_key: string } {
  const db = getDatabase();
  const id = `ik_${nanoid()}`;
  const plaintextKey = `ohk_${nanoid(32)}`;
  const keyHash = hashToken(plaintextKey);

  let expiresAt: string | null = null;
  if (input.expires_in_hours) {
    const date = new Date();
    date.setHours(date.getHours() + input.expires_in_hours);
    expiresAt = date.toISOString();
  }

  const scopes = JSON.stringify(input.scopes ?? ['map']);

  db.prepare(`
    INSERT INTO ingest_keys (id, label, key_hash, key_value, scopes, agent_id, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.label, keyHash, plaintextKey, scopes, input.agent_id, expiresAt, createdBy);

  const key = findIngestKeyById(id)!;
  return { key, plaintext_key: plaintextKey };
}

/**
 * Find an ingest key by its internal ID.
 */
export function findIngestKeyById(id: string): IngestKey | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM ingest_keys WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToIngestKey(row) : null;
}

/**
 * Validate a plaintext ingest key. Returns the key record if valid
 * (not revoked, not expired), null otherwise. Updates last_used_at on success.
 */
export function validateIngestKey(plaintextKey: string): IngestKey | null {
  const db = getDatabase();
  const keyHash = hashToken(plaintextKey);

  const row = db.prepare('SELECT * FROM ingest_keys WHERE key_hash = ?').get(keyHash) as
    | Record<string, unknown>
    | undefined;

  if (!row) return null;
  if (row.revoked) return null;
  if (row.expires_at && new Date(row.expires_at as string) < new Date()) return null;

  db.prepare("UPDATE ingest_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);

  // Re-fetch to include updated last_used_at
  const updated = db.prepare('SELECT * FROM ingest_keys WHERE id = ?').get(row.id) as Record<string, unknown>;
  return rowToIngestKey(updated);
}

/**
 * List ingest keys with optional filters.
 */
export function listIngestKeys(
  options: {
    agent_id?: string;
    include_revoked?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): IngestKey[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.agent_id) {
    where.push('agent_id = ?');
    params.push(options.agent_id);
  }
  if (!options.include_revoked) {
    where.push('revoked = 0');
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const rows = db
    .prepare(
      `SELECT * FROM ingest_keys ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(rowToIngestKey);
}

/**
 * Soft-revoke an ingest key. Returns true if the key was revoked.
 */
export function revokeIngestKey(id: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare('UPDATE ingest_keys SET revoked = 1 WHERE id = ? AND revoked = 0')
    .run(id);
  return result.changes > 0;
}

/**
 * Hard-delete an ingest key. Returns true if the key was deleted.
 */
export function deleteIngestKey(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM ingest_keys WHERE id = ?').run(id);
  return result.changes > 0;
}
