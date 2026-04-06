import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readConfig,
  writeConfig,
  resolveDescriptors,
  findDescriptor,
} from '../../swarmkit/config-io.js';
import type { PackageConfigDescriptor } from '../../swarmkit/types.js';

describe('swarmkit/config-io', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmkit-configio-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── readConfig ─────────────────────────────────────────────

  describe('readConfig', () => {
    it('should read a JSON config file', () => {
      const configDir = path.join(tmpDir, 'pkg');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ embedding: { provider: 'openai' } }),
      );

      const desc: PackageConfigDescriptor = {
        packageName: 'minimem',
        scope: 'project',
        configDir,
        configFile: 'config.json',
        format: 'json',
        exists: true,
      };

      expect(readConfig(desc)).toEqual({ embedding: { provider: 'openai' } });
    });

    it('should read a YAML config file', () => {
      const configDir = path.join(tmpDir, 'skilltree');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config.yaml'),
        'storage:\n  type: sqlite\n  path: ~/.skill-tree/skills.db\n',
      );

      const desc: PackageConfigDescriptor = {
        packageName: 'skill-tree',
        scope: 'global',
        configDir,
        configFile: 'config.yaml',
        format: 'yaml',
        exists: true,
      };

      const result = readConfig(desc);
      expect(result).toEqual({
        storage: { type: 'sqlite', path: '~/.skill-tree/skills.db' },
      });
    });

    it('should return empty object for missing file', () => {
      const desc: PackageConfigDescriptor = {
        packageName: 'minimem',
        scope: 'project',
        configDir: path.join(tmpDir, 'nonexistent'),
        configFile: 'config.json',
        format: 'json',
        exists: false,
      };

      expect(readConfig(desc)).toEqual({});
    });

    it('should return empty object for corrupt JSON', () => {
      const configDir = path.join(tmpDir, 'bad');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), '{not valid json');

      const desc: PackageConfigDescriptor = {
        packageName: 'test',
        scope: 'project',
        configDir,
        configFile: 'config.json',
        format: 'json',
        exists: true,
      };

      expect(readConfig(desc)).toEqual({});
    });

    it('should return empty object for empty configFile (directory-only packages)', () => {
      const desc: PackageConfigDescriptor = {
        packageName: 'cognitive-core',
        scope: 'project',
        configDir: tmpDir,
        configFile: '',
        format: 'json',
        exists: true,
      };

      expect(readConfig(desc)).toEqual({});
    });
  });

  // ─── writeConfig ────────────────────────────────────────────

  describe('writeConfig', () => {
    it('should write JSON config atomically', () => {
      const configDir = path.join(tmpDir, 'write-test');
      fs.mkdirSync(configDir, { recursive: true });

      const desc: PackageConfigDescriptor = {
        packageName: 'minimem',
        scope: 'project',
        configDir,
        configFile: 'config.json',
        format: 'json',
        exists: false,
      };

      writeConfig(desc, { hybrid: { vectorWeight: 0.8 } });

      const written = JSON.parse(
        fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'),
      );
      expect(written).toEqual({ hybrid: { vectorWeight: 0.8 } });
      expect(fs.existsSync(path.join(configDir, 'config.json.tmp'))).toBe(false);
    });

    it('should write YAML config', () => {
      const configDir = path.join(tmpDir, 'yaml-write');
      fs.mkdirSync(configDir, { recursive: true });

      const desc: PackageConfigDescriptor = {
        packageName: 'skill-tree',
        scope: 'global',
        configDir,
        configFile: 'config.yaml',
        format: 'yaml',
        exists: false,
      };

      writeConfig(desc, { storage: { type: 'sqlite' } });

      const raw = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
      expect(raw).toContain('storage:');
      expect(raw).toContain('type: sqlite');
    });

    it('should create directories if missing', () => {
      const configDir = path.join(tmpDir, 'deep', 'nested', 'dir');

      const desc: PackageConfigDescriptor = {
        packageName: 'test',
        scope: 'project',
        configDir,
        configFile: 'config.json',
        format: 'json',
        exists: false,
      };

      writeConfig(desc, { key: 'value' });
      expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(true);
    });

    it('should no-op for empty configFile', () => {
      const desc: PackageConfigDescriptor = {
        packageName: 'cognitive-core',
        scope: 'project',
        configDir: tmpDir,
        configFile: '',
        format: 'json',
        exists: true,
      };

      // Should not throw or create files
      writeConfig(desc, { key: 'value' });
      // No config.json should be created at tmpDir root
      expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(false);
    });
  });

  // ─── resolveDescriptors ─────────────────────────────────────

  describe('resolveDescriptors', () => {
    it('should return project descriptor for project-only packages', () => {
      const projectRoot = path.join(tmpDir, 'project');
      fs.mkdirSync(path.join(projectRoot, '.swarm', 'minimem'), { recursive: true });

      const descriptors = resolveDescriptors('minimem', projectRoot, true);
      expect(descriptors.length).toBe(1);
      expect(descriptors[0].scope).toBe('project');
      expect(descriptors[0].configFile).toBe('config.json');
      expect(descriptors[0].format).toBe('json');
      expect(descriptors[0].configDir).toBe(
        path.join(projectRoot, '.swarm', 'minimem'),
      );
    });

    it('should return both global and project for dual-scope packages', () => {
      const projectRoot = path.join(tmpDir, 'project');
      fs.mkdirSync(path.join(projectRoot, '.swarm', 'claude-swarm'), { recursive: true });

      const descriptors = resolveDescriptors('claude-code-swarm', projectRoot, true);
      // Should have both global (~/.claude-swarm) and project
      expect(descriptors.length).toBe(2);
      const scopes = descriptors.map((d) => d.scope);
      expect(scopes).toContain('global');
      expect(scopes).toContain('project');
    });

    it('should return empty for unknown packages', () => {
      expect(resolveDescriptors('nonexistent', tmpDir, true)).toEqual([]);
    });

    it('should use flat dirs when usePrefix is false', () => {
      const projectRoot = path.join(tmpDir, 'flat');
      const descriptors = resolveDescriptors('minimem', projectRoot, false);
      const project = descriptors.find((d) => d.scope === 'project');
      expect(project?.configDir).toBe(path.join(projectRoot, '.minimem'));
    });

    it('should return project descriptor for cognitive-core (dir-only)', () => {
      const projectRoot = path.join(tmpDir, 'cogcore');
      const descriptors = resolveDescriptors('cognitive-core', projectRoot, true);
      const project = descriptors.find((d) => d.scope === 'project');
      expect(project).toBeDefined();
      expect(project!.configFile).toBe('');
    });

    it('should use settings.json for sessionlog', () => {
      const projectRoot = path.join(tmpDir, 'sl');
      const descriptors = resolveDescriptors('sessionlog', projectRoot, true);
      expect(descriptors[0].configFile).toBe('settings.json');
    });

    it('should use YAML for self-driving-repo', () => {
      const projectRoot = path.join(tmpDir, 'sdr');
      const descriptors = resolveDescriptors('self-driving-repo', projectRoot, true);
      expect(descriptors[0].configFile).toBe('config.yml');
      expect(descriptors[0].format).toBe('yaml');
    });
  });

  // ─── findDescriptor ─────────────────────────────────────────

  describe('findDescriptor', () => {
    it('should find by scope', () => {
      const descriptors: PackageConfigDescriptor[] = [
        { packageName: 'test', scope: 'global', configDir: '/g', configFile: 'c.json', format: 'json', exists: true },
        { packageName: 'test', scope: 'project', configDir: '/p', configFile: 'c.json', format: 'json', exists: true },
      ];

      expect(findDescriptor(descriptors, 'global')?.configDir).toBe('/g');
      expect(findDescriptor(descriptors, 'project')?.configDir).toBe('/p');
    });

    it('should return null when scope not found', () => {
      expect(findDescriptor([], 'global')).toBeNull();
    });
  });

  // ─── Roundtrip ──────────────────────────────────────────────

  describe('roundtrip', () => {
    it('should read back what was written (JSON)', () => {
      const configDir = path.join(tmpDir, 'roundtrip-json');
      fs.mkdirSync(configDir, { recursive: true });

      const desc: PackageConfigDescriptor = {
        packageName: 'minimem',
        scope: 'project',
        configDir,
        configFile: 'config.json',
        format: 'json',
        exists: false,
      };

      const data = { hybrid: { vectorWeight: 0.8, textWeight: 0.2 }, query: { maxResults: 5 } };
      writeConfig(desc, data);
      expect(readConfig({ ...desc, exists: true })).toEqual(data);
    });

    it('should read back what was written (YAML)', () => {
      const configDir = path.join(tmpDir, 'roundtrip-yaml');
      fs.mkdirSync(configDir, { recursive: true });

      const desc: PackageConfigDescriptor = {
        packageName: 'skill-tree',
        scope: 'global',
        configDir,
        configFile: 'config.yaml',
        format: 'yaml',
        exists: false,
      };

      const data = { storage: { type: 'sqlite', path: '/tmp/db' }, cli: { color: true } };
      writeConfig(desc, data);
      expect(readConfig({ ...desc, exists: true })).toEqual(data);
    });
  });
});
