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
