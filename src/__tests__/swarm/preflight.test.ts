/**
 * SwarmManager.preflight() — side-effect-free spawn readiness probe.
 *
 * Binary resolvers are mocked so results don't depend on what's installed
 * on the machine running the suite. The manager is constructed with a
 * non-default swarm_runner_command (like every other test) so the
 * swarm-runner check reports the resolved command.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';

let mockClaudeBinary: string | null = '/usr/local/bin/claude';
let mockCodexBinary: string | null = '/opt/homebrew/bin/codex';

vi.mock('../../swarm/claude-binary.js', () => ({
  resolveClaudeBinary: () => mockClaudeBinary,
}));
vi.mock('../../swarm/codex-binary.js', () => ({
  resolveCodexBinary: () => mockCodexBinary,
}));

import { SwarmManager } from '../../swarm/manager.js';

const TEST_ROOT = testRoot('swarm-preflight');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'swarm-preflight.db');

function createTestConfig(overrides: Partial<SwarmHostingConfig> = {}): SwarmHostingConfig {
  return {
    enabled: true,
    default_provider: 'local',
    swarm_runner_command: 'node ./fixtures/sleep-server.js',
    data_dir: path.join(TEST_ROOT, 'data'),
    port_range: [19300, 19310],
    max_swarms: 10,
    health_check_interval: 60000,
    max_health_failures: 3,
    auto_restart: false,
    max_restart_attempts: 3,
    ...overrides,
  };
}

describe('SwarmManager.preflight', () => {
  let manager: SwarmManager;

  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
    manager = new SwarmManager(createTestConfig(), 'http://localhost:3000');
  });

  afterAll(async () => {
    await manager.shutdown();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('swarm-runner: ready with a resolved command, provider, and capacity', () => {
    const result = manager.preflight('swarm-runner');
    expect(result.ready).toBe(true);
    expect(result.kind).toBe('swarm-runner');

    const cmd = result.checks.find((c) => c.id === 'swarm-runner-command')!;
    expect(cmd.ok).toBe(true);
    expect(cmd.message).toContain('sleep-server.js');

    expect(result.checks.find((c) => c.id === 'provider')!.ok).toBe(true);
    const capacity = result.checks.find((c) => c.id === 'capacity')!;
    expect(capacity.ok).toBe(true);
    expect(capacity.message).toContain('/10');
  });

  it('codex rpc: not ready without a CodexAppServerManager, even with the binary', () => {
    mockCodexBinary = '/opt/homebrew/bin/codex';
    const result = manager.preflight('codex', 'rpc');
    expect(result.mode).toBe('rpc');

    expect(result.checks.find((c) => c.id === 'codex-binary')!.ok).toBe(true);
    const appServer = result.checks.find((c) => c.id === 'codex-app-server')!;
    expect(appServer.ok).toBe(false);
    expect(result.ready).toBe(false);
  });

  it('codex: missing binary fails with an actionable message', () => {
    mockCodexBinary = null;
    const result = manager.preflight('codex', 'rpc');
    const binary = result.checks.find((c) => c.id === 'codex-binary')!;
    expect(binary.ok).toBe(false);
    expect(binary.message).toContain('Install Codex');
    expect(result.ready).toBe(false);
    mockCodexBinary = '/opt/homebrew/bin/codex';
  });

  it('codex defaults to rpc mode; tui mode checks the PTY manager instead', () => {
    expect(manager.preflight('codex').mode).toBe('rpc');

    const tui = manager.preflight('codex', 'tui');
    expect(tui.mode).toBe('tui');
    expect(tui.checks.some((c) => c.id === 'pty-manager')).toBe(true);
    expect(tui.checks.some((c) => c.id === 'codex-app-server')).toBe(false);
  });

  it('claude-code: normalizes to tui and requires claude binary + PTY manager', () => {
    mockClaudeBinary = null;
    const result = manager.preflight('claude-code');
    expect(result.mode).toBe('tui');

    const binary = result.checks.find((c) => c.id === 'claude-binary')!;
    expect(binary.ok).toBe(false);
    expect(binary.message).toContain('Install Claude Code');
    // No PtyManager injected in this test setup either.
    expect(result.checks.find((c) => c.id === 'pty-manager')!.ok).toBe(false);
    expect(result.ready).toBe(false);
    mockClaudeBinary = '/usr/local/bin/claude';
  });

  it('credentials check is informational and never leaks values', () => {
    const withCreds = new SwarmManager(
      createTestConfig({
        credentials: {
          default_set: 'main',
          sets: { main: { vars: { SECRET_API_KEY: 'super-secret-value' } } },
          inherit_env: false,
        },
      }),
      'http://localhost:3000',
    );
    const result = withCreds.preflight('swarm-runner');
    const creds = result.checks.find((c) => c.id === 'credentials')!;
    expect(creds.ok).toBe(true);
    expect(creds.message).toContain('SECRET_API_KEY');
    expect(creds.message).toContain('env inheritance off');
    expect(creds.message).not.toContain('super-secret-value');
  });
});
