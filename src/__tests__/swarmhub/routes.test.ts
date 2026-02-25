import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { swarmhubRoutes } from '../../swarmhub/routes.js';
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
  let agentApiKey: string;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    initDatabase(TEST_DB_PATH);

    // Set up local auth so all requests are auto-authenticated
    const agent = await getOrCreateLocalAgent();
    setLocalAgent(agent);
    agentApiKey = agent.api_key;
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
