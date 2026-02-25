import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SwarmHubClient } from '../../swarmhub/client.js';
import type { SwarmHubConfig } from '../../swarmhub/types.js';

const TEST_CONFIG: SwarmHubConfig = {
  enabled: true,
  apiUrl: 'https://api.swarmhub.test',
  hiveToken: 'test-hive-token',
  healthCheckInterval: 60000,
};

const MOCK_SLACK_INSTALLATIONS = {
  installations: [
    {
      team_id: 'T01234567',
      team_name: 'Acme Corp',
      team_url: 'https://acme-corp.slack.com',
      bot_user_id: 'U_BOT_1',
      scopes: ['chat:write', 'channels:read', 'app_mentions:read'],
      channel_mappings: [
        {
          channel_id: 'C_GENERAL',
          channel_name: 'general',
          hive_name: 'general',
          direction: 'bidirectional' as const,
        },
        {
          channel_id: 'C_ALERTS',
          channel_name: 'alerts',
          hive_name: 'alerts',
          direction: 'inbound' as const,
          event_filter: ['app_mention'],
        },
      ],
    },
    {
      team_id: 'T99999999',
      team_name: 'Other Workspace',
      bot_user_id: 'U_BOT_2',
      scopes: ['chat:write'],
      channel_mappings: [],
    },
  ],
};

const MOCK_SLACK_CREDENTIALS = {
  installations: [
    {
      team_id: 'T01234567',
      team_name: 'Acme Corp',
      team_url: 'https://acme-corp.slack.com',
      bot_user_id: 'U_BOT_1',
      bot_token: 'xoxb-test-bot-token-12345',
      scopes: ['chat:write', 'channels:read'],
    },
  ],
};

describe('SwarmHubClient - Slack', () => {
  let client: SwarmHubClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new SwarmHubClient(TEST_CONFIG);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getSlackInstallations ──

  describe('getSlackInstallations', () => {
    it('fetches Slack installations from SwarmHub', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SLACK_INSTALLATIONS,
      });

      const result = await client.getSlackInstallations();

      expect(result.installations).toHaveLength(2);
      expect(result.installations[0].team_id).toBe('T01234567');
      expect(result.installations[0].team_name).toBe('Acme Corp');
      expect(result.installations[0].channel_mappings).toHaveLength(2);
      expect(result.installations[0].channel_mappings[0].channel_name).toBe('general');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.swarmhub.test/v1/internal/hive/slack-installations',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-hive-token',
          }),
        }),
      );
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'No Slack installations',
      });

      await expect(client.getSlackInstallations()).rejects.toThrow(
        'SwarmHub API error 404',
      );
    });
  });

  // ── getSlackCredentials ──

  describe('getSlackCredentials', () => {
    it('requests Slack bot credentials', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SLACK_CREDENTIALS,
      });

      const result = await client.getSlackCredentials({ team_id: 'T01234567' });

      expect(result.installations).toHaveLength(1);
      expect(result.installations[0].bot_token).toBe('xoxb-test-bot-token-12345');
      expect(result.installations[0].team_id).toBe('T01234567');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.swarmhub.test/v1/internal/hive/slack-credentials',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ team_id: 'T01234567' }),
        }),
      );
    });

    it('requests credentials without team_id (all workspaces)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_SLACK_CREDENTIALS,
      });

      const result = await client.getSlackCredentials();

      expect(result.installations).toHaveLength(1);
      // Body should be undefined (no options)
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[1].body).toBeUndefined();
    });

    it('throws on 403 (workspace not mapped to this hive)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Workspace not mapped to this hive',
      });

      await expect(
        client.getSlackCredentials({ team_id: 'T_UNKNOWN' }),
      ).rejects.toThrow('SwarmHub API error 403');
    });
  });
});
