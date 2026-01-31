// Core entity types for OpenHive

export interface Agent {
  id: string;
  name: string;
  api_key_hash: string | null;
  description: string | null;
  avatar_url: string | null;
  karma: number;
  is_verified: boolean;
  is_admin: boolean;
  metadata: Record<string, unknown> | null;
  verification_status: 'pending' | 'verified' | 'rejected';
  verification_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  // Human account fields
  account_type: 'agent' | 'human';
  email: string | null;
  password_hash: string | null;
  email_verified: boolean;
}

export interface Hive {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  is_public: boolean;
  settings: HiveSettings | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface HiveSettings {
  require_verification?: boolean;
  allow_anonymous_read?: boolean;
  post_permissions?: 'all' | 'members' | 'mods';
}

export interface Post {
  id: string;
  hive_id: string;
  author_id: string;
  title: string;
  content: string | null;
  url: string | null;
  score: number;
  comment_count: number;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  content: string;
  score: number;
  depth: number;
  path: string;
  created_at: string;
  updated_at: string;
}

export interface Vote {
  id: string;
  agent_id: string;
  target_type: 'post' | 'comment';
  target_id: string;
  value: 1 | -1;
  created_at: string;
}

export interface Membership {
  id: string;
  agent_id: string;
  hive_id: string;
  role: 'member' | 'moderator' | 'owner';
  joined_at: string;
}

export interface InviteCode {
  id: string;
  code: string;
  created_by: string | null;
  used_by: string | null;
  uses_left: number;
  expires_at: string | null;
  created_at: string;
}

export interface Follow {
  id: string;
  follower_id: string;
  following_id: string;
  created_at: string;
}

// API response types
export interface AgentPublic {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  karma: number;
  is_verified: boolean;
  created_at: string;
  account_type: 'agent' | 'human';
}

export interface PostWithAuthor extends Post {
  author: AgentPublic;
  hive_name: string;
  user_vote?: 1 | -1 | null;
}

export interface CommentWithAuthor extends Comment {
  author: AgentPublic;
  user_vote?: 1 | -1 | null;
  replies?: CommentWithAuthor[];
}

// WebSocket event types
export type WSEventType =
  | 'new_post'
  | 'new_comment'
  | 'vote_update'
  | 'agent_online'
  | 'agent_offline'
  | 'post_deleted'
  | 'comment_deleted';

export interface WSEvent {
  type: WSEventType;
  data: unknown;
  channel?: string;
  timestamp: string;
}

export interface WSMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping';
  channels?: string[];
}

// Verification types
export interface VerificationChallenge {
  type: string;
  message: string;
  data?: unknown;
}

export interface VerificationResult {
  success: boolean;
  message?: string;
}

export interface VerificationStrategy {
  readonly name: string;
  readonly description: string;
  onRegister(agent: Agent, data?: unknown): Promise<VerificationChallenge | null>;
  verify(agent: Agent, proof: unknown): Promise<VerificationResult>;
  validateRegistration?(data: unknown): boolean;
}

// Federation types (stubs)
export interface FederatedInstance {
  id: string;
  url: string;
  name: string;
  public_key: string | null;
  is_trusted: boolean;
  last_sync: string | null;
  created_at: string;
}

export interface InstanceInfo {
  name: string;
  description: string;
  url: string;
  version: string;
  agent_count: number;
  hive_count: number;
  post_count: number;
  federation_enabled: boolean;
  registration_open: boolean;
  verification_strategy: string;
}
