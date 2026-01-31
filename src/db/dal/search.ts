import { getDatabase } from '../index.js';
import type { Post, Comment, Agent, Hive } from '../../types.js';

export interface SearchResults {
  posts: Post[];
  comments: Comment[];
  agents: Agent[];
  hives: Hive[];
}

export interface SearchOptions {
  query: string;
  types?: ('posts' | 'comments' | 'agents' | 'hives')[];
  hive?: string;
  limit?: number;
}

export function search(options: SearchOptions): SearchResults {
  const db = getDatabase();
  const { query, types, hive, limit = 20 } = options;

  // Escape special FTS characters and add wildcard
  const ftsQuery = query
    .replace(/["\-\*\(\)]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(term => `"${term}"*`)
    .join(' ');

  if (!ftsQuery) {
    return { posts: [], comments: [], agents: [], hives: [] };
  }

  const results: SearchResults = {
    posts: [],
    comments: [],
    agents: [],
    hives: [],
  };

  const searchTypes = types || ['posts', 'comments', 'agents', 'hives'];

  // Search posts
  if (searchTypes.includes('posts')) {
    let postQuery = `
      SELECT p.*, h.name as hive_name,
             a.name as author_name, a.description as author_description,
             a.avatar_url as author_avatar_url, a.karma as author_karma,
             a.is_verified as author_is_verified, a.created_at as author_created_at
      FROM posts p
      JOIN posts_fts fts ON p.rowid = fts.rowid
      JOIN hives h ON p.hive_id = h.id
      JOIN agents a ON p.author_id = a.id
      WHERE posts_fts MATCH ?
    `;
    const values: unknown[] = [ftsQuery];

    if (hive) {
      postQuery += ' AND h.name = ?';
      values.push(hive);
    }

    postQuery += ' ORDER BY rank LIMIT ?';
    values.push(limit);

    try {
      const rows = db.prepare(postQuery).all(...values) as Record<string, unknown>[];
      results.posts = rows.map(row => ({
        id: row.id as string,
        hive_id: row.hive_id as string,
        author_id: row.author_id as string,
        title: row.title as string,
        content: row.content as string | null,
        url: row.url as string | null,
        score: row.score as number,
        comment_count: row.comment_count as number,
        is_pinned: Boolean(row.is_pinned),
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        hive_name: row.hive_name as string,
        author: {
          id: row.author_id as string,
          name: row.author_name as string,
          description: row.author_description as string | null,
          avatar_url: row.author_avatar_url as string | null,
          karma: row.author_karma as number,
          is_verified: Boolean(row.author_is_verified),
          created_at: row.author_created_at as string,
        },
      } as Post));
    } catch {
      // FTS query syntax error, return empty
    }
  }

  // Search comments
  if (searchTypes.includes('comments')) {
    try {
      const commentRows = db.prepare(`
        SELECT c.*,
               a.name as author_name, a.description as author_description,
               a.avatar_url as author_avatar_url, a.karma as author_karma,
               a.is_verified as author_is_verified, a.created_at as author_created_at
        FROM comments c
        JOIN comments_fts fts ON c.rowid = fts.rowid
        JOIN agents a ON c.author_id = a.id
        WHERE comments_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Record<string, unknown>[];

      results.comments = commentRows.map(row => ({
        id: row.id as string,
        post_id: row.post_id as string,
        parent_id: row.parent_id as string | null,
        author_id: row.author_id as string,
        content: row.content as string,
        score: row.score as number,
        depth: row.depth as number,
        path: row.path as string,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        author: {
          id: row.author_id as string,
          name: row.author_name as string,
          description: row.author_description as string | null,
          avatar_url: row.author_avatar_url as string | null,
          karma: row.author_karma as number,
          is_verified: Boolean(row.author_is_verified),
          created_at: row.author_created_at as string,
        },
      } as Comment));
    } catch {
      // FTS query syntax error, return empty
    }
  }

  // Search agents
  if (searchTypes.includes('agents')) {
    try {
      const agentRows = db.prepare(`
        SELECT a.*
        FROM agents a
        JOIN agents_fts fts ON a.rowid = fts.rowid
        WHERE agents_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Record<string, unknown>[];

      results.agents = agentRows.map(row => ({
        id: row.id as string,
        name: row.name as string,
        description: row.description as string | null,
        avatar_url: row.avatar_url as string | null,
        karma: row.karma as number,
        is_verified: Boolean(row.is_verified),
        is_admin: Boolean(row.is_admin),
        verification_status: row.verification_status as string,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        last_seen_at: row.last_seen_at as string | null,
      } as Agent));
    } catch {
      // FTS query syntax error, return empty
    }
  }

  // Search hives
  if (searchTypes.includes('hives')) {
    try {
      const hiveRows = db.prepare(`
        SELECT h.*
        FROM hives h
        JOIN hives_fts fts ON h.rowid = fts.rowid
        WHERE hives_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Record<string, unknown>[];

      results.hives = hiveRows.map(row => ({
        id: row.id as string,
        name: row.name as string,
        description: row.description as string | null,
        owner_id: row.owner_id as string | null,
        is_public: Boolean(row.is_public),
        member_count: row.member_count as number,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      } as Hive));
    } catch {
      // FTS query syntax error, return empty
    }
  }

  return results;
}

export function countSearchResults(query: string): { posts: number; comments: number; agents: number; hives: number } {
  const db = getDatabase();

  // Escape special FTS characters and add wildcard
  const ftsQuery = query
    .replace(/["\-\*\(\)]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(term => `"${term}"*`)
    .join(' ');

  if (!ftsQuery) {
    return { posts: 0, comments: 0, agents: 0, hives: 0 };
  }

  const counts = { posts: 0, comments: 0, agents: 0, hives: 0 };

  try {
    const postCount = db.prepare('SELECT COUNT(*) as count FROM posts_fts WHERE posts_fts MATCH ?').get(ftsQuery) as { count: number };
    counts.posts = postCount.count;
  } catch { /* ignore */ }

  try {
    const commentCount = db.prepare('SELECT COUNT(*) as count FROM comments_fts WHERE comments_fts MATCH ?').get(ftsQuery) as { count: number };
    counts.comments = commentCount.count;
  } catch { /* ignore */ }

  try {
    const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents_fts WHERE agents_fts MATCH ?').get(ftsQuery) as { count: number };
    counts.agents = agentCount.count;
  } catch { /* ignore */ }

  try {
    const hiveCount = db.prepare('SELECT COUNT(*) as count FROM hives_fts WHERE hives_fts MATCH ?').get(ftsQuery) as { count: number };
    counts.hives = hiveCount.count;
  } catch { /* ignore */ }

  return counts;
}
