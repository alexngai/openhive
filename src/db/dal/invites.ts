import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type { InviteCode } from '../../types.js';

export interface CreateInviteInput {
  created_by?: string;
  uses_left?: number;
  expires_at?: string;
}

export function createInviteCode(input: CreateInviteInput = {}): InviteCode {
  const db = getDatabase();
  const id = nanoid();
  const code = nanoid(12).toUpperCase();

  db.prepare(`
    INSERT INTO invite_codes (id, code, created_by, uses_left, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    code,
    input.created_by || null,
    input.uses_left ?? 1,
    input.expires_at || null
  );

  return findInviteById(id)!;
}

export function findInviteById(id: string): InviteCode | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM invite_codes WHERE id = ?').get(id) as InviteCode | undefined;
  return row || null;
}

export function findInviteByCode(code: string): InviteCode | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code.toUpperCase()) as InviteCode | undefined;
  return row || null;
}

export function validateInviteCode(code: string): { valid: boolean; reason?: string } {
  const invite = findInviteByCode(code);

  if (!invite) {
    return { valid: false, reason: 'Invalid invite code' };
  }

  if (invite.uses_left <= 0) {
    return { valid: false, reason: 'Invite code has been fully used' };
  }

  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return { valid: false, reason: 'Invite code has expired' };
  }

  return { valid: true };
}

export function useInviteCode(code: string, usedBy: string): boolean {
  const db = getDatabase();
  const invite = findInviteByCode(code);

  if (!invite || invite.uses_left <= 0) {
    return false;
  }

  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return false;
  }

  db.prepare(`
    UPDATE invite_codes
    SET uses_left = uses_left - 1, used_by = ?
    WHERE id = ?
  `).run(usedBy, invite.id);

  return true;
}

export function listInviteCodes(options: {
  created_by?: string;
  active_only?: boolean;
  limit?: number;
  offset?: number;
}): InviteCode[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (options.created_by) {
    conditions.push('created_by = ?');
    values.push(options.created_by);
  }

  if (options.active_only) {
    conditions.push('uses_left > 0');
    conditions.push('(expires_at IS NULL OR expires_at > datetime("now"))');
  }

  let query = 'SELECT * FROM invite_codes';
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }
  if (options.offset) {
    query += ' OFFSET ?';
    values.push(options.offset);
  }

  return db.prepare(query).all(...values) as InviteCode[];
}

export function deleteInviteCode(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM invite_codes WHERE id = ?').run(id);
  return result.changes > 0;
}
