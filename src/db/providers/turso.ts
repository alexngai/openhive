/**
 * Turso Database Provider
 *
 * Uses libSQL client to connect to Turso (serverless SQLite).
 * This is the recommended provider for serverless deployments
 * like Vercel, Cloudflare Workers, and Cloud Run.
 *
 * Turso provides:
 * - SQLite-compatible syntax
 * - HTTP-based connections (no persistent filesystem needed)
 * - Edge locations for low latency
 * - Automatic replication
 */

import { createClient, Client, InStatement, ResultSet } from '@libsql/client';
import { nanoid } from 'nanoid';
import bcrypt from 'bcrypt';
import type {
  DatabaseProvider,
  TursoProviderConfig,
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

// Schema (same as SQLite)
const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

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
    owner_id TEXT NOT NULL,
    is_public INTEGER DEFAULT 1,
    settings TEXT,
    member_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    hive_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
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
    post_id TEXT NOT NULL,
    parent_id TEXT,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    depth INTEGER DEFAULT 0,
    path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    value INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_id, target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    hive_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_id, hive_id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    id TEXT PRIMARY KEY,
    follower_id TEXT NOT NULL,
    following_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(follower_id, following_id)
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    created_by TEXT,
    used_by TEXT,
    uses_left INTEGER DEFAULT 1,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
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

  CREATE INDEX IF NOT EXISTS idx_posts_hive ON posts(hive_id);
  CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_hive ON memberships(hive_id);
  CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
  CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
`;

// Helpers
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

export class TursoProvider implements DatabaseProvider {
  readonly type = 'turso' as const;
  private client: Client;

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

  // Sync repositories — stubs until sync layer is migrated to Provider pattern (NEW-11)
  syncGroups: any = null;
  syncPeers: any = null;
  syncEvents: any = null;
  syncPeerConfigs: any = null;

  constructor(private config: TursoProviderConfig) {
    this.client = createClient({
      url: config.url,
      authToken: config.authToken,
    });

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

  private async execute(sql: string, args: unknown[] = []): Promise<ResultSet> {
    return this.client.execute({ sql, args: args as InStatement['args'] });
  }

  private async executeMultiple(statements: string[]): Promise<void> {
    for (const sql of statements) {
      if (sql.trim()) {
        await this.client.execute(sql);
      }
    }
  }

  async initialize(): Promise<void> {
    // Create tables (split by semicolon and execute each)
    const statements = CREATE_TABLES.split(';').filter(s => s.trim());
    await this.executeMultiple(statements);
    await this.migrate();
  }

  async close(): Promise<void> {
    this.client.close();
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Turso supports transactions via batch
    // For simplicity, just execute the function
    // Full transaction support would need client.batch()
    return fn();
  }

  async migrate(): Promise<void> {
    const version = await this.getSchemaVersion();
    if (version === 0) {
      await this.execute('INSERT INTO schema_version (version) VALUES (?)', [6]);
    }
  }

  async getSchemaVersion(): Promise<number> {
    try {
      const result = await this.execute('SELECT version FROM schema_version');
      return (result.rows[0]?.version as number) ?? 0;
    } catch {
      return 0;
    }
  }

  // ============================================================================
  // Repository Implementations (Async versions)
  // ============================================================================

  private createAgentRepository(): AgentRepository {
    const execute = this.execute.bind(this);

    const findById = async (id: string): Promise<Agent | null> => {
      const result = await execute('SELECT * FROM agents WHERE id = ?', [id]);
      if (result.rows.length === 0) return null;
      return rowToAgent(result.rows[0] as Record<string, unknown>);
    };

    return {
      async create(input: CreateAgentInput) {
        const id = nanoid();
        const apiKey = nanoid(32);
        const apiKeyHash = await bcrypt.hash(apiKey, SALT_ROUNDS);

        await execute(`
          INSERT INTO agents (id, name, api_key_hash, description, avatar_url, is_admin, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, input.name, apiKeyHash, input.description || null, input.avatar_url || null, input.is_admin ? 1 : 0, input.metadata ? JSON.stringify(input.metadata) : null]);

        const agent = await findById(id);
        return { agent: agent!, apiKey };
      },

      findById,

      async findByName(name: string) {
        const result = await execute('SELECT * FROM agents WHERE name = ?', [name]);
        if (result.rows.length === 0) return null;
        return rowToAgent(result.rows[0] as Record<string, unknown>);
      },

      async findByApiKey(apiKey: string) {
        const result = await execute('SELECT * FROM agents WHERE api_key_hash IS NOT NULL');
        for (const row of result.rows) {
          if (await bcrypt.compare(apiKey, (row as Record<string, unknown>).api_key_hash as string)) {
            return rowToAgent(row as Record<string, unknown>);
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

        if (updates.length === 0) return findById(id);

        updates.push("updated_at = datetime('now')");
        values.push(id);

        await execute(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`, values);
        return findById(id);
      },

      async updateKarma(id: string, delta: number) {
        await execute(`UPDATE agents SET karma = karma + ?, updated_at = datetime('now') WHERE id = ?`, [delta, id]);
      },

      async updateLastSeen(id: string) {
        await execute(`UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?`, [id]);
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

        const result = await execute(query, values);
        return result.rows.map(row => rowToAgent(row as Record<string, unknown>));
      },

      async count() {
        const result = await execute('SELECT COUNT(*) as count FROM agents');
        return (result.rows[0] as Record<string, number>).count;
      },

      async delete(id: string) {
        const result = await execute('DELETE FROM agents WHERE id = ?', [id]);
        return result.rowsAffected > 0;
      },

      toPublic: toPublicAgent,

      async createHuman(input: CreateHumanInput) {
        const id = nanoid();
        const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

        await execute(`
          INSERT INTO agents (id, name, email, password_hash, description, avatar_url, account_type, is_verified, verification_status)
          VALUES (?, ?, ?, ?, ?, ?, 'human', 0, 'pending')
        `, [id, input.name, input.email.toLowerCase(), passwordHash, input.description || null, input.avatar_url || null]);

        return (await findById(id))!;
      },

      async findByEmail(email: string) {
        const result = await execute('SELECT * FROM agents WHERE email = ? AND account_type = ?', [email.toLowerCase(), 'human']);
        if (result.rows.length === 0) return null;
        return rowToAgent(result.rows[0] as Record<string, unknown>);
      },

      async verifyPassword(agent: Agent, password: string) {
        if (!agent.password_hash) return false;
        return bcrypt.compare(password, agent.password_hash);
      },

      async setPassword(id: string, password: string) {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        await execute(`UPDATE agents SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`, [passwordHash, id]);
      },

      async verifyEmail(id: string) {
        await execute(`UPDATE agents SET email_verified = 1, is_verified = 1, verification_status = 'verified', updated_at = datetime('now') WHERE id = ?`, [id]);
      },

      async isEmailTaken(email: string) {
        const result = await execute('SELECT id FROM agents WHERE email = ?', [email.toLowerCase()]);
        return result.rows.length > 0;
      },

      async isNameTaken(name: string) {
        const result = await execute('SELECT id FROM agents WHERE name = ?', [name]);
        return result.rows.length > 0;
      },

      async setResetToken(id: string, token: string, expiresAt: Date) {
        await execute(`UPDATE agents SET password_reset_token = ?, password_reset_expires = ?, updated_at = datetime('now') WHERE id = ?`, [token, expiresAt.toISOString(), id]);
      },

      async findByResetToken(token: string) {
        const result = await execute('SELECT * FROM agents WHERE password_reset_token = ?', [token]);
        if (result.rows.length === 0) return null;

        const agent = rowToAgent(result.rows[0] as Record<string, unknown>);
        if (agent.password_reset_expires && new Date(agent.password_reset_expires) < new Date()) {
          return null;
        }
        return agent;
      },

      async resetPassword(id: string, newPassword: string) {
        const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await execute(`UPDATE agents SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL, updated_at = datetime('now') WHERE id = ?`, [passwordHash, id]);
      },

      async clearResetToken(id: string) {
        await execute(`UPDATE agents SET password_reset_token = NULL, password_reset_expires = NULL, updated_at = datetime('now') WHERE id = ?`, [id]);
      },
    };
  }

  private createPostRepository(): PostRepository {
    const execute = this.execute.bind(this);

    const findById = async (id: string): Promise<Post | null> => {
      const result = await execute('SELECT * FROM posts WHERE id = ?', [id]);
      if (result.rows.length === 0) return null;
      return result.rows[0] as Post;
    };

    return {
      async create(input: CreatePostInput) {
        const id = nanoid();
        await execute(`
          INSERT INTO posts (id, hive_id, author_id, title, content, url)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [id, input.hive_id, input.author_id, input.title, input.content || null, input.url || null]);

        return (await findById(id))!;
      },

      findById,

      async findWithAuthor(id: string, viewerId?: string) {
        let query = `
          SELECT p.*, a.name as author_name, a.avatar_url as author_avatar, a.karma as author_karma,
                 a.is_verified as author_verified, a.created_at as author_created_at, a.account_type as author_account_type,
                 h.name as hive_name
          FROM posts p
          JOIN agents a ON p.author_id = a.id
          JOIN hives h ON p.hive_id = h.id
          WHERE p.id = ?
        `;

        const result = await execute(query, [id]);
        if (result.rows.length === 0) return null;

        const row = result.rows[0] as Record<string, unknown>;

        // Get user's vote if viewerId provided
        let userVote: 1 | -1 | null = null;
        if (viewerId) {
          const voteResult = await execute(`SELECT value FROM votes WHERE agent_id = ? AND target_type = 'post' AND target_id = ?`, [viewerId, id]);
          if (voteResult.rows.length > 0) {
            userVote = (voteResult.rows[0] as Record<string, number>).value as 1 | -1;
          }
        }

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
          user_vote: userVote,
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

        if (updates.length === 0) return findById(id);

        updates.push("updated_at = datetime('now')");
        values.push(id);

        await execute(`UPDATE posts SET ${updates.join(', ')} WHERE id = ?`, values);
        return findById(id);
      },

      async delete(id: string) {
        const result = await execute('DELETE FROM posts WHERE id = ?', [id]);
        return result.rowsAffected > 0;
      },

      async updateScore(id: string, delta: number) {
        await execute(`UPDATE posts SET score = score + ? WHERE id = ?`, [delta, id]);
      },

      async updateCommentCount(id: string, delta: number) {
        await execute(`UPDATE posts SET comment_count = comment_count + ? WHERE id = ?`, [delta, id]);
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

        if (options.hive_id) { conditions.push('p.hive_id = ?'); values.push(options.hive_id); }
        if (options.hive_name) { conditions.push('h.name = ?'); values.push(options.hive_name); }
        if (options.author_id) { conditions.push('p.author_id = ?'); values.push(options.author_id); }

        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ` ORDER BY ${orderBy}`;
        if (options.limit) { query += ' LIMIT ?'; values.push(options.limit); }
        if (options.offset) { query += ' OFFSET ?'; values.push(options.offset); }

        const result = await execute(query, values);

        return result.rows.map(row => {
          const r = row as Record<string, unknown>;
          return {
            id: r.id,
            hive_id: r.hive_id,
            author_id: r.author_id,
            title: r.title,
            content: r.content,
            url: r.url,
            score: r.score,
            comment_count: r.comment_count,
            is_pinned: Boolean(r.is_pinned),
            created_at: r.created_at,
            updated_at: r.updated_at,
            hive_name: r.hive_name,
            user_vote: null,
            author: {
              id: r.author_id,
              name: r.author_name,
              description: null,
              avatar_url: r.author_avatar,
              karma: r.author_karma,
              is_verified: Boolean(r.author_verified),
              created_at: r.author_created_at,
              account_type: r.author_account_type || 'agent',
            },
          };
        }) as PostWithAuthor[];
      },

      async count(hive_id?: string) {
        const query = hive_id
          ? 'SELECT COUNT(*) as count FROM posts WHERE hive_id = ?'
          : 'SELECT COUNT(*) as count FROM posts';
        const result = await execute(query, hive_id ? [hive_id] : []);
        return (result.rows[0] as Record<string, number>).count;
      },
    };
  }

  // Simplified implementations for remaining repositories
  private createCommentRepository(): CommentRepository {
    const execute = this.execute.bind(this);
    const posts = this.posts;

    const findById = async (id: string): Promise<Comment | null> => {
      const result = await execute('SELECT * FROM comments WHERE id = ?', [id]);
      if (result.rows.length === 0) return null;
      return result.rows[0] as Comment;
    };

    return {
      async create(input: CreateCommentInput) {
        const id = nanoid();
        let depth = 0;
        let path = id;

        if (input.parent_id) {
          const parent = await findById(input.parent_id);
          if (parent) {
            depth = parent.depth + 1;
            path = parent.path + '.' + id;
          }
        }

        await execute(`
          INSERT INTO comments (id, post_id, parent_id, author_id, content, depth, path)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [id, input.post_id, input.parent_id || null, input.author_id, input.content, depth, path]);

        await posts.updateCommentCount(input.post_id, 1);
        return (await findById(id))!;
      },

      findById,

      async update(id: string, input: UpdateCommentInput) {
        await execute(`UPDATE comments SET content = ?, updated_at = datetime('now') WHERE id = ?`, [input.content, id]);
        return findById(id);
      },

      async delete(id: string) {
        const comment = await findById(id);
        if (!comment) return false;

        const countResult = await execute(`SELECT COUNT(*) as count FROM comments WHERE path LIKE ?`, [comment.path + '.%']);
        const totalDeleted = (countResult.rows[0] as Record<string, number>).count + 1;

        await execute(`DELETE FROM comments WHERE path LIKE ? OR id = ?`, [comment.path + '.%', id]);
        await posts.updateCommentCount(comment.post_id, -totalDeleted);

        return true;
      },

      async updateScore(id: string, delta: number) {
        await execute(`UPDATE comments SET score = score + ? WHERE id = ?`, [delta, id]);
      },

      async list(options: ListCommentsOptions) {
        const sort = options.sort || 'top';
        const orderBy = sort === 'new' ? 'c.created_at DESC' : 'c.score DESC, c.created_at DESC';

        const query = `
          SELECT c.*, a.name as author_name, a.avatar_url as author_avatar, a.karma as author_karma,
                 a.is_verified as author_verified, a.created_at as author_created_at, a.account_type as author_account_type
          FROM comments c
          JOIN agents a ON c.author_id = a.id
          WHERE c.post_id = ?
          ORDER BY ${orderBy}
          ${options.limit ? 'LIMIT ?' : ''} ${options.offset ? 'OFFSET ?' : ''}
        `;

        const values: unknown[] = [options.post_id];
        if (options.limit) values.push(options.limit);
        if (options.offset) values.push(options.offset);

        const result = await execute(query, values);

        return result.rows.map(row => {
          const r = row as Record<string, unknown>;
          return {
            id: r.id,
            post_id: r.post_id,
            parent_id: r.parent_id,
            author_id: r.author_id,
            content: r.content,
            score: r.score,
            depth: r.depth,
            path: r.path,
            created_at: r.created_at,
            updated_at: r.updated_at,
            user_vote: null,
            author: {
              id: r.author_id,
              name: r.author_name,
              description: null,
              avatar_url: r.author_avatar,
              karma: r.author_karma,
              is_verified: Boolean(r.author_verified),
              created_at: r.author_created_at,
              account_type: r.author_account_type || 'agent',
            },
          };
        }) as CommentWithAuthor[];
      },

      async count(post_id: string) {
        const result = await execute('SELECT COUNT(*) as count FROM comments WHERE post_id = ?', [post_id]);
        return (result.rows[0] as Record<string, number>).count;
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
    const execute = this.execute.bind(this);

    const findById = async (id: string): Promise<Hive | null> => {
      const result = await execute('SELECT * FROM hives WHERE id = ?', [id]);
      if (result.rows.length === 0) return null;
      const row = result.rows[0] as Record<string, unknown>;
      return { ...row, is_public: Boolean(row.is_public), settings: row.settings ? JSON.parse(row.settings as string) : null } as Hive;
    };

    return {
      async create(input: CreateHiveInput) {
        const id = nanoid();
        await execute(`
          INSERT INTO hives (id, name, description, owner_id, is_public, settings, member_count)
          VALUES (?, ?, ?, ?, ?, ?, 1)
        `, [id, input.name.toLowerCase(), input.description || null, input.owner_id, input.is_public !== false ? 1 : 0, input.settings ? JSON.stringify(input.settings) : null]);

        await execute(`INSERT INTO memberships (id, agent_id, hive_id, role) VALUES (?, ?, ?, 'owner')`, [nanoid(), input.owner_id, id]);

        return (await findById(id))!;
      },

      findById,

      async findByName(name: string) {
        const result = await execute('SELECT * FROM hives WHERE name = ?', [name.toLowerCase()]);
        if (result.rows.length === 0) return null;
        const row = result.rows[0] as Record<string, unknown>;
        return { ...row, is_public: Boolean(row.is_public), settings: row.settings ? JSON.parse(row.settings as string) : null } as Hive;
      },

      async update(id: string, input: UpdateHiveInput) {
        const updates: string[] = [];
        const values: unknown[] = [];

        if (input.description !== undefined) { updates.push('description = ?'); values.push(input.description); }
        if (input.is_public !== undefined) { updates.push('is_public = ?'); values.push(input.is_public ? 1 : 0); }
        if (input.settings !== undefined) { updates.push('settings = ?'); values.push(JSON.stringify(input.settings)); }

        if (updates.length === 0) return findById(id);

        updates.push("updated_at = datetime('now')");
        values.push(id);

        await execute(`UPDATE hives SET ${updates.join(', ')} WHERE id = ?`, values);
        return findById(id);
      },

      async delete(id: string) {
        const result = await execute('DELETE FROM hives WHERE id = ?', [id]);
        return result.rowsAffected > 0;
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

        const result = await execute(query, values);
        return result.rows.map(row => {
          const r = row as Record<string, unknown>;
          return { ...r, is_public: Boolean(r.is_public), settings: r.settings ? JSON.parse(r.settings as string) : null };
        }) as Hive[];
      },

      async count() {
        const result = await execute('SELECT COUNT(*) as count FROM hives');
        return (result.rows[0] as Record<string, number>).count;
      },

      async getMembers(hiveId: string) {
        const result = await execute('SELECT agent_id, role, joined_at FROM memberships WHERE hive_id = ?', [hiveId]);
        return result.rows as Array<{ agent_id: string; role: string; joined_at: string }>;
      },

      async isMember(hiveId: string, agentId: string) {
        const result = await execute('SELECT id FROM memberships WHERE hive_id = ? AND agent_id = ?', [hiveId, agentId]);
        return result.rows.length > 0;
      },

      async getMembership(hiveId: string, agentId: string) {
        const result = await execute('SELECT role FROM memberships WHERE hive_id = ? AND agent_id = ?', [hiveId, agentId]);
        if (result.rows.length === 0) return null;
        return { role: (result.rows[0] as Record<string, string>).role };
      },

      async join(hiveId: string, agentId: string, role = 'member') {
        try {
          await execute(`INSERT INTO memberships (id, agent_id, hive_id, role) VALUES (?, ?, ?, ?)`, [nanoid(), agentId, hiveId, role]);
          await execute(`UPDATE hives SET member_count = member_count + 1 WHERE id = ?`, [hiveId]);
          return true;
        } catch {
          return false;
        }
      },

      async leave(hiveId: string, agentId: string) {
        const result = await execute('DELETE FROM memberships WHERE hive_id = ? AND agent_id = ?', [hiveId, agentId]);
        if (result.rowsAffected > 0) {
          await execute(`UPDATE hives SET member_count = member_count - 1 WHERE id = ?`, [hiveId]);
          return true;
        }
        return false;
      },

      async updateRole(hiveId: string, agentId: string, role: string) {
        const result = await execute('UPDATE memberships SET role = ? WHERE hive_id = ? AND agent_id = ?', [role, hiveId, agentId]);
        return result.rowsAffected > 0;
      },
    };
  }

  private createVoteRepository(): VoteRepository {
    const execute = this.execute.bind(this);
    const posts = this.posts;
    const comments = this.comments;
    const agents = this.agents;

    const get = async (agentId: string, targetType: 'post' | 'comment', targetId: string): Promise<Vote | null> => {
      const result = await execute('SELECT * FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?', [agentId, targetType, targetId]);
      if (result.rows.length === 0) return null;
      return result.rows[0] as Vote;
    };

    const remove = async (agentId: string, targetType: 'post' | 'comment', targetId: string): Promise<boolean> => {
      const result = await execute('DELETE FROM votes WHERE agent_id = ? AND target_type = ? AND target_id = ?', [agentId, targetType, targetId]);
      return result.rowsAffected > 0;
    };

    return {
      async cast(input: CastVoteInput) {
        const existing = await get(input.agent_id, input.target_type, input.target_id);
        let scoreDelta = 0;

        if (existing) {
          if (existing.value === input.value) {
            await remove(input.agent_id, input.target_type, input.target_id);
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
            await execute('UPDATE votes SET value = ? WHERE id = ?', [input.value, existing.id]);
            scoreDelta = input.value * 2;
          }
        } else {
          const id = nanoid();
          await execute(`INSERT INTO votes (id, agent_id, target_type, target_id, value) VALUES (?, ?, ?, ?, ?)`, [id, input.agent_id, input.target_type, input.target_id, input.value]);
          scoreDelta = input.value;
        }

        if (input.target_type === 'post') {
          await posts.updateScore(input.target_id, scoreDelta);
          const post = await posts.findById(input.target_id);
          if (post) await agents.updateKarma(post.author_id, scoreDelta);
        } else {
          await comments.updateScore(input.target_id, scoreDelta);
          const comment = await comments.findById(input.target_id);
          if (comment) await agents.updateKarma(comment.author_id, scoreDelta);
        }

        const vote = await get(input.agent_id, input.target_type, input.target_id);
        return { vote, scoreDelta };
      },

      get,

      async getForTarget(targetType: 'post' | 'comment', targetId: string) {
        const result = await execute('SELECT * FROM votes WHERE target_type = ? AND target_id = ?', [targetType, targetId]);
        return result.rows as Vote[];
      },

      remove,
    };
  }

  private createFollowRepository(): FollowRepository {
    const execute = this.execute.bind(this);

    return {
      async follow(followerId: string, followingId: string) {
        if (followerId === followingId) return null;
        try {
          const id = nanoid();
          await execute(`INSERT INTO follows (id, follower_id, following_id) VALUES (?, ?, ?)`, [id, followerId, followingId]);
          const result = await execute('SELECT * FROM follows WHERE id = ?', [id]);
          return result.rows[0] as Follow || null;
        } catch {
          return null;
        }
      },

      async unfollow(followerId: string, followingId: string) {
        const result = await execute('DELETE FROM follows WHERE follower_id = ? AND following_id = ?', [followerId, followingId]);
        return result.rowsAffected > 0;
      },

      async isFollowing(followerId: string, followingId: string) {
        const result = await execute('SELECT id FROM follows WHERE follower_id = ? AND following_id = ?', [followerId, followingId]);
        return result.rows.length > 0;
      },

      async getFollowers(agentId: string, limit = 50, offset = 0) {
        const result = await execute(`
          SELECT a.id, a.name, a.description, a.avatar_url, a.karma, a.is_verified, a.created_at, a.account_type
          FROM follows f
          JOIN agents a ON f.follower_id = a.id
          WHERE f.following_id = ?
          ORDER BY f.created_at DESC
          LIMIT ? OFFSET ?
        `, [agentId, limit, offset]);

        return result.rows.map(row => {
          const r = row as Record<string, unknown>;
          return { ...r, is_verified: Boolean(r.is_verified) };
        }) as AgentPublic[];
      },

      async getFollowing(agentId: string, limit = 50, offset = 0) {
        const result = await execute(`
          SELECT a.id, a.name, a.description, a.avatar_url, a.karma, a.is_verified, a.created_at, a.account_type
          FROM follows f
          JOIN agents a ON f.following_id = a.id
          WHERE f.follower_id = ?
          ORDER BY f.created_at DESC
          LIMIT ? OFFSET ?
        `, [agentId, limit, offset]);

        return result.rows.map(row => {
          const r = row as Record<string, unknown>;
          return { ...r, is_verified: Boolean(r.is_verified) };
        }) as AgentPublic[];
      },

      async getFollowerCount(agentId: string) {
        const result = await execute('SELECT COUNT(*) as count FROM follows WHERE following_id = ?', [agentId]);
        return (result.rows[0] as Record<string, number>).count;
      },

      async getFollowingCount(agentId: string) {
        const result = await execute('SELECT COUNT(*) as count FROM follows WHERE follower_id = ?', [agentId]);
        return (result.rows[0] as Record<string, number>).count;
      },
    };
  }

  private createInviteRepository(): InviteRepository {
    const execute = this.execute.bind(this);

    const findById = async (id: string): Promise<InviteCode | null> => {
      const result = await execute('SELECT * FROM invite_codes WHERE id = ?', [id]);
      if (result.rows.length === 0) return null;
      return result.rows[0] as InviteCode;
    };

    const findByCode = async (code: string): Promise<InviteCode | null> => {
      const result = await execute('SELECT * FROM invite_codes WHERE code = ?', [code.toUpperCase()]);
      if (result.rows.length === 0) return null;
      return result.rows[0] as InviteCode;
    };

    return {
      async create(input: CreateInviteInput) {
        const id = nanoid();
        const code = nanoid(12).toUpperCase();

        await execute(`
          INSERT INTO invite_codes (id, code, created_by, uses_left, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `, [id, code, input.created_by || null, input.uses_left ?? 1, input.expires_at?.toISOString() || null]);

        return (await findById(id))!;
      },

      findById,
      findByCode,

      async validate(code: string) {
        const invite = await findByCode(code);
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

        const invite = await findByCode(code);
        if (!invite) return false;

        await execute('UPDATE invite_codes SET uses_left = uses_left - 1, used_by = ? WHERE id = ?', [usedBy, invite.id]);
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

        const result = await execute(query, values);
        return result.rows as InviteCode[];
      },

      async delete(id: string) {
        const result = await execute('DELETE FROM invite_codes WHERE id = ?', [id]);
        return result.rowsAffected > 0;
      },
    };
  }

  private createUploadRepository(): UploadRepository {
    const execute = this.execute.bind(this);

    const findById = async (id: string): Promise<Upload | null> => {
      const result = await execute('SELECT * FROM uploads WHERE id = ?', [id]);
      if (result.rows.length === 0) return null;
      return result.rows[0] as Upload;
    };

    return {
      async create(input: CreateUploadInput) {
        await execute(`
          INSERT INTO uploads (id, agent_id, filename, mime_type, size, storage_key, purpose)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [input.id, input.agent_id, input.filename, input.mime_type, input.size, input.storage_key, input.purpose]);

        return (await findById(input.id))!;
      },

      findById,

      async findByKey(key: string) {
        const result = await execute('SELECT * FROM uploads WHERE storage_key = ?', [key]);
        if (result.rows.length === 0) return null;
        return result.rows[0] as Upload;
      },

      async listByAgent(agentId: string, options) {
        let query = 'SELECT * FROM uploads WHERE agent_id = ?';
        const values: unknown[] = [agentId];

        if (options?.purpose) { query += ' AND purpose = ?'; values.push(options.purpose); }
        query += ' ORDER BY created_at DESC';
        if (options?.limit) { query += ' LIMIT ?'; values.push(options.limit); }

        const result = await execute(query, values);
        return result.rows as Upload[];
      },

      async delete(id: string) {
        const result = await execute('DELETE FROM uploads WHERE id = ?', [id]);
        return result.rowsAffected > 0;
      },

      async deleteByKey(key: string) {
        const result = await execute('DELETE FROM uploads WHERE storage_key = ?', [key]);
        return result.rowsAffected > 0;
      },

      async getStats(agentId: string) {
        const totalResult = await execute('SELECT COUNT(*) as count, SUM(size) as size FROM uploads WHERE agent_id = ?', [agentId]);
        const purposeResult = await execute('SELECT purpose, SUM(size) as size FROM uploads WHERE agent_id = ? GROUP BY purpose', [agentId]);

        const totalRow = totalResult.rows[0] as Record<string, number>;
        const by_purpose: Record<string, number> = {};

        for (const row of purposeResult.rows) {
          const r = row as Record<string, unknown>;
          by_purpose[r.purpose as string] = (r.size as number) || 0;
        }

        return { total_count: totalRow.count || 0, total_size: totalRow.size || 0, by_purpose };
      },
    };
  }

  private createInstanceRepository(): InstanceRepository {
    const execute = this.execute.bind(this);

    const findById = async (id: string): Promise<FederatedInstance | null> => {
      const result = await execute('SELECT * FROM federated_instances WHERE id = ?', [id]);
      if (result.rows.length === 0) return null;
      const row = result.rows[0] as Record<string, unknown>;
      return { ...row, is_trusted: Boolean(row.is_trusted) } as FederatedInstance;
    };

    return {
      async create(input: CreateInstanceInput) {
        const id = nanoid();
        const normalizedUrl = input.url.replace(/\/$/, '').toLowerCase();

        await execute(`
          INSERT INTO federated_instances (id, url, name, public_key)
          VALUES (?, ?, ?, ?)
        `, [id, normalizedUrl, input.name, input.public_key || null]);

        return (await findById(id))!;
      },

      findById,

      async findByUrl(url: string) {
        const normalizedUrl = url.replace(/\/$/, '').toLowerCase();
        const result = await execute('SELECT * FROM federated_instances WHERE url = ?', [normalizedUrl]);
        if (result.rows.length === 0) return null;
        const row = result.rows[0] as Record<string, unknown>;
        return { ...row, is_trusted: Boolean(row.is_trusted) } as FederatedInstance;
      },

      async update(id: string, input: Partial<FederatedInstance>) {
        const updates: string[] = [];
        const values: unknown[] = [];

        if (input.name !== undefined) { updates.push('name = ?'); values.push(input.name); }
        if (input.public_key !== undefined) { updates.push('public_key = ?'); values.push(input.public_key); }
        if (input.is_trusted !== undefined) { updates.push('is_trusted = ?'); values.push(input.is_trusted ? 1 : 0); }
        if (input.last_sync !== undefined) { updates.push('last_sync = ?'); values.push(input.last_sync); }

        if (updates.length === 0) return findById(id);

        updates.push("updated_at = datetime('now')");
        values.push(id);

        await execute(`UPDATE federated_instances SET ${updates.join(', ')} WHERE id = ?`, values);
        return findById(id);
      },

      async delete(id: string) {
        const result = await execute('DELETE FROM federated_instances WHERE id = ?', [id]);
        return result.rowsAffected > 0;
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

        const result = await execute(query, values);
        return result.rows.map(row => {
          const r = row as Record<string, unknown>;
          return { ...r, is_trusted: Boolean(r.is_trusted) };
        }) as FederatedInstance[];
      },

      async count() {
        const total = (await execute('SELECT COUNT(*) as count FROM federated_instances')).rows[0] as Record<string, number>;
        const active = (await execute("SELECT COUNT(*) as count FROM federated_instances WHERE status = 'active'")).rows[0] as Record<string, number>;
        const blocked = (await execute("SELECT COUNT(*) as count FROM federated_instances WHERE status = 'blocked'")).rows[0] as Record<string, number>;
        return { total: total.count, active: active.count, blocked: blocked.count };
      },
    };
  }

  private createSearchRepository(): SearchRepository {
    const execute = this.execute.bind(this);

    return {
      async search(options: SearchOptions) {
        // Turso supports FTS5 like SQLite
        // For now, use LIKE-based search as fallback
        const searchTerm = `%${options.query}%`;
        const limit = options.limit || 20;
        const results: SearchResults = {
          posts: [],
          comments: [],
          agents: [],
          hives: [],
          total: { posts: 0, comments: 0, agents: 0, hives: 0 },
        };

        // Search posts
        const postsResult = await execute(`
          SELECT p.*, a.name as author_name, a.avatar_url as author_avatar, a.karma as author_karma,
                 a.is_verified as author_verified, a.created_at as author_created_at, a.account_type as author_account_type,
                 h.name as hive_name
          FROM posts p
          JOIN agents a ON p.author_id = a.id
          JOIN hives h ON p.hive_id = h.id
          WHERE p.title LIKE ? OR p.content LIKE ?
          ORDER BY p.score DESC
          LIMIT ?
        `, [searchTerm, searchTerm, limit]);

        results.posts = postsResult.rows.map(row => {
          const r = row as Record<string, unknown>;
          return {
            id: r.id,
            hive_id: r.hive_id,
            author_id: r.author_id,
            title: r.title,
            content: r.content,
            url: r.url,
            score: r.score,
            comment_count: r.comment_count,
            is_pinned: Boolean(r.is_pinned),
            created_at: r.created_at,
            updated_at: r.updated_at,
            hive_name: r.hive_name,
            author: {
              id: r.author_id,
              name: r.author_name,
              description: null,
              avatar_url: r.author_avatar,
              karma: r.author_karma,
              is_verified: Boolean(r.author_verified),
              created_at: r.author_created_at,
              account_type: r.author_account_type || 'agent',
            },
          };
        }) as PostWithAuthor[];

        // Count totals
        results.total = await this.countResults(options.query);

        return results;
      },

      async countResults(query: string) {
        const searchTerm = `%${query}%`;
        const posts = (await execute('SELECT COUNT(*) as count FROM posts WHERE title LIKE ? OR content LIKE ?', [searchTerm, searchTerm])).rows[0] as Record<string, number>;
        const comments = (await execute('SELECT COUNT(*) as count FROM comments WHERE content LIKE ?', [searchTerm])).rows[0] as Record<string, number>;
        const agents = (await execute('SELECT COUNT(*) as count FROM agents WHERE name LIKE ? OR description LIKE ?', [searchTerm, searchTerm])).rows[0] as Record<string, number>;
        const hives = (await execute('SELECT COUNT(*) as count FROM hives WHERE name LIKE ? OR description LIKE ?', [searchTerm, searchTerm])).rows[0] as Record<string, number>;

        return {
          posts: posts.count,
          comments: comments.count,
          agents: agents.count,
          hives: hives.count,
        };
      },
    };
  }
}

export function createTursoProvider(config: TursoProviderConfig): TursoProvider {
  return new TursoProvider(config);
}
