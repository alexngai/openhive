import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SwarmHubConnector } from '../../swarmhub/connector.js';
import type { SwarmHubConfig } from '../../swarmhub/types.js';

const TEST_CONFIG: SwarmHubConfig = {
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
          direction: 'bidirectional' as const,
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

describe('SwarmHubConnector - Slack', () => {
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

  async function connectConnector() {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => MOCK_IDENTITY,
    });
    await connector.connect();
  }

  // ── getSlackInstallations ──

  describe('getSlackInstallations', () => {
    it('returns installations when connected', async () => {
      await connectConnector();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SLACK_INSTALLATIONS,
      });

      const result = await connector.getSlackInstallations();
      expect(result.installations).toHaveLength(1);
      expect(result.installations[0].team_id).toBe('T01234567');
    });

    it('throws when not connected', async () => {
      await expect(connector.getSlackInstallations()).rejects.toThrow(
        'SwarmHub connector is not connected',
      );
    });

    it('stores last error on failure', async () => {
      await connectConnector();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server Error',
      });

      await connector.getSlackInstallations().catch(() => {});

      const state = connector.getState();
      expect(state.lastError).toContain('500');
    });
  });

  // ── getSlackCredentials ──

  describe('getSlackCredentials', () => {
    it('returns credentials when connected', async () => {
      await connectConnector();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SLACK_CREDENTIALS,
      });

      const result = await connector.getSlackCredentials({ team_id: 'T01234567' });
      expect(result.installations).toHaveLength(1);
      expect(result.installations[0].bot_token).toBe('xoxb-test-token');
    });

    it('works without team_id', async () => {
      await connectConnector();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SLACK_CREDENTIALS,
      });

      const result = await connector.getSlackCredentials();
      expect(result.installations).toHaveLength(1);
    });

    it('throws when not connected', async () => {
      await expect(connector.getSlackCredentials()).rejects.toThrow(
        'SwarmHub connector is not connected',
      );
    });

    it('stores last error on failure', async () => {
      await connectConnector();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      await connector.getSlackCredentials({ team_id: 'T_BAD' }).catch(() => {});

      const state = connector.getState();
      expect(state.lastError).toContain('403');
    });
  });
});
