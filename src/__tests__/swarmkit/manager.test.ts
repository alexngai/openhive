import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock os.homedir before any swarmkit modules are imported
let mockHomeDir: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => mockHomeDir,
  };
});

// Import after mock setup
import { SwarmKitConfigManager } from '../../swarmkit/manager.js';

describe('swarmkit/manager', () => {
  let tmpDir: string;
  let dataDir: string;
  let projectRoot: string;
  let manager: SwarmKitConfigManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmkit-mgr-'));
    dataDir = path.join(tmpDir, 'data');
    projectRoot = path.join(tmpDir, 'project');
    mockHomeDir = path.join(tmpDir, 'home');

    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.swarm', 'minimem'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.swarm', 'sessionlog'), { recursive: true });
    fs.mkdirSync(path.join(mockHomeDir, '.swarmkit'), { recursive: true });

    // Write a mock global config
    fs.writeFileSync(
      path.join(mockHomeDir, '.swarmkit', 'config.json'),
      JSON.stringify({
        installedPackages: ['minimem', 'sessionlog', 'claude-code-swarm'],
        embeddingProvider: 'openai',
        usePrefix: true,
      }),
    );

    // Write a mock minimem config
    fs.writeFileSync(
      path.join(projectRoot, '.swarm', 'minimem', 'config.json'),
      JSON.stringify({
        embedding: { provider: 'openai' },
        hybrid: { vectorWeight: 0.7, textWeight: 0.3 },
        query: { maxResults: 10, minScore: 0.3 },
      }),
    );

    // Write a mock sessionlog config
    fs.writeFileSync(
      path.join(projectRoot, '.swarm', 'sessionlog', 'settings.json'),
      JSON.stringify({
        enabled: false,
        strategy: 'manual-commit',
      }),
    );

    manager = new SwarmKitConfigManager(dataDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── getState ───────────────────────────────────────────────

  describe('getState', () => {
    it('should return installed packages and config', () => {
      const state = manager.getState();
      expect(state.installed).toBe(true);
      expect(state.installedPackages).toEqual(['minimem', 'sessionlog', 'claude-code-swarm']);
      expect(state.embeddingProvider).toBe('openai');
      expect(state.usePrefix).toBe(true);
    });

    it('should report not installed when config missing', () => {
      fs.rmSync(path.join(mockHomeDir, '.swarmkit', 'config.json'));
      const state = manager.getState();
      expect(state.installed).toBe(false);
      expect(state.installedPackages).toEqual([]);
    });
  });

  // ─── getPackageConfig ───────────────────────────────────────

  describe('getPackageConfig', () => {
    it('should return null for unknown packages', () => {
      expect(manager.getPackageConfig('nonexistent', projectRoot)).toBeNull();
    });

    it('should read minimem config from project', () => {
      const result = manager.getPackageConfig('minimem', projectRoot);
      expect(result).not.toBeNull();
      expect(result!.packageName).toBe('minimem');
      expect(result!.installed).toBe(true);
      expect(result!.config).toEqual({
        embedding: { provider: 'openai' },
        hybrid: { vectorWeight: 0.7, textWeight: 0.3 },
        query: { maxResults: 10, minScore: 0.3 },
      });
    });

    it('should read sessionlog config with correct filename', () => {
      const result = manager.getPackageConfig('sessionlog', projectRoot);
      expect(result).not.toBeNull();
      expect(result!.config).toEqual({
        enabled: false,
        strategy: 'manual-commit',
      });
    });

    it('should return empty config when file does not exist', () => {
      const result = manager.getPackageConfig('opentasks', projectRoot);
      expect(result).not.toBeNull();
      expect(result!.config).toEqual({});
      expect(result!.installed).toBe(false);
    });

    it('should return metadata with inline options', () => {
      const result = manager.getPackageConfig('minimem', projectRoot)!;
      expect(result.meta.inlineOptions.length).toBeGreaterThan(0);
      expect(result.meta.category).toBe('learning');
    });

    it('should scope reads when scope parameter provided', () => {
      const result = manager.getPackageConfig('minimem', projectRoot, 'project');
      expect(result!.scope).toBe('project');
    });

    it('should merge sessionlog settings.local.json over settings.json', () => {
      fs.writeFileSync(
        path.join(projectRoot, '.swarm', 'sessionlog', 'settings.local.json'),
        JSON.stringify({ sessionRepo: { localPath: '/Users/alex/sessions' } }),
      );

      const result = manager.getPackageConfig('sessionlog', projectRoot)!;
      expect(result.config).toEqual({
        enabled: false,
        strategy: 'manual-commit',
        sessionRepo: { localPath: '/Users/alex/sessions' },
      });
      expect(result.localConfig).toEqual({
        sessionRepo: { localPath: '/Users/alex/sessions' },
      });
    });

    it('should let settings.local.json override settings.json for colliding keys', () => {
      fs.writeFileSync(
        path.join(projectRoot, '.swarm', 'sessionlog', 'settings.json'),
        JSON.stringify({ enabled: true, sessionRepo: { remote: 'git@github:org/s.git' } }),
      );
      fs.writeFileSync(
        path.join(projectRoot, '.swarm', 'sessionlog', 'settings.local.json'),
        JSON.stringify({ sessionRepo: { localPath: '/Users/alex/sessions' } }),
      );

      const result = manager.getPackageConfig('sessionlog', projectRoot)!;
      // remote from project, localPath from local — merged
      expect(result.config).toEqual({
        enabled: true,
        sessionRepo: {
          remote: 'git@github:org/s.git',
          localPath: '/Users/alex/sessions',
        },
      });
    });

    it('should omit localConfig when no settings.local.json exists', () => {
      const result = manager.getPackageConfig('sessionlog', projectRoot)!;
      expect(result.localConfig).toBeUndefined();
    });
  });

  // ─── getAllPackageConfigs ────────────────────────────────────

  describe('getAllPackageConfigs', () => {
    it('should return configs for all registered packages', () => {
      const all = manager.getAllPackageConfigs(projectRoot);
      expect(all.length).toBeGreaterThan(0);
      const names = all.map((p) => p.packageName);
      expect(names).toContain('minimem');
      expect(names).toContain('sessionlog');
    });
  });

  // ─── updatePackageConfig ────────────────────────────────────

  describe('updatePackageConfig', () => {
    it('should update a config value and persist to disk', () => {
      const result = manager.updatePackageConfig(
        'minimem',
        projectRoot,
        'project',
        { 'hybrid.vectorWeight': 0.9 },
      );

      expect(result.success).toBe(true);

      // Verify written to disk
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.swarm', 'minimem', 'config.json'),
          'utf-8',
        ),
      );
      expect(raw.hybrid.vectorWeight).toBe(0.9);
      expect(raw.hybrid.textWeight).toBe(0.3);
      expect(raw.query.maxResults).toBe(10);
    });

    it('should fail for missing descriptor', () => {
      const result = manager.updatePackageConfig(
        'minimem',
        null,
        'global',
        { 'hybrid.vectorWeight': 0.5 },
      );
      expect(result.success).toBe(false);
    });

    it('should fail for directory-only packages', () => {
      fs.mkdirSync(path.join(projectRoot, '.swarm', 'cognitive-core'), { recursive: true });
      const result = manager.updatePackageConfig(
        'cognitive-core',
        projectRoot,
        'project',
        { some: 'value' },
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('no config file');
    });

    it('should write localUpdates to settings.local.json for sessionlog', () => {
      const result = manager.updatePackageConfig(
        'sessionlog',
        projectRoot,
        'project',
        { 'sessionRepo.remote': 'git@github:org/s.git' },
        { 'sessionRepo.localPath': '/Users/alex/sessions' },
      );

      expect(result.success).toBe(true);

      const mainRaw = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.swarm', 'sessionlog', 'settings.json'),
          'utf-8',
        ),
      );
      const localRaw = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.swarm', 'sessionlog', 'settings.local.json'),
          'utf-8',
        ),
      );

      // project-file keys don't leak into local, and vice versa
      expect(mainRaw.sessionRepo).toEqual({ remote: 'git@github:org/s.git' });
      expect(localRaw.sessionRepo).toEqual({ localPath: '/Users/alex/sessions' });
    });

    it('should accept localUpdates only (no main updates)', () => {
      const result = manager.updatePackageConfig(
        'sessionlog',
        projectRoot,
        'project',
        {},
        { 'sessionRepo.localPath': '/Users/alex/sessions' },
      );

      expect(result.success).toBe(true);

      // Main file untouched
      const mainRaw = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.swarm', 'sessionlog', 'settings.json'),
          'utf-8',
        ),
      );
      expect(mainRaw).toEqual({ enabled: false, strategy: 'manual-commit' });

      const localRaw = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.swarm', 'sessionlog', 'settings.local.json'),
          'utf-8',
        ),
      );
      expect(localRaw.sessionRepo.localPath).toBe('/Users/alex/sessions');
    });

    it('should reject localUpdates for packages without a local file', () => {
      const result = manager.updatePackageConfig(
        'minimem',
        projectRoot,
        'project',
        {},
        { 'hybrid.vectorWeight': 0.9 },
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('does not support local-file overrides');
    });
  });

  // ─── Project roots ──────────────────────────────────────────

  describe('project roots', () => {
    it('should add and list project roots', () => {
      manager.addProjectRoot(projectRoot);
      expect(manager.getProjectRoots()).toContain(projectRoot);
    });

    it('should remove project roots', () => {
      manager.addProjectRoot(projectRoot);
      manager.removeProjectRoot(projectRoot);
      expect(manager.getProjectRoots()).not.toContain(projectRoot);
    });
  });

  // ─── runDoctor ──────────────────────────────────────────────

  describe('runDoctor', () => {
    it('should pass for installed packages with configs', () => {
      const results = manager.runDoctor(projectRoot);
      const minimemCheck = results.find((r) => r.name === 'minimem-config');
      expect(minimemCheck).toBeDefined();
      expect(minimemCheck!.status).toBe('pass');
    });

    it('should pass for swarmkit installation', () => {
      const results = manager.runDoctor(projectRoot);
      const installCheck = results.find((r) => r.name === 'swarmkit-installed');
      expect(installCheck!.status).toBe('pass');
    });

    it('should pass for embedding provider', () => {
      const results = manager.runDoctor(projectRoot);
      const embedCheck = results.find((r) => r.name === 'embedding-provider');
      expect(embedCheck!.status).toBe('pass');
      expect(embedCheck!.message).toContain('openai');
    });

    it('should warn when embedding provider is missing', () => {
      fs.writeFileSync(
        path.join(mockHomeDir, '.swarmkit', 'config.json'),
        JSON.stringify({ installedPackages: ['minimem'] }),
      );
      const results = manager.runDoctor(projectRoot);
      const embedCheck = results.find((r) => r.name === 'embedding-provider');
      expect(embedCheck!.status).toBe('warn');
    });

    it('should fail when swarmkit not installed', () => {
      fs.rmSync(path.join(mockHomeDir, '.swarmkit', 'config.json'));
      const results = manager.runDoctor(null);
      expect(results.length).toBe(1);
      expect(results[0].status).toBe('fail');
      expect(results[0].fix).toContain('swarmkit init');
    });

    it('should quote project root paths in fix suggestions', () => {
      const spacePath = path.join(tmpDir, 'has spaces');
      fs.mkdirSync(path.join(spacePath, '.swarm'), { recursive: true });
      const results = manager.runDoctor(spacePath);
      const projectCheck = results.find((r) => r.name === 'project-root');
      if (projectCheck?.fix) {
        expect(projectCheck.fix).toContain('"');
      }
    });
  });

  // ─── Integrations ──────────────────────────────────────────

  describe('getIntegrations', () => {
    it('should return integrations based on installed packages', () => {
      const integrations = manager.getIntegrations(projectRoot);
      expect(integrations.length).toBeGreaterThan(0);
      const ccsSessionlog = integrations.find(
        (i) => i.packages.includes('claude-code-swarm') && i.packages.includes('sessionlog'),
      );
      expect(ccsSessionlog).toBeDefined();
      expect(ccsSessionlog!.active).toBe(true);
    });
  });

  // ─── Shared settings ───────────────────────────────────────

  describe('getSharedSettings', () => {
    it('should return shared settings with sync status', () => {
      const settings = manager.getSharedSettings(projectRoot);
      expect(settings.length).toBeGreaterThan(0);

      const embedding = settings.find((s) => s.key === 'embeddingProvider');
      expect(embedding).toBeDefined();
      expect(embedding!.currentValue).toBe('openai');
    });

    it('should report in-sync for matching values', () => {
      const settings = manager.getSharedSettings(projectRoot);
      const embedding = settings.find((s) => s.key === 'embeddingProvider')!;
      const minimemTarget = embedding.targets.find((t) => t.packageName === 'minimem');
      expect(minimemTarget?.inSync).toBe(true);
    });
  });
});
