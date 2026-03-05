import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { swarmhubRoutes } from '../../swarmhub/routes.js';
import { authRoutes } from '../../api/routes/auth.js';
import { SwarmHubConnector } from '../../swarmhub/connector.js';
import type { SwarmHubConfig } from '../../swarmhub/types.js';
import { getOrCreateLocalAgent } from '../../db/dal/agents.js';
import { setLocalAgent } from '../../api/middleware/auth.js';

// Mock broadcastToChannel
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_DB_PATH = path.join(process.cwd(), 'test-swarmhub-routes.db');

const CONNECTOR_CONFIG: SwarmHubConfig = {
  enabled: true,
  apiUrl: 'https://api.swarmhub.test',
  hiveToken: 'test-hive-token',
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

const MOCK_REPOS = {
  repositories: [
    {
      repo_full_name: 'acme-corp/api-server',
      installation_id: 12345678,
      event_filter: ['push'],
    },
  ],
};

const MOCK_TOKEN = {
  token: 'ghs_test_token',
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  permissions: { contents: 'write' },
  installation_id: 12345678,
  repositories: [
    { id: 1234, name: 'api-server', full_name: 'acme-corp/api-server' },
  ],
};

describe('SwarmHub Routes', () => {
  let fastify: FastifyInstance;
  let connector: SwarmHubConnector;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    initDatabase(TEST_DB_PATH);

    // Set up local auth so all requests are auto-authenticated
    const agent = await getOrCreateLocalAgent();
    setLocalAgent(agent);
  });

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    connector = new SwarmHubConnector(CONNECTOR_CONFIG);

    fastify = Fastify();
    await fastify.register(swarmhubRoutes, { connector });
    await fastify.ready();
  });

  afterEach(async () => {
    await connector.disconnect();
    await fastify.close();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  // ── GET /swarmhub/status ──

  describe('GET /swarmhub/status', () => {
    it('returns disconnected status when not connected', async () => {
      const res = await fastify.inject({
        method: 'GET',
        url: '/swarmhub/status',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.connected).toBe(false);
      expect(body.status).toBe('disconnected');
      expect(body.identity).toBeNull();
    });

    it('returns connected status with identity', async () => {
      // Connect the connector
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      const res = await fastify.inject({
        method: 'GET',
        url: '/swarmhub/status',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.connected).toBe(true);
      expect(body.status).toBe('connected');
      expect(body.identity.slug).toBe('my-project');
      expect(body.identity.tier).toBe('pro');
      expect(body.connected_at).not.toBeNull();
    });

    it('returns error status after connection failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });
      await connector.connect().catch(() => {});

      const res = await fastify.inject({
        method: 'GET',
        url: '/swarmhub/status',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.connected).toBe(false);
      expect(body.status).toBe('error');
      expect(body.last_error).toContain('401');
    });
  });

  // ── GET /swarmhub/repos ──

  describe('GET /swarmhub/repos', () => {
    it('returns 503 when not connected', async () => {
      const res = await fastify.inject({
        method: 'GET',
        url: '/swarmhub/repos',
      });

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('not connected');
    });

    it('returns repositories when connected', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REPOS,
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/swarmhub/repos',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.repositories).toHaveLength(1);
      expect(body.repositories[0].repo_full_name).toBe('acme-corp/api-server');
    });

    it('returns 502 when SwarmHub API fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/swarmhub/repos',
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Failed to fetch repos');
    });
  });

  // ── POST /swarmhub/github-token ──

  describe('POST /swarmhub/github-token', () => {
    it('returns 503 when not connected', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/swarmhub/github-token',
        payload: {},
      });

      expect(res.statusCode).toBe(503);
    });

    it('returns GitHub token when connected', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_TOKEN,
      });

      const res = await fastify.inject({
        method: 'POST',
        url: '/swarmhub/github-token',
        payload: {
          repositories: ['acme-corp/api-server'],
          permissions: { contents: 'write' },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.token).toBe('ghs_test_token');
      expect(body.installation_id).toBe(12345678);
      expect(body.repositories).toHaveLength(1);
    });

    it('works with empty body', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_TOKEN,
      });

      const res = await fastify.inject({
        method: 'POST',
        url: '/swarmhub/github-token',
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.token).toBe('ghs_test_token');
    });

    it('returns upstream error code on token failure', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Repos not mapped to this hive',
      });

      const res = await fastify.inject({
        method: 'POST',
        url: '/swarmhub/github-token',
        payload: {
          repositories: ['other-org/repo'],
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Failed to get GitHub token');
    });

    it('returns 502 for unknown upstream errors', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });
      await connector.connect();

      // Simulate a network error (no statusCode property)
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await fastify.inject({
        method: 'POST',
        url: '/swarmhub/github-token',
        payload: {},
      });

      expect(res.statusCode).toBe(502);
    });
  });
});

// ── Auth route dynamic client_id tests ──

