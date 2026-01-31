import { describe, it, expect } from 'vitest';
import { ConfigSchema, loadConfig, defaultConfig } from '../config.js';

describe('Configuration', () => {
  describe('ConfigSchema', () => {
    it('should parse minimal config with defaults', () => {
      const config = ConfigSchema.parse({});

      expect(config.port).toBe(3000);
      expect(config.host).toBe('0.0.0.0');
      expect(config.instance.name).toBe('OpenHive');
      expect(config.instance.public).toBe(true);
      expect(config.verification.strategy).toBe('open');
      expect(config.rateLimit.enabled).toBe(true);
      expect(config.federation.enabled).toBe(false);
    });

    it('should accept custom port and host', () => {
      const config = ConfigSchema.parse({
        port: 8080,
        host: '127.0.0.1',
      });

      expect(config.port).toBe(8080);
      expect(config.host).toBe('127.0.0.1');
    });

    it('should parse SQLite database config as string', () => {
      const config = ConfigSchema.parse({
        database: './data/custom.db',
      });

      expect(config.database).toBe('./data/custom.db');
    });

    it('should parse SQLite database config as object', () => {
      const config = ConfigSchema.parse({
        database: {
          type: 'sqlite',
          path: './data/custom.db',
        },
      });

      expect(config.database).toEqual({
        type: 'sqlite',
        path: './data/custom.db',
      });
    });

    it('should parse PostgreSQL database config', () => {
      const config = ConfigSchema.parse({
        database: {
          type: 'postgres',
          host: 'localhost',
          port: 5432,
          database: 'openhive',
          user: 'admin',
          password: 'secret',
        },
      });

      expect(config.database).toEqual({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'openhive',
        user: 'admin',
        password: 'secret',
      });
    });

    it('should parse instance config', () => {
      const config = ConfigSchema.parse({
        instance: {
          name: 'My Hive',
          description: 'A custom hive',
          url: 'https://hive.example.com',
          public: false,
        },
      });

      expect(config.instance.name).toBe('My Hive');
      expect(config.instance.description).toBe('A custom hive');
      expect(config.instance.url).toBe('https://hive.example.com');
      expect(config.instance.public).toBe(false);
    });

    it('should parse verification strategies', () => {
      for (const strategy of ['open', 'invite', 'manual', 'social'] as const) {
        const config = ConfigSchema.parse({
          verification: { strategy },
        });
        expect(config.verification.strategy).toBe(strategy);
      }
    });

    it('should reject invalid verification strategy', () => {
      expect(() => {
        ConfigSchema.parse({
          verification: { strategy: 'invalid' },
        });
      }).toThrow();
    });

    it('should parse rate limit config', () => {
      const config = ConfigSchema.parse({
        rateLimit: {
          enabled: false,
          max: 50,
          timeWindow: '30 seconds',
        },
      });

      expect(config.rateLimit.enabled).toBe(false);
      expect(config.rateLimit.max).toBe(50);
      expect(config.rateLimit.timeWindow).toBe('30 seconds');
    });

    it('should parse federation config', () => {
      const config = ConfigSchema.parse({
        federation: {
          enabled: true,
          peers: ['https://peer1.example.com', 'https://peer2.example.com'],
        },
      });

      expect(config.federation.enabled).toBe(true);
      expect(config.federation.peers).toHaveLength(2);
    });

    it('should parse local storage config', () => {
      const config = ConfigSchema.parse({
        storage: {
          type: 'local',
          path: './uploads',
          publicUrl: '/uploads',
        },
      });

      expect(config.storage).toEqual({
        type: 'local',
        path: './uploads',
        publicUrl: '/uploads',
      });
    });

    it('should parse S3 storage config', () => {
      const config = ConfigSchema.parse({
        storage: {
          type: 's3',
          bucket: 'my-bucket',
          region: 'us-east-1',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        },
      });

      expect(config.storage?.type).toBe('s3');
      expect((config.storage as { bucket: string }).bucket).toBe('my-bucket');
    });

    it('should parse JWT config', () => {
      const config = ConfigSchema.parse({
        jwt: {
          secret: 'my-secret-key',
          expiresIn: '30d',
        },
      });

      expect(config.jwt.secret).toBe('my-secret-key');
      expect(config.jwt.expiresIn).toBe('30d');
    });

    it('should parse CORS config', () => {
      const config = ConfigSchema.parse({
        cors: {
          enabled: true,
          origin: ['https://app1.example.com', 'https://app2.example.com'],
        },
      });

      expect(config.cors.enabled).toBe(true);
      expect(config.cors.origin).toHaveLength(2);
    });
  });

  describe('defaultConfig', () => {
    it('should have sensible defaults', () => {
      expect(defaultConfig.port).toBe(3000);
      expect(defaultConfig.host).toBe('0.0.0.0');
      expect(defaultConfig.instance.name).toBe('OpenHive');
      expect(defaultConfig.verification.strategy).toBe('open');
    });
  });
});
