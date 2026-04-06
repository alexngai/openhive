/**
 * Package scaffolding — creates the directory structure, config files,
 * and supporting files that `swarmkit init` would create for each package.
 *
 * Uses SwarmKit's init functions directly where possible. Falls back
 * to inline creation for packages whose CLI init spawns child processes
 * (which we avoid in a server context).
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import * as yaml from 'js-yaml';
import {
  PROJECT_CONFIG_DIRS,
  FLAT_PROJECT_CONFIG_DIRS,
  GLOBAL_CONFIG_DIRS,
  isProjectInit,
} from 'swarmkit';

export interface ScaffoldOptions {
  embeddingProvider?: 'openai' | 'gemini' | 'local' | null;
  usePrefix?: boolean;
  projectName?: string;
  overrides?: Record<string, unknown>;
}

export interface ScaffoldResult {
  packageName: string;
  success: boolean;
  message?: string;
  configDir?: string;
  filesCreated?: string[];
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Initialize a package in a project directory.
 * Safe to call multiple times — skips files that already exist.
 */
export function scaffoldProjectPackage(
  packageName: string,
  projectRoot: string,
  opts: ScaffoldOptions = {},
): ScaffoldResult {
  const usePrefix = opts.usePrefix ?? true;
  const dirs = usePrefix ? PROJECT_CONFIG_DIRS : FLAT_PROJECT_CONFIG_DIRS;
  const relDir = dirs[packageName];

  if (!relDir) {
    return { packageName, success: false, message: `Unknown package: ${packageName}` };
  }

  const configDir = path.join(projectRoot, relDir);

  try {
    const scaffolder = PROJECT_SCAFFOLDERS[packageName];
    if (!scaffolder) {
      fs.mkdirSync(configDir, { recursive: true });
      return { packageName, success: true, configDir, filesCreated: [] };
    }
    return scaffolder(configDir, projectRoot, opts);
  } catch (err) {
    return {
      packageName,
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Initialize a global package.
 */
export function scaffoldGlobalPackage(
  packageName: string,
  opts: ScaffoldOptions = {},
): ScaffoldResult {
  const globalRelDir = GLOBAL_CONFIG_DIRS[packageName];
  if (!globalRelDir) {
    return { packageName, success: false, message: `No global config for: ${packageName}` };
  }

  const configDir = path.join(homedir(), globalRelDir);

  try {
    const scaffolder = GLOBAL_SCAFFOLDERS[packageName];
    if (!scaffolder) {
      fs.mkdirSync(configDir, { recursive: true });
      return { packageName, success: true, configDir, filesCreated: [] };
    }
    return scaffolder(configDir, opts);
  } catch (err) {
    return {
      packageName,
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Get the list of packages that can be initialized at project level.
 */
export function getProjectInitPackages(): string[] {
  return Object.keys(PROJECT_CONFIG_DIRS);
}

/**
 * Get the list of packages that can be initialized at global level.
 */
export function getGlobalInitPackages(): string[] {
  return Object.keys(GLOBAL_CONFIG_DIRS);
}

/**
 * Check if a package is already initialized in a project.
 * Delegates to SwarmKit's isProjectInit which checks both layouts.
 */
export function isPackageInitialized(
  packageName: string,
  projectRoot: string,
  _usePrefix: boolean,
): boolean {
  return isProjectInit(projectRoot, packageName);
}

// ─── Per-package scaffolders (project) ──────────────────────

type ProjectScaffolder = (
  configDir: string,
  projectRoot: string,
  opts: ScaffoldOptions,
) => ScaffoldResult;

const PROJECT_SCAFFOLDERS: Record<string, ProjectScaffolder> = {
  opentasks: scaffoldOpentasks,
  minimem: scaffoldMinimem,
  'cognitive-core': scaffoldCognitiveCore,
  'skill-tree': scaffoldSkillTreeProject,
  'self-driving-repo': scaffoldSelfDrivingRepo,
  openteams: scaffoldOpenteams,
  sessionlog: scaffoldSessionlog,
  'claude-code-swarm': scaffoldClaudeSwarmProject,
};

function scaffoldOpentasks(
  configDir: string,
  projectRoot: string,
  opts: ScaffoldOptions,
): ScaffoldResult {
  fs.mkdirSync(configDir, { recursive: true });
  const files: string[] = [];

  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    const projectName = opts.projectName ?? detectProjectName(projectRoot);
    writeJSON(configPath, {
      version: '1.0',
      location: {
        name: projectName,
        hash: randomHex(8),
        uuid: randomUUID(),
      },
      connections: [],
      providers: {
        beads: { enabled: true },
        claudeTasks: { enabled: true },
      },
    });
    files.push('config.json');
  }

  const graphPath = path.join(configDir, 'graph.jsonl');
  if (!fs.existsSync(graphPath)) {
    fs.writeFileSync(graphPath, '', 'utf-8');
    files.push('graph.jsonl');
  }

  return { packageName: 'opentasks', success: true, configDir, filesCreated: files };
}

function scaffoldMinimem(
  configDir: string,
  _projectRoot: string,
  opts: ScaffoldOptions,
): ScaffoldResult {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'memory'), { recursive: true });
  const files: string[] = [];

  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    const provider = opts.embeddingProvider && opts.embeddingProvider !== 'local'
      ? opts.embeddingProvider
      : 'auto';

    const config: Record<string, unknown> = {
      embedding: { provider },
      hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      query: { maxResults: 10, minScore: 0.3 },
    };

    if (opts.overrides) applyOverrides(config, opts.overrides);
    writeJSON(configPath, config);
    files.push('config.json');
  }

  writeIfMissing(path.join(configDir, 'MEMORY.md'), '# Memory\n\nAdd notes, decisions, and context here.\n', files);
  writeIfMissing(path.join(configDir, '.gitignore'), 'index.db\nindex.db-*\n', files);

  return { packageName: 'minimem', success: true, configDir, filesCreated: files };
}

function scaffoldCognitiveCore(
  configDir: string,
  _projectRoot: string,
  _opts: ScaffoldOptions,
): ScaffoldResult {
  const subdirs = ['team-experiences', 'team-playbooks', 'team-meta-strategies', 'team-meta-observations'];
  fs.mkdirSync(configDir, { recursive: true });
  for (const sub of subdirs) {
    fs.mkdirSync(path.join(configDir, sub), { recursive: true });
  }
  return { packageName: 'cognitive-core', success: true, configDir, filesCreated: subdirs.map((s) => `${s}/`) };
}

function scaffoldSkillTreeProject(
  configDir: string,
  _projectRoot: string,
  _opts: ScaffoldOptions,
): ScaffoldResult {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(configDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(configDir, '.cache'), { recursive: true });
  const files: string[] = ['skills/', '.cache/'];
  writeIfMissing(path.join(configDir, '.gitignore'), '.cache/\n', files);
  return { packageName: 'skill-tree', success: true, configDir, filesCreated: files };
}

function scaffoldSelfDrivingRepo(
  configDir: string,
  _projectRoot: string,
  opts: ScaffoldOptions,
): ScaffoldResult {
  fs.mkdirSync(configDir, { recursive: true });
  const files: string[] = [];

  const configPath = path.join(configDir, 'config.yml');
  if (!fs.existsSync(configPath)) {
    const template = (opts.overrides?.template as string) ?? 'triage-only';
    fs.writeFileSync(configPath, yaml.dump({ template, agents: {}, workflows: {} }, { indent: 2 }), 'utf-8');
    files.push('config.yml');
  }

  return { packageName: 'self-driving-repo', success: true, configDir, filesCreated: files };
}

function scaffoldOpenteams(
  configDir: string,
  _projectRoot: string,
  _opts: ScaffoldOptions,
): ScaffoldResult {
  fs.mkdirSync(configDir, { recursive: true });
  const files: string[] = [];
  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    writeJSON(configPath, { defaults: {} });
    files.push('config.json');
  }
  return { packageName: 'openteams', success: true, configDir, filesCreated: files };
}

function scaffoldSessionlog(
  configDir: string,
  _projectRoot: string,
  opts: ScaffoldOptions,
): ScaffoldResult {
  fs.mkdirSync(configDir, { recursive: true });
  const files: string[] = [];

  const settingsPath = path.join(configDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    const settings: Record<string, unknown> = {
      enabled: false,
      strategy: 'manual-commit',
      logLevel: 'warn',
      telemetryEnabled: false,
      summarizationEnabled: false,
    };

    if (opts.overrides) {
      const repoRemote = opts.overrides['sessionRepo.remote'] as string | undefined;
      const repoDir = opts.overrides['sessionRepo.directory'] as string | undefined;

      for (const [key, value] of Object.entries(opts.overrides)) {
        if (!key.startsWith('sessionRepo.')) settings[key] = value;
      }

      if (repoRemote) {
        const sessionRepo: Record<string, unknown> = { remote: repoRemote };
        if (repoDir) sessionRepo.directory = repoDir;
        settings.sessionRepo = sessionRepo;
      }
    }

    writeJSON(settingsPath, settings);
    files.push('settings.json');
  }

  writeIfMissing(
    path.join(configDir, '.gitignore'),
    '# Sessionlog local files (not committed)\nsettings.local.json\ntmp/\nlogs/\n',
    files,
  );

  return { packageName: 'sessionlog', success: true, configDir, filesCreated: files };
}

function scaffoldClaudeSwarmProject(
  configDir: string,
  _projectRoot: string,
  opts: ScaffoldOptions,
): ScaffoldResult {
  fs.mkdirSync(configDir, { recursive: true });
  const files: string[] = [];

  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    const config: Record<string, unknown> = {
      template: '',
      map: { enabled: false, server: 'ws://localhost:8080', scope: '', systemId: 'system-claude-swarm', sidecar: 'session' },
      sessionlog: { enabled: false, sync: 'off' },
    };
    if (opts.overrides) applyOverrides(config, opts.overrides);
    writeJSON(configPath, config);
    files.push('config.json');
  }

  writeIfMissing(path.join(configDir, '.gitignore'), 'tmp/\n', files);

  return { packageName: 'claude-code-swarm', success: true, configDir, filesCreated: files };
}

