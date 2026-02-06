/**
 * Tailscale Cloud API Client
 *
 * Typed HTTP client for the Tailscale API (api.tailscale.com/api/v2).
 * Supports both API key and OAuth client credential authentication.
 */

// ============================================================================
// Types matching the Tailscale API
// ============================================================================

export interface TailscaleAuthKey {
  id: string;
  key: string; // only present on creation
  created: string;
  expires: string;
  revoked?: string;
  invalid?: boolean;
  description: string;
  capabilities: {
    devices: {
      create: {
        reusable: boolean;
        ephemeral: boolean;
        preauthorized: boolean;
        tags: string[];
      };
    };
  };
}

export interface TailscaleDevice {
  id: string;
  nodeId: string;
  name: string; // MagicDNS FQDN
  hostname: string;
  user: string;
  addresses: string[];
  os: string;
  clientVersion: string;
  created: string;
  lastSeen: string;
  authorized: boolean;
  isExternal: boolean;
  keyExpiryDisabled: boolean;
  expires: string;
  updateAvailable: boolean;
  blocksIncomingConnections: boolean;
  tags?: string[];
  connectedToControl?: boolean;
  advertisedRoutes?: string[];
  enabledRoutes?: string[];
}

export interface TailscaleOAuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface CreateAuthKeyRequest {
  capabilities: {
    devices: {
      create: {
        reusable: boolean;
        ephemeral: boolean;
        preauthorized: boolean;
        tags: string[];
      };
    };
  };
  expirySeconds?: number;
  description?: string;
}

// ============================================================================
// Client
// ============================================================================

export class TailscaleClientError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TailscaleClientError';
    this.status = status;
  }
}

export interface TailscaleClientOptions {
  /** Tailnet name or '-' for default */
  tailnet: string;
  /** API key (tskey-api-...) — use this OR OAuth credentials */
  apiKey?: string;
  /** OAuth client ID */
  oauthClientId?: string;
  /** OAuth client secret */
  oauthClientSecret?: string;
}

export class TailscaleClient {
  private baseUrl = 'https://api.tailscale.com/api/v2';
  private tailnet: string;
  private apiKey?: string;
  private oauthClientId?: string;
  private oauthClientSecret?: string;
  private oauthToken?: string;
  private oauthTokenExpiresAt?: number;

  constructor(opts: TailscaleClientOptions) {
    this.tailnet = opts.tailnet;
    this.apiKey = opts.apiKey;
    this.oauthClientId = opts.oauthClientId;
    this.oauthClientSecret = opts.oauthClientSecret;

    if (!opts.apiKey && !(opts.oauthClientId && opts.oauthClientSecret)) {
      throw new Error('TailscaleClient requires either apiKey or oauthClientId + oauthClientSecret');
    }
  }

  // --------------------------------------------------------------------------
  // Auth
  // --------------------------------------------------------------------------

  private async getAuthHeader(): Promise<string> {
    if (this.apiKey) {
      return `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`;
    }

    // OAuth: refresh token if expired or missing
    if (!this.oauthToken || !this.oauthTokenExpiresAt || Date.now() >= this.oauthTokenExpiresAt - 60_000) {
      await this.refreshOAuthToken();
    }

    return `Bearer ${this.oauthToken}`;
  }

