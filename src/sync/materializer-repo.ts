/**
 * Materializer Repository
 *
 * Abstracts the direct SQLite queries used by the event materializer (NEW-10).
 * This allows future Postgres/Turso providers to supply their own implementations.
 */

import { getDatabase } from '../db/index.js';

export interface MaterializerRepository {
  // Posts
  findPostByOrigin(originInstanceId: string, originPostId: string): { id: string; updated_at: string | null } | null;
  insertPost(input: {
    id: string; hive_id: string; author_id: string; title: string;
    content: string | null; url: string | null; sync_event_id: string;
    origin_instance_id: string; origin_post_id: string;
    remote_author_id: string | null; created_at: string;
  }): void;
  updatePost(id: string, fields: { title?: string; content?: string; url?: string; updated_at: string }): void;
  deletePost(id: string): void;

  // Comments
  findCommentByOrigin(originInstanceId: string, originCommentId: string): { id: string; updated_at: string | null } | null;
  findPostByOriginOrId(postId: string): { id: string } | null;
  findCommentByOriginOrId(commentId: string): { id: string; depth: number; path: string } | null;
  insertComment(input: {
    id: string; post_id: string; parent_id: string | null; author_id: string;
    content: string; depth: number; path: string; sync_event_id: string;
    origin_instance_id: string; origin_comment_id: string;
    remote_author_id: string | null; created_at: string;
  }): void;
  updateComment(id: string, content: string, updated_at: string): void;
  findCommentForDelete(originCommentId: string): { id: string; post_id: string; path: string } | null;
  deleteCommentTree(path: string): number;
  updatePostCommentCount(postId: string, delta: number): void;

  // Resources
  findResourceByOrigin(originInstanceId: string, originResourceId: string): { id: string; resource_type: string; updated_at: string | null } | null;
  upsertRemoteResource(input: {
    id: string; resource_type: string; name: string; description: string | null;
    git_remote_url: string; visibility: string; owner_agent_id: string;
    sync_event_id: string; origin_instance_id: string; origin_resource_id: string;
    metadata: string | null; created_at: string;
  }): void;
  updateRemoteResource(id: string, fields: { name?: string; description?: string; visibility?: string; metadata?: string; updated_at: string }): void;
  deleteRemoteResource(id: string): void;
  updateResourceCommit(id: string, commitHash: string, updatedAt: string): void;

  // Votes
  findVoteTarget(targetType: 'post' | 'comment', targetId: string): { id: string } | null;
  findVote(agentId: string, targetType: string, targetId: string): { id: string; value: number } | null;
  insertVote(input: {
    id: string; agent_id: string; target_type: string; target_id: string;
    value: number; sync_event_id: string; origin_instance_id: string;
  }): void;
  updateVoteValue(id: string, value: number): void;
  deleteVote(id: string): void;
  updateTargetScore(targetType: 'post' | 'comment', targetId: string, delta: number): void;
}

/** SQLite implementation of the materializer repository */
export class SQLiteMaterializerRepository implements MaterializerRepository {
  private get db() { return getDatabase(); }

  findPostByOrigin(originInstanceId: string, originPostId: string) {
    return this.db.prepare(
      'SELECT id, updated_at FROM posts WHERE origin_instance_id = ? AND origin_post_id = ?'
    ).get(originInstanceId, originPostId) as { id: string; updated_at: string | null } | null;
  }

