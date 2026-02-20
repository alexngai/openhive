import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveDataDir,
  ensureDataDir,
  dataDirPaths,
  isInitialised,
  findConfigFile,
} from '../data-dir.js';
import { testRoot, mkTestDir, cleanTestRoot } from './helpers/test-dirs.js';

// Use a unique temp directory for each test run to avoid collisions
const TEST_ROOT = testRoot('datadir');

function mkTemp(name: string): string {
  return mkTestDir(TEST_ROOT, name);
}

describe('data-dir', () => {
  beforeEach(() => {
    // Clean env vars that affect resolution
    delete process.env.OPENHIVE_HOME;
  });

  afterAll(() => {
    cleanTestRoot(TEST_ROOT);
    delete process.env.OPENHIVE_HOME;
  });

  // ===========================================================================
  // resolveDataDir
  // ===========================================================================

  describe('resolveDataDir', () => {
    it('should return the explicit path when provided', () => {
      const result = resolveDataDir('/custom/data/dir');
      expect(result).toBe('/custom/data/dir');
    });

    it('should resolve a relative explicit path to absolute', () => {
      const result = resolveDataDir('./my-data');
      expect(path.isAbsolute(result)).toBe(true);
      expect(result).toBe(path.resolve('./my-data'));
    });

    it('should use OPENHIVE_HOME env var when no explicit path', () => {
      const envDir = mkTemp('env-home');
      process.env.OPENHIVE_HOME = envDir;

      const result = resolveDataDir();
      expect(result).toBe(envDir);
    });

    it('should prefer explicit path over OPENHIVE_HOME', () => {
      process.env.OPENHIVE_HOME = '/env/path';
      const result = resolveDataDir('/explicit/path');
      expect(result).toBe('/explicit/path');
    });

    it('should detect .openhive/ in CWD when marker exists', () => {
      // Use a temp directory as fake CWD to avoid touching the real project root
      const fakeCwd = mkTemp('cwd-marker');
      const localDir = path.join(fakeCwd, '.openhive');
      const markerPath = path.join(localDir, '.openhive-root');

      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(markerPath, 'test');

      vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
      try {
        const result = resolveDataDir();
        expect(result).toBe(localDir);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('should fall back to ~/.openhive/ when nothing else matches', () => {
      // Use a temp directory with no .openhive marker as fake CWD
      const fakeCwd = mkTemp('cwd-fallback');
      vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);

      try {
        const result = resolveDataDir();
        expect(result).toBe(path.join(os.homedir(), '.openhive'));
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('should not detect .openhive/ in CWD without marker file', () => {
      // Use a temp directory as fake CWD
      const fakeCwd = mkTemp('cwd-no-marker');
      const localDir = path.join(fakeCwd, '.openhive');

      // Create directory but no marker
      fs.mkdirSync(localDir, { recursive: true });

      vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
      try {
        const result = resolveDataDir();
        // Should NOT return the local dir without marker
        expect(result).toBe(path.join(os.homedir(), '.openhive'));
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  // ===========================================================================
  // ensureDataDir
  // ===========================================================================

  describe('ensureDataDir', () => {
    it('should create the directory structure', () => {
      const dir = path.join(TEST_ROOT, 'ensure-test');
      cleanTestRoot(dir);

      ensureDataDir(dir);

      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'data'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'uploads'))).toBe(true);
    });

    it('should write a marker file', () => {
      const dir = path.join(TEST_ROOT, 'ensure-marker');
      cleanTestRoot(dir);

      ensureDataDir(dir);

      const markerPath = path.join(dir, '.openhive-root');
      expect(fs.existsSync(markerPath)).toBe(true);

      const content = fs.readFileSync(markerPath, 'utf-8');
      expect(content).toContain('Created by OpenHive');
    });

    it('should not overwrite an existing marker file', () => {
      const dir = path.join(TEST_ROOT, 'ensure-no-overwrite');
      cleanTestRoot(dir);
      fs.mkdirSync(dir, { recursive: true });

      const markerPath = path.join(dir, '.openhive-root');
      fs.writeFileSync(markerPath, 'original content');

      ensureDataDir(dir);

      const content = fs.readFileSync(markerPath, 'utf-8');
      expect(content).toBe('original content');
    });

    it('should be idempotent (safe to call multiple times)', () => {
      const dir = path.join(TEST_ROOT, 'ensure-idempotent');
      cleanTestRoot(dir);

      ensureDataDir(dir);
      ensureDataDir(dir);
      ensureDataDir(dir);

      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'data'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'uploads'))).toBe(true);
    });
  });

  // ===========================================================================
  // dataDirPaths
  // ===========================================================================

  describe('dataDirPaths', () => {
    it('should return all expected paths', () => {
      const paths = dataDirPaths('/my/data');

      expect(paths.root).toBe('/my/data');
      expect(paths.database).toBe(path.join('/my/data', 'data', 'openhive.db'));
      expect(paths.uploads).toBe(path.join('/my/data', 'uploads'));
      expect(paths.config).toBe(path.join('/my/data', 'config.js'));
      expect(paths.configJson).toBe(path.join('/my/data', 'config.json'));
    });

    it('should handle paths with trailing slashes', () => {
      const paths = dataDirPaths('/my/data/');

      expect(paths.root).toBe('/my/data/');
      expect(paths.database).toBe(path.join('/my/data/', 'data', 'openhive.db'));
    });
  });

  // ===========================================================================
  // isInitialised
  // ===========================================================================

  describe('isInitialised', () => {
    it('should return true when marker file exists', () => {
      const dir = mkTemp('init-true');
      fs.writeFileSync(path.join(dir, '.openhive-root'), 'test');

      expect(isInitialised(dir)).toBe(true);
    });

    it('should return false when marker file does not exist', () => {
      const dir = mkTemp('init-false');

      expect(isInitialised(dir)).toBe(false);
    });

    it('should return false when directory does not exist', () => {
      expect(isInitialised('/nonexistent/path/abc123')).toBe(false);
    });

    it('should return true after ensureDataDir is called', () => {
      const dir = path.join(TEST_ROOT, 'init-after-ensure');
      cleanTestRoot(dir);

      expect(isInitialised(dir)).toBe(false);
      ensureDataDir(dir);
      expect(isInitialised(dir)).toBe(true);
    });
  });

  // ===========================================================================
  // findConfigFile
  // ===========================================================================

  describe('findConfigFile', () => {
    it('should return undefined when no config files exist', () => {
      const dir = mkTemp('find-none');

      // Mock CWD so findConfigFile doesn't find real project config files
      const fakeCwd = mkTemp('find-none-cwd');
      vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);

      try {
        const result = findConfigFile(dir);
        expect(result).toBeUndefined();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('should find config.js in the data directory', () => {
      const dir = mkTemp('find-configjs');
      const configPath = path.join(dir, 'config.js');
      fs.writeFileSync(configPath, 'module.exports = {}');

      const fakeCwd = mkTemp('find-configjs-cwd');
      vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);

      try {
        const result = findConfigFile(dir);
        expect(result).toBe(configPath);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('should find config.json in the data directory', () => {
      const dir = mkTemp('find-configjson');
      const configPath = path.join(dir, 'config.json');
      fs.writeFileSync(configPath, '{}');

      const fakeCwd = mkTemp('find-configjson-cwd');
      vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);

      try {
        const result = findConfigFile(dir);
        expect(result).toBe(configPath);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('should prefer config.js over config.json in data dir', () => {
      const dir = mkTemp('find-prefer-js');
      const jsPath = path.join(dir, 'config.js');
      const jsonPath = path.join(dir, 'config.json');
      fs.writeFileSync(jsPath, 'module.exports = {}');
      fs.writeFileSync(jsonPath, '{}');

      const fakeCwd = mkTemp('find-prefer-js-cwd');
      vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);

      try {
        const result = findConfigFile(dir);
        expect(result).toBe(jsPath);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  // ===========================================================================
  // Integration: resolveDataDir + ensureDataDir + isInitialised
  // ===========================================================================

  describe('integration', () => {
    it('should resolve, initialise, and then detect a data dir', () => {
      const dir = path.join(TEST_ROOT, 'integration-full');
      cleanTestRoot(dir);

      // Initially not initialised
      expect(isInitialised(dir)).toBe(false);

      // Ensure creates the structure
      ensureDataDir(dir);

      // Now initialised
      expect(isInitialised(dir)).toBe(true);

      // Paths are correct
      const paths = dataDirPaths(dir);
      expect(fs.existsSync(paths.root)).toBe(true);
      expect(fs.existsSync(path.dirname(paths.database))).toBe(true);
      expect(fs.existsSync(paths.uploads)).toBe(true);
    });

    it('should resolve via OPENHIVE_HOME after ensureDataDir', () => {
      const dir = path.join(TEST_ROOT, 'integration-env');
      cleanTestRoot(dir);

      ensureDataDir(dir);
      process.env.OPENHIVE_HOME = dir;

      const resolved = resolveDataDir();
      expect(resolved).toBe(dir);
      expect(isInitialised(resolved)).toBe(true);
    });
  });
});
