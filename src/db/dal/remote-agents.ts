import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type { RemoteAgentCache } from '../../sync/types.js';

export interface UpsertRemoteAgentInput {
  origin_instance_id: string;
  origin_agent_id: string;
  name: string;
  avatar_url?: string | null;
}

function rowToRemoteAgent(row: Record<string, unknown>): RemoteAgentCache {
  return row as unknown as RemoteAgentCache;
}

export function upsertRemoteAgent(input: UpsertRemoteAgentInput): RemoteAgentCache {
  const db = getDatabase();
  const id = `ragent_${nanoid()}`;

  db.prepare(`
    INSERT INTO remote_agents_cache (id, origin_instance_id, origin_agent_id, name, avatar_url)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(origin_instance_id, origin_agent_id)
    DO UPDATE SET
      name = excluded.name,
      avatar_url = excluded.avatar_url,
      last_seen_at = datetime('now')
  `).run(id, input.origin_instance_id, input.origin_agent_id, input.name, input.avatar_url ?? null);

  return findRemoteAgent(input.origin_instance_id, input.origin_agent_id)!;
}

export function findRemoteAgent(originInstanceId: string, originAgentId: string): RemoteAgentCache | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT * FROM remote_agents_cache WHERE origin_instance_id = ? AND origin_agent_id = ?'
  ).get(originInstanceId, originAgentId) as Record<string, unknown> | undefined;
  return row ? rowToRemoteAgent(row) : null;
}

export function findRemoteAgentById(id: string): RemoteAgentCache | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM remote_agents_cache WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToRemoteAgent(row) : null;
}

export function listRemoteAgents(originInstanceId?: string): RemoteAgentCache[] {
  const db = getDatabase();
  if (originInstanceId) {
    const rows = db.prepare('SELECT * FROM remote_agents_cache WHERE origin_instance_id = ?')
      .all(originInstanceId) as Record<string, unknown>[];
    return rows.map(rowToRemoteAgent);
  }
  const rows = db.prepare('SELECT * FROM remote_agents_cache').all() as Record<string, unknown>[];
  return rows.map(rowToRemoteAgent);
}
