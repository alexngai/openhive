/**
 * Tests for the kind=claude-code spawn pipeline.
 *
 * Scope: unit-level coverage of the helpers + the no-binary error path.
 * The happy path (cc-swarm sidecar registers → row flips to running) is
 * verified live, not in unit tests — it requires a real Claude Code
 * subprocess and the cc-swarm plugin.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Mock the binary resolver BEFORE any module-under-test import. Tests can
// override the return value per-case via vi.mocked().mockReturnValue.
vi.mock('../../swarm/claude-binary.js', () => ({
  resolveClaudeBinary: vi.fn(() => null),
}));

import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { SwarmManager, SwarmHostingError } from '../../swarm/manager.js';
import { resolveClaudeBinary } from '../../swarm/claude-binary.js';
import {
  buildClaudeSwarmConfig,
  writeClaudeSwarmConfig,
} from '../../swarm/claude-code-config.js';
import { getTuiKindStrategy } from '../../swarm/tui-strategies.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('claude-code-spawn');
const TEST_DB = testDbPath(TEST_ROOT, 'claude-code-spawn.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

function makeConfig(): SwarmHostingConfig {
  return {
    enabled: true,
    default_provider: 'local',
    openswarm_command: 'node /tmp/unused.js',
    data_dir: TEST_DATA_DIR,
    port_range: [19200, 19210],
    max_swarms: 3,
    health_check_interval: 60000,
    max_health_failures: 3,
    auto_restart: false,
    max_restart_attempts: 3,
  };
}

describe('claude-code spawn helpers', () => {
  describe('buildClaudeSwarmConfig', () => {
    it('produces the expected shape with all required fields', () => {
      const cfg = buildClaudeSwarmConfig({
        mapServer: 'ws://127.0.0.1:7836/ws/map',
        scope: 'hswarm_abc',
        systemId: 'swarm_xyz',
        credential: 'test-token',
      });
      expect(cfg).toEqual({
        map: {
          server: 'ws://127.0.0.1:7836/ws/map',
          scope: 'hswarm_abc',
          systemId: 'swarm_xyz',
          // swarmId pin is required so cc-swarm appends `?swarm_id=...`
          // to the WS URL — open-mode openhive keys the inbound
          // connection by that query param.
          swarmId: 'swarm_xyz',
          // Only `auth.token` (no `auth.credential`): setting credential
          // would make cc-swarm SKIP the swarm_id query param.
          auth: { token: 'test-token' },
        },
        sessionlog: { enabled: true, sync: 'metrics' },
        opentasks: { enabled: false },
      });
    });

    it('honors sessionlog override', () => {
      const cfg = buildClaudeSwarmConfig({
        mapServer: 'ws://x/ws/map',
        scope: 's',
        systemId: 'i',
        credential: 'c',
        sessionlogEnabled: false,
        sessionlogSync: 'off',
      });
      expect(cfg.sessionlog).toEqual({ enabled: false, sync: 'off' });
    });
  });

  describe('writeClaudeSwarmConfig', () => {
    it('writes to <dataDir>/.swarm/claude-swarm/config.json with correct content', () => {
      const dataDir = path.join(TEST_DATA_DIR, 'write-config-test');
      const cfg = buildClaudeSwarmConfig({
        mapServer: 'ws://127.0.0.1:7836/ws/map',
        scope: 'hswarm_xyz',
        systemId: 'swarm_xyz',
        credential: 'cred-123',
      });
      const written = writeClaudeSwarmConfig(dataDir, cfg);
      expect(written).toBe(path.join(dataDir, '.swarm', 'claude-swarm', 'config.json'));
      expect(fs.existsSync(written)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(written, 'utf-8'));
      expect(parsed.map.server).toBe('ws://127.0.0.1:7836/ws/map');
      expect(parsed.map.auth.token).toBe('cred-123');
      // No credential field — see buildClaudeSwarmConfig comment for why.
      expect(parsed.map.auth.credential).toBeUndefined();
      expect(parsed.map.swarmId).toBe('swarm_xyz');
      // Cleanup just this subdir.
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it('creates the .swarm/claude-swarm directory if missing', () => {
      const dataDir = path.join(TEST_DATA_DIR, 'fresh-dir');
      // Don't create dataDir manually — writer should mkdir -p.
      const cfg = buildClaudeSwarmConfig({
        mapServer: 'ws://x/ws/map',
        scope: 's',
        systemId: 'i',
        credential: 'c',
      });
      writeClaudeSwarmConfig(dataDir, cfg);
      expect(fs.existsSync(path.join(dataDir, '.swarm', 'claude-swarm'))).toBe(true);
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
  });
});

describe('claude-code hook settings injection', () => {
  it('emits Stop / UserPromptSubmit / Notification hooks pointing at the openhive CLI', () => {
    const strategy = getTuiKindStrategy('claude-code', { signalSidecar: () => false });
    const settings = strategy?.buildHookSettings?.();
    expect(settings).toBeTruthy();
    expect(settings!.args[0]).toBe('--settings');
    const parsed = JSON.parse(settings!.args[1]);

    // Silences claude's OSC-9 channel so we're the only notification source.
    expect(parsed.preferredNotifChannel).toBe('notifications_disabled');

    // Each hook event maps to `openhive hook claude <event>` so the CLI
    // can forward to POST /api/v1/map/hosted/:id/hook/:event.
    const stopCmd = parsed.hooks.Stop[0].hooks[0].command;
    const promptCmd = parsed.hooks.UserPromptSubmit[0].hooks[0].command;
    const notifyCmd = parsed.hooks.Notification[0].hooks[0].command;
    expect(stopCmd).toBe('openhive hook claude stop');
    expect(promptCmd).toBe('openhive hook claude prompt-submit');
    expect(notifyCmd).toBe('openhive hook claude notification');
  });
});

describe('SwarmManager.spawn — kind=claude-code', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB);
    initTokenService(undefined, TEST_ROOT);
    const created = await agentsDAL.createAgent({
      name: 'claude-code-spawn-agent',
      description: 'agent for claude-code spawn tests',
    });
    agentId = created.agent.id;
  });

  afterAll(() => {
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('rejects with a clear error when the claude binary is not on PATH', async () => {
    // Default mock returns null (set in vi.mock factory above).
    vi.mocked(resolveClaudeBinary).mockReturnValue(null);

    const manager = new SwarmManager(makeConfig(), 'http://localhost:7836');
    try {
      await expect(
        manager.spawn(agentId, { kind: 'claude-code', name: 'no-binary' }),
      ).rejects.toMatchObject({
        code: 'SPAWN_FAILED',
        name: 'SwarmHostingError',
      });
      // Error message should mention the install hint, not just "failed."
      await manager
        .spawn(agentId, { kind: 'claude-code', name: 'no-binary-2' })
        .catch((err: SwarmHostingError) => {
          expect(err.message).toMatch(/claude/i);
          expect(err.message).toMatch(/PATH|install/i);
        });
    } finally {
      await manager.shutdown();
    }
  });

  describe('signalClaudeCodeSidecar', () => {
    it('returns false for non-claude-code rows', () => {
      const manager = new SwarmManager(makeConfig(), 'http://localhost:7836');
      try {
        const fakeOpenswarmRow = {
          id: 'h1',
          kind: 'openswarm' as const,
          config: { data_dir: '/tmp' } as any,
        } as any;
        expect(manager.signalClaudeCodeSidecar(fakeOpenswarmRow)).toBe(false);
      } finally {
        manager.shutdown();
      }
    });

    it('returns false when the pid file is missing (sidecar already exited)', () => {
      const manager = new SwarmManager(makeConfig(), 'http://localhost:7836');
      try {
        const dataDir = path.join(TEST_DATA_DIR, 'no-pid-file');
        const fakeRow = {
          id: 'h1',
          kind: 'claude-code' as const,
          config: { data_dir: dataDir } as any,
        } as any;
        expect(manager.signalClaudeCodeSidecar(fakeRow)).toBe(false);
      } finally {
        manager.shutdown();
      }
    });

    it('returns false when the pid file exists but the process is gone', () => {
      const manager = new SwarmManager(makeConfig(), 'http://localhost:7836');
      try {
        const dataDir = path.join(TEST_DATA_DIR, 'stale-pid');
        const pidDir = path.join(dataDir, '.swarm', 'claude-swarm', 'tmp', 'map');
        fs.mkdirSync(pidDir, { recursive: true });
        // Use a PID that's almost certainly not running (max + 1 wraps to 1 on
        // some kernels, but 999999 is unused on every dev box).
        fs.writeFileSync(path.join(pidDir, 'sidecar.pid'), '999999');
        const fakeRow = {
          id: 'h1',
          kind: 'claude-code' as const,
          config: { data_dir: dataDir } as any,
        } as any;
        expect(manager.signalClaudeCodeSidecar(fakeRow)).toBe(false);
      } finally {
        manager.shutdown();
      }
    });

    it('returns true when signalling our own pid (sanity that the path works)', () => {
      const manager = new SwarmManager(makeConfig(), 'http://localhost:7836');
      try {
        const dataDir = path.join(TEST_DATA_DIR, 'live-pid');
        const pidDir = path.join(dataDir, '.swarm', 'claude-swarm', 'tmp', 'map');
        fs.mkdirSync(pidDir, { recursive: true });
        fs.writeFileSync(path.join(pidDir, 'sidecar.pid'), String(process.pid));
        const fakeRow = {
          id: 'h1',
          kind: 'claude-code' as const,
          config: { data_dir: dataDir } as any,
        } as any;
        // Signal 0 is the no-op probe — process.kill(pid, 0) succeeds if
        // the process exists, throws ESRCH otherwise. Use it instead of
        // SIGTERM so we don't actually kill the test runner.
        expect(manager.signalClaudeCodeSidecar(fakeRow, 0)).toBe(true);
      } finally {
        manager.shutdown();
      }
    });
  });

  it('health monitor leaves claude-code rows alone (no openswarm-style probe)', async () => {
    // Insert a synthetic claude-code row at state=running and run the
    // private health-check loop directly. The loop should skip it (no
    // probe attempted) and leave the state untouched. Without the
    // kind=claude-code branch the loop would still skip BY ACCIDENT
    // because we don't populate hostedToInstanceId for claude-code, but
    // making the bypass explicit prevents future regressions if instance
    // tracking ever changes.
    const manager = new SwarmManager(makeConfig(), 'http://localhost:7836');
    try {
      const { createHostedSwarm, updateHostedSwarm, findHostedSwarmById } =
        await import('../../swarm/dal.js');
      const row = createHostedSwarm({
        id: 'h-cc-health',
        kind: 'claude-code',
        provider: 'local',
        spawned_by: agentId,
      });
      updateHostedSwarm(row.id, { state: 'running' });

      // Cast through unknown to call private method.
      await (manager as unknown as { runHealthChecks: () => Promise<void> }).runHealthChecks();

      const after = findHostedSwarmById(row.id);
      expect(after?.state).toBe('running');
      expect(after?.error).toBeNull();
    } finally {
      await manager.shutdown();
    }
  });

  it('rejects when max_swarms is reached, before touching the binary resolver', async () => {
    // Confirm the shared validation happens BEFORE binary resolution — a
    // missing binary on a server at max capacity should still report the
    // correct (cap-related) error.
    vi.mocked(resolveClaudeBinary).mockReturnValue(null);
    const manager = new SwarmManager(
      { ...makeConfig(), max_swarms: 0 },
      'http://localhost:7836',
    );
    try {
      await expect(
        manager.spawn(agentId, { kind: 'claude-code', name: 'cap-hit' }),
      ).rejects.toMatchObject({
        code: 'MAX_SWARMS_REACHED',
        name: 'SwarmHostingError',
      });
    } finally {
      await manager.shutdown();
    }
  });
});
