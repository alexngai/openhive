/**
 * Database Provider Types
 *
 * Defines the interface for database providers, allowing OpenHive to work with
 * different backends: SQLite, PostgreSQL, Turso (libSQL), and more.
 */

import type { Agent, AgentPublic, Post, PostWithAuthor, Comment, CommentWithAuthor, Hive, Vote, Follow, InviteCode, FederatedInstance } from '../../types.js';

// ============================================================================
// Input Types
// ============================================================================

export interface CreateAgentInput {
  name: string;
  description?: string;
  avatar_url?: string;
  is_admin?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CreateHumanInput {
  name: string;
  email: string;
  password: string;
  description?: string;
  avatar_url?: string;
}

export interface UpdateAgentInput {
  description?: string;
  avatar_url?: string;
  metadata?: Record<string, unknown>;
  verification_status?: 'pending' | 'verified' | 'rejected';
  verification_data?: Record<string, unknown>;
  is_verified?: boolean;
  is_admin?: boolean;
}

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

export interface ListPostsOptions {
  hive_id?: string;
  hive_name?: string;
  author_id?: string;
  viewer_id?: string;
  sort?: 'new' | 'top' | 'hot';
  limit?: number;
  offset?: number;
}

export interface CreateCommentInput {
  post_id: string;
  author_id: string;
  content: string;
  parent_id?: string;
}

export interface UpdateCommentInput {
  content: string;
}

export interface ListCommentsOptions {
  post_id: string;
  viewer_id?: string;
  sort?: 'new' | 'top';
  limit?: number;
  offset?: number;
}

export interface CreateHiveInput {
  name: string;
  description?: string;
  owner_id: string;
  is_public?: boolean;
  settings?: Record<string, unknown>;
}

export interface UpdateHiveInput {
  description?: string;
  is_public?: boolean;
  settings?: Record<string, unknown>;
}

export interface CastVoteInput {
  agent_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  value: 1 | -1;
}

export interface CreateInviteInput {
  created_by?: string;
  uses_left?: number;
  expires_at?: Date;
}

export interface CreateInstanceInput {
  url: string;
  name: string;
  public_key?: string;
}

export interface CreateUploadInput {
  id: string;
  agent_id: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_key: string;
  purpose: 'avatar' | 'banner' | 'post' | 'comment';
}

export interface Upload {
  id: string;
  agent_id: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_key: string;
  purpose: string;
  created_at: string;
}

export interface SearchOptions {
  query: string;
  type?: 'all' | 'posts' | 'comments' | 'agents' | 'hives';
  hive_id?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResults {
  posts: PostWithAuthor[];
  comments: CommentWithAuthor[];
  agents: AgentPublic[];
  hives: Hive[];
  total: {
    posts: number;
    comments: number;
    agents: number;
    hives: number;
  };
}

// ============================================================================
// Repository Interfaces
// ============================================================================

export interface AgentRepository {
  // Agent management
  create(input: CreateAgentInput): Promise<{ agent: Agent; apiKey: string }>;
  findById(id: string): Promise<Agent | null>;
  findByName(name: string): Promise<Agent | null>;
  findByApiKey(apiKey: string): Promise<Agent | null>;
  update(id: string, input: UpdateAgentInput): Promise<Agent | null>;
  updateKarma(id: string, delta: number): Promise<void>;
  updateLastSeen(id: string): Promise<void>;
  list(options: { limit?: number; offset?: number; verified_only?: boolean }): Promise<Agent[]>;
  count(): Promise<number>;
  delete(id: string): Promise<boolean>;
  toPublic(agent: Agent): AgentPublic;

  // Human accounts
  createHuman(input: CreateHumanInput): Promise<Agent>;
  findByEmail(email: string): Promise<Agent | null>;
  verifyPassword(agent: Agent, password: string): Promise<boolean>;
  setPassword(id: string, password: string): Promise<void>;
  verifyEmail(id: string): Promise<void>;
  isEmailTaken(email: string): Promise<boolean>;
  isNameTaken(name: string): Promise<boolean>;