// ─── Per-package scaffolders (global) ───────────────────────

type GlobalScaffolder = (configDir: string, opts: ScaffoldOptions) => ScaffoldResult;

const GLOBAL_SCAFFOLDERS: Record<string, GlobalScaffolder> = {
  'skill-tree': scaffoldSkillTreeGlobal,
  'claude-code-swarm': scaffoldClaudeSwarmGlobal,
};

function scaffoldSkillTreeGlobal(configDir: string, _opts: ScaffoldOptions): ScaffoldResult {
  fs.mkdirSync(configDir, { recursive: true });
  const files: string[] = [];
  const configPath = path.join(configDir, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, yaml.dump({
      storage: { type: 'sqlite', path: path.join(configDir, 'skills.db') },
      cli: { output_format: 'table', color: true },
    }, { indent: 2 }), 'utf-8');
    files.push('config.yaml');
  }
  return { packageName: 'skill-tree', success: true, configDir, filesCreated: files };
}

function scaffoldClaudeSwarmGlobal(configDir: string, opts: ScaffoldOptions): ScaffoldResult {
  fs.mkdirSync(configDir, { recursive: true });
  const files: string[] = [];
  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    const config: Record<string, unknown> = {
      map: { server: '', sidecar: 'session' },
      sessionlog: { enabled: false, sync: 'off' },
    };
    if (opts.overrides) applyOverrides(config, opts.overrides);
    writeJSON(configPath, config, 0o600);
    files.push('config.json');
  }
  return { packageName: 'claude-code-swarm', success: true, configDir, filesCreated: files };
}

// ─── Helpers ────────────────────────────────────────────────

function writeJSON(filePath: string, data: Record<string, unknown>, mode?: number): void {
  const opts: fs.WriteFileOptions = { encoding: 'utf-8' };
  if (mode) (opts as { mode: number }).mode = mode;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', opts);
}

function writeIfMissing(filePath: string, content: string, files: string[]): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
    files.push(path.basename(filePath));
  }
}

function applyOverrides(config: Record<string, unknown>, overrides: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(overrides)) {
    const parts = key.split('.');
    let target = config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof target[parts[i]] !== 'object' || target[parts[i]] === null) target[parts[i]] = {};
      target = target[parts[i]] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }
}

function detectProjectName(projectRoot: string): string {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (typeof pkg.name === 'string' && pkg.name) return pkg.name;
    }
  } catch { /* fall through */ }
  return path.basename(projectRoot) || 'project';
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomUUID(): string {
  return crypto.randomUUID();
}
