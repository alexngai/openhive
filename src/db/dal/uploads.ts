import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';

export interface Upload {
  id: string;
  agent_id: string;
  key: string;
  url: string;
  thumbnail_url: string | null;
  purpose: 'avatar' | 'banner' | 'post' | 'comment';
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface CreateUploadInput {
  agent_id: string;
  key: string;
  url: string;
  thumbnail_url?: string;
  purpose: 'avatar' | 'banner' | 'post' | 'comment';
  mime_type: string;
  size: number;
  width?: number;
  height?: number;
}

export function createUpload(input: CreateUploadInput): Upload {
  const db = getDatabase();
  const id = nanoid();

  db.prepare(
    `INSERT INTO uploads (id, agent_id, key, url, thumbnail_url, purpose, mime_type, size, width, height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.agent_id,
    input.key,
    input.url,
    input.thumbnail_url || null,
    input.purpose,
    input.mime_type,
    input.size,
    input.width || null,
    input.height || null
  );

  return findUploadById(id)!;
}

export function findUploadById(id: string): Upload | undefined {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
  return row as Upload | undefined;
}

export function findUploadByKey(key: string): Upload | undefined {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM uploads WHERE key = ?').get(key);
  return row as Upload | undefined;
}

export function listUploadsByAgent(
  agentId: string,
  options: { purpose?: string; limit?: number; offset?: number } = {}
): Upload[] {
  const db = getDatabase();
  const { purpose, limit = 50, offset = 0 } = options;

  let query = 'SELECT * FROM uploads WHERE agent_id = ?';
  const params: unknown[] = [agentId];

  if (purpose) {
    query += ' AND purpose = ?';
    params.push(purpose);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params);
  return rows as Upload[];
}

export function deleteUpload(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteUploadByKey(key: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM uploads WHERE key = ?').run(key);
  return result.changes > 0;
}

export function getUploadStats(agentId: string): {
  total_count: number;
  total_size: number;
  by_purpose: Record<string, number>;
} {
  const db = getDatabase();

  const totalRow = db
    .prepare('SELECT COUNT(*) as count, SUM(size) as total_size FROM uploads WHERE agent_id = ?')
    .get(agentId) as { count: number; total_size: number | null };

  const purposeRows = db
    .prepare('SELECT purpose, COUNT(*) as count FROM uploads WHERE agent_id = ? GROUP BY purpose')
    .all(agentId) as { purpose: string; count: number }[];

  const byPurpose: Record<string, number> = {};
  for (const row of purposeRows) {
    byPurpose[row.purpose] = row.count;
  }

  return {
    total_count: totalRow.count,
    total_size: totalRow.total_size || 0,
    by_purpose: byPurpose,
  };
}
