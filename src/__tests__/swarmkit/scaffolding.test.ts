import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
  scaffoldProjectPackage,
  isPackageInitialized,
  getProjectInitPackages,
} from '../../swarmkit/scaffolding.js';

describe('swarmkit/scaffolding', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmkit-scaffold-'));
    projectRoot = path.join(tmpDir, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getProjectInitPackages', () => {
    it('should return all known project-level packages', () => {
      const pkgs = getProjectInitPackages();
      expect(pkgs).toContain('minimem');
      expect(pkgs).toContain('opentasks');
      expect(pkgs).toContain('sessionlog');
      expect(pkgs).toContain('claude-code-swarm');
      expect(pkgs).toContain('cognitive-core');
      expect(pkgs).toContain('skill-tree');
      expect(pkgs).toContain('self-driving-repo');
      expect(pkgs).toContain('openteams');
    });
  });

  // ─── minimem ──────────────────────────────────────────────

  describe('minimem', () => {
    it('should create config, memory dir, MEMORY.md, and .gitignore', () => {
      const result = scaffoldProjectPackage('minimem', projectRoot);
      expect(result.success).toBe(true);

      const dir = path.join(projectRoot, '.swarm', 'minimem');
      expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'memory'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'MEMORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(true);
    });

    it('should set embedding provider from options', () => {
      scaffoldProjectPackage('minimem', projectRoot, {
        embeddingProvider: 'gemini',
      });

      const config = JSON.parse(
        fs.readFileSync(path.join(projectRoot, '.swarm', 'minimem', 'config.json'), 'utf-8'),
      );
      expect(config.embedding.provider).toBe('gemini');
    });

    it('should use "auto" for local embedding provider', () => {
      scaffoldProjectPackage('minimem', projectRoot, {
        embeddingProvider: 'local',
      });

      const config = JSON.parse(
        fs.readFileSync(path.join(projectRoot, '.swarm', 'minimem', 'config.json'), 'utf-8'),
      );
      expect(config.embedding.provider).toBe('auto');
    });

    it('should apply overrides', () => {
      scaffoldProjectPackage('minimem', projectRoot, {
        overrides: { 'hybrid.vectorWeight': 0.9, 'query.maxResults': 20 },
      });

      const config = JSON.parse(
        fs.readFileSync(path.join(projectRoot, '.swarm', 'minimem', 'config.json'), 'utf-8'),
      );
      expect(config.hybrid.vectorWeight).toBe(0.9);
      expect(config.query.maxResults).toBe(20);
      // Default values preserved
      expect(config.hybrid.textWeight).toBe(0.3);
    });

    it('should not overwrite existing config', () => {
      const dir = path.join(projectRoot, '.swarm', 'minimem');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ custom: true }));

      scaffoldProjectPackage('minimem', projectRoot);

      const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
      expect(config.custom).toBe(true);
      expect(config.embedding).toBeUndefined(); // not overwritten
    });

    it('should use flat layout when usePrefix is false', () => {
      scaffoldProjectPackage('minimem', projectRoot, { usePrefix: false });
      expect(fs.existsSync(path.join(projectRoot, '.minimem', 'config.json'))).toBe(true);
    });
  });

  // ─── opentasks ────────────────────────────────────────────

  describe('opentasks', () => {
    it('should create config.json and graph.jsonl', () => {
      const result = scaffoldProjectPackage('opentasks', projectRoot);
      expect(result.success).toBe(true);

      const dir = path.join(projectRoot, '.swarm', 'opentasks');
      expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'graph.jsonl'))).toBe(true);

      const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
      expect(config.version).toBe('1.0');
      expect(config.location.name).toBeDefined();
      expect(config.location.hash).toBeDefined();
      expect(config.location.uuid).toBeDefined();
    });

    it('should use project name from package.json', () => {
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'my-project' }),
      );

      scaffoldProjectPackage('opentasks', projectRoot);

      const config = JSON.parse(
        fs.readFileSync(path.join(projectRoot, '.swarm', 'opentasks', 'config.json'), 'utf-8'),
      );
      expect(config.location.name).toBe('my-project');
    });
  });

  // ─── cognitive-core ───────────────────────────────────────

  describe('cognitive-core', () => {
    it('should create subdirectories', () => {
      const result = scaffoldProjectPackage('cognitive-core', projectRoot);
      expect(result.success).toBe(true);

      const dir = path.join(projectRoot, '.swarm', 'cognitive-core');
      expect(fs.existsSync(path.join(dir, 'team-experiences'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'team-playbooks'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'team-meta-strategies'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'team-meta-observations'))).toBe(true);
    });
  });

  // ─── skill-tree (project) ─────────────────────────────────

  describe('skill-tree project', () => {
    it('should create skills dir, cache dir, and .gitignore', () => {
      const result = scaffoldProjectPackage('skill-tree', projectRoot);
      expect(result.success).toBe(true);

      const dir = path.join(projectRoot, '.swarm', 'skilltree');
      expect(fs.existsSync(path.join(dir, 'skills'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.cache'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toContain('.cache/');
    });
  });

  // ─── self-driving-repo ────────────────────────────────────

  describe('self-driving-repo', () => {
    it('should create YAML config with default template', () => {
      const result = scaffoldProjectPackage('self-driving-repo', projectRoot);
      expect(result.success).toBe(true);

      const configPath = path.join(projectRoot, '.swarm', 'self-driving', 'config.yml');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      expect(config.template).toBe('triage-only');
    });

    it('should use custom template from overrides', () => {
      scaffoldProjectPackage('self-driving-repo', projectRoot, {
        overrides: { template: 'full-pipeline' },
      });

      const configPath = path.join(projectRoot, '.swarm', 'self-driving', 'config.yml');
      const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      expect(config.template).toBe('full-pipeline');
    });
  });

  // ─── sessionlog ───────────────────────────────────────────

  describe('sessionlog', () => {
    it('should create settings.json and .gitignore', () => {
      const result = scaffoldProjectPackage('sessionlog', projectRoot);
      expect(result.success).toBe(true);

      const dir = path.join(projectRoot, '.swarm', 'sessionlog');
      const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
      expect(settings.enabled).toBe(false);
      expect(settings.strategy).toBe('manual-commit');
      expect(settings.logLevel).toBe('warn');

      const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('settings.local.json');
    });

    it('should apply session repo overrides', () => {
      scaffoldProjectPackage('sessionlog', projectRoot, {
        overrides: {
          enabled: true,
          'sessionRepo.remote': 'git@github.com:org/sessions.git',
          'sessionRepo.directory': 'my-project',
        },
      });

      const dir = path.join(projectRoot, '.swarm', 'sessionlog');
      const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
      expect(settings.enabled).toBe(true);
      expect(settings.sessionRepo.remote).toBe('git@github.com:org/sessions.git');
      expect(settings.sessionRepo.directory).toBe('my-project');
    });
  });

  // ─── claude-code-swarm ────────────────────────────────────

  describe('claude-code-swarm project', () => {
    it('should create config.json and .gitignore', () => {
      const result = scaffoldProjectPackage('claude-code-swarm', projectRoot);
      expect(result.success).toBe(true);

      const dir = path.join(projectRoot, '.swarm', 'claude-swarm');
      const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
      expect(config.template).toBe('');
      expect(config.map.enabled).toBe(false);
      expect(config.sessionlog.sync).toBe('off');

      expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toContain('tmp/');
    });
  });

  // ─── openteams ────────────────────────────────────────────

  describe('openteams', () => {
    it('should create config.json with empty defaults', () => {
      const result = scaffoldProjectPackage('openteams', projectRoot);
      expect(result.success).toBe(true);

      const config = JSON.parse(
        fs.readFileSync(path.join(projectRoot, '.swarm', 'openteams', 'config.json'), 'utf-8'),
      );
      expect(config).toEqual({ defaults: {} });
    });
  });

  // ─── isPackageInitialized ─────────────────────────────────

  describe('isPackageInitialized', () => {
    it('should return false for uninitialized package', () => {
      expect(isPackageInitialized('minimem', projectRoot, true)).toBe(false);
    });

    it('should return true after scaffolding', () => {
      scaffoldProjectPackage('minimem', projectRoot);
      expect(isPackageInitialized('minimem', projectRoot, true)).toBe(true);
    });

    it('should return true for flat layout', () => {
      scaffoldProjectPackage('minimem', projectRoot, { usePrefix: false });
      expect(isPackageInitialized('minimem', projectRoot, false)).toBe(true);
    });
  });

  // ─── Error handling ───────────────────────────────────────

  describe('error handling', () => {
    it('should return error for unknown package', () => {
      const result = scaffoldProjectPackage('nonexistent', projectRoot);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown package');
    });

    it('should be idempotent — safe to call multiple times', () => {
      scaffoldProjectPackage('minimem', projectRoot);
      const result = scaffoldProjectPackage('minimem', projectRoot);
      expect(result.success).toBe(true);
      // Config should not be overwritten
      expect(result.filesCreated?.length).toBe(0);
    });
  });
});
