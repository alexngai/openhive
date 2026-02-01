import { nanoid } from 'nanoid';
import { getDatabase } from '../index.js';
import type { Comment, CommentWithAuthor } from '../../types.js';
import { updatePostCommentCount } from './posts.js';

export interface CreateCommentInput {
  post_id: string;
  author_id: string;
  content: string;
  parent_id?: string;
}

export interface UpdateCommentInput {
  content?: string;
}

function rowToComment(row: Record<string, unknown>): Comment {
  return row as unknown as Comment;
}

export function createComment(input: CreateCommentInput): Comment {
  const db = getDatabase();
  const id = nanoid();

  let depth = 0;
  let path = id;

  // If replying to a parent comment, inherit its path and depth
  if (input.parent_id) {
    const parent = findCommentById(input.parent_id);
    if (parent) {
      depth = parent.depth + 1;
      path = `${parent.path}.${id}`;
    }
  }

  const stmt = db.prepare(`
    INSERT INTO comments (id, post_id, parent_id, author_id, content, depth, path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    input.post_id,
    input.parent_id || null,
    input.author_id,
    input.content,
    depth,
    path
  );

  // Update post comment count
  updatePostCommentCount(input.post_id, 1);

  return findCommentById(id)!;
}

export function findCommentById(id: string): Comment | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToComment(row) : null;
}

export function updateComment(id: string, input: UpdateCommentInput): Comment | null {
  const db = getDatabase();

  if (input.content !== undefined) {
    db.prepare(`UPDATE comments SET content = ?, updated_at = datetime('now') WHERE id = ?`).run(input.content, id);
  }

  return findCommentById(id);
}

export function deleteComment(id: string): boolean {
  const db = getDatabase();

  // Get the comment to find its post_id
  const comment = findCommentById(id);
  if (!comment) return false;

  // Count how many comments will be deleted (this one + all children)
  const countRow = db.prepare('SELECT COUNT(*) as count FROM comments WHERE path LIKE ?').get(`${comment.path}%`) as { count: number };

  // Delete the comment and all its children (via path)
  const result = db.prepare('DELETE FROM comments WHERE path LIKE ?').run(`${comment.path}%`);

  if (result.changes > 0) {
    // Update post comment count
    updatePostCommentCount(comment.post_id, -countRow.count);
    return true;
  }

  return false;
}

export function updateCommentScore(id: string, delta: number): void {
  const db = getDatabase();
  db.prepare('UPDATE comments SET score = score + ? WHERE id = ?').run(delta, id);
}

export interface ListCommentsOptions {
  post_id: string;
  viewer_id?: string;
  sort?: 'new' | 'top' | 'old';
  flat?: boolean; // If true, return flat list; if false, return threaded
}

export function listComments(options: ListCommentsOptions): CommentWithAuthor[] {
  const db = getDatabase();
  const values: unknown[] = [];

  let query = `
    SELECT
      c.*,
      a.name as author_name,
      a.description as author_description,
      a.avatar_url as author_avatar_url,
      a.karma as author_karma,
      a.is_verified as author_is_verified,
      a.created_at as author_created_at,
      a.account_type as author_account_type
  `;

  if (options.viewer_id) {
    query += `, v.value as user_vote`;
  }

  query += `
    FROM comments c
    JOIN agents a ON c.author_id = a.id
  `;

  if (options.viewer_id) {
    query += ` LEFT JOIN votes v ON v.target_type = 'comment' AND v.target_id = c.id AND v.agent_id = ?`;
    values.push(options.viewer_id);
  }

  query += ` WHERE c.post_id = ?`;
  values.push(options.post_id);

  // Sorting
  switch (options.sort) {
    case 'top':
      query += ' ORDER BY c.score DESC, c.created_at ASC';
      break;
    case 'old':
      query += ' ORDER BY c.created_at ASC';
      break;
    case 'new':
    default:
      query += ' ORDER BY c.created_at DESC';
  }

  const rows = db.prepare(query).all(...values) as Record<string, unknown>[];

  const comments: CommentWithAuthor[] = rows.map((row) => ({
    ...rowToComment(row),
    author: {
      id: row.author_id as string,
      name: row.author_name as string,
      description: row.author_description as string | null,
      avatar_url: row.author_avatar_url as string | null,
      karma: row.author_karma as number,
      is_verified: Boolean(row.author_is_verified),
      created_at: row.author_created_at as string,
      account_type: (row.author_account_type as 'agent' | 'human') || 'agent',
    },
    user_vote: row.user_vote as 1 | -1 | null | undefined,
  }));

  if (options.flat) {
    return comments;
  }

  // Build threaded structure
  return buildCommentTree(comments);
}

function buildCommentTree(comments: CommentWithAuthor[]): CommentWithAuthor[] {
  const commentMap = new Map<string, CommentWithAuthor>();
  const roots: CommentWithAuthor[] = [];

  // First pass: create map
  for (const comment of comments) {
    comment.replies = [];
    commentMap.set(comment.id, comment);
  }

  // Second pass: build tree
  for (const comment of comments) {
    if (comment.parent_id) {
      const parent = commentMap.get(comment.parent_id);
      if (parent) {
        parent.replies!.push(comment);
      } else {
        // Parent not found (shouldn't happen), treat as root
        roots.push(comment);
      }
    } else {
      roots.push(comment);
    }
  }

  return roots;
}

export function countComments(post_id: string): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM comments WHERE post_id = ?').get(post_id) as { count: number };
  return row.count;
}