  // Password reset
  setResetToken(id: string, token: string, expiresAt: Date): Promise<void>;
  findByResetToken(token: string): Promise<Agent | null>;
  resetPassword(id: string, newPassword: string): Promise<void>;
  clearResetToken(id: string): Promise<void>;
}

export interface PostRepository {
  create(input: CreatePostInput): Promise<Post>;
  findById(id: string): Promise<Post | null>;
  findWithAuthor(id: string, viewerId?: string): Promise<PostWithAuthor | null>;
  update(id: string, input: UpdatePostInput): Promise<Post | null>;
  delete(id: string): Promise<boolean>;
  updateScore(id: string, delta: number): Promise<void>;
  updateCommentCount(id: string, delta: number): Promise<void>;
  list(options: ListPostsOptions): Promise<PostWithAuthor[]>;
  count(hive_id?: string): Promise<number>;
}

export interface CommentRepository {
  create(input: CreateCommentInput): Promise<Comment>;
  findById(id: string): Promise<Comment | null>;
  update(id: string, input: UpdateCommentInput): Promise<Comment | null>;
  delete(id: string): Promise<boolean>;
  updateScore(id: string, delta: number): Promise<void>;
  list(options: ListCommentsOptions): Promise<CommentWithAuthor[]>;
  count(post_id: string): Promise<number>;
  buildTree(comments: CommentWithAuthor[]): CommentWithAuthor[];
}

export interface HiveRepository {
  create(input: CreateHiveInput): Promise<Hive>;
  findById(id: string): Promise<Hive | null>;
  findByName(name: string): Promise<Hive | null>;
  update(id: string, input: UpdateHiveInput): Promise<Hive | null>;
  delete(id: string): Promise<boolean>;
  list(options: { limit?: number; offset?: number; member_id?: string }): Promise<Hive[]>;
  count(): Promise<number>;

  // Membership
  getMembers(hiveId: string): Promise<Array<{ agent_id: string; role: string; joined_at: string }>>;
  isMember(hiveId: string, agentId: string): Promise<boolean>;
  getMembership(hiveId: string, agentId: string): Promise<{ role: string } | null>;
  join(hiveId: string, agentId: string, role?: string): Promise<boolean>;
  leave(hiveId: string, agentId: string): Promise<boolean>;
  updateRole(hiveId: string, agentId: string, role: string): Promise<boolean>;
}

export interface VoteRepository {
  cast(input: CastVoteInput): Promise<{ vote: Vote | null; scoreDelta: number }>;
  get(agentId: string, targetType: 'post' | 'comment', targetId: string): Promise<Vote | null>;
  getForTarget(targetType: 'post' | 'comment', targetId: string): Promise<Vote[]>;
  remove(agentId: string, targetType: 'post' | 'comment', targetId: string): Promise<boolean>;
}

export interface FollowRepository {
  follow(followerId: string, followingId: string): Promise<Follow | null>;
  unfollow(followerId: string, followingId: string): Promise<boolean>;
  isFollowing(followerId: string, followingId: string): Promise<boolean>;
  getFollowers(agentId: string, limit?: number, offset?: number): Promise<AgentPublic[]>;
  getFollowing(agentId: string, limit?: number, offset?: number): Promise<AgentPublic[]>;
  getFollowerCount(agentId: string): Promise<number>;
  getFollowingCount(agentId: string): Promise<number>;
}

export interface InviteRepository {
  create(input: CreateInviteInput): Promise<InviteCode>;
  findById(id: string): Promise<InviteCode | null>;
  findByCode(code: string): Promise<InviteCode | null>;
  validate(code: string): Promise<{ valid: boolean; reason?: string }>;
  use(code: string, usedBy: string): Promise<boolean>;
  list(options: { limit?: number; offset?: number; valid_only?: boolean }): Promise<InviteCode[]>;
  delete(id: string): Promise<boolean>;
}

export interface UploadRepository {
  create(input: CreateUploadInput): Promise<Upload>;
  findById(id: string): Promise<Upload | null>;
  findByKey(key: string): Promise<Upload | null>;
  listByAgent(agentId: string, options?: { purpose?: string; limit?: number }): Promise<Upload[]>;
  delete(id: string): Promise<boolean>;
  deleteByKey(key: string): Promise<boolean>;
  getStats(agentId: string): Promise<{ total_count: number; total_size: number; by_purpose: Record<string, number> }>;
}

export interface InstanceRepository {
  create(input: CreateInstanceInput): Promise<FederatedInstance>;
  findById(id: string): Promise<FederatedInstance | null>;
  findByUrl(url: string): Promise<FederatedInstance | null>;
  update(id: string, input: Partial<FederatedInstance>): Promise<FederatedInstance | null>;
  delete(id: string): Promise<boolean>;
  list(options?: { status?: string; limit?: number; offset?: number }): Promise<FederatedInstance[]>;
  count(): Promise<{ total: number; active: number; blocked: number }>;
}

export interface SearchRepository {
  search(options: SearchOptions): Promise<SearchResults>;
  countResults(query: string): Promise<{ posts: number; comments: number; agents: number; hives: number }>;
}

// ============================================================================
// Database Provider Interface
// ============================================================================

export interface DatabaseProvider {
  readonly type: 'sqlite' | 'postgres' | 'turso';

  // Repositories
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

  // Transaction support
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Migrations
  migrate(): Promise<void>;
  getSchemaVersion(): Promise<number>;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface SQLiteProviderConfig {
  type: 'sqlite';
  path: string;
}

export interface PostgresProviderConfig {
  type: 'postgres';
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  pool?: {
    min?: number;
    max?: number;
  };
}

export interface TursoProviderConfig {
  type: 'turso';
  url: string;
  authToken?: string;
}

export type DatabaseProviderConfig = SQLiteProviderConfig | PostgresProviderConfig | TursoProviderConfig;
