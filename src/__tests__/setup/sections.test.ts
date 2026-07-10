/**
 * Setup engine — sections, registry, doctor, and the in-process CLI
 * drivers (`openhive setup --yes` / `openhive doctor` equivalents).
 *
 * Sections must be pure over (config file, disk): status is derived, so
 * a fresh temp dir reads incomplete, apply makes it complete, and a
 * second apply is idempotent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { closeDatabase } from '../../db/index.js';
import { readConfigFile } from '../../config-persistence.js';
import { dataDirPaths, isInitialised } from '../../data-dir.js';
import {
  buildSetupContext,
  refreshContext,
  statusAll,
  runDoctor,
  getSection,
  SECTIONS,
} from '../../setup/registry.js';
import { coreSection } from '../../setup/sections/core.js';
import { gitStoreSection } from '../../setup/sections/git-store.js';
import { swarmHostingSection } from '../../setup/sections/swarm-hosting.js';
import { runSetupCommand, runDoctorCommand } from '../../cli/setup.js';
import { testRoot, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('setup-engine');
const DATA_DIR = path.join(TEST_ROOT, 'hub');
// Off the default 7836 so a locally running dev hub can't interfere
const TEST_PORT = 7911;

describe('setup engine', () => {
  beforeAll(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  });

  afterAll(() => {
    try {
      closeDatabase();
    } catch {
      /* not open */
    }
    cleanTestRoot(TEST_ROOT);
  });

  it('reads a fresh dir as incomplete', async () => {
    const ctx = await buildSetupContext(DATA_DIR);
    expect(ctx.configParseError).toBeNull();
    expect(ctx.hubRunning).toBe(false);

    const status = await coreSection.status(ctx);
    expect(status.state).toBe('incomplete');
    expect(status.issues.length).toBeGreaterThan(0);
  });

  it('core.apply initialises the hub and becomes complete', async () => {
    const ctx = await buildSetupContext(DATA_DIR);
    const result = await coreSection.apply(ctx, {
      name: 'SetupTest',
      port: TEST_PORT,
      trustModel: 'verified',
      authMode: 'local',
      hubMode: 'full',
    });
    expect(result.ok).toBe(true);
    expect(typeof result.outputs?.adminKey).toBe('string');

    const written = readConfigFile(dataDirPaths(DATA_DIR).config);
    expect(written.port).toBe(TEST_PORT);
    expect((written.instance as Record<string, unknown>).name).toBe('SetupTest');
    expect((written.mapHub as Record<string, unknown>).trustModel).toBe('verified');
    expect(isInitialised(DATA_DIR)).toBe(true);
    expect(fs.existsSync(dataDirPaths(DATA_DIR).database)).toBe(true);

    await refreshContext(ctx);
    const status = await coreSection.status(ctx);
    expect(status.state).toBe('complete');
  });

  it('core.apply is idempotent and preserves the admin key', async () => {
    const before = readConfigFile(dataDirPaths(DATA_DIR).config);
    const ctx = await buildSetupContext(DATA_DIR);
    const result = await coreSection.apply(ctx, { port: TEST_PORT });
    expect(result.ok).toBe(true);
    // Existing key wins — no regeneration on re-run
    expect(result.outputs?.adminKey).toBeUndefined();
    const after = readConfigFile(dataDirPaths(DATA_DIR).config);
    expect((after.admin as Record<string, unknown>).key).toBe(
      (before.admin as Record<string, unknown>).key,
    );
  });

  it('git-store.apply enables and initialises the store repo', async () => {
    const storePath = path.join(TEST_ROOT, 'store');
    const ctx = await buildSetupContext(DATA_DIR);
    const result = await gitStoreSection.apply(ctx, {
      enabled: true,
      path: storePath,
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(storePath, '.git'))).toBe(true);

    await refreshContext(ctx);
    const status = await gitStoreSection.status(ctx);
    expect(status.state).toBe('complete');
  });

  it('swarm-hosting.apply patches config', async () => {
    const ctx = await buildSetupContext(DATA_DIR);
    const result = await swarmHostingSection.apply(ctx, {
      enabled: true,
      runnerCommand: 'git --version', // resolvable binary for the status check
      defaultProvider: 'local',
      inheritEnv: true,
    });
    expect(result.ok).toBe(true);

    await refreshContext(ctx);
    const hosting = ctx.rawConfig.swarmHosting as Record<string, unknown>;
    expect(hosting.swarm_runner_command).toBe('git --version');
    expect((hosting.credentials as Record<string, unknown>).inherit_env).toBe(true);
    const status = await swarmHostingSection.status(ctx);
    expect(status.state).toBe('complete');
  });

  it('statusAll reports every registered section', async () => {
    const ctx = await buildSetupContext(DATA_DIR);
    const reports = await statusAll(ctx);
    expect(reports.map((r) => r.id)).toEqual(SECTIONS.map((s) => s.id));
    expect(reports.find((r) => r.id === 'services')?.status.state).toBe('optional');
  });

  it('doctor (cheap) has no failing checks on the configured hub', async () => {
    const ctx = await buildSetupContext(DATA_DIR);
    const checks = await runDoctor(ctx, { deep: false });
    const fails = checks.filter((c) => c.status === 'fail');
    expect(fails).toEqual([]);
    // Prereqs are present in the aggregate
    expect(checks.some((c) => c.section === 'prereqs' && c.name === 'git')).toBe(true);
    expect(checks.some((c) => c.section === 'hub' && c.name === 'port-available')).toBe(true);
  });

  it('agent-access apply mints a working onboard token', async () => {
    const section = getSection('agent-access')!;
    const ctx = await buildSetupContext(DATA_DIR);
    const result = await section.apply(ctx, {
      mintToken: true,
      agentName: 'setup-test-agent',
      scopes: 'map:agents:spawn',
      ttlHours: 1,
    });
    expect(result.ok).toBe(true);
    expect(typeof result.outputs?.token).toBe('string');
    expect((result.outputs?.token as string).length).toBeGreaterThan(10);
    expect(Array.isArray(result.outputs?.snippets)).toBe(true);
  });
});

describe('CLI drivers (in-process)', () => {
  const CLI_DIR = path.join(TEST_ROOT, 'cli-hub');

  afterAll(() => {
    try {
      closeDatabase();
    } catch {
      /* not open */
    }
    process.exitCode = 0;
  });

  it('runSetupCommand --yes configures a fresh hub end-to-end', async () => {
    fs.mkdirSync(CLI_DIR, { recursive: true });
    await runSetupCommand(undefined, {
      dataDir: CLI_DIR,
      yes: true,
      set: ['core.port=7912'],
      makePrompt: () => {
        throw new Error('must not prompt with --yes');
      },
    });

    const written = readConfigFile(dataDirPaths(CLI_DIR).config);
    expect(written.port).toBe(7912);
    expect(isInitialised(CLI_DIR)).toBe(true);
    // agent-access with defaults minted a token → an agent exists in the DB
    expect(fs.existsSync(dataDirPaths(CLI_DIR).database)).toBe(true);
  });

  it('runDoctorCommand exits clean on the configured hub', async () => {
    process.exitCode = 0;
    await runDoctorCommand({ dataDir: CLI_DIR, json: true });
    expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
  });

  it('git repo state in the CLI hub store matches enabled flag (disabled by default)', () => {
    // --yes leaves the git store disabled (its default); no repo created
    expect(fs.existsSync(path.join(CLI_DIR, 'hive-store', '.git'))).toBe(false);
    // sanity: git is available for the sections that do use it
    expect(() => execFileSync('git', ['--version'])).not.toThrow();
  });
});
