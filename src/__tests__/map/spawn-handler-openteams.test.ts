/**
 * Layer 4 — `map/agents/spawn` openteams binding tests.
 *
 * Verifies that the spawn handler records `loadout_bundle_id`,
 * `team_bundle_id`, and `role` on the spawned child agent's metadata
 * under the `openteams` key. This is the bookkeeping side of the spawn
 * flow — downstream dispatch/coordinator code reads from the child's
 * metadata to surface team context. The materialization side
 * (BootstrapToken's mcp_servers) is exercised by the SwarmManager
 * spawn tests; this file covers the in-existing-swarm path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  initTokenService,
  _resetTokenService,
} from '../../map/token-service.js';
import { handleSpawnRequest } from '../../map/spawn-handler.js';
import type { MapInboundConnection } from '../../map/connection-registry.js';
import { registerInbound, unregisterInbound } from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('spawn-handler-openteams');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'spawn-handler-openteams.db');

function mockConnection(
  swarmId: string,
  agentId: string,
  scopes: string[],
): MapInboundConnection {
  return {
    ws: { readyState: 1 } as unknown as MapInboundConnection['ws'],
    agentId,
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    sessionScopes: scopes,
    registeredAgents: new Map(),
  };
}

describe('handleSpawnRequest — openteams binding (Layer 4)', () => {
  let parentAgentId: string;
  const SWARM_ID = 'swarm-spawn-openteams-test';

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);
    const parent = await agentsDAL.createAgent({
      name: 'spawn-openteams-parent',
      description: 'parent for openteams-binding spawn tests',
    });
    parentAgentId = parent.agent.id;
  });

  afterAll(() => {
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    unregisterInbound(SWARM_ID);
    getDatabase()
      .prepare("DELETE FROM agents WHERE name LIKE 'spawn-ot-%'")
      .run();
  });

  it('omits the openteams key when no binding fields are supplied (backwards compat)', async () => {
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, ['map:*']));
    const result = await handleSpawnRequest(
      {
        parent: parentAgentId,
        name: 'spawn-ot-compat',
        requestedScopes: ['map:tasks:create'],
      },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );
    const child = agentsDAL.findAgentById(result.agent.id);
    expect(child?.metadata?.openteams).toBeUndefined();
  });

  it('records loadout_bundle_id under metadata.openteams.loadout', async () => {
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, ['map:*']));
    const result = await handleSpawnRequest(
      {
        parent: parentAgentId,
        name: 'spawn-ot-loadout',
        requestedScopes: ['map:tasks:create'],
        loadout_bundle_id: 'sha256:abc123',
      },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );
    const child = agentsDAL.findAgentById(result.agent.id);
    const openteams = child?.metadata?.openteams as Record<string, unknown> | undefined;
    expect(openteams).toBeDefined();
    expect(openteams!.loadout).toBe('sha256:abc123');
    expect(openteams!.team).toBeUndefined();
    expect(openteams!.role).toBeUndefined();
  });

  it('records team_bundle_id + role alongside loadout', async () => {
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, ['map:*']));
    const result = await handleSpawnRequest(
      {
        parent: parentAgentId,
        name: 'spawn-ot-full',
        requestedScopes: ['map:tasks:create'],
        loadout_bundle_id: 'sha256:def456',
        team_bundle_id: 'sha256:9f3a',
        role: 'executor',
      },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );
    const child = agentsDAL.findAgentById(result.agent.id);
    const openteams = child?.metadata?.openteams as Record<string, unknown> | undefined;
    expect(openteams).toEqual({
      loadout: 'sha256:def456',
      team: 'sha256:9f3a',
      role: 'executor',
    });
  });

  it('role + team alone (without loadout) still records on metadata', async () => {
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, ['map:*']));
    const result = await handleSpawnRequest(
      {
        parent: parentAgentId,
        name: 'spawn-ot-team-only',
        requestedScopes: ['map:tasks:create'],
        team_bundle_id: 'sha256:teamonly',
        role: 'planner',
      },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );
    const child = agentsDAL.findAgentById(result.agent.id);
    const openteams = child?.metadata?.openteams as Record<string, unknown> | undefined;
    expect(openteams).toEqual({
      team: 'sha256:teamonly',
      role: 'planner',
    });
  });

  it('preserves caller-supplied metadata alongside the openteams binding', async () => {
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, ['map:*']));
    const result = await handleSpawnRequest(
      {
        parent: parentAgentId,
        name: 'spawn-ot-merge',
        requestedScopes: ['map:tasks:create'],
        metadata: { customField: 'preserved' },
        loadout_bundle_id: 'sha256:keep-meta',
      },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );
    const child = agentsDAL.findAgentById(result.agent.id);
    expect(child?.metadata?.customField).toBe('preserved');
    expect(child?.metadata?.spawned_by).toBe(parentAgentId);
    expect((child?.metadata?.openteams as Record<string, unknown>).loadout).toBe('sha256:keep-meta');
  });
});
