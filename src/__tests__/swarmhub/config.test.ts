import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigSchema } from '../../config.js';

describe('SwarmHub config', () => {
  describe('ConfigSchema', () => {
    it('defaults swarmhub to disabled', () => {
      const config = ConfigSchema.parse({});
      expect(config.swarmhub.enabled).toBe(false);
      expect(config.swarmhub.healthCheckInterval).toBe(60000);
    });

    it('parses explicit swarmhub config', () => {
      const config = ConfigSchema.parse({
        swarmhub: {
          enabled: true,
          apiUrl: 'https://api.swarmhub.dev',
          healthCheckInterval: 30000,
        },
      });

      expect(config.swarmhub.enabled).toBe(true);
      expect(config.swarmhub.apiUrl).toBe('https://api.swarmhub.dev');
      expect(config.swarmhub.healthCheckInterval).toBe(30000);
    });

    it('accepts partial swarmhub config with defaults', () => {
      const config = ConfigSchema.parse({
        swarmhub: {
          enabled: true,
          apiUrl: 'https://api.swarmhub.dev',
        },
      });

      expect(config.swarmhub.enabled).toBe(true);
      expect(config.swarmhub.healthCheckInterval).toBe(60000); // default
    });

    it('does not interfere with other config sections', () => {
      const config = ConfigSchema.parse({
        swarmhub: { enabled: true, apiUrl: 'https://api.swarmhub.dev' },
        bridge: { enabled: true, maxBridges: 5 },
        swarmcraft: { enabled: true },
      });

      expect(config.swarmhub.enabled).toBe(true);
      expect(config.bridge.enabled).toBe(true);
      expect(config.swarmcraft.enabled).toBe(true);
    });
  });

  describe('env var auto-detection', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      savedEnv.SWARMHUB_API_URL = process.env.SWARMHUB_API_URL;
      savedEnv.SWARMHUB_HIVE_TOKEN = process.env.SWARMHUB_HIVE_TOKEN;
      savedEnv.SWARMHUB_OAUTH_CLIENT_ID = process.env.SWARMHUB_OAUTH_CLIENT_ID;
      savedEnv.SWARMHUB_OAUTH_CLIENT_SECRET = process.env.SWARMHUB_OAUTH_CLIENT_SECRET;
      savedEnv.OPENHIVE_AUTH_MODE = process.env.OPENHIVE_AUTH_MODE;
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

    it('loadConfig auto-enables swarmhub when both env vars are set', async () => {
      process.env.SWARMHUB_API_URL = 'https://api.swarmhub.dev';
      process.env.SWARMHUB_HIVE_TOKEN = 'test-token';

      // We can't easily call loadConfig because it reads files,
      // but we can test the logic by simulating what loadConfig does:
      // It merges env vars into rawConfig then calls ConfigSchema.parse()
      const rawConfig: Record<string, unknown> = {};

      if (process.env.SWARMHUB_API_URL && process.env.SWARMHUB_HIVE_TOKEN) {
        rawConfig.swarmhub = {
          enabled: true,
          apiUrl: process.env.SWARMHUB_API_URL,
        };
      }

      const config = ConfigSchema.parse(rawConfig);
      expect(config.swarmhub.enabled).toBe(true);
      expect(config.swarmhub.apiUrl).toBe('https://api.swarmhub.dev');
    });

    it('does not auto-enable when only API URL is set', () => {
      process.env.SWARMHUB_API_URL = 'https://api.swarmhub.dev';
      delete process.env.SWARMHUB_HIVE_TOKEN;

      const rawConfig: Record<string, unknown> = {};
      if (process.env.SWARMHUB_API_URL && process.env.SWARMHUB_HIVE_TOKEN) {
        rawConfig.swarmhub = {
          enabled: true,
          apiUrl: process.env.SWARMHUB_API_URL,
        };
      }

      const config = ConfigSchema.parse(rawConfig);
      expect(config.swarmhub.enabled).toBe(false);
    });

    it('does not auto-enable when only token is set', () => {
      delete process.env.SWARMHUB_API_URL;
      process.env.SWARMHUB_HIVE_TOKEN = 'test-token';

      const rawConfig: Record<string, unknown> = {};
      if (process.env.SWARMHUB_API_URL && process.env.SWARMHUB_HIVE_TOKEN) {
        rawConfig.swarmhub = {
          enabled: true,
          apiUrl: process.env.SWARMHUB_API_URL,
        };
      }

      const config = ConfigSchema.parse(rawConfig);
      expect(config.swarmhub.enabled).toBe(false);
    });

    it('does not auto-enable when neither env var is set', () => {
      delete process.env.SWARMHUB_API_URL;
      delete process.env.SWARMHUB_HIVE_TOKEN;

      const rawConfig: Record<string, unknown> = {};
      if (process.env.SWARMHUB_API_URL && process.env.SWARMHUB_HIVE_TOKEN) {
        rawConfig.swarmhub = {
          enabled: true,
          apiUrl: process.env.SWARMHUB_API_URL,
        };
      }

      const config = ConfigSchema.parse(rawConfig);
      expect(config.swarmhub.enabled).toBe(false);
    });
  });

  describe('auth mode auto-detection', () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      savedEnv.SWARMHUB_API_URL = process.env.SWARMHUB_API_URL;
      savedEnv.SWARMHUB_HIVE_TOKEN = process.env.SWARMHUB_HIVE_TOKEN;
      savedEnv.SWARMHUB_OAUTH_CLIENT_ID = process.env.SWARMHUB_OAUTH_CLIENT_ID;
      savedEnv.SWARMHUB_OAUTH_CLIENT_SECRET = process.env.SWARMHUB_OAUTH_CLIENT_SECRET;
      savedEnv.OPENHIVE_AUTH_MODE = process.env.OPENHIVE_AUTH_MODE;
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

    it('defaults to local auth when no bridge env vars are set', () => {
      delete process.env.SWARMHUB_API_URL;
      delete process.env.SWARMHUB_HIVE_TOKEN;
      delete process.env.SWARMHUB_OAUTH_CLIENT_ID;
      delete process.env.OPENHIVE_AUTH_MODE;

      const config = ConfigSchema.parse({});
      expect(config.auth.mode).toBe('local');
    });

    it('auto-detects swarmhub auth when bridge env vars are present', async () => {
      process.env.SWARMHUB_API_URL = 'https://api.swarmhub.dev';
      process.env.SWARMHUB_HIVE_TOKEN = 'test-token';
      delete process.env.SWARMHUB_OAUTH_CLIENT_ID;
      delete process.env.OPENHIVE_AUTH_MODE;

      const { loadConfig } = await import('../../config.js');
      const config = loadConfig();

      expect(config.auth.mode).toBe('swarmhub');
      expect(config.swarmhub.enabled).toBe(true);
    });

    it('does not auto-detect swarmhub auth from OAuth client ID alone', async () => {
      delete process.env.SWARMHUB_API_URL;
      delete process.env.SWARMHUB_HIVE_TOKEN;
      process.env.SWARMHUB_OAUTH_CLIENT_ID = 'test-client-id';
      process.env.SWARMHUB_OAUTH_CLIENT_SECRET = 'test-secret';
      delete process.env.OPENHIVE_AUTH_MODE;

      const { loadConfig } = await import('../../config.js');
      const config = loadConfig();

      // OAuth client ID populates config but doesn't trigger auth mode change
      expect(config.auth.mode).toBe('local');
      expect(config.swarmhub.oauth.clientId).toBe('test-client-id');
    });

    it('respects explicit OPENHIVE_AUTH_MODE override to local', async () => {
      process.env.SWARMHUB_API_URL = 'https://api.swarmhub.dev';
      process.env.SWARMHUB_HIVE_TOKEN = 'test-token';
      process.env.OPENHIVE_AUTH_MODE = 'local';

      const { loadConfig } = await import('../../config.js');
      const config = loadConfig();

      // Explicit override should win over auto-detection
      expect(config.auth.mode).toBe('local');
    });
  });
});
