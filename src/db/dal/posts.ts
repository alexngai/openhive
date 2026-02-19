import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type { Post, PostWithAuthor } from '../../types.js';

export interface CreatePostInput {
  hive_id: string;
  author_id: string;
  title: string;
  content?: string;
  url?: string;
}

export interface UpdatePostInput {
  title?: string;
  content?: string;
  url?: string;
  is_pinned?: boolean;
}

function rowToPost(row: Record<string, unknown>): Post {
  return {
    ...row,
    is_pinned: Boolean(row.is_pinned),
  } as Post;
}

export function createPost(input: CreatePostInput): Post {
  const db = getDatabase();
  const id = nanoid();

  const stmt = db.prepare(`
    INSERT INTO posts (id, hive_id, author_id, title, content, url)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    input.hive_id,
    input.author_id,
    input.title,
    input.content || null,
    input.url || null
  );

  return findPostById(id)!;
}

export function findPostById(id: string): Post | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToPost(row) : null;
}

export function findPostWithAuthor(id: string, viewerId?: string): PostWithAuthor | null {
  const db = getDatabase();

  let query = `
    SELECT
      p.*,
      COALESCE(a.name, ra.name) as author_name,
      a.description as author_description,
      COALESCE(a.avatar_url, ra.avatar_url) as author_avatar_url,
      COALESCE(a.karma, 0) as author_karma,
      COALESCE(a.is_verified, 0) as author_is_verified,
      COALESCE(a.created_at, ra.last_seen_at) as author_created_at,
      COALESCE(a.account_type, 'agent') as author_account_type,
      h.name as hive_name,
      ra.origin_instance_id as author_origin_instance_id
  `;

  const values: unknown[] = [];

  if (viewerId) {
    query += `, v.value as user_vote`;
  }

  query += `
    FROM posts p
    LEFT JOIN agents a ON p.author_id = a.id
    LEFT JOIN remote_agents_cache ra ON p.remote_author_id = ra.id
    JOIN hives h ON p.hive_id = h.id
  `;

  if (viewerId) {
    query += ` LEFT JOIN votes v ON v.target_type = 'post' AND v.target_id = p.id AND v.agent_id = ?`;
    values.push(viewerId);
  }

  query += ` WHERE p.id = ?`;
  values.push(id);

  const row = db.prepare(query).get(...values) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    ...rowToPost(row),
    author: {
      id: row.author_id as string,
      name: row.author_name as string,
      description: row.author_description as string | null,
      avatar_url: row.author_avatar_url as string | null,
      karma: (row.author_karma as number) || 0,
      is_verified: Boolean(row.author_is_verified),
      created_at: row.author_created_at as string,
      account_type: (row.author_account_type as 'agent' | 'human') || 'agent',
    },
    hive_name: row.hive_name as string,
    user_vote: row.user_vote as 1 | -1 | null | undefined,
  };
}

export function updatePost(id: string, input: UpdatePostInput): Post | null {
  const db = getDatabase();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.title !== undefined) {
    updates.push('title = ?');
    values.push(input.title);
  }
  if (input.content !== undefined) {
    updates.push('content = ?');
    values.push(input.content);
  }
  if (input.url !== undefined) {
    updates.push('url = ?');
    values.push(input.url);
  }
  if (input.is_pinned !== undefined) {
    updates.push('is_pinned = ?');
    values.push(input.is_pinned ? 1 : 0);
  }

  if (updates.length === 0) {
    return findPostById(id);
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return findPostById(id);
}

export function deletePost(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updatePostScore(id: string, delta: number): void {
  const db = getDatabase();
  db.prepare('UPDATE posts SET score = score + ? WHERE id = ?').run(delta, id);
}

export function updatePostCommentCount(id: string, delta: number): void {
  const db = getDatabase();
  db.prepare('UPDATE posts SET comment_count = comment_count + ? WHERE id = ?').run(delta, id);
}

export interface ListPostsOptions {
  hive_id?: string;
  hive_name?: string;
  author_id?: string;
  limit?: number;
  offset?: number;
  sort?: 'new' | 'top' | 'hot';
  viewer_id?: string;
}

export function listPosts(options: ListPostsOptions): PostWithAuthor[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: unknown[] = [];

  let query = `
    SELECT
      p.*,
      COALESCE(a.name, ra.name) as author_name,
      a.description as author_description,
      COALESCE(a.avatar_url, ra.avatar_url) as author_avatar_url,
      COALESCE(a.karma, 0) as author_karma,
      COALESCE(a.is_verified, 0) as author_is_verified,
      COALESCE(a.created_at, ra.last_seen_at) as author_created_at,
      COALESCE(a.account_type, 'agent') as author_account_type,
      h.name as hive_name,
      ra.origin_instance_id as author_origin_instance_id
  `;

  if (options.viewer_id) {
    query += `, v.value as user_vote`;
  }

  query += `
    FROM posts p
    LEFT JOIN agents a ON p.author_id = a.id
    LEFT JOIN remote_agents_cache ra ON p.remote_author_id = ra.id
    JOIN hives h ON p.hive_id = h.id
  `;

  if (options.viewer_id) {
    query += ` LEFT JOIN votes v ON v.target_type = 'post' AND v.target_id = p.id AND v.agent_id = ?`;
    values.push(options.viewer_id);
  }

  if (options.hive_id) {
    conditions.push('p.hive_id = ?');
    values.push(options.hive_id);
  }
  if (options.hive_name) {
    conditions.push('h.name = ?');
    values.push(options.hive_name.toLowerCase());
  }
  if (options.author_id) {
    conditions.push('p.author_id = ?');
    values.push(options.author_id);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  // Sorting
  switch (options.sort) {
    case 'top':
      query += ' ORDER BY p.score DESC, p.created_at DESC';
      break;
    case 'hot':
      // Simple "hot" algorithm: score / age in hours
      query += " ORDER BY (p.score + 1) / (1 + (julianday('now') - julianday(p.created_at)) * 24) DESC";
      break;
    case 'new':
    default:
      query += ' ORDER BY p.created_at DESC';
  }

  if (options.limit) {
    query += ' LIMIT ?';
    values.push(options.limit);
  }
  if (options.offset) {
    query += ' OFFSET ?';
    values.push(options.offset);
  }

  const rows = db.prepare(query).all(...values) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...rowToPost(row),
    author: {
      id: row.author_id as string,
      name: row.author_name as string,
      description: row.author_description as string | null,
      avatar_url: row.author_avatar_url as string | null,
      karma: (row.author_karma as number) || 0,
      is_verified: Boolean(row.author_is_verified),
      created_at: row.author_created_at as string,
      account_type: (row.author_account_type as 'agent' | 'human') || 'agent',
    },
    hive_name: row.hive_name as string,
    user_vote: row.user_vote as 1 | -1 | null | undefined,
  }));
}

export function countPosts(hive_id?: string): number {
  const db = getDatabase();
  if (hive_id) {
    const row = db.prepare('SELECT COUNT(*) as count FROM posts WHERE hive_id = ?').get(hive_id) as { count: number };
    return row.count;
  }
  const row = db.prepare('SELECT COUNT(*) as count FROM posts').get() as { count: number };
  return row.count;
}