  private async refreshOAuthToken(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.oauthClientId!,
        client_secret: this.oauthClientSecret!,
        grant_type: 'client_credentials',
      }),
    });

    if (!response.ok) {
      throw new TailscaleClientError(
        `OAuth token exchange failed: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    const data = await response.json() as TailscaleOAuthToken;
    this.oauthToken = data.access_token;
    this.oauthTokenExpiresAt = Date.now() + data.expires_in * 1000;
  }

  // --------------------------------------------------------------------------
  // HTTP
  // --------------------------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const authHeader = await this.getAuthHeader();

    const options: RequestInit = {
      method,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      let errorMsg = `Tailscale API error: ${response.status} ${response.statusText}`;
      try {
        const errorBody = await response.json() as { message?: string };
        if (errorBody.message) errorMsg = errorBody.message;
      } catch {
        // non-JSON error body
      }
      throw new TailscaleClientError(errorMsg, response.status);
    }

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // --------------------------------------------------------------------------
  // Auth Keys
  // --------------------------------------------------------------------------

  async createAuthKey(input: CreateAuthKeyRequest): Promise<TailscaleAuthKey> {
    return this.request<TailscaleAuthKey>('POST', `/tailnet/${this.tailnet}/keys`, input);
  }

  async listAuthKeys(): Promise<TailscaleAuthKey[]> {
    const resp = await this.request<{ keys: TailscaleAuthKey[] }>('GET', `/tailnet/${this.tailnet}/keys`);
    return resp.keys || [];
  }

  async getAuthKey(keyId: string): Promise<TailscaleAuthKey> {
    return this.request<TailscaleAuthKey>('GET', `/tailnet/${this.tailnet}/keys/${keyId}`);
  }

  async deleteAuthKey(keyId: string): Promise<void> {
    await this.request<void>('DELETE', `/tailnet/${this.tailnet}/keys/${keyId}`);
  }

  // --------------------------------------------------------------------------
  // Devices
  // --------------------------------------------------------------------------

  async listDevices(fields: 'default' | 'all' = 'all'): Promise<TailscaleDevice[]> {
    const qs = fields === 'all' ? '?fields=all' : '';
    const resp = await this.request<{ devices: TailscaleDevice[] }>(
      'GET', `/tailnet/${this.tailnet}/devices${qs}`
    );
    return resp.devices || [];
  }

  async getDevice(deviceId: string): Promise<TailscaleDevice> {
    return this.request<TailscaleDevice>('GET', `/device/${deviceId}?fields=all`);
  }

  async deleteDevice(deviceId: string): Promise<void> {
    await this.request<void>('DELETE', `/device/${deviceId}`);
  }

  async authorizeDevice(deviceId: string, authorized: boolean): Promise<void> {
    await this.request<void>('POST', `/device/${deviceId}/authorized`, { authorized });
  }

  async setDeviceTags(deviceId: string, tags: string[]): Promise<void> {
    await this.request<void>('POST', `/device/${deviceId}/tags`, { tags });
  }

  async getDeviceRoutes(deviceId: string): Promise<{ advertisedRoutes: string[]; enabledRoutes: string[] }> {
    return this.request('GET', `/device/${deviceId}/routes`);
  }

  async setDeviceRoutes(deviceId: string, routes: string[]): Promise<void> {
    await this.request<void>('POST', `/device/${deviceId}/routes`, { routes });
  }

  // --------------------------------------------------------------------------
  // ACL / Policy
  // --------------------------------------------------------------------------

  async getPolicy(): Promise<{ acls?: unknown[]; groups?: Record<string, string[]>; tagOwners?: Record<string, string[]> }> {
    return this.request('GET', `/tailnet/${this.tailnet}/acl`);
  }

  async setPolicy(policy: Record<string, unknown>): Promise<void> {
    await this.request<void>('POST', `/tailnet/${this.tailnet}/acl`, policy);
  }

  // --------------------------------------------------------------------------
  // DNS
  // --------------------------------------------------------------------------

  async getDnsPreferences(): Promise<{ magicDNS: boolean }> {
    return this.request('GET', `/tailnet/${this.tailnet}/dns/preferences`);
  }

  async setDnsPreferences(magicDNS: boolean): Promise<void> {
    await this.request<void>('POST', `/tailnet/${this.tailnet}/dns/preferences`, { magicDNS });
  }

  async getNameservers(): Promise<{ dns: string[] }> {
    return this.request('GET', `/tailnet/${this.tailnet}/dns/nameservers`);
  }

  async setNameservers(dns: string[]): Promise<void> {
    await this.request<void>('POST', `/tailnet/${this.tailnet}/dns/nameservers`, { dns });
  }
}
