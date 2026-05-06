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
