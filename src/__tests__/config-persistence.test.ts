import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readConfigFile, writeConfigFile, deepMerge } from '../config-persistence.js';

describe('config-persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhive-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readConfigFile', () => {
    it('should read a valid JSON config file', () => {
      const filePath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(filePath, JSON.stringify({ port: 8080, instance: { name: 'Test' } }));

      const result = readConfigFile(filePath);
      expect(result).toEqual({ port: 8080, instance: { name: 'Test' } });
    });

    it('should return empty object for non-existent file', () => {
      const result = readConfigFile(path.join(tmpDir, 'missing.json'));
      expect(result).toEqual({});
    });

    it('should return empty object for invalid JSON', () => {
      const filePath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filePath, 'not json{{{');

      const result = readConfigFile(filePath);
      expect(result).toEqual({});
    });

    it('should return empty object for array JSON', () => {
      const filePath = path.join(tmpDir, 'array.json');
      fs.writeFileSync(filePath, '[1,2,3]');

      const result = readConfigFile(filePath);
      expect(result).toEqual({});
    });
  });

  describe('writeConfigFile', () => {
    it('should write JSON config atomically', () => {
      const filePath = path.join(tmpDir, 'config.json');
      const config = { port: 3000, instance: { name: 'MyHive' } };

      writeConfigFile(filePath, config);

      const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(written).toEqual(config);
    });

    it('should overwrite existing config', () => {
      const filePath = path.join(tmpDir, 'config.json');
      writeConfigFile(filePath, { port: 3000 });
      writeConfigFile(filePath, { port: 8080 });

      const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(written).toEqual({ port: 8080 });
    });

    it('should not leave tmp file on success', () => {
      const filePath = path.join(tmpDir, 'config.json');
      writeConfigFile(filePath, { port: 3000 });

      expect(fs.existsSync(filePath + '.tmp')).toBe(false);
    });

    it('should produce pretty-printed JSON with trailing newline', () => {
      const filePath = path.join(tmpDir, 'config.json');
      writeConfigFile(filePath, { port: 3000 });

      const raw = fs.readFileSync(filePath, 'utf-8');
      expect(raw).toContain('\n');
      expect(raw.endsWith('\n')).toBe(true);
    });
  });

  describe('deepMerge', () => {
    it('should merge flat objects', () => {
      const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
      expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('should recursively merge nested objects', () => {
      const result = deepMerge(
        { instance: { name: 'Old', description: 'keep' } },
        { instance: { name: 'New' } },
      );
      expect(result).toEqual({ instance: { name: 'New', description: 'keep' } });
    });

    it('should replace arrays (not concatenate)', () => {
      const result = deepMerge(
        { peers: ['a', 'b'] },
        { peers: ['c'] },
      );
      expect(result).toEqual({ peers: ['c'] });
    });

    it('should delete keys set to null', () => {
      const result = deepMerge(
        { a: 1, b: 2 },
        { b: null } as Record<string, unknown>,
      );
      expect(result).toEqual({ a: 1 });
    });

    it('should not mutate the target object', () => {
      const target = { a: 1, nested: { x: 10 } };
      const source = { nested: { y: 20 } };
      deepMerge(target, source);

      expect(target).toEqual({ a: 1, nested: { x: 10 } });
    });

    it('should handle type changes (object to primitive)', () => {
      const result = deepMerge(
        { field: { nested: true } },
        { field: 'string-now' },
      );
      expect(result).toEqual({ field: 'string-now' });
    });
  });

  describe('roundtrip: read → merge → write → read', () => {
    it('should persist config changes through a full cycle', () => {
      const filePath = path.join(tmpDir, 'config.json');

      // Initial config
      const initial = {
        port: 3000,
        instance: { name: 'MyHive', description: 'Test', public: true },
        learning: { enabled: false },
        cors: { enabled: true },
      };
      writeConfigFile(filePath, initial);

      // Read, merge updates, write back
      const current = readConfigFile(filePath);
      const updates = { learning: { enabled: true }, cors: { origin: '*' } };
      const merged = deepMerge(current, updates);
      writeConfigFile(filePath, merged);

      // Read again and verify
      const final = readConfigFile(filePath);
      expect(final).toEqual({
        port: 3000,
        instance: { name: 'MyHive', description: 'Test', public: true },
        learning: { enabled: true },
        cors: { enabled: true, origin: '*' },
      });
    });
  });
});
