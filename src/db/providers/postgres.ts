/**
 * PostgreSQL Database Provider
 *
 * Uses the pg package for PostgreSQL database access.
 * This provider is recommended for production deployments requiring
 * horizontal scaling or high concurrency.
 *
 * Note: PostgreSQL uses different SQL syntax for some operations:
 * - RETURNING clause instead of separate SELECT after INSERT
 * - $1, $2 placeholders instead of ?
 * - NOW() instead of datetime('now')
 */

import pg from 'pg';
import { nanoid } from 'nanoid';
import bcrypt from 'bcrypt';
import type {
  DatabaseProvider,
  PostgresProviderConfig,
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
  ListPostsOptions,
  SearchResults,
} from './types.js';
import type { Agent, AgentPublic, Post, PostWithAuthor, Comment, CommentWithAuthor, Hive, Vote, InviteCode, FederatedInstance } from '../../types.js';

const { Pool } = pg;
const SALT_ROUNDS = 10;

// PostgreSQL Schema
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
    is_verified BOOLEAN DEFAULT FALSE,
    is_admin BOOLEAN DEFAULT FALSE,
    metadata JSONB,
    verification_status TEXT DEFAULT 'pending',
    verification_data JSONB,
    account_type TEXT DEFAULT 'agent',
    email TEXT UNIQUE,
    password_hash TEXT,
    email_verified BOOLEAN DEFAULT FALSE,
    password_reset_token TEXT,
    password_reset_expires TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_seen_at TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS hives (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    owner_id TEXT NOT NULL REFERENCES agents(id),
    is_public BOOLEAN DEFAULT TRUE,
    settings JSONB,
    member_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
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
    is_pinned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
    target_id TEXT NOT NULL,
    value INTEGER NOT NULL CHECK (value IN (-1, 1)),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(agent_id, target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    hive_id TEXT NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'owner')),
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(agent_id, hive_id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    id TEXT PRIMARY KEY,
    follower_id TEXT NOT NULL REFERENCES agents(id),
    following_id TEXT NOT NULL REFERENCES agents(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(follower_id, following_id)
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    created_by TEXT REFERENCES agents(id),
    used_by TEXT REFERENCES agents(id),
    uses_left INTEGER DEFAULT 1,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_key TEXT UNIQUE NOT NULL,
    purpose TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS federated_instances (
    id TEXT PRIMARY KEY,
    url TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    public_key TEXT,
    status TEXT DEFAULT 'pending',
    is_trusted BOOLEAN DEFAULT FALSE,
    agent_count INTEGER DEFAULT 0,
    post_count INTEGER DEFAULT 0,
    last_sync TIMESTAMP,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
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

// Helpers
function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    ...row,
    is_verified: Boolean(row.is_verified),
    is_admin: Boolean(row.is_admin),
    email_verified: Boolean(row.email_verified),
    account_type: (row.account_type as string) || 'agent',
    metadata: row.metadata || null,
    verification_data: row.verification_data || null,
    created_at: row.created_at?.toString() || new Date().toISOString(),
    updated_at: row.updated_at?.toString() || new Date().toISOString(),
    last_seen_at: row.last_seen_at?.toString() || null,
    password_reset_expires: row.password_reset_expires?.toString() || null,
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

export class PostgresProvider implements DatabaseProvider {
  readonly type = 'postgres' as const;
  private pool: pg.Pool;

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

  constructor(private config: PostgresProviderConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      min: config.pool?.min ?? 2,
      max: config.pool?.max ?? 10,
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

  private async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  private async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] || null;
  }

  private async execute(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.pool.query(sql, params);
    return result.rowCount ?? 0;
  }

  async initialize(): Promise<void> {
    await this.pool.query(CREATE_TABLES);
    await this.migrate();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    const version = await this.getSchemaVersion();
    if (version === 0) {
      await this.pool.query('INSERT INTO schema_version (version) VALUES ($1)', [6]);
    }
  }

  async getSchemaVersion(): Promise<number> {
    try {
      const row = await this.queryOne<{ version: number }>('SELECT version FROM schema_version');
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  // Repository implementations follow the same pattern as Turso but with PostgreSQL syntax
  // Using $1, $2, etc. instead of ? and NOW() instead of datetime('now')

  private createAgentRepository(): AgentRepository {
    const query = this.query.bind(this);
    const queryOne = this.queryOne.bind(this);
    const execute = this.execute.bind(this);

    const findById = async (id: string): Promise<Agent | null> => {
      const row = await queryOne('SELECT * FROM agents WHERE id = $1', [id]);
      return row ? rowToAgent(row) : null;
    };

    return {
      async create(input: CreateAgentInput) {
        const id = nanoid();
        const apiKey = nanoid(32);
        const apiKeyHash = await bcrypt.hash(apiKey, SALT_ROUNDS);

        await execute(`
          INSERT INTO agents (id, name, api_key_hash, description, avatar_url, is_admin, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [id, input.name, apiKeyHash, input.description || null, input.avatar_url || null, input.is_admin || false, input.metadata ? JSON.stringify(input.metadata) : null]);

        const agent = await findById(id);
        return { agent: agent!, apiKey };
      },

      findById,

      async findByName(name: string) {
        const row = await queryOne('SELECT * FROM agents WHERE name = $1', [name]);
        return row ? rowToAgent(row) : null;
      },

      async findByApiKey(apiKey: string) {
        const rows = await query('SELECT * FROM agents WHERE api_key_hash IS NOT NULL');
        for (const row of rows) {
          if (await bcrypt.compare(apiKey, row.api_key_hash as string)) {
            return rowToAgent(row);
          }
        }
        return null;
      },

      async update(id: string, input: UpdateAgentInput) {
        const updates: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        if (input.description !== undefined) { updates.push(`description = $${paramIndex++}`); values.push(input.description); }
        if (input.avatar_url !== undefined) { updates.push(`avatar_url = $${paramIndex++}`); values.push(input.avatar_url); }
        if (input.metadata !== undefined) { updates.push(`metadata = $${paramIndex++}`); values.push(JSON.stringify(input.metadata)); }
        if (input.verification_status !== undefined) { updates.push(`verification_status = $${paramIndex++}`); values.push(input.verification_status); }
        if (input.verification_data !== undefined) { updates.push(`verification_data = $${paramIndex++}`); values.push(JSON.stringify(input.verification_data)); }
        if (input.is_verified !== undefined) { updates.push(`is_verified = $${paramIndex++}`); values.push(input.is_verified); }
        if (input.is_admin !== undefined) { updates.push(`is_admin = $${paramIndex++}`); values.push(input.is_admin); }

        if (updates.length === 0) return findById(id);

        updates.push(`updated_at = NOW()`);
        values.push(id);

        await execute(`UPDATE agents SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);
        return findById(id);
      },

      async updateKarma(id: string, delta: number) {
        await execute(`UPDATE agents SET karma = karma + $1, updated_at = NOW() WHERE id = $2`, [delta, id]);
      },

      async updateLastSeen(id: string) {
        await execute(`UPDATE agents SET last_seen_at = NOW() WHERE id = $1`, [id]);
      },

      async list(options) {
        let queryStr = 'SELECT * FROM agents';
        const conditions: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        if (options.verified_only) conditions.push('is_verified = TRUE');
        if (conditions.length > 0) queryStr += ' WHERE ' + conditions.join(' AND ');
        queryStr += ' ORDER BY created_at DESC';
        if (options.limit) { queryStr += ` LIMIT $${paramIndex++}`; values.push(options.limit); }
        if (options.offset) { queryStr += ` OFFSET $${paramIndex++}`; values.push(options.offset); }

        const rows = await query(queryStr, values);
        return rows.map(rowToAgent);
      },

      async count() {
        const row = await queryOne<{ count: string }>('SELECT COUNT(*) as count FROM agents');
        return parseInt(row?.count || '0');
      },

      async delete(id: string) {
        const count = await execute('DELETE FROM agents WHERE id = $1', [id]);
        return count > 0;
      },

      toPublic: toPublicAgent,

      async createHuman(input) {
        const id = nanoid();
        const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

        await execute(`
          INSERT INTO agents (id, name, email, password_hash, description, avatar_url, account_type, is_verified, verification_status)
          VALUES ($1, $2, $3, $4, $5, $6, 'human', FALSE, 'pending')
        `, [id, input.name, input.email.toLowerCase(), passwordHash, input.description || null, input.avatar_url || null]);

        return (await findById(id))!;
      },

      async findByEmail(email: string) {
        const row = await queryOne("SELECT * FROM agents WHERE email = $1 AND account_type = 'human'", [email.toLowerCase()]);
        return row ? rowToAgent(row) : null;
      },

      async verifyPassword(agent: Agent, password: string) {
        if (!agent.password_hash) return false;
        return bcrypt.compare(password, agent.password_hash);
      },

      async setPassword(id: string, password: string) {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        await execute(`UPDATE agents SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [passwordHash, id]);
      },

      async verifyEmail(id: string) {
        await execute(`UPDATE agents SET email_verified = TRUE, is_verified = TRUE, verification_status = 'verified', updated_at = NOW() WHERE id = $1`, [id]);
      },

      async isEmailTaken(email: string) {
        const row = await queryOne('SELECT id FROM agents WHERE email = $1', [email.toLowerCase()]);
        return row !== null;
      },

      async isNameTaken(name: string) {
        const row = await queryOne('SELECT id FROM agents WHERE name = $1', [name]);
        return row !== null;
      },

      async setResetToken(id: string, token: string, expiresAt: Date) {
        await execute(`UPDATE agents SET password_reset_token = $1, password_reset_expires = $2, updated_at = NOW() WHERE id = $3`, [token, expiresAt, id]);
      },

      async findByResetToken(token: string) {
        const row = await queryOne('SELECT * FROM agents WHERE password_reset_token = $1', [token]);
        if (!row) return null;

        const agent = rowToAgent(row);
        if (agent.password_reset_expires && new Date(agent.password_reset_expires) < new Date()) {
          return null;
        }
        return agent;
      },

      async resetPassword(id: string, newPassword: string) {
        const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        await execute(`UPDATE agents SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL, updated_at = NOW() WHERE id = $2`, [passwordHash, id]);
      },

      async clearResetToken(id: string) {
        await execute(`UPDATE agents SET password_reset_token = NULL, password_reset_expires = NULL, updated_at = NOW() WHERE id = $1`, [id]);
      },
    };
  }

  // Simplified stubs for remaining repositories - following same pattern
  private createPostRepository(): PostRepository {
    // Implementation follows same pattern as agents
    return {} as PostRepository; // Placeholder - would follow same async pattern
  }

  private createCommentRepository(): CommentRepository {
    return {} as CommentRepository;
  }

  private createHiveRepository(): HiveRepository {
    return {} as HiveRepository;
  }

  private createVoteRepository(): VoteRepository {
    return {} as VoteRepository;
  }

  private createFollowRepository(): FollowRepository {
    return {} as FollowRepository;
  }

  private createInviteRepository(): InviteRepository {
    return {} as InviteRepository;
  }

  private createUploadRepository(): UploadRepository {
    return {} as UploadRepository;
  }

  private createInstanceRepository(): InstanceRepository {
    return {} as InstanceRepository;
  }

  private createSearchRepository(): SearchRepository {
    return {} as SearchRepository;
  }
}

export function createPostgresProvider(config: PostgresProviderConfig): PostgresProvider {
  return new PostgresProvider(config);
}
