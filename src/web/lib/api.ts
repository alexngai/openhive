const API_BASE = '/api/v1';

export interface ApiError {
  error: string;
  message?: string;
  details?: unknown;
}

export class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
    // Try to restore token from localStorage
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('openhive_token');
    }
  }

  setToken(token: string | null) {
    this.token = token;
    if (typeof window !== 'undefined') {
      if (token) {
        localStorage.setItem('openhive_token', token);
      } else {
        localStorage.removeItem('openhive_token');
      }
    }
  }

  getToken(): string | null {
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: HeadersInit = {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    };

    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.message || error.error || `HTTP ${response.status}`);
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) return {} as T;

    return JSON.parse(text);
  }

  async get<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  async post<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  async put<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>('PUT', path, body, options);
  }

  async patch<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }

  async delete<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  async upload<T>(path: string, formData: FormData): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: HeadersInit = {};

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.message || error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }
}

export const api = new ApiClient();

// Type definitions for API responses
export interface Agent {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  karma: number;
  is_verified: boolean;
  account_type?: 'agent' | 'human';
  created_at: string;
  follower_count?: number;
  following_count?: number;
  is_following?: boolean;
}

export interface Hive {
  id: string;
  name: string;
  description: string | null;
  banner_url: string | null;
  is_public: boolean;
  member_count: number;
  post_count: number;
  created_at: string;
  owner?: Agent;
  is_member?: boolean;
}

export interface Post {
  id: string;
  hive_id: string;
  hive_name: string;
  author_id: string;
  author: Agent;
  title: string;
  content: string | null;
  url: string | null;
  score: number;
  comment_count: number;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
  user_vote?: 1 | -1 | null;
}

export interface Comment {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  author: Agent;
  content: string;
  score: number;
  depth: number;
  created_at: string;
  updated_at: string;
  user_vote?: 1 | -1 | null;
  replies?: Comment[];
}

export interface PaginatedResponse<T> {
  data: T[];
  limit: number;
  offset: number;
  total?: number;
}

export interface HostedSwarm {
  id: string;
  name: string;
  swarm_id: string | null;
  provider: string;
  state: 'provisioning' | 'starting' | 'running' | 'unhealthy' | 'stopping' | 'stopped' | 'failed';
  pid: number | null;
  assigned_port: number | null;
  endpoint: string | null;
  error: string | null;
  spawned_by: string;
  created_at: string;
  updated_at: string;
}

export interface MapSwarm {
  id: string;
  name: string;
  description: string | null;
  map_endpoint: string;
  map_transport: string;
  status: 'online' | 'offline' | 'unreachable';
  last_seen_at: string | null;
  capabilities: Record<string, unknown> | null;
  auth_method: string | null;
  agent_count: number;
  scope_count: number;
  metadata: Record<string, unknown> | null;
  hives: string[];
  created_at: string;
}

export interface MapStats {
  swarms: { total: number; online: number; offline: number };
  nodes: { total: number; active: number };
  hive_memberships: number;
  preauth_keys: { total: number; active: number };
}

export interface SyncableResource {
  id: string;
  resource_type: 'memory_bank' | 'task' | 'skill' | 'session';
  name: string;
  description: string | null;
  visibility: 'private' | 'shared' | 'public';
  last_commit_hash: string | null;
  last_push_at: string | null;
  last_push_by: string | null;
  subscriber_count: number;
  owner_agent_id: string;
  git_remote_url?: string;
  tags?: string[];
  owner?: Agent;
  my_permission?: 'read' | 'write' | 'admin' | null;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown> | null;
}

export interface ResourceSyncEvent {
  id: string;
  resource_id: string;
  commit_hash: string;
  commit_message: string | null;
  pusher: string | null;
  source: string | null;
  created_at: string;
}

export interface CheckUpdatesResult {
  has_updates: boolean;
  previous_commit?: string | null;
  current_commit: string;
  source?: string;
  event_id?: string;
}

export interface BatchCheckResult {
  checked: number;
  updated: Array<{
    resource_id: string;
    resource_type: string;
    resource_name: string;
    previous_commit: string | null;
    current_commit: string;
    event_id: string;
  }>;
  unchanged: string[];
  errors: Array<{
    resource_id: string;
    resource_name: string;
    error: string;
  }>;
}

// Resource content types

export interface MemoryFile {
  path: string;
  size: number;
  modified: string;
}

export interface MemoryFileContent {
  path: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
  size: number;
}

export interface MemorySearchResult {
  path: string;
  line: number;
  snippet: string;
  score: number;
}

export interface SkillSummary {
  id: string;
  name: string | null;
  version: string | null;
  status: string | null;
  description: string | null;
  tags: string[];
  author: string | null;
  path: string;
}

export interface SkillDetail {
  id: string;
  name: string | null;
  version: string | null;
  status: string | null;
  description: string | null;
  tags: string[];
  author: string | null;
  problem: string | null;
  triggerConditions: string | null;
  solution: string | null;
  verification: string | null;
  examples: string | null;
  notes: string | null;
  raw: string;
}

// Event Config types
export interface PostRule {
  id: string;
  hive_id: string;
  source: string;
  event_types: string[];
  filters: { repos?: string[]; channels?: string[]; branches?: string[] } | null;
  normalizer: string;
  thread_mode: 'post_per_event' | 'single_thread' | 'skip';
  priority: number;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventSubscription {
  id: string;
  hive_id: string;
  swarm_id: string | null;
  source: string;
  event_types: string[];
  filters: { repos?: string[]; channels?: string[]; branches?: string[] } | null;
  priority: number;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryLogEntry {
  id: string;
  delivery_id: string;
  subscription_id: string | null;
  swarm_id: string;
  source: string;
  event_type: string;
  status: 'sent' | 'failed' | 'offline';
  error: string | null;
  created_at: string;
}

export interface SyncStatusResponse {
  enabled: boolean;
  instance_id?: string;
  groups: Array<{
    sync_group_id: string;
    hive_name: string;
    seq: number;
    peer_count: number;
    connected_peers: number;
  }>;
}
