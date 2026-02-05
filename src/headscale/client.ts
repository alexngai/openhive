/**
 * Headscale REST API Client
 *
 * Typed HTTP client for the headscale REST API (v0.28+).
 * Communicates with headscale via its /api/v1/ endpoints.
 */

import type {
  HeadscaleUser,
  CreateUserRequest,
  ListUsersResponse,
  HeadscaleNode,
  ListNodesResponse,
  SetTagsRequest,
  ApproveRoutesRequest,
  HeadscalePreauthKey,
  CreatePreauthKeyRequest,
  CreatePreauthKeyResponse,
  ListPreauthKeysResponse,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  HealthResponse,
  HeadscaleError,
  SetPolicyRequest,
  PolicyResponse,
} from './types.js';

export class HeadscaleClientError extends Error {
  status: number;
  headscaleError?: HeadscaleError;

  constructor(message: string, status: number, headscaleError?: HeadscaleError) {
    super(message);
    this.name = 'HeadscaleClientError';
    this.status = status;
    this.headscaleError = headscaleError;
  }
}

export class HeadscaleClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    // Normalize base URL (remove trailing slash)
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  // ==========================================================================
  // HTTP Helpers
  // ==========================================================================

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>
  ): Promise<T> {
    let url = `${this.baseUrl}/api/v1${path}`;

    if (query) {
      const params = new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined)
      );
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const options: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      let errorBody: HeadscaleError | undefined;
      try {
        errorBody = await response.json() as HeadscaleError;
      } catch {
        // Response may not be JSON
      }
      throw new HeadscaleClientError(
        errorBody?.message || `Headscale API error: ${response.status} ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    // 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // ==========================================================================
  // Health
  // ==========================================================================

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  async waitForHealthy(timeoutMs: number = 30000, intervalMs: number = 500): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const health = await this.health();
        if (health.databaseConnectivity) return;
      } catch {
        // Not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new HeadscaleClientError('Headscale did not become healthy within timeout', 0);
  }

  // ==========================================================================
  // Users
  // ==========================================================================

  async listUsers(): Promise<HeadscaleUser[]> {
    const resp = await this.request<ListUsersResponse>('GET', '/user');
    return resp.users || [];
  }

  async createUser(input: CreateUserRequest): Promise<HeadscaleUser> {
    const resp = await this.request<{ user: HeadscaleUser }>('POST', '/user', input);
    return resp.user;
  }

  async deleteUser(id: string): Promise<void> {
    await this.request<void>('DELETE', `/user/${id}`);
  }

  async findUserByName(name: string): Promise<HeadscaleUser | null> {
    const users = await this.listUsers();
    return users.find((u) => u.name === name) || null;
  }

  async ensureUser(name: string): Promise<HeadscaleUser> {
    const existing = await this.findUserByName(name);
    if (existing) return existing;
    return this.createUser({ name });
  }

  // ==========================================================================
  // Nodes
  // ==========================================================================

  async listNodes(userId?: string): Promise<HeadscaleNode[]> {
    const query = userId ? { user: userId } : undefined;
    const resp = await this.request<ListNodesResponse>('GET', '/node', undefined, query);
    return resp.nodes || [];
  }

  async getNode(nodeId: string): Promise<HeadscaleNode> {
    const resp = await this.request<{ node: HeadscaleNode }>('GET', `/node/${nodeId}`);
    return resp.node;
  }

  async deleteNode(nodeId: string): Promise<void> {
    await this.request<void>('DELETE', `/node/${nodeId}`);
  }

  async expireNode(nodeId: string): Promise<HeadscaleNode> {
    const resp = await this.request<{ node: HeadscaleNode }>('POST', `/node/${nodeId}/expire`);
    return resp.node;
  }

  async renameNode(nodeId: string, newName: string): Promise<HeadscaleNode> {
    const resp = await this.request<{ node: HeadscaleNode }>(
      'POST', `/node/${nodeId}/rename/${encodeURIComponent(newName)}`
    );
    return resp.node;
  }

  async setNodeTags(nodeId: string, tags: string[]): Promise<HeadscaleNode> {
    const body: SetTagsRequest = { tags };
    const resp = await this.request<{ node: HeadscaleNode }>('POST', `/node/${nodeId}/tags`, body);
    return resp.node;
  }

  async approveRoutes(nodeId: string, routes: string[]): Promise<HeadscaleNode> {
    const body: ApproveRoutesRequest = { routes };
    const resp = await this.request<{ node: HeadscaleNode }>(
      'POST', `/node/${nodeId}/approve_routes`, body
    );
    return resp.node;
  }

  /**
   * Find a headscale node by its tailscale hostname or given name.
   */
  async findNodeByName(name: string, userId?: string): Promise<HeadscaleNode | null> {
    const nodes = await this.listNodes(userId);
    return nodes.find((n) => n.name === name || n.givenName === name) || null;
  }

  // ==========================================================================
  // Pre-Auth Keys
  // ==========================================================================

  async listPreauthKeys(userId?: string): Promise<HeadscalePreauthKey[]> {
    const query = userId ? { user: userId } : undefined;
    const resp = await this.request<ListPreauthKeysResponse>('GET', '/preauthkey', undefined, query);
    return resp.preAuthKeys || [];
  }

  async createPreauthKey(input: CreatePreauthKeyRequest): Promise<HeadscalePreauthKey> {
    const resp = await this.request<CreatePreauthKeyResponse>('POST', '/preauthkey', input);
    return resp.preAuthKey;
  }

  async expirePreauthKey(keyId: string): Promise<void> {
    await this.request<void>('POST', '/preauthkey/expire', { id: keyId });
  }

  async deletePreauthKey(keyId: string): Promise<void> {
    await this.request<void>('DELETE', '/preauthkey', undefined, { id: keyId });
  }

  // ==========================================================================
  // API Keys
  // ==========================================================================

  async createApiKey(expiration?: string): Promise<string> {
    const body: CreateApiKeyRequest = {};
    if (expiration) body.expiration = expiration;
    const resp = await this.request<CreateApiKeyResponse>('POST', '/apikey', body);
    return resp.apiKey;
  }

  // ==========================================================================
  // Policy
  // ==========================================================================

  async getPolicy(): Promise<PolicyResponse> {
    return this.request<PolicyResponse>('GET', '/policy');
  }

  async setPolicy(policy: string): Promise<PolicyResponse> {
    const body: SetPolicyRequest = { policy };
    return this.request<PolicyResponse>('PUT', '/policy', body);
  }
}
