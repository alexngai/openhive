import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigSchema, defaultConfig, loadConfig, getLoadedConfigPath, isConfigEditable } from '../config.js';

describe('Configuration', () => {
  describe('ConfigSchema', () => {
    it('should parse minimal config with defaults', () => {
      const config = ConfigSchema.parse({});

      expect(config.port).toBe(7836);
      expect(config.host).toBe('127.0.0.1');
      expect(config.instance.name).toBe('OpenHive');
      expect(config.instance.public).toBe(true);
      expect(config.auth.mode).toBe('local');
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

    it('should parse auth mode', () => {
      for (const mode of ['local', 'swarmhub'] as const) {
        const config = ConfigSchema.parse({
          auth: { mode },
        });
        expect(config.auth.mode).toBe(mode);
      }
    });

    it('should reject invalid auth mode', () => {
      expect(() => {
        ConfigSchema.parse({
          auth: { mode: 'invalid' },
        });
      }).toThrow();
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

    it('should default auth mode to local', () => {
      const config = ConfigSchema.parse({});
      expect(config.auth.mode).toBe('local');
    });

    it('should parse SwarmHub OAuth config', () => {
      const config = ConfigSchema.parse({
        swarmhub: {
          enabled: true,
          apiUrl: 'https://swarmhub.example.com',
          oauth: {
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
          },
        },
      });

      expect(config.swarmhub.enabled).toBe(true);
      expect(config.swarmhub.oauth.clientId).toBe('test-client-id');
      expect(config.swarmhub.oauth.clientSecret).toBe('test-client-secret');
    });
  });

  describe('defaultConfig', () => {
    it('should have sensible defaults', () => {
      expect(defaultConfig.port).toBe(7836);
      expect(defaultConfig.host).toBe('127.0.0.1');
      expect(defaultConfig.instance.name).toBe('OpenHive');
      expect(defaultConfig.auth.mode).toBe('local');
    });
  });

  describe('JS → JSON auto-migration', () => {
    let tmpDir: string;

    afterEach(() => {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should migrate a JS config to JSON on load', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-migrate-'));
      const jsPath = path.join(tmpDir, 'openhive.config.js');
      fs.writeFileSync(jsPath, `module.exports = {
        port: 4000,
        instance: { name: 'MigrateTest', description: 'test', public: true },
      };`);

      const config = loadConfig(jsPath);

      // Config should have loaded correctly
      expect(config.port).toBe(4000);
      expect(config.instance.name).toBe('MigrateTest');

      // JS file should be renamed to .bak
      expect(fs.existsSync(jsPath)).toBe(false);
      expect(fs.existsSync(jsPath + '.bak')).toBe(true);

      // JSON file should exist
      const jsonPath = jsPath.replace(/\.js$/, '.json');
      expect(fs.existsSync(jsonPath)).toBe(true);

      // JSON should be valid and contain the config
      const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      expect(jsonContent.port).toBe(4000);
      expect(jsonContent.instance.name).toBe('MigrateTest');

      // Loaded path should point to JSON
      expect(getLoadedConfigPath()).toBe(jsonPath);
      expect(isConfigEditable()).toBe(true);
    });

    it('should not migrate if JSON already exists', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-nomigrate-'));
      const jsPath = path.join(tmpDir, 'openhive.config.js');
      const jsonPath = path.join(tmpDir, 'openhive.config.json');

      fs.writeFileSync(jsPath, `module.exports = { port: 4000 };`);
      fs.writeFileSync(jsonPath, JSON.stringify({ port: 5000 }));

      // Since JSON is preferred in search order, it loads JSON (not JS)
      // So no migration is triggered
      const config = loadConfig(jsonPath);
      expect(config.port).toBe(5000);

      // JS file should still exist (not renamed)
      expect(fs.existsSync(jsPath)).toBe(true);
      expect(fs.existsSync(jsPath + '.bak')).toBe(false);
    });
  });
});
