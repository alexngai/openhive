import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { swarmhubRoutes, swarmhubWebhookRoutes } from '../../swarmhub/routes.js';
import { SwarmHubConnector } from '../../swarmhub/connector.js';
import { clearManagedBridgeCache } from '../../swarmhub/webhook-handler.js';
import * as bridgeDAL from '../../db/dal/bridge.js';
import { encryptCredentials } from '../../bridge/credentials.js';
import type { SwarmHubConfig } from '../../swarmhub/types.js';
import { getOrCreateLocalAgent } from '../../db/dal/agents.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { getDatabase } from '../../db/index.js';

// Mock broadcastToChannel
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_DB_PATH = path.join(process.cwd(), 'test-swarmhub-slack-routes.db');
const ENCRYPTION_KEY = 'test-slack-routes-key';

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

const MOCK_SLACK_INSTALLATIONS = {
  installations: [
    {
      team_id: 'T01234567',
      team_name: 'Acme Corp',
      bot_user_id: 'U_BOT_1',
      scopes: ['chat:write'],
      channel_mappings: [
        {
          channel_id: 'C_GENERAL',
          channel_name: 'general',
          hive_name: 'general',
          direction: 'bidirectional',
        },
      ],
    },
  ],
};

const MOCK_SLACK_CREDENTIALS = {
  installations: [
    {
      team_id: 'T01234567',
      team_name: 'Acme Corp',
      bot_user_id: 'U_BOT_1',
      bot_token: 'xoxb-test-token',
      scopes: ['chat:write'],
    },
  ],
};

