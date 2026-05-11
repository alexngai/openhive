/**
 * Layer 4 — SwarmManager loadout-aware spawn tests.
 *
 * Verifies that when `spawn()` is called with an openteams `loadout_bundle_id`,
 * the materialized MCP scope + prompt addendum reach the spawned swarm's
 * `BootstrapToken`. The token is base64-encoded JSON inside
 * `hosted.config.bootstrap_token` — decoding it gives us the same envelope
 * the openswarm sidecar would consume.
 *
 * Backwards compat: spawns without openteams fields produce a token with
 * `openteams === undefined`.
 *
 * Modeled on `manager.test.ts` — real SwarmManager, sleep-server.js stub
 * so the spawn doesn't need a real OpenSwarm runtime.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as path from 'path';
import {
  bundleLoadout,
  resolveStandaloneLoadout,
} from 'openteams';
import type { LoadoutDefinition, MAPResource } from 'openteams';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { SwarmManager } from '../../swarm/manager.js';
import type { BootstrapToken, SwarmHostingConfig } from '../../swarm/types.js';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
} from '../../openteams/map-handlers.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('swarm-manager-loadout-spawn');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'swarm-manager-loadout-spawn.db');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'swarm-manager-loadout-spawn-data');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SLEEP_SCRIPT = path.join(FIXTURES_DIR, 'sleep-server.js');

const LOADOUT_DEF: LoadoutDefinition = {
  name: 'spawn-test-lo',
  capabilities: ['file.read'],
  mcp_servers: [
    { name: 'opentasks', command: 'node', args: ['./mcp/opentasks.js'] },
  ],
  prompt_addendum: 'WORK CAREFULLY',
};

function createTestConfig(): SwarmHostingConfig {
  return {
    enabled: true,
    default_provider: 'local',
    openswarm_command: `node ${SLEEP_SCRIPT}`,
    data_dir: TEST_DATA_DIR,
    port_range: [19200, 19220],
    max_swarms: 10,
    health_check_interval: 60000,
    max_health_failures: 3,
    auto_restart: false,
    max_restart_attempts: 3,
  };
}

function decodeBootstrapToken(tokenB64: string): BootstrapToken {
  return JSON.parse(Buffer.from(tokenB64, 'base64').toString('utf-8')) as BootstrapToken;
}

describe('SwarmManager — loadout-aware spawn', () => {
  let agentId: string;
  let manager: SwarmManager;
  const spawned: string[] = [];

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);
    const { agent } = await agentsDAL.createAgent({
      name: 'loadout-spawn-agent',
      description: 'Layer 4 spawn tests',
    });
    agentId = agent.id;
    manager = new SwarmManager(createTestConfig(), 'http://localhost:3000');
  });

  afterAll(async () => {
    for (const id of spawned) {
      try {
        await manager.stop(id, agentId);
      } catch {
        /* best effort */
      }
    }
    await manager.shutdown();
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  afterEach(() => {
    _resetOpenteamsMapHandlers();
  });

  it('backwards compat: spawn without openteams fields produces a token with openteams === undefined', async () => {
    const hosted = await manager.spawn(agentId, { name: 'compat' });
    spawned.push(hosted.id);
    const token = decodeBootstrapToken(hosted.config!.bootstrap_token);
    expect(token.openteams).toBeUndefined();
  });

  it('forwards loadout binding ids to the bootstrap token even when materialization fails', async () => {
    // Don't seed the store — materializer will throw, manager logs + proceeds
    // with binding ids preserved but mcp_servers / prompt_addendum absent.
    const hosted = await manager.spawn(agentId, {
      name: 'bind-only',
      loadout_bundle_id: 'sha256:not-published',
      team_bundle_id: 'sha256:teamhash',
      role: 'executor',
    });
    spawned.push(hosted.id);

    const token = decodeBootstrapToken(hosted.config!.bootstrap_token);
    expect(token.openteams).toBeDefined();
    expect(token.openteams!.loadout_bundle_id).toBe('sha256:not-published');
    expect(token.openteams!.team_bundle_id).toBe('sha256:teamhash');
    expect(token.openteams!.role).toBe('executor');
    expect(token.openteams!.mcp_servers).toBeUndefined();
    expect(token.openteams!.prompt_addendum).toBeUndefined();
  });

  it('materializes the bundle and forwards mcp_servers + prompt_addendum', async () => {
    const bundle = bundleLoadout(resolveStandaloneLoadout(LOADOUT_DEF), {
      version: '0.0.0',
      name: 'spawn-test-lo',
    });
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

    const hosted = await manager.spawn(agentId, {
      name: 'with-loadout',
      loadout_bundle_id: bundle.id,
      role: 'executor',
    });
    spawned.push(hosted.id);

    const token = decodeBootstrapToken(hosted.config!.bootstrap_token);
    expect(token.openteams).toBeDefined();
    expect(token.openteams!.loadout_bundle_id).toBe(bundle.id);
    expect(token.openteams!.role).toBe('executor');
    expect(token.openteams!.mcp_servers).toEqual([
      { name: 'opentasks', command: 'node', args: ['./mcp/opentasks.js'] },
    ]);
    expect(token.openteams!.prompt_addendum).toBe('WORK CAREFULLY');
  });

  it('team_bundle_id alone (without loadout) still flows as advisory metadata', async () => {
    const hosted = await manager.spawn(agentId, {
      name: 'team-only',
      team_bundle_id: 'sha256:teamhash',
      role: 'planner',
    });
    spawned.push(hosted.id);

    const token = decodeBootstrapToken(hosted.config!.bootstrap_token);
    expect(token.openteams).toBeDefined();
    expect(token.openteams!.team_bundle_id).toBe('sha256:teamhash');
    expect(token.openteams!.role).toBe('planner');
    expect(token.openteams!.loadout_bundle_id).toBeUndefined();
    expect(token.openteams!.mcp_servers).toBeUndefined();
  });
});
