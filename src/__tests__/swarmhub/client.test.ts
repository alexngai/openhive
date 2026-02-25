import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SwarmHubClient } from '../../swarmhub/client.js';
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

const MOCK_REPOS = {
  repositories: [
    {
      repo_full_name: 'acme-corp/api-server',
      installation_id: 12345678,
      event_filter: ['push', 'pull_request'],
    },
    {
      repo_full_name: 'acme-corp/frontend',
      installation_id: 12345678,
    },
  ],
};

const MOCK_TOKEN_RESPONSE = {
  token: 'ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
  permissions: { contents: 'write', pull_requests: 'write' },
  installation_id: 12345678,
  repositories: [
    { id: 1234, name: 'api-server', full_name: 'acme-corp/api-server' },
  ],
};

describe('SwarmHubClient', () => {
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

  // ── Identity ──

  describe('getIdentity', () => {
    it('fetches hive identity from SwarmHub', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });

      const identity = await client.getIdentity();

      expect(identity).toEqual(MOCK_IDENTITY);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.swarmhub.test/v1/internal/hive/identity',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-hive-token-abc123',
            Accept: 'application/json',
          }),
        }),
      );
    });

    it('throws on non-OK response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(client.getIdentity()).rejects.toThrow('SwarmHub API error 401: Unauthorized');
    });

    it('includes status code on error', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      try {
        await client.getIdentity();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as Error & { statusCode: number }).statusCode).toBe(403);
      }
    });

    it('handles empty error body', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => '',
      });

      await expect(client.getIdentity()).rejects.toThrow('SwarmHub API error 500');
    });
  });

  // ── Repos ──

  describe('getRepos', () => {
    it('fetches mapped repositories', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_REPOS,
      });

      const repos = await client.getRepos();

      expect(repos.repositories).toHaveLength(2);
      expect(repos.repositories[0].repo_full_name).toBe('acme-corp/api-server');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.swarmhub.test/v1/internal/hive/repos',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  // ── GitHub Tokens ──

  describe('getGitHubToken', () => {
    it('requests a GitHub token', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_TOKEN_RESPONSE,
      });

      const token = await client.getGitHubToken({
        repositories: ['acme-corp/api-server'],
        permissions: { contents: 'write' },
      });

      expect(token.token).toBe('ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(token.installation_id).toBe(12345678);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.swarmhub.test/v1/internal/hive/github-token',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            repositories: ['acme-corp/api-server'],
            permissions: { contents: 'write' },
          }),
        }),
      );
    });

    it('requests token without options', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_TOKEN_RESPONSE,
      });

      const token = await client.getGitHubToken();

      expect(token.token).toBe('ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      // Body should be undefined (no options)
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[1].body).toBeUndefined();
    });

    it('caches token and returns from cache on second call', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_TOKEN_RESPONSE,
      });

      // First call fetches
      await client.getGitHubToken();
      expect(fetchMock).toHaveBeenCalledOnce();

      // Second call should use cache
      const cached = await client.getGitHubToken();
      expect(fetchMock).toHaveBeenCalledOnce(); // Still only 1 fetch call
      expect(cached.token).toBe('ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    });

    it('uses separate cache keys for different request options', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => MOCK_TOKEN_RESPONSE,
      });

      await client.getGitHubToken({ repositories: ['repo-a'] });
      await client.getGitHubToken({ repositories: ['repo-b'] });

      // Different repos = different cache keys = 2 fetch calls
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refreshes token when nearing expiry', async () => {
      // First response: token expires in 5 minutes (under 10-minute buffer)
      const nearExpiryResponse = {
        ...MOCK_TOKEN_RESPONSE,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => nearExpiryResponse,
      });

      await client.getGitHubToken();
      await client.getGitHubToken();

      // Should have fetched twice because the cached token is near expiry
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('handles multi-installation response (uses first token)', async () => {
      const multiResponse = {
        tokens: [
          { ...MOCK_TOKEN_RESPONSE, installation_id: 11111 },
          { ...MOCK_TOKEN_RESPONSE, token: 'ghs_second', installation_id: 22222 },
        ],
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => multiResponse,
      });

      const token = await client.getGitHubToken();
      expect(token.installation_id).toBe(11111);
    });

    it('clearTokenCache clears all cached tokens', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => MOCK_TOKEN_RESPONSE,
      });

      await client.getGitHubToken();
      expect(fetchMock).toHaveBeenCalledOnce();

      client.clearTokenCache();

      await client.getGitHubToken();
      expect(fetchMock).toHaveBeenCalledTimes(2); // Fetched again after cache clear
    });
  });

  // ── getGitHubTokens (multi-install) ──

  describe('getGitHubTokens', () => {
    it('returns array of tokens for multi-installation response', async () => {
      const multiResponse = {
        tokens: [
          { ...MOCK_TOKEN_RESPONSE, installation_id: 11111 },
          { ...MOCK_TOKEN_RESPONSE, token: 'ghs_second', installation_id: 22222 },
        ],
      };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => multiResponse,
      });

      const tokens = await client.getGitHubTokens();
      expect(tokens).toHaveLength(2);
      expect(tokens[0].installation_id).toBe(11111);
      expect(tokens[1].installation_id).toBe(22222);
    });

    it('wraps single-installation response in array', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_TOKEN_RESPONSE,
      });

      const tokens = await client.getGitHubTokens();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].installation_id).toBe(12345678);
    });
  });

  // ── Health Check ──

  describe('healthCheck', () => {
    it('returns true when SwarmHub is reachable', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => MOCK_IDENTITY,
      });

      expect(await client.healthCheck()).toBe(true);
    });

    it('returns false when SwarmHub returns error', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      expect(await client.healthCheck()).toBe(false);
    });

    it('returns false when fetch throws (network error)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      expect(await client.healthCheck()).toBe(false);
    });
  });
});
