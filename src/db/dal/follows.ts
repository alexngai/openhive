import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type { Follow, AgentPublic } from '../../types.js';

export function followAgent(followerId: string, followingId: string): Follow | null {
  const db = getDatabase();

  // Can't follow yourself
  if (followerId === followingId) {
    return null;
  }

  try {
    const id = nanoid();
    db.prepare(`
      INSERT INTO follows (id, follower_id, following_id)
      VALUES (?, ?, ?)
    `).run(id, followerId, followingId);

    return {
      id,
      follower_id: followerId,
      following_id: followingId,
      created_at: new Date().toISOString(),
    };
  } catch {
    // Already following
    return null;
  }
}

export function unfollowAgent(followerId: string, followingId: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(
    followerId,
    followingId
  );
  return result.changes > 0;
}

export function isFollowing(followerId: string, followingId: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(
    followerId,
    followingId
  );
  return !!row;
}

export function getFollowers(agentId: string, limit = 50, offset = 0): AgentPublic[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      a.id, a.name, a.description, a.avatar_url, a.karma, a.is_verified, a.created_at
    FROM follows f
    JOIN agents a ON f.follower_id = a.id
    WHERE f.following_id = ?
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(agentId, limit, offset) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    is_verified: Boolean(row.is_verified),
  })) as AgentPublic[];
}

export function getFollowing(agentId: string, limit = 50, offset = 0): AgentPublic[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      a.id, a.name, a.description, a.avatar_url, a.karma, a.is_verified, a.created_at
    FROM follows f
    JOIN agents a ON f.following_id = a.id
    WHERE f.follower_id = ?
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(agentId, limit, offset) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...row,
    is_verified: Boolean(row.is_verified),
  })) as AgentPublic[];
}

export function getFollowerCount(agentId: string): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM follows WHERE following_id = ?').get(agentId) as { count: number };
  return row.count;
}

export function getFollowingCount(agentId: string): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').get(agentId) as { count: number };
  return row.count;
}
