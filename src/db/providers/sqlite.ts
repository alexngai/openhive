/**
 * SQLite Database Provider
 *
 * Wraps the existing DAL functions to implement the DatabaseProvider interface.
 * Uses better-sqlite3 for synchronous SQLite access.
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import bcrypt from 'bcrypt';
import * as path from 'path';
import * as fs from 'fs';
import type {
  DatabaseProvider,
  SQLiteProviderConfig,
  AgentRepository,
  PostRepository,
  CommentRepository,
  HiveRepository,
  VoteRepository,
  FollowRepository,
  InviteRepository,
  UploadRepository,
  InstanceRepository,
  SearchRepository,
  CreateAgentInput,
  CreateHumanInput,
  UpdateAgentInput,
  CreatePostInput,
  UpdatePostInput,
  ListPostsOptions,
  CreateCommentInput,
  UpdateCommentInput,
  ListCommentsOptions,
  CreateHiveInput,
  UpdateHiveInput,
  CastVoteInput,
  CreateInviteInput,
  CreateUploadInput,
  Upload,
  CreateInstanceInput,
  SearchOptions,
  SearchResults,
} from './types.js';
import type { Agent, AgentPublic, Post, PostWithAuthor, Comment, CommentWithAuthor, Hive, Vote, Follow, InviteCode, FederatedInstance } from '../../types.js';

const SALT_ROUNDS = 10;

// Schema and migrations
const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    api_key_hash TEXT,
    description TEXT,
    avatar_url TEXT,
    karma INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    is_admin INTEGER DEFAULT 0,
    metadata TEXT,
    verification_status TEXT DEFAULT 'pending',
    verification_data TEXT,
    account_type TEXT DEFAULT 'agent',
    email TEXT UNIQUE,
    password_hash TEXT,
    email_verified INTEGER DEFAULT 0,
    password_reset_token TEXT,
    password_reset_expires TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT
  );

  CREATE TABLE IF NOT EXISTS hives (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    owner_id TEXT NOT NULL REFERENCES agents(id),
    is_public INTEGER DEFAULT 1,
    settings TEXT,
    member_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES agents(id),
    title TEXT NOT NULL,
    content TEXT,
    url TEXT,
    score INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES comments(id),
    author_id TEXT NOT NULL REFERENCES agents(id),
    content TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    depth INTEGER DEFAULT 0,
    path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
    target_id TEXT NOT NULL,
    value INTEGER NOT NULL CHECK (value IN (-1, 1)),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_id, target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'owner')),
    joined_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_id, hive_id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    id TEXT PRIMARY KEY,
    follower_id TEXT NOT NULL REFERENCES agents(id),
    following_id TEXT NOT NULL REFERENCES agents(id),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(follower_id, following_id)
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    created_by TEXT REFERENCES agents(id),
    used_by TEXT REFERENCES agents(id),
    uses_left INTEGER DEFAULT 1,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_key TEXT UNIQUE NOT NULL,
    purpose TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS federated_instances (
    id TEXT PRIMARY KEY,
    url TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    public_key TEXT,
    status TEXT DEFAULT 'pending',
    is_trusted INTEGER DEFAULT 0,
    agent_count INTEGER DEFAULT 0,
    post_count INTEGER DEFAULT 0,
    last_sync TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_posts_hive ON posts(hive_id);
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(path);
  CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_hive ON memberships(hive_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_agent ON memberships(agent_id);
  CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
  CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
  CREATE INDEX IF NOT EXISTS idx_uploads_agent ON uploads(agent_id);
`;

const CREATE_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(title, content, content=posts, content_rowid=rowid);
  CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(content, content=comments, content_rowid=rowid);
  CREATE VIRTUAL TABLE IF NOT EXISTS agents_fts USING fts5(name, description, content=agents, content_rowid=rowid);
  CREATE VIRTUAL TABLE IF NOT EXISTS hives_fts USING fts5(name, description, content=hives, content_rowid=rowid);

  -- Triggers to keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
  END;
  CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, content) VALUES('delete', OLD.rowid, OLD.title, OLD.content);
  END;
  CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, title, content) VALUES('delete', OLD.rowid, OLD.title, OLD.content);
    INSERT INTO posts_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
  END;
`;

// Helper functions
function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    ...row,
    is_verified: Boolean(row.is_verified),
    is_admin: Boolean(row.is_admin),
    email_verified: Boolean(row.email_verified),
    account_type: (row.account_type as string) || 'agent',
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    verification_data: row.verification_data ? JSON.parse(row.verification_data as string) : null,
  } as Agent;
}

function toPublicAgent(agent: Agent): AgentPublic {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    avatar_url: agent.avatar_url,
    karma: agent.karma,
    is_verified: agent.is_verified,
    created_at: agent.created_at,
    account_type: agent.account_type || 'agent',
  };
}

// SQLite Provider Implementation
export class SQLiteProvider implements DatabaseProvider {
  readonly type = 'sqlite' as const;
  private db: Database.Database;

  agents: AgentRepository;
  posts: PostRepository;
  comments: CommentRepository;
  hives: HiveRepository;
  votes: VoteRepository;
  follows: FollowRepository;
  invites: InviteRepository;
  uploads: UploadRepository;
  instances: InstanceRepository;
  search: SearchRepository;

  constructor(private config: SQLiteProviderConfig) {
    // Ensure directory exists
    const dbPath = path.resolve(config.path);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Initialize repositories
    this.agents = this.createAgentRepository();
    this.posts = this.createPostRepository();
    this.comments = this.createCommentRepository();
    this.hives = this.createHiveRepository();
    this.votes = this.createVoteRepository();
    this.follows = this.createFollowRepository();
    this.invites = this.createInviteRepository();
    this.uploads = this.createUploadRepository();
    this.instances = this.createInstanceRepository();
    this.search = this.createSearchRepository();
  }

  async initialize(): Promise<void> {
    this.db.exec(CREATE_TABLES);
    await this.migrate();
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const txn = this.db.transaction(async () => {
      return await fn();
    });
    return txn() as T;
  }

  async migrate(): Promise<void> {
    const version = await this.getSchemaVersion();

    if (version === 0) {
      // Fresh install
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(6);
      this.db.exec(CREATE_FTS);
    } else if (version < 6) {
      // Run migrations
      if (version < 2) {
        this.db.exec(CREATE_FTS);
      }
      if (version < 3) {
        // Uploads table already in CREATE_TABLES
      }
      if (version < 4) {
        // Human account fields already in CREATE_TABLES
      }
      if (version < 6) {
        // Password reset fields already in CREATE_TABLES
      }
      this.db.prepare('UPDATE schema_version SET version = ?').run(6);
    }
  }

  async getSchemaVersion(): Promise<number> {
    try {
      const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  // ============================================================================
  // Repository Implementations
  // ============================================================================

  private createAgentRepository(): AgentRepository {
    const db = this.db;

    return {
      async create(input: CreateAgentInput) {
        const id = nanoid();
        const apiKey = nanoid(32);
        const apiKeyHash = await bcrypt.hash(apiKey, SALT_ROUNDS);

        db.prepare(`
          INSERT INTO agents (id, name, api_key_hash, description, avatar_url, is_admin, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          input.name,
          apiKeyHash,
          input.description || null,
          input.avatar_url || null,
          input.is_admin ? 1 : 0,
          input.metadata ? JSON.stringify(input.metadata) : null
        );

        const agent = await this.findById(id);
        return { agent: agent!, apiKey };
      },

      async findById(id: string) {
        const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row ? rowToAgent(row) : null;
      },

      async findByName(name: string) {
        const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as Record<string, unknown> | undefined;
        return row ? rowToAgent(row) : null;
      },

      async findByApiKey(apiKey: string) {
        const agents = db.prepare('SELECT * FROM agents WHERE api_key_hash IS NOT NULL').all() as Record<string, unknown>[];
        for (const row of agents) {
          if (await bcrypt.compare(apiKey, row.api_key_hash as string)) {
            return rowToAgent(row);
          }
        }
        return null;
      },

      async update(id: string, input: UpdateAgentInput) {
        const updates: string[] = [];
        const values: unknown[] = [];

        if (input.description !== undefined) { updates.push('description = ?'); values.push(input.description); }
        if (input.avatar_url !== undefined) { updates.push('avatar_url = ?'); values.push(input.avatar_url); }
        if (input.metadata !== undefined) { updates.push('metadata = ?'); values.push(JSON.stringify(input.metadata)); }
        if (input.verification_status !== undefined) { updates.push('verification_status = ?'); values.push(input.verification_status); }
        if (input.verification_data !== undefined) { updates.push('verification_data = ?'); values.push(JSON.stringify(input.verification_data)); }
        if (input.is_verified !== undefined) { updates.push('is_verified = ?'); values.push(input.is_verified ? 1 : 0); }
        if (input.is_admin !== undefined) { updates.push('is_admin = ?'); values.push(input.is_admin ? 1 : 0); }

        if (updates.length === 0) return this.findById(id);

        updates.push("updated_at = datetime('now')");
        values.push(id);

        db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        return this.findById(id);
      },

      async updateKarma(id: string, delta: number) {
        db.prepare(`UPDATE agents SET karma = karma + ?, updated_at = datetime('now') WHERE id = ?`).run(delta, id);
      },

      async updateLastSeen(id: string) {
        db.prepare(`UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?`).run(id);
      },

      async list(options) {
        let query = 'SELECT * FROM agents';
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (options.verified_only) conditions.push('is_verified = 1');
        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY created_at DESC';
        if (options.limit) { query += ' LIMIT ?'; values.push(options.limit); }
        if (options.offset) { query += ' OFFSET ?'; values.push(options.offset); }

        const rows = db.prepare(query).all(...values) as Record<string, unknown>[];
        return rows.map(rowToAgent);
      },

      async count() {
        const row = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
        return row.count;
      },

      async delete(id: string) {
        const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
        return result.changes > 0;
      },

      toPublic: toPublicAgent,

      // Human accounts
      async createHuman(input: CreateHumanInput) {
        const id = nanoid();
        const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

        db.prepare(`
          INSERT INTO agents (id, name, email, password_hash, description, avatar_url, account_type, is_verified, verification_status)
          VALUES (?, ?, ?, ?, ?, ?, 'human', 0, 'pending')
        `).run(id, input.name, input.email.toLowerCase(), passwordHash, input.description || null, input.avatar_url || null);

        return (await this.findById(id))!;
      },

      async findByEmail(email: string) {
        const row = db.prepare('SELECT * FROM agents WHERE email = ? AND account_type = ?').get(email.toLowerCase(), 'human') as Record<string, unknown> | undefined;
        return row ? rowToAgent(row) : null;
      },

      async verifyPassword(agent: Agent, password: string) {
        if (!agent.password_hash) return false;
        return bcrypt.compare(password, agent.password_hash);
      },

      async setPassword(id: string, password: string) {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        db.prepare(`UPDATE agents SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(passwordHash, id);
      },

      async verifyEmail(id: string) {
        db.prepare(`UPDATE agents SET email_verified = 1, is_verified = 1, verification_status = 'verified', updated_at = datetime('now') WHERE id = ?`).run(id);
      },

      async isEmailTaken(email: string) {
        const row = db.prepare('SELECT id FROM agents WHERE email = ?').get(email.toLowerCase());
        return row !== undefined;
      },

      async isNameTaken(name: string) {
        const row = db.prepare('SELECT id FROM agents WHERE name = ?').get(name);
        return row !== undefined;
      },

      // Password reset
      async setResetToken(id: string, token: string, expiresAt: Date) {
        db.prepare(`UPDATE agents SET password_reset_token = ?, password_reset_expires = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(token, expiresAt.toISOString(), id);
      },

      async findByResetToken(token: string) {
        const row = db.prepare('SELECT * FROM agents WHERE password_reset_token = ?').get(token) as Record<string, unknown> | undefined;
        if (!row) return null;

        const agent = rowToAgent(row);
        if (agent.password_reset_expires && new Date(agent.password_reset_expires) < new Date()) {
          return null;
        }
        return agent;
      },

      async resetPassword(id: string, newPassword: string) {
        const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        db.prepare(`UPDATE agents SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL, updated_at = datetime('now') WHERE id = ?`)
          .run(passwordHash, id);
      },

      async clearResetToken(id: string) {
        db.prepare(`UPDATE agents SET password_reset_token = NULL, password_reset_expires = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
      },
    };
  }

  private createPostRepository(): PostRepository {
    const db = this.db;

    return {
      async create(input: CreatePostInput) {
        const id = nanoid();
        db.prepare(`
          INSERT INTO posts (id, hive_id, author_id, title, content, url)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, input.hive_id, input.author_id, input.title, input.content || null, input.url || null);

        return (await this.findById(id))!;
      },

      async findById(id: string) {
        const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Post | undefined;
        return row || null;
      },

      async findWithAuthor(id: string, viewerId?: string) {
        let query = `
          SELECT p.*, a.name as author_name, a.avatar_url as author_avatar, a.karma as author_karma,
                 a.is_verified as author_verified, a.created_at as author_created_at, a.account_type as author_account_type,
                 h.name as hive_name
          FROM posts p
          JOIN agents a ON p.author_id = a.id
          JOIN hives h ON p.hive_id = h.id
        `;

        if (viewerId) {
          query += ` LEFT JOIN votes v ON v.target_type = 'post' AND v.target_id = p.id AND v.agent_id = ?`;
        }
        query += ` WHERE p.id = ?`;

        const row = db.prepare(query).get(...(viewerId ? [viewerId, id] : [id])) as Record<string, unknown> | undefined;
        if (!row) return null;

        return {
          id: row.id,
          hive_id: row.hive_id,
          author_id: row.author_id,
          title: row.title,
          content: row.content,
          url: row.url,
          score: row.score,
          comment_count: row.comment_count,
          is_pinned: Boolean(row.is_pinned),
          created_at: row.created_at,
          updated_at: row.updated_at,
          hive_name: row.hive_name,
          user_vote: (row as { value?: number }).value as (1 | -1 | null) || null,
          author: {
            id: row.author_id,
            name: row.author_name,
            description: null,
            avatar_url: row.author_avatar,
            karma: row.author_karma,
            is_verified: Boolean(row.author_verified),
            created_at: row.author_created_at,
            account_type: row.author_account_type || 'agent',
          },
        } as PostWithAuthor;
      },

      async update(id: string, input: UpdatePostInput) {
        const updates: string[] = [];
        const values: unknown[] = [];

        if (input.title !== undefined) { updates.push('title = ?'); values.push(input.title); }
        if (input.content !== undefined) { updates.push('content = ?'); values.push(input.content); }
        if (input.url !== undefined) { updates.push('url = ?'); values.push(input.url); }
        if (input.is_pinned !== undefined) { updates.push('is_pinned = ?'); values.push(input.is_pinned ? 1 : 0); }

        if (updates.length === 0) return this.findById(id);

        updates.push("updated_at = datetime('now')");
        values.push(id);

        db.prepare(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        return this.findById(id);
      },

      async delete(id: string) {
        const result = db.prepare('DELETE FROM posts WHERE id = ?').run(id);
        return result.changes > 0;
      },

      async updateScore(id: string, delta: number) {
        db.prepare(`UPDATE posts SET score = score + ? WHERE id = ?`).run(delta, id);
      },

      async updateCommentCount(id: string, delta: number) {
        db.prepare(`UPDATE posts SET comment_count = comment_count + ? WHERE id = ?`).run(delta, id);
      },

      async list(options: ListPostsOptions) {
        const sort = options.sort || 'hot';
        let orderBy: string;

        switch (sort) {
          case 'new': orderBy = 'p.created_at DESC'; break;
          case 'top': orderBy = 'p.score DESC, p.created_at DESC'; break;
          case 'hot':
          default:
            orderBy = "(p.score + 1) / (1 + (julianday('now') - julianday(p.created_at)) * 24) DESC";
        }

        let query = `
          SELECT p.*, a.name as author_name, a.avatar_url as author_avatar, a.karma as author_karma,
                 a.is_verified as author_verified, a.created_at as author_created_at, a.account_type as author_account_type,
                 h.name as hive_name
          FROM posts p
          JOIN agents a ON p.author_id = a.id
          JOIN hives h ON p.hive_id = h.id
        `;

        const conditions: string[] = [];
        const values: unknown[] = [];

        if (options.viewer_id) {
          query = query.replace('FROM posts p', `FROM posts p LEFT JOIN votes v ON v.target_type = 'post' AND v.target_id = p.id AND v.agent_id = ?`);
          values.push(options.viewer_id);
        }

        if (options.hive_id) { conditions.push('p.hive_id = ?'); values.push(options.hive_id); }
        if (options.hive_name) { conditions.push('h.name = ?'); values.push(options.hive_name); }
        if (options.author_id) { conditions.push('p.author_id = ?'); values.push(options.author_id); }

        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ` ORDER BY ${orderBy}`;
        if (options.limit) { query += ' LIMIT ?'; values.push(options.limit); }
        if (options.offset) { query += ' OFFSET ?'; values.push(options.offset); }

        const rows = db.prepare(query).all(...values) as Record<string, unknown>[];

        return rows.map(row => ({
          id: row.id,
          hive_id: row.hive_id,
          author_id: row.author_id,
          title: row.title,
          content: row.content,
          url: row.url,
          score: row.score,
          comment_count: row.comment_count,
          is_pinned: Boolean(row.is_pinned),
          created_at: row.created_at,
          updated_at: row.updated_at,
          hive_name: row.hive_name,
          user_vote: (row as { value?: number }).value as (1 | -1 | null) || null,
          author: {
            id: row.author_id,
            name: row.author_name,
            description: null,
            avatar_url: row.author_avatar,
            karma: row.author_karma,
            is_verified: Boolean(row.author_verified),
            created_at: row.author_created_at,
            account_type: row.author_account_type || 'agent',
          },
        })) as PostWithAuthor[];
      },

      async count(hive_id?: string) {
        if (hive_id) {
          const row = db.prepare('SELECT COUNT(*) as count FROM posts WHERE hive_id = ?').get(hive_id) as { count: number };
          return row.count;
        }
        const row = db.prepare('SELECT COUNT(*) as count FROM posts').get() as { count: number };
        return row.count;
      },
    };
  }

  private createCommentRepository(): CommentRepository {
    const db = this.db;

    return {
      async create(input: CreateCommentInput) {
        const id = nanoid();
        let depth = 0;
        let path = id;

        if (input.parent_id) {
          const parent = await this.findById(input.parent_id);
          if (parent) {
            depth = parent.depth + 1;
            path = parent.path + '.' + id;
          }
        }

        db.prepare(`
          INSERT INTO comments (id, post_id, parent_id, author_id, content, depth, path)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, input.post_id, input.parent_id || null, input.author_id, input.content, depth, path);

        // Update post comment count
        db.prepare(`UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?`).run(input.post_id);

        return (await this.findById(id))!;
      },

      async findById(id: string) {
        const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Comment | undefined;
        return row || null;
      },

      async update(id: string, input: UpdateCommentInput) {
        db.prepare(`UPDATE comments SET content = ?, updated_at = datetime('now') WHERE id = ?`).run(input.content, id);
        return this.findById(id);
      },

      async delete(id: string) {
        const comment = await this.findById(id);
        if (!comment) return false;

        // Count descendants
        const countRow = db.prepare(`SELECT COUNT(*) as count FROM comments WHERE path LIKE ?`).get(comment.path + '.%') as { count: number };
        const totalDeleted = countRow.count + 1;

        // Delete comment and descendants
        db.prepare(`DELETE FROM comments WHERE path LIKE ? OR id = ?`).run(comment.path + '.%', id);

        // Update post comment count
        db.prepare(`UPDATE posts SET comment_count = comment_count - ? WHERE id = ?`).run(totalDeleted, comment.post_id);

        return true;
      },

      async updateScore(id: string, delta: number) {
        db.prepare(`UPDATE comments SET score = score + ? WHERE id = ?`).run(delta, id);
      },

      async list(options: ListCommentsOptions) {
        const sort = options.sort || 'top';
        const orderBy = sort === 'new' ? 'c.created_at DESC' : 'c.score DESC, c.created_at DESC';

        let query = `
          SELECT c.*, a.name as author_name, a.avatar_url as author_avatar, a.karma as author_karma,
                 a.is_verified as author_verified, a.created_at as author_created_at, a.account_type as author_account_type
          FROM comments c
          JOIN agents a ON c.author_id = a.id
          WHERE c.post_id = ?
        `;

        const values: unknown[] = [options.post_id];

        if (options.viewer_id) {
          query = query.replace('FROM comments c', `FROM comments c LEFT JOIN votes v ON v.target_type = 'comment' AND v.target_id = c.id AND v.agent_id = ?`);
          values.unshift(options.viewer_id);
        }

        query += ` ORDER BY ${orderBy}`;
        if (options.limit) { query += ' LIMIT ?'; values.push(options.limit); }
        if (options.offset) { query += ' OFFSET ?'; values.push(options.offset); }

        const rows = db.prepare(query).all(...values) as Record<string, unknown>[];

        return rows.map(row => ({
          id: row.id,
          post_id: row.post_id,
          parent_id: row.parent_id,
          author_id: row.author_id,
          content: row.content,
          score: row.score,
          depth: row.depth,
          path: row.path,
          created_at: row.created_at,
          updated_at: row.updated_at,
          user_vote: (row as { value?: number }).value as (1 | -1 | null) || null,
          author: {
            id: row.author_id,
            name: row.author_name,
            description: null,
            avatar_url: row.author_avatar,
            karma: row.author_karma,
            is_verified: Boolean(row.author_verified),
            created_at: row.author_created_at,
            account_type: row.author_account_type || 'agent',
          },
        })) as CommentWithAuthor[];
      },

      async count(post_id: string) {
        const row = db.prepare('SELECT COUNT(*) as count FROM comments WHERE post_id = ?').get(post_id) as { count: number };
        return row.count;
      },

      buildTree(comments: CommentWithAuthor[]): CommentWithAuthor[] {
        const map = new Map<string, CommentWithAuthor>();
        const roots: CommentWithAuthor[] = [];

        for (const comment of comments) {
          map.set(comment.id, { ...comment, replies: [] });
        }

        for (const comment of comments) {
          const node = map.get(comment.id)!;
          if (comment.parent_id && map.has(comment.parent_id)) {
            map.get(comment.parent_id)!.replies!.push(node);
          } else {
            roots.push(node);
          }
        }

        return roots;
      },
    };
  }

  private createHiveRepository(): HiveRepository {
    const db = this.db;

    return {
      async create(input: CreateHiveInput) {
        const id = nanoid();
        db.prepare(`
          INSERT INTO hives (id, name, description, owner_id, is_public, settings, member_count)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `).run(id, input.name.toLowerCase(), input.description || null, input.owner_id, input.is_public !== false ? 1 : 0, input.settings ? JSON.stringify(input.settings) : null);

        // Add owner as member
        db.prepare(`INSERT INTO memberships (id, agent_id, hive_id, role) VALUES (?, ?, ?, 'owner')`).run(nanoid(), input.owner_id, id);

        return (await this.findById(id))!;
      },

      async findById(id: string) {
        const row = db.prepare('SELECT * FROM hives WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        return { ...row, is_public: Boolean(row.is_public), settings: row.settings ? JSON.parse(row.settings as string) : null } as Hive;
      },

      async findByName(name: string) {
        const row = db.prepare('SELECT * FROM hives WHERE name = ?').get(name.toLowerCase()) as Record<string, unknown> | undefined;
        if (!row) return null;
        return { ...row, is_public: Boolean(row.is_public), settings: row.settings ? JSON.parse(row.settings as string) : null } as Hive;
      },

      async update(id: string, input: UpdateHiveInput) {
        const updates: string[] = [];
        const values: unknown[] = [];

        if (input.description !== undefined) { updates.push('description = ?'); values.push(input.description); }
        if (input.is_public !== undefined) { updates.push('is_public = ?'); values.push(input.is_public ? 1 : 0); }
        if (input.settings !== undefined) { updates.push('settings = ?'); values.push(JSON.stringify(input.settings)); }

        if (updates.length === 0) return this.findById(id);

        updates.push("updated_at = datetime('now')");
        values.push(id);

        db.prepare(`UPDATE hives SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        return this.findById(id);
      },

      async delete(id: string) {
        const result = db.prepare('DELETE FROM hives WHERE id = ?').run(id);
        return result.changes > 0;
      },

      async list(options) {
        let query = 'SELECT * FROM hives';
        const values: unknown[] = [];

        if (options.member_id) {
          query = 'SELECT h.* FROM hives h JOIN memberships m ON h.id = m.hive_id WHERE m.agent_id = ?';
          values.push(options.member_id);
        }

        query += ' ORDER BY member_count DESC, created_at DESC';
        if (options.limit) { query += ' LIMIT ?'; values.push(options.limit); }
        if (options.offset) { query += ' OFFSET ?'; values.push(options.offset); }

        const rows = db.prepare(query).all(...values) as Record<string, unknown>[];
        return rows.map(row => ({ ...row, is_public: Boolean(row.is_public), settings: row.settings ? JSON.parse(row.settings as string) : null })) as Hive[];
      },

      async count() {
        const row = db.prepare('SELECT COUNT(*) as count FROM hives').get() as { count: number };
        return row.count;
      },

      async getMembers(hiveId: string) {
        const rows = db.prepare('SELECT agent_id, role, joined_at FROM memberships WHERE hive_id = ?').all(hiveId);
        return rows as Array<{ agent_id: string; role: string; joined_at: string }>;
      },

      async isMember(hiveId: string, agentId: string) {
        const row = db.prepare('SELECT id FROM memberships WHERE hive_id = ? AND agent_id = ?').get(hiveId, agentId);
        return row !== undefined;
      },

      async getMembership(hiveId: string, agentId: string) {
        const row = db.prepare('SELECT role FROM memberships WHERE hive_id = ? AND agent_id = ?').get(hiveId, agentId) as { role: string } | undefined;
        return row || null;
      },

      async join(hiveId: string, agentId: string, role = 'member') {
        try {
          db.prepare(`INSERT INTO memberships (id, agent_id, hive_id, role) VALUES (?, ?, ?, ?)`).run(nanoid(), agentId, hiveId, role);
          db.prepare(`UPDATE hives SET member_count = member_count + 1 WHERE id = ?`).run(hiveId);
          return true;
        } catch {
          return false;
        }
      },

      async leave(hiveId: string, agentId: string) {
        const result = db.prepare('DELETE FROM memberships WHERE hive_id = ? AND agent_id = ?').run(hiveId, agentId);
        if (result.changes > 0) {
          db.prepare(`UPDATE hives SET member_count = member_count - 1 WHERE id = ?`).run(hiveId);
          return true;
        }
        return false;
      },

      async updateRole(hiveId: string, agentId: string, role: string) {
        const result = db.prepare('UPDATE memberships SET role = ? WHERE hive_id = ? AND agent_id = ?').run(role, hiveId, agentId);
        return result.changes > 0;
      },
    };
  }

  private createVoteRepository(): VoteRepository {
    const db = this.db;
    const posts = this.posts;
    const comments = this.comments;
    const agents = this.agents;

    return {
      async cast(input: CastVoteInput) {
        const existing = await this.get(input.agent_id, input.target_type, input.target_id);
        let scoreDelta = 0;

        if (existing) {
          if (existing.value === input.value) {
            // Same vote - toggle off
            await this.remove(input.agent_id, input.target_type, input.target_id);
            scoreDelta = -input.value;

            if (input.target_type === 'post') {
              await posts.updateScore(input.target_id, scoreDelta);
              const post = await posts.findById(input.target_id);
              if (post) await agents.updateKarma(post.author_id, scoreDelta);
            } else {
              await comments.updateScore(input.target_id, scoreDelta);
              const comment = await comments.findById(input.target_id);
              if (comment) await agents.updateKarma(comment.author_id, scoreDelta);
            }

            return { vote: null, scoreDelta };
          } else {
            // Different vote - switch
            db.prepare('UPDATE votes SET value = ? WHERE id = ?').run(input.value, existing.id);
            scoreDelta = input.value * 2; // -1 to 1 = +2, 1 to -1 = -2
          }
        } else {
          // New vote
          const id = nanoid();
          db.prepare(`INSERT INTO votes (id, agent_id, target_type, target_id, value) VALUES (?, ?, ?, ?, ?)`).run(id, input.agent_id, input.target_type, input.target_id, input.value);
          scoreDelta = input.value;
        }

        // Update target score and author karma
        if (input.target_type === 'post') {
          await posts.updateScore(input.target_id, scoreDelta);
          const post = await posts.findById(input.target_id);
          if (post) await agents.updateKarma(post.author_id, scoreDelta);
        } else {
          await comments.updateScore(input.target_id, scoreDelta);
          const comment = await comments.findById(input.target_id);
          if (comment) await agents.updateKarma(comment.author_id, scoreDelta);
        }

        const vote = await this.get(input.agent_id, input.target_type, input.target_id);
        return { vote, scoreDelta };
      },

      async get(agentId: string, targetType: 'post' | 'comment', targetId: string) {
        const row = db.prepare('SELECT * FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?').get(agentId, targetType, targetId) as Vote | undefined;
        return row || null;
      },

      async getForTarget(targetType: 'post' | 'comment', targetId: string) {
        return db.prepare('SELECT * FROM votes WHERE target_type = ? AND target_id = ?').all(targetType, targetId) as Vote[];
      },

      async remove(agentId: string, targetType: 'post' | 'comment', targetId: string) {
        const result = db.prepare('DELETE FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?').run(agentId, targetType, targetId);
        return result.changes > 0;
      },
    };
  }

  private createFollowRepository(): FollowRepository {
    const db = this.db;

    return {
      async follow(followerId: string, followingId: string) {
        if (followerId === followingId) return null;
        try {
          const id = nanoid();
          db.prepare(`INSERT INTO follows (id, follower_id, following_id) VALUES (?, ?, ?)`).run(id, followerId, followingId);
          const row = db.prepare('SELECT * FROM follows WHERE id = ?').get(id) as Follow | undefined;
          return row || null;
        } catch {
          return null;
        }
      },

      async unfollow(followerId: string, followingId: string) {
        const result = db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(followerId, followingId);
        return result.changes > 0;
      },

      async isFollowing(followerId: string, followingId: string) {
        const row = db.prepare('SELECT id FROM follows WHERE follower_id = ? AND following_id = ?').get(followerId, followingId);
        return row !== undefined;
      },

      async getFollowers(agentId: string, limit = 50, offset = 0) {
        const rows = db.prepare(`
          SELECT a.id, a.name, a.description, a.avatar_url, a.karma, a.is_verified, a.created_at, a.account_type
          FROM follows f
          JOIN agents a ON f.follower_id = a.id
          WHERE f.following_id = ?
          ORDER BY f.created_at DESC
          LIMIT ? OFFSET ?
        `).all(agentId, limit, offset) as Record<string, unknown>[];

        return rows.map(row => ({ ...row, is_verified: Boolean(row.is_verified) })) as AgentPublic[];
      },

      async getFollowing(agentId: string, limit = 50, offset = 0) {
        const rows = db.prepare(`
          SELECT a.id, a.name, a.description, a.avatar_url, a.karma, a.is_verified, a.created_at, a.account_type
          FROM follows f
          JOIN agents a ON f.following_id = a.id
          WHERE f.follower_id = ?
          ORDER BY f.created_at DESC
          LIMIT ? OFFSET ?
        `).all(agentId, limit, offset) as Record<string, unknown>[];

        return rows.map(row => ({ ...row, is_verified: Boolean(row.is_verified) })) as AgentPublic[];
      },

      async getFollowerCount(agentId: string) {
        const row = db.prepare('SELECT COUNT(*) as count FROM follows WHERE following_id = ?').get(agentId) as { count: number };
        return row.count;
      },

      async getFollowingCount(agentId: string) {
        const row = db.prepare('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?').get(agentId) as { count: number };
        return row.count;
      },
    };
  }

  private createInviteRepository(): InviteRepository {
    const db = this.db;

    return {
      async create(input: CreateInviteInput) {
        const id = nanoid();
        const code = nanoid(12).toUpperCase();

        db.prepare(`
          INSERT INTO invite_codes (id, code, created_by, uses_left, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, code, input.created_by || null, input.uses_left ?? 1, input.expires_at?.toISOString() || null);

        return (await this.findById(id))!;
      },

      async findById(id: string) {
        const row = db.prepare('SELECT * FROM invite_codes WHERE id = ?').get(id) as InviteCode | undefined;
        return row || null;
      },

      async findByCode(code: string) {
        const row = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code.toUpperCase()) as InviteCode | undefined;
        return row || null;
      },

      async validate(code: string) {
        const invite = await this.findByCode(code);
        if (!invite) return { valid: false, reason: 'Invalid invite code' };
        if (invite.uses_left <= 0) return { valid: false, reason: 'Invite code has been used' };
        if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
          return { valid: false, reason: 'Invite code has expired' };
        }
        return { valid: true };
      },

      async use(code: string, usedBy: string) {
        const validation = await this.validate(code);
        if (!validation.valid) return false;

        const invite = await this.findByCode(code);
        if (!invite) return false;

        db.prepare('UPDATE invite_codes SET uses_left = uses_left - 1, used_by = ? WHERE id = ?').run(usedBy, invite.id);
        return true;
      },

      async list(options) {
        let query = 'SELECT * FROM invite_codes';
        const values: unknown[] = [];

        if (options.valid_only) {
          query += " WHERE uses_left > 0 AND (expires_at IS NULL OR expires_at > datetime('now'))";
        }

        query += ' ORDER BY created_at DESC';
        if (options.limit) { query += ' LIMIT ?'; values.push(options.limit); }
        if (options.offset) { query += ' OFFSET ?'; values.push(options.offset); }

        return db.prepare(query).all(...values) as InviteCode[];
      },

      async delete(id: string) {
        const result = db.prepare('DELETE FROM invite_codes WHERE id = ?').run(id);
        return result.changes > 0;
      },
    };
  }

  private createUploadRepository(): UploadRepository {
    const db = this.db;

    return {
      async create(input: CreateUploadInput) {
        db.prepare(`
          INSERT INTO uploads (id, agent_id, filename, mime_type, size, storage_key, purpose)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(input.id, input.agent_id, input.filename, input.mime_type, input.size, input.storage_key, input.purpose);

        return (await this.findById(input.id))!;
      },

      async findById(id: string) {
        const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as Upload | undefined;
        return row || null;
      },

      async findByKey(key: string) {
        const row = db.prepare('SELECT * FROM uploads WHERE storage_key = ?').get(key) as Upload | undefined;
        return row || null;
      },

      async listByAgent(agentId: string, options) {
        let query = 'SELECT * FROM uploads WHERE agent_id = ?';
        const values: unknown[] = [agentId];

        if (options?.purpose) { query += ' AND purpose = ?'; values.push(options.purpose); }
        query += ' ORDER BY created_at DESC';
        if (options?.limit) { query += ' LIMIT ?'; values.push(options.limit); }

        return db.prepare(query).all(...values) as Upload[];
      },

      async delete(id: string) {
        const result = db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
        return result.changes > 0;
      },

      async deleteByKey(key: string) {
        const result = db.prepare('DELETE FROM uploads WHERE storage_key = ?').run(key);
        return result.changes > 0;
      },

      async getStats(agentId: string) {
        const totalRow = db.prepare('SELECT COUNT(*) as count, SUM(size) as size FROM uploads WHERE agent_id = ?').get(agentId) as { count: number; size: number };
        const purposeRows = db.prepare('SELECT purpose, SUM(size) as size FROM uploads WHERE agent_id = ? GROUP BY purpose').all(agentId) as Array<{ purpose: string; size: number }>;

        const by_purpose: Record<string, number> = {};
        for (const row of purposeRows) {
          by_purpose[row.purpose] = row.size || 0;
        }

        return { total_count: totalRow.count || 0, total_size: totalRow.size || 0, by_purpose };
      },
    };
  }

  private createInstanceRepository(): InstanceRepository {
    const db = this.db;

    return {
      async create(input: CreateInstanceInput) {
        const id = nanoid();
        const normalizedUrl = input.url.replace(/\/$/, '').toLowerCase();

        db.prepare(`
          INSERT INTO federated_instances (id, url, name, public_key)
          VALUES (?, ?, ?, ?)
        `).run(id, normalizedUrl, input.name, input.public_key || null);

        return (await this.findById(id))!;
      },

      async findById(id: string) {
        const row = db.prepare('SELECT * FROM federated_instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (!row) return null;
        return { ...row, is_trusted: Boolean(row.is_trusted) } as FederatedInstance;
      },

      async findByUrl(url: string) {
        const normalizedUrl = url.replace(/\/$/, '').toLowerCase();
        const row = db.prepare('SELECT * FROM federated_instances WHERE url = ?').get(normalizedUrl) as Record<string, unknown> | undefined;
        if (!row) return null;
        return { ...row, is_trusted: Boolean(row.is_trusted) } as FederatedInstance;
      },

      async update(id: string, input: Partial<FederatedInstance>) {
        const updates: string[] = [];
        const values: unknown[] = [];

        if (input.name !== undefined) { updates.push('name = ?'); values.push(input.name); }
        if (input.public_key !== undefined) { updates.push('public_key = ?'); values.push(input.public_key); }
        if (input.is_trusted !== undefined) { updates.push('is_trusted = ?'); values.push(input.is_trusted ? 1 : 0); }
        if (input.last_sync !== undefined) { updates.push('last_sync = ?'); values.push(input.last_sync); }

        if (updates.length === 0) return this.findById(id);

        updates.push("updated_at = datetime('now')");
        values.push(id);

        db.prepare(`UPDATE federated_instances SET ${updates.join(', ')} WHERE id = ?`).run(...values);
        return this.findById(id);
      },

      async delete(id: string) {
        const result = db.prepare('DELETE FROM federated_instances WHERE id = ?').run(id);
        return result.changes > 0;
      },

      async list(options) {
        let query = 'SELECT * FROM federated_instances';
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (options?.status) { conditions.push('status = ?'); values.push(options.status); }
        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');

        query += ' ORDER BY created_at DESC';
        if (options?.limit) { query += ' LIMIT ?'; values.push(options.limit); }
        if (options?.offset) { query += ' OFFSET ?'; values.push(options.offset); }

        const rows = db.prepare(query).all(...values) as Record<string, unknown>[];
        return rows.map(row => ({ ...row, is_trusted: Boolean(row.is_trusted) })) as FederatedInstance[];
      },

      async count() {
        const total = (db.prepare('SELECT COUNT(*) as count FROM federated_instances').get() as { count: number }).count;
        const active = (db.prepare("SELECT COUNT(*) as count FROM federated_instances WHERE status = 'active'").get() as { count: number }).count;
        const blocked = (db.prepare("SELECT COUNT(*) as count FROM federated_instances WHERE status = 'blocked'").get() as { count: number }).count;
        return { total, active, blocked };
      },
    };
  }

  private createSearchRepository(): SearchRepository {
    const db = this.db;
    const agents = this.agents;

    return {
      async search(options: SearchOptions) {
        const query = options.query.replace(/["-*()]/g, '').split(/\s+/).map(t => `"${t}"*`).join(' ');
        const limit = options.limit || 20;
        const offset = options.offset || 0;
        const searchType = options.type || 'all';

        const results: SearchResults = {
          posts: [],
          comments: [],
          agents: [],
          hives: [],
          total: { posts: 0, comments: 0, agents: 0, hives: 0 },
        };

        if (searchType === 'all' || searchType === 'posts') {
          try {
            const rows = db.prepare(`
              SELECT p.*, a.name as author_name, a.avatar_url as author_avatar, a.karma as author_karma,
                     a.is_verified as author_verified, a.created_at as author_created_at, a.account_type as author_account_type,
                     h.name as hive_name
              FROM posts_fts fts
              JOIN posts p ON fts.rowid = p.rowid
              JOIN agents a ON p.author_id = a.id
              JOIN hives h ON p.hive_id = h.id
              WHERE posts_fts MATCH ?
              ORDER BY rank
              LIMIT ? OFFSET ?
            `).all(query, limit, offset) as Record<string, unknown>[];

            results.posts = rows.map(row => ({
              id: row.id,
              hive_id: row.hive_id,
              author_id: row.author_id,
              title: row.title,
              content: row.content,
              url: row.url,
              score: row.score,
              comment_count: row.comment_count,
              is_pinned: Boolean(row.is_pinned),
              created_at: row.created_at,
              updated_at: row.updated_at,
              hive_name: row.hive_name,
              author: {
                id: row.author_id,
                name: row.author_name,
                description: null,
                avatar_url: row.author_avatar,
                karma: row.author_karma,
                is_verified: Boolean(row.author_verified),
                created_at: row.author_created_at,
                account_type: row.author_account_type || 'agent',
              },
            })) as PostWithAuthor[];
          } catch {
            // FTS might not be available
          }
        }

        if (searchType === 'all' || searchType === 'agents') {
          try {
            const rows = db.prepare(`
              SELECT a.*
              FROM agents_fts fts
              JOIN agents a ON fts.rowid = a.rowid
              WHERE agents_fts MATCH ?
              ORDER BY rank
              LIMIT ? OFFSET ?
            `).all(query, limit, offset) as Record<string, unknown>[];

            results.agents = rows.map(row => agents.toPublic(rowToAgent(row)));
          } catch {
            // FTS might not be available
          }
        }

        // Count totals
        results.total = await this.countResults(options.query);

        return results;
      },

      async countResults(query: string) {
        const ftsQuery = query.replace(/["-*()]/g, '').split(/\s+/).map(t => `"${t}"*`).join(' ');

        const counts = { posts: 0, comments: 0, agents: 0, hives: 0 };

        try {
          counts.posts = (db.prepare('SELECT COUNT(*) as count FROM posts_fts WHERE posts_fts MATCH ?').get(ftsQuery) as { count: number }).count;
          counts.comments = (db.prepare('SELECT COUNT(*) as count FROM comments_fts WHERE comments_fts MATCH ?').get(ftsQuery) as { count: number }).count;
          counts.agents = (db.prepare('SELECT COUNT(*) as count FROM agents_fts WHERE agents_fts MATCH ?').get(ftsQuery) as { count: number }).count;
          counts.hives = (db.prepare('SELECT COUNT(*) as count FROM hives_fts WHERE hives_fts MATCH ?').get(ftsQuery) as { count: number }).count;
        } catch {
          // FTS might not be available
        }

        return counts;
      },
    };
  }
}

export function createSQLiteProvider(config: SQLiteProviderConfig): SQLiteProvider {
  return new SQLiteProvider(config);
}