  insertPost(input: {
    id: string; hive_id: string; author_id: string; title: string;
    content: string | null; url: string | null; sync_event_id: string;
    origin_instance_id: string; origin_post_id: string;
    remote_author_id: string | null; created_at: string;
  }) {
    this.db.prepare(`
      INSERT INTO posts (id, hive_id, author_id, title, content, url, sync_event_id, origin_instance_id, origin_post_id, remote_author_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.hive_id, input.author_id, input.title, input.content,
      input.url, input.sync_event_id, input.origin_instance_id, input.origin_post_id,
      input.remote_author_id, input.created_at);
  }

  updatePost(id: string, fields: { title?: string; content?: string; url?: string; updated_at: string }) {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (fields.title !== undefined) { updates.push('title = ?'); values.push(fields.title); }
    if (fields.content !== undefined) { updates.push('content = ?'); values.push(fields.content); }
    if (fields.url !== undefined) { updates.push('url = ?'); values.push(fields.url); }
    updates.push('updated_at = ?'); values.push(fields.updated_at);
    values.push(id);
    if (updates.length > 1) { // at least one field besides updated_at
      this.db.prepare(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
  }

  deletePost(id: string) {
    this.db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  }

  findCommentByOrigin(originInstanceId: string, originCommentId: string) {
    return this.db.prepare(
      'SELECT id, updated_at FROM comments WHERE origin_instance_id = ? AND origin_comment_id = ?'
    ).get(originInstanceId, originCommentId) as { id: string; updated_at: string | null } | null;
  }

  findPostByOriginOrId(postId: string) {
    return this.db.prepare(
      'SELECT id FROM posts WHERE origin_post_id = ? OR id = ?'
    ).get(postId, postId) as { id: string } | null;
  }

  findCommentByOriginOrId(commentId: string) {
    return this.db.prepare(
      'SELECT id, depth, path FROM comments WHERE origin_comment_id = ? OR id = ?'
    ).get(commentId, commentId) as { id: string; depth: number; path: string } | null;
  }

  insertComment(input: {
    id: string; post_id: string; parent_id: string | null; author_id: string;
    content: string; depth: number; path: string; sync_event_id: string;
    origin_instance_id: string; origin_comment_id: string;
    remote_author_id: string | null; created_at: string;
  }) {
    this.db.prepare(`
      INSERT INTO comments (id, post_id, parent_id, author_id, content, depth, path, sync_event_id, origin_instance_id, origin_comment_id, remote_author_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.post_id, input.parent_id, input.author_id, input.content,
      input.depth, input.path, input.sync_event_id, input.origin_instance_id,
      input.origin_comment_id, input.remote_author_id, input.created_at);
  }

  updateComment(id: string, content: string, updated_at: string) {
    this.db.prepare('UPDATE comments SET content = ?, updated_at = ? WHERE id = ?')
      .run(content, updated_at, id);
  }

  findCommentForDelete(originCommentId: string) {
    return this.db.prepare(
      'SELECT id, post_id, path FROM comments WHERE origin_comment_id = ?'
    ).get(originCommentId) as { id: string; post_id: string; path: string } | null;
  }

  deleteCommentTree(path: string): number {
    const countRow = this.db.prepare('SELECT COUNT(*) as count FROM comments WHERE path LIKE ?')
      .get(`${path}%`) as { count: number };
    this.db.prepare('DELETE FROM comments WHERE path LIKE ?').run(`${path}%`);
    return countRow.count;
  }

  updatePostCommentCount(postId: string, delta: number) {
    this.db.prepare('UPDATE posts SET comment_count = comment_count + ? WHERE id = ?').run(delta, postId);
  }

  findResourceByOrigin(originInstanceId: string, originResourceId: string) {
    return this.db.prepare(
      'SELECT id, resource_type, updated_at FROM syncable_resources WHERE origin_instance_id = ? AND origin_resource_id = ?'
    ).get(originInstanceId, originResourceId) as { id: string; resource_type: string; updated_at: string | null } | null;
  }

  upsertRemoteResource(input: {
    id: string; resource_type: string; name: string; description: string | null;
    git_remote_url: string; visibility: string; owner_agent_id: string;
    sync_event_id: string; origin_instance_id: string; origin_resource_id: string;
    metadata: string | null; created_at: string;
  }) {
    this.db.prepare(`
      INSERT INTO syncable_resources (id, resource_type, name, description, git_remote_url, visibility, owner_agent_id, sync_event_id, origin_instance_id, origin_resource_id, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(origin_instance_id, origin_resource_id) DO UPDATE SET
        name = excluded.name, description = excluded.description,
        git_remote_url = excluded.git_remote_url, visibility = excluded.visibility,
        metadata = excluded.metadata, updated_at = datetime('now')
    `).run(input.id, input.resource_type, input.name, input.description,
      input.git_remote_url, input.visibility, input.owner_agent_id,
      input.sync_event_id, input.origin_instance_id, input.origin_resource_id,
      input.metadata, input.created_at);
  }

  updateRemoteResource(id: string, fields: { name?: string; description?: string; visibility?: string; metadata?: string; updated_at: string }) {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name); }
    if (fields.description !== undefined) { updates.push('description = ?'); values.push(fields.description); }
    if (fields.visibility !== undefined) { updates.push('visibility = ?'); values.push(fields.visibility); }
    if (fields.metadata !== undefined) { updates.push('metadata = ?'); values.push(fields.metadata); }
    updates.push('updated_at = ?'); values.push(fields.updated_at);
    values.push(id);
    if (updates.length > 1) {
      this.db.prepare(`UPDATE syncable_resources SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }
  }

  deleteRemoteResource(id: string) {
    this.db.prepare('DELETE FROM syncable_resources WHERE id = ?').run(id);
  }

  updateResourceCommit(id: string, commitHash: string, updatedAt: string) {
    this.db.prepare('UPDATE syncable_resources SET last_commit_hash = ?, updated_at = ? WHERE id = ?')
      .run(commitHash, updatedAt, id);
  }

  findVoteTarget(targetType: 'post' | 'comment', targetId: string) {
    if (targetType === 'post') {
      return this.db.prepare('SELECT id FROM posts WHERE origin_post_id = ? OR id = ?')
        .get(targetId, targetId) as { id: string } | null;
    }
    return this.db.prepare('SELECT id FROM comments WHERE origin_comment_id = ? OR id = ?')
      .get(targetId, targetId) as { id: string } | null;
  }

  findVote(agentId: string, targetType: string, targetId: string) {
    return this.db.prepare(
      'SELECT id, value FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?'
    ).get(agentId, targetType, targetId) as { id: string; value: number } | null;
  }

  insertVote(input: {
    id: string; agent_id: string; target_type: string; target_id: string;
    value: number; sync_event_id: string; origin_instance_id: string;
  }) {
    this.db.prepare(`
      INSERT INTO votes (id, agent_id, target_type, target_id, value, sync_event_id, origin_instance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.agent_id, input.target_type, input.target_id,
      input.value, input.sync_event_id, input.origin_instance_id);
  }

  updateVoteValue(id: string, value: number) {
    this.db.prepare('UPDATE votes SET value = ? WHERE id = ?').run(value, id);
  }

  deleteVote(id: string) {
    this.db.prepare('DELETE FROM votes WHERE id = ?').run(id);
  }

  updateTargetScore(targetType: 'post' | 'comment', targetId: string, delta: number) {
    if (targetType === 'post') {
      this.db.prepare('UPDATE posts SET score = score + ? WHERE id = ?').run(delta, targetId);
    } else {
      this.db.prepare('UPDATE comments SET score = score + ? WHERE id = ?').run(delta, targetId);
    }
  }
}

/** Singleton repository instance — swap for testing or alternative providers */
let repo: MaterializerRepository = new SQLiteMaterializerRepository();

export function getMaterializerRepo(): MaterializerRepository {
  return repo;
}

export function setMaterializerRepo(newRepo: MaterializerRepository): void {
  repo = newRepo;
}
