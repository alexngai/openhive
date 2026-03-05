import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SwarmHubConnector } from '../../swarmhub/connector.js';
import type { SwarmHubConfig } from '../../swarmhub/types.js';

const TEST_CONFIG: SwarmHubConfig = {
  enabled: true,
  apiUrl: 'https://api.swarmhub.test',
  hiveToken: 'test-hive-token-abc123',
  healthCheckInterval: 60000,
};

const MOCK_IDENTITY = {
  id: 'hive_abc123',
  slug: 'my-project',
  name: 'My Project',
  owner_type: 'organization' as const,
  owner_id: 'org_xyz',
  tier: 'pro',
  status: 'running',
  endpoint_url: 'https://my-project.swarmhub.dev',
};

const MOCK_TOKEN_RESPONSE = {
  token: 'ghs_test_token',
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  permissions: { contents: 'write' },
  installation_id: 12345678,
  repositories: [
    { id: 1234, name: 'api-server', full_name: 'acme-corp/api-server' },
  ],
};

const MOCK_REPOS = {
  repositories: [
    {
      repo_full_name: 'acme-corp/api-server',
      installation_id: 12345678,
      event_filter: ['push'],
    },
  ],
};

describe('SwarmHubConnector', () => {
  let connector: SwarmHubConnector;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connector = new SwarmHubConnector(TEST_CONFIG);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await connector.disconnect();
    vi.restoreAllMocks();
  });

  // ── fromEnv ──

  describe('fromEnv', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      savedEnv.SWARMHUB_API_URL = process.env.SWARMHUB_API_URL;
      savedEnv.SWARMHUB_HIVE_TOKEN = process.env.SWARMHUB_HIVE_TOKEN;
      savedEnv.SWARMHUB_HEALTH_INTERVAL = process.env.SWARMHUB_HEALTH_INTERVAL;
    });

    afterEach(() => {
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
    });

    it('returns null when env vars are not set', () => {
      delete process.env.SWARMHUB_API_URL;
      delete process.env.SWARMHUB_HIVE_TOKEN;

      expect(SwarmHubConnector.fromEnv()).toBeNull();
    });

    it('returns null when only API URL is set', () => {
      process.env.SWARMHUB_API_URL = 'https://api.swarmhub.dev';
      delete process.env.SWARMHUB_HIVE_TOKEN;

      expect(SwarmHubConnector.fromEnv()).toBeNull();
    });

    it('returns null when only token is set', () => {
      delete process.env.SWARMHUB_API_URL;
      process.env.SWARMHUB_HIVE_TOKEN = 'some-token';

      expect(SwarmHubConnector.fromEnv()).toBeNull();
    });

    it('creates connector when both env vars are set', () => {
      process.env.SWARMHUB_API_URL = 'https://api.swarmhub.dev';
      process.env.SWARMHUB_HIVE_TOKEN = 'some-token';

      const c = SwarmHubConnector.fromEnv();
      expect(c).not.toBeNull();
      expect(c).toBeInstanceOf(SwarmHubConnector);
    });

    it('respects custom health interval env var', () => {
      process.env.SWARMHUB_API_URL = 'https://api.swarmhub.dev';
      process.env.SWARMHUB_HIVE_TOKEN = 'some-token';
      process.env.SWARMHUB_HEALTH_INTERVAL = '30000';

      const c = SwarmHubConnector.fromEnv()!;
      // The interval is internal, but we can verify the connector was created
      expect(c).not.toBeNull();
    });
  });

  // ── Initial state ──

  describe('initial state', () => {
    it('starts in disconnected state', () => {
      expect(connector.status).toBe('disconnected');
      expect(connector.isConnected).toBe(false);
      expect(connector.identity).toBeNull();
    });

    it('getState returns full state snapshot', () => {
      const state = connector.getState();
      expect(state).toEqual({
        status: 'disconnected',
        identity: null,
        lastHealthCheck: null,
        lastError: null,
        connectedAt: null,
      });
    });
  });

  // ── connect ──

  describe('connect', () => {
    it('connects successfully and stores identity', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });

      const identity = await connector.connect();

      expect(identity).toEqual(MOCK_IDENTITY);
      expect(connector.status).toBe('connected');
      expect(connector.isConnected).toBe(true);
      expect(connector.identity).toEqual(MOCK_IDENTITY);
    });

    it('sets connectedAt timestamp', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });

      await connector.connect();

      const state = connector.getState();
      expect(state.connectedAt).not.toBeNull();
      // Should be a valid ISO date
      expect(new Date(state.connectedAt!).getTime()).toBeGreaterThan(0);
    });

    it('emits connected event', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });

      const handler = vi.fn();
      connector.on('connected', handler);

      await connector.connect();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(MOCK_IDENTITY);
    });

    it('transitions to error state on connection failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(connector.connect()).rejects.toThrow('SwarmHub API error 401');
      expect(connector.status).toBe('error');
      expect(connector.isConnected).toBe(false);
    });

    it('emits error event on connection failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const handler = vi.fn();
      connector.on('error', handler);

      await connector.connect().catch(() => {});

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].message).toContain('401');
    });

    it('stores last error on failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await connector.connect().catch(() => {});

      const state = connector.getState();
      expect(state.lastError).toContain('401');
    });
  });

  // ── disconnect ──

  describe('disconnect', () => {
    it('disconnects and resets state', async () => {
      // First connect
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();
      expect(connector.isConnected).toBe(true);

      // Then disconnect
      await connector.disconnect();
      expect(connector.status).toBe('disconnected');
      expect(connector.isConnected).toBe(false);
    });

    it('emits disconnected event', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      const handler = vi.fn();
      connector.on('disconnected', handler);

      await connector.disconnect();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ reason: 'manual' });
    });

    it('is safe to call when already disconnected', async () => {
      await expect(connector.disconnect()).resolves.toBeUndefined();
    });
  });

  // ── getGitHubToken ──

  describe('getGitHubToken', () => {
    it('fetches GitHub token when connected', async () => {
      // Connect
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      // Get token
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_TOKEN_RESPONSE,
      });

      const token = await connector.getGitHubToken({
        repositories: ['acme-corp/api-server'],
      });

      expect(token.token).toBe('ghs_test_token');
      expect(token.installation_id).toBe(12345678);
    });

    it('emits github_token_refreshed event', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_TOKEN_RESPONSE,
      });

      const handler = vi.fn();
      connector.on('github_token_refreshed', handler);

      await connector.getGitHubToken();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].installationId).toBe(12345678);
    });

    it('throws when not connected', async () => {
      await expect(connector.getGitHubToken()).rejects.toThrow(
        'SwarmHub connector is not connected',
      );
    });

    it('stores last error on token request failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Repos not mapped',
      });

      await connector.getGitHubToken().catch(() => {});

      const state = connector.getState();
      expect(state.lastError).toContain('403');
    });
  });

  // ── getRepos ──

  describe('getRepos', () => {
    it('fetches repos when connected', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REPOS,
      });

      const repos = await connector.getRepos();
      expect(repos.repositories).toHaveLength(1);
      expect(repos.repositories[0].repo_full_name).toBe('acme-corp/api-server');
    });

    it('throws when not connected', async () => {
      await expect(connector.getRepos()).rejects.toThrow(
        'SwarmHub connector is not connected',
      );
    });
  });

  // ── Health monitoring ──

  describe('health monitoring', () => {
    it('starts health monitoring on connect', async () => {
      const shortIntervalConfig = { ...TEST_CONFIG, healthCheckInterval: 100 };
      const c = new SwarmHubConnector(shortIntervalConfig);

      // Connect
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await c.connect();

      // Subsequent health checks
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });

      // Wait for a health check cycle
      await new Promise(r => setTimeout(r, 250));

      const state = c.getState();
      expect(state.lastHealthCheck).not.toBeNull();

      await c.disconnect();
    });

    it('transitions to error state on health check failure', async () => {
      const shortIntervalConfig = { ...TEST_CONFIG, healthCheckInterval: 50 };
      const c = new SwarmHubConnector(shortIntervalConfig);

      // Connect successfully
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await c.connect();
      expect(c.status).toBe('connected');

      // Health check fails
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const errorHandler = vi.fn();
      c.on('error', errorHandler);

      await new Promise(r => setTimeout(r, 150));

      expect(c.status).toBe('error');
      expect(errorHandler).toHaveBeenCalled();

      await c.disconnect();
    });

    it('recovers from error state when health check succeeds', async () => {
      const shortIntervalConfig = { ...TEST_CONFIG, healthCheckInterval: 50 };
      const c = new SwarmHubConnector(shortIntervalConfig);

      // Connect successfully
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await c.connect();

      // Health check fails once
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'error',
      });

      await new Promise(r => setTimeout(r, 80));
      expect(c.status).toBe('error');

      // Next health check succeeds
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });

      await new Promise(r => setTimeout(r, 100));
      expect(c.status).toBe('connected');

      await c.disconnect();
    });

    it('stops health monitoring on disconnect', async () => {
      const shortIntervalConfig = { ...TEST_CONFIG, healthCheckInterval: 50 };
      const c = new SwarmHubConnector(shortIntervalConfig);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await c.connect();
      await c.disconnect();

      const callCountAtDisconnect = fetchMock.mock.calls.length;

      // Wait and verify no more health checks
      await new Promise(r => setTimeout(r, 150));
      expect(fetchMock.mock.calls.length).toBe(callCountAtDisconnect);
    });
  });

  // ── hive config and OAuth ──

  describe('hive config and OAuth', () => {
    it('fetches hive config on connect and exposes OAuth client secret', async () => {
      // Identity request
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      // Config request
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          oauth: { client_id: 'hive-client-id', client_secret: 'hive-client-secret-xyz' },
        }),
      });

      await connector.connect();

      expect(connector.getOAuthClientSecret()).toBe('hive-client-secret-xyz');
    });

    it('getOAuthClientSecret returns undefined when config fetch fails', async () => {
      // Identity request
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      // Config request fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      await connector.connect();

      expect(connector.getOAuthClientSecret()).toBeUndefined();
    });

    it('getOAuthClientSecret returns undefined before connect', () => {
      expect(connector.getOAuthClientSecret()).toBeUndefined();
    });

    it('fetches hive config on connect and exposes OAuth client id', async () => {
      // Identity request
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      // Config request
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          oauth: { client_id: 'hive-client-id', client_secret: 'hive-client-secret-xyz' },
        }),
      });

      await connector.connect();

      expect(connector.getOAuthClientId()).toBe('hive-client-id');
    });

    it('getOAuthClientId returns undefined when config fetch fails', async () => {
      // Identity request
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      // Config request fails
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      await connector.connect();

      expect(connector.getOAuthClientId()).toBeUndefined();
    });

    it('getOAuthClientId returns undefined before connect', () => {
      expect(connector.getOAuthClientId()).toBeUndefined();
    });
  });

  // ── getState snapshot ──

  describe('getState', () => {
    it('returns a copy, not the internal state', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      const state1 = connector.getState();
      const state2 = connector.getState();

      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2); // Different objects
    });
  });
});