describe('SwarmHub Slack Routes', () => {
  let fastify: FastifyInstance;
  let connector: SwarmHubConnector;
  let fetchMock: ReturnType<typeof vi.fn>;
  let testAgentId: string;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    const db = initDatabase(TEST_DB_PATH);

    const agent = await getOrCreateLocalAgent();
    setLocalAgent(agent);

    // Create a test agent for bridge ownership
    testAgentId = 'agent_slack_routes_test';
    db.prepare(`
      INSERT OR IGNORE INTO agents (id, name, account_type) VALUES (?, ?, 'human')
    `).run(testAgentId, 'slack-routes-test');
  });

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    clearManagedBridgeCache();

    connector = new SwarmHubConnector(CONNECTOR_CONFIG);

    fastify = Fastify();
    await fastify.register(swarmhubRoutes, { connector });
    await fastify.register(swarmhubWebhookRoutes, { connector });
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

  async function connectConnector() {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_IDENTITY,
    });
    await connector.connect();
  }

  // ==========================================================================
  // GET /swarmhub/slack/installations
  // ==========================================================================

  describe('GET /swarmhub/slack/installations', () => {
    it('returns 503 when not connected', async () => {
      const res = await fastify.inject({
        method: 'GET',
        url: '/swarmhub/slack/installations',
      });

      expect(res.statusCode).toBe(503);
    });

    it('returns installations when connected', async () => {
      await connectConnector();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SLACK_INSTALLATIONS,
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/swarmhub/slack/installations',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.installations).toHaveLength(1);
      expect(body.installations[0].team_name).toBe('Acme Corp');
      expect(body.installations[0].channel_mappings).toHaveLength(1);
    });

    it('returns 502 on upstream failure', async () => {
      await connectConnector();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server Error',
      });

      const res = await fastify.inject({
        method: 'GET',
        url: '/swarmhub/slack/installations',
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Failed to fetch Slack installations');
    });
  });

  // ==========================================================================
  // POST /swarmhub/slack/credentials
  // ==========================================================================

  describe('POST /swarmhub/slack/credentials', () => {
    it('returns 503 when not connected', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/swarmhub/slack/credentials',
        payload: {},
      });

      expect(res.statusCode).toBe(503);
    });

    it('returns credentials when connected', async () => {
      await connectConnector();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SLACK_CREDENTIALS,
      });

      const res = await fastify.inject({
        method: 'POST',
        url: '/swarmhub/slack/credentials',
        payload: { team_id: 'T01234567' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.installations).toHaveLength(1);
      expect(body.installations[0].bot_token).toBe('xoxb-test-token');
    });

    it('returns upstream error code', async () => {
      await connectConnector();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Not authorized',
      });

      const res = await fastify.inject({
        method: 'POST',
        url: '/swarmhub/slack/credentials',
        payload: { team_id: 'T_BAD' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ==========================================================================
  // POST /webhooks/swarmhub — Webhook ingestion
  // ==========================================================================

  describe('POST /webhooks/swarmhub', () => {
    it('returns 401 without X-SwarmHub-Forwarded header', async () => {
      await connectConnector();

      const res = await fastify.inject({
        method: 'POST',
        url: '/webhooks/swarmhub',
        payload: { source: 'slack' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 503 when connector not connected', async () => {
      const res = await fastify.inject({
        method: 'POST',
        url: '/webhooks/swarmhub',
        headers: { 'x-swarmhub-forwarded': 'true' },
        payload: { source: 'slack' },
      });

      expect(res.statusCode).toBe(503);
    });

    it('acknowledges unknown event sources', async () => {
      await connectConnector();

      const res = await fastify.inject({
        method: 'POST',
        url: '/webhooks/swarmhub',
        headers: { 'x-swarmhub-forwarded': 'true' },
        payload: { source: 'linear', event_type: 'issue_created' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.source).toBe('linear');
    });

    it('returns 400 for invalid Slack event payload', async () => {
      await connectConnector();

      const res = await fastify.inject({
        method: 'POST',
        url: '/webhooks/swarmhub',
        headers: { 'x-swarmhub-forwarded': 'true' },
        payload: {
          source: 'slack',
          // Missing team_id, event_type, event
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('processes a valid Slack message event', async () => {
      await connectConnector();

      // Create bridge and mapping for this team
      const encrypted = encryptCredentials({ bot_token: 'xoxb-test' }, ENCRYPTION_KEY);
      const bridge = bridgeDAL.createBridge({
        name: 'swarmhub:slack:T_ROUTE_TEST',
        platform: 'slack',
        transport_mode: 'webhook',
        credentials_encrypted: encrypted,
        owner_agent_id: testAgentId,
      });

      // Create hive
      const db = getDatabase();
      db.prepare(`
        INSERT OR IGNORE INTO hives (id, name, description, owner_id)
        VALUES (?, ?, 'Test hive', ?)
      `).run('hive_route_general', 'route-general', testAgentId);

      bridgeDAL.addChannelMapping(bridge.id, {
        platform_channel_id: 'C_ROUTE_TEST',
        platform_channel_name: 'route-test',
        hive_name: 'route-general',
        direction: 'bidirectional',
      });

      const res = await fastify.inject({
        method: 'POST',
        url: '/webhooks/swarmhub',
        headers: { 'x-swarmhub-forwarded': 'true' },
        payload: {
          source: 'slack',
          team_id: 'T_ROUTE_TEST',
          event_type: 'message',
          event_id: 'Ev_test_123',
          event: {
            type: 'message',
            channel: 'C_ROUTE_TEST',
            user: 'U_SLACK_USER',
            text: 'Hello from SwarmHub-routed Slack!',
            ts: '1708900010.000100',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.ok).toBe(true);
      expect(body.source).toBe('slack');
      expect(body.result.action).toBe('post_created');
      expect(body.result.post_id).toBeDefined();
    });

    it('returns skipped for Slack events with no bridge', async () => {
      await connectConnector();

      const res = await fastify.inject({
        method: 'POST',
        url: '/webhooks/swarmhub',
        headers: { 'x-swarmhub-forwarded': 'true' },
        payload: {
          source: 'slack',
          team_id: 'T_NO_BRIDGE',
          event_type: 'message',
          event: {
            type: 'message',
            channel: 'C_X',
            user: 'U_X',
            text: 'no bridge here',
            ts: '123',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result.action).toBe('skipped');
    });
  });
});