describe('Auth routes — dynamic client_id from connector', () => {
  let fastify: FastifyInstance;
  let connector: SwarmHubConnector;
  let fetchMock: ReturnType<typeof vi.fn>;

  const STATIC_CONFIG = {
    authMode: 'swarmhub' as const,
    swarmhubApiUrl: 'https://api.swarmhub.test',
    swarmhubOAuthClientId: 'static-client-id',
    swarmhubOAuthClientSecret: 'static-client-secret',
  };

  beforeAll(async () => {
    // DB already initialized from outer describe
  });

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    connector = new SwarmHubConnector(CONNECTOR_CONFIG);

    fastify = Fastify();
    await fastify.register(authRoutes, {
      config: STATIC_CONFIG,
      swarmhubConnector: connector,
    });
    await fastify.ready();
  });

  afterEach(async () => {
    await connector.disconnect();
    await fastify.close();
    vi.restoreAllMocks();
  });

  it('GET /auth/mode returns connector client_id when available', async () => {
    // Connect the connector with hive config that includes client_id
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_IDENTITY,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        oauth: { client_id: 'dynamic-client-id', client_secret: 'dynamic-secret' },
      }),
    });
    await connector.connect();

    const res = await fastify.inject({
      method: 'GET',
      url: '/auth/mode',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('swarmhub');
    expect(body.oauth.client_id).toBe('dynamic-client-id');
  });

  it('GET /auth/mode falls back to static config when connector has no client_id', async () => {
    // Connect but config fetch fails — connector returns undefined for client_id
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_IDENTITY,
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });
    await connector.connect();

    const res = await fastify.inject({
      method: 'GET',
      url: '/auth/mode',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('swarmhub');
    expect(body.oauth.client_id).toBe('static-client-id');
  });

  it('GET /auth/mode falls back to static config when connector is not connected', async () => {
    // Don't connect — connector.getOAuthClientId() returns undefined
    const res = await fastify.inject({
      method: 'GET',
      url: '/auth/mode',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('swarmhub');
    expect(body.oauth.client_id).toBe('static-client-id');
  });

  it('POST /auth/swarmhub/exchange uses connector client_id in token request', async () => {
    // Connect with dynamic credentials
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_IDENTITY,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        oauth: { client_id: 'dynamic-client-id', client_secret: 'dynamic-secret' },
      }),
    });
    await connector.connect();

    // After connect, stop polling so it doesn't consume our token exchange mock
    await connector.disconnect();

    // Re-register a fresh fastify with the same (now-configured) connector
    // so the connector still has the fetched hive config with dynamic credentials.
    // We need a new fetch mock implementation that handles just the token exchange.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'test-access-token',
        token_type: 'bearer',
        expires_in: 3600,
      }),
    });

    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/swarmhub/exchange',
      payload: {
        code: 'test-auth-code',
        redirect_uri: 'https://my-project.swarmhub.dev/auth/callback',
      },
    });

    expect(res.statusCode).toBe(200);

    // Verify the token exchange fetch was called with the dynamic client_id
    const tokenCall = fetchMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/oauth/token')
    );
    expect(tokenCall).toBeDefined();
    const tokenBody = JSON.parse(tokenCall![1].body);
    expect(tokenBody.client_id).toBe('dynamic-client-id');
    expect(tokenBody.client_secret).toBe('dynamic-secret');
  });
});

// ── Auth routes — no static config (connector-only, the new default) ──

describe('Auth routes — connector-only (no static config)', () => {
  let fastify: FastifyInstance;
  let connector: SwarmHubConnector;
  let fetchMock: ReturnType<typeof vi.fn>;

  // No swarmhubOAuthClientId or swarmhubOAuthClientSecret — simulates
  // new hives where SWARMHUB_OAUTH_CLIENT_ID env var is no longer set.
  const NO_STATIC_CONFIG = {
    authMode: 'swarmhub' as const,
    swarmhubApiUrl: 'https://api.swarmhub.test',
  };

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    connector = new SwarmHubConnector(CONNECTOR_CONFIG);

    fastify = Fastify();
    await fastify.register(authRoutes, {
      config: NO_STATIC_CONFIG,
      swarmhubConnector: connector,
    });
    await fastify.ready();
  });

  afterEach(async () => {
    await connector.disconnect();
    await fastify.close();
    vi.restoreAllMocks();
  });

  it('GET /auth/mode returns connector client_id (no env var fallback needed)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_IDENTITY,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        oauth: { client_id: 'bridge-client-id', client_secret: 'bridge-secret' },
      }),
    });
    await connector.connect();

    const res = await fastify.inject({
      method: 'GET',
      url: '/auth/mode',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.oauth.client_id).toBe('bridge-client-id');
  });

  it('GET /auth/mode returns undefined client_id when connector not connected and no env var', async () => {
    // Connector not connected, no static config — client_id is undefined
    const res = await fastify.inject({
      method: 'GET',
      url: '/auth/mode',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.mode).toBe('swarmhub');
    expect(body.oauth.client_id).toBeUndefined();
  });

  it('POST /auth/swarmhub/exchange returns 500 when no secret available', async () => {
    // Connector not connected, no static secret
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/swarmhub/exchange',
      payload: {
        code: 'some-code',
        redirect_uri: 'https://example.com/callback',
      },
    });

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('Configuration Error');
  });

  it('POST /auth/swarmhub/exchange works with connector credentials only', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_IDENTITY,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        oauth: { client_id: 'bridge-client-id', client_secret: 'bridge-secret' },
      }),
    });
    await connector.connect();
    await connector.disconnect();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'user-token',
        token_type: 'bearer',
      }),
    });

    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/swarmhub/exchange',
      payload: {
        code: 'auth-code',
        redirect_uri: 'https://example.com/callback',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.token).toBe('user-token');

    // Verify bridge credentials were used
    const tokenCall = fetchMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/oauth/token')
    );
    const tokenBody = JSON.parse(tokenCall![1].body);
    expect(tokenBody.client_id).toBe('bridge-client-id');
    expect(tokenBody.client_secret).toBe('bridge-secret');
  });

  it('POST /auth/swarmhub/exchange returns 401 when SwarmHub rejects the code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_IDENTITY,
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        oauth: { client_id: 'bridge-client-id', client_secret: 'bridge-secret' },
      }),
    });
    await connector.connect();
    await connector.disconnect();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    });

    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/swarmhub/exchange',
      payload: {
        code: 'expired-code',
        redirect_uri: 'https://example.com/callback',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('OAuth Error');
  });
});
