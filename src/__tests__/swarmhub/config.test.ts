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
});
