/**
 * Unit tests for the map/agents/spawn handler (PR 3 of the v4 rollout).
 *
 * Verifies:
 *   - Scope check (map:agents:spawn) gates the handler
 *   - Parent param must match the calling session's agent id
 *   - Child agent row is created in the DB
 *   - Delegated credentials are minted and returned
 *   - Failed delegation rolls back the child row (no orphans)
 *   - Param validation rejects malformed input
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  initTokenService,
  _resetTokenService,
  verifyToken,
} from '../../map/token-service.js';
import { handleSpawnRequest } from '../../map/spawn-handler.js';
import type { MapInboundConnection } from '../../map/connection-registry.js';
import { registerInbound, unregisterInbound } from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('spawn-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'spawn-handler.db');

/**
 * Build a fake MapInboundConnection with the given session scopes.
 * Enough shape for the registry + scope resolution to work.
 */
function mockConnection(
  swarmId: string,
  agentId: string,
  scopes: string[],
  opts?: { tokenDelegatable?: boolean; tokenSerialized?: string },
): MapInboundConnection {
  return {
    // Minimal WebSocket stub — not exercised by spawn
    ws: { readyState: 1 } as unknown as MapInboundConnection['ws'],
    agentId,
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    sessionScopes: scopes,
    tokenDelegatable: opts?.tokenDelegatable,
    tokenSerialized: opts?.tokenSerialized,
    registeredAgents: new Map(),
  };
}

describe('handleSpawnRequest', () => {
  let parentAgentId: string;
  const SWARM_ID = 'swarm-spawn-test';

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    initTokenService(undefined, TEST_ROOT);

    const parent = await agentsDAL.createAgent({
      name: 'spawn-parent',
      description: 'parent for spawn tests',
    });
    parentAgentId = parent.agent.id;
  });

  afterAll(() => {
    _resetTokenService();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    // Clean up any lingering spawn-created children between tests
    unregisterInbound(SWARM_ID);
    getDatabase()
      .prepare("DELETE FROM agents WHERE name LIKE 'spawn-child-%' OR name LIKE 'spawn-test-%'")
      .run();
  });

  // ──────────────────────────────────────────────────────────────
  // Happy path
  // ──────────────────────────────────────────────────────────────

  it('spawns a child agent with delegated credentials', async () => {
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, ['map:*']));

    const result = await handleSpawnRequest(
      {
        parent: parentAgentId,
        name: 'spawn-child-1',
        role: 'worker',
        requestedScopes: ['map:tasks:create'],
      },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );

    // Response shape
    expect(result.agent.id).toBeTruthy();
    expect(result.agent.name).toBe('spawn-child-1');
    expect(result.agent.role).toBe('worker');
    expect(result.agent.visibility).toBe('public');
    expect(result.agent.metadata?.parentId).toBe(parentAgentId);

    // Delegated credentials
    expect(result.delegatedCredentials.method).toBe('bearer');
    expect(result.delegatedCredentials.credentials.token).toBeTruthy();
    expect(result.delegatedCredentials.env.AGENT_TOKEN).toBe(
      result.delegatedCredentials.credentials.token,
    );
    expect(result.delegatedCredentials.env.MAP_CREDENTIAL).toBe(
      result.delegatedCredentials.credentials.token,
    );

    // Token verifies and carries the narrow scope
    const verified = verifyToken(result.delegatedCredentials.credentials.token);
    expect(verified.valid).toBe(true);
    expect(verified.token?.agentId).toBe(result.agent.id);
    expect(verified.token?.scopes).toEqual(['map:tasks:create']);

    // DB row exists for the child
    const childRow = agentsDAL.findAgentById(result.agent.id);
    expect(childRow).toBeTruthy();
    expect(childRow?.name).toBe('spawn-child-1');
    expect(childRow?.metadata?.spawned_by).toBe(parentAgentId);
  });

  it('defaults requestedScopes to parent scopes when empty', async () => {
    const parentScopeSet = ['map:agents:spawn', 'map:tasks:create', 'map:tasks:list'];
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, parentScopeSet));

    const result = await handleSpawnRequest(
      { parent: parentAgentId, name: 'spawn-child-default', requestedScopes: [] },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );

    // Empty requestedScopes → child inherits the full parent scope set,
    // including map:agents:spawn (child could then delegate further).
    const verified = verifyToken(result.delegatedCredentials.credentials.token);
    expect(verified.token?.scopes).toEqual(parentScopeSet);
  });

  // ──────────────────────────────────────────────────────────────
  // Scope enforcement
  // ──────────────────────────────────────────────────────────────

  it('rejects when session lacks map:agents:spawn', async () => {
    registerInbound(
      SWARM_ID,
      mockConnection(SWARM_ID, parentAgentId, ['map:tasks:create']), // no spawn
    );

    try {
      await handleSpawnRequest(
        { parent: parentAgentId, name: 'spawn-child-denied', requestedScopes: [] },
        { swarmId: SWARM_ID, hubAgentId: parentAgentId },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error & { code: number }).code).toBe(-32403);
      expect((err as Error).message).toMatch(/map:agents:spawn/);
    }
  });

  it('rejects when requestedScopes exceeds parent scopes', async () => {
    registerInbound(
      SWARM_ID,
      // Has spawn but not wildcard — can only delegate narrowly
      mockConnection(SWARM_ID, parentAgentId, ['map:agents:spawn', 'map:tasks:create']),
    );

    try {
      await handleSpawnRequest(
        {
          parent: parentAgentId,
          name: 'spawn-child-overreach',
          requestedScopes: ['map:admin:everything'],
        },
        { swarmId: SWARM_ID, hubAgentId: parentAgentId },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error & { code: number }).code).toBe(-32403);
    }
  });

  it('rolls back child agent row when delegation fails', async () => {
    registerInbound(
      SWARM_ID,
      mockConnection(SWARM_ID, parentAgentId, ['map:agents:spawn']),
    );

    const preCount = agentsDAL.countAgents();
    try {
      await handleSpawnRequest(
        {
          parent: parentAgentId,
          name: 'spawn-test-rollback',
          requestedScopes: ['scope:not:in:parent'],
        },
        { swarmId: SWARM_ID, hubAgentId: parentAgentId },
      );
      expect.fail('should have thrown');
    } catch {
      /* expected */
    }
    const postCount = agentsDAL.countAgents();
    expect(postCount).toBe(preCount); // child row was rolled back
  });

  // ──────────────────────────────────────────────────────────────
  // Param validation
  // ──────────────────────────────────────────────────────────────

  it('rejects malformed params with -32602', async () => {
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, ['map:*']));

    try {
      await handleSpawnRequest(
        { parent: parentAgentId /* missing name */ },
        { swarmId: SWARM_ID, hubAgentId: parentAgentId },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error & { code: number }).code).toBe(-32602);
    }
  });

  it('rejects when session does not exist (no inbound connection)', async () => {
    // No registerInbound call — session scopes are undefined → deny
    try {
      await handleSpawnRequest(
        { parent: parentAgentId, name: 'spawn-child-nosession', requestedScopes: [] },
        { swarmId: 'nonexistent-swarm', hubAgentId: parentAgentId },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error & { code: number }).code).toBe(-32403);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Delegatable flag enforcement (C2 of v4 review)
  // ──────────────────────────────────────────────────────────────

  it('rejects spawn when the caller token is non-delegatable', async () => {
    // Session auth'd via a delegated child token → tokenDelegatable=false.
    // Even with map:agents:spawn in session scopes, spawn must fail.
    registerInbound(
      SWARM_ID,
      mockConnection(SWARM_ID, parentAgentId, ['map:*'], {
        tokenDelegatable: false,
      }),
    );

    try {
      await handleSpawnRequest(
        { parent: parentAgentId, name: 'spawn-child-nondelegatable', requestedScopes: [] },
        { swarmId: SWARM_ID, hubAgentId: parentAgentId },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/not delegatable/i);
      expect((err as Error & { code: number }).code).toBe(-32403);
    }
  });

  it('allows spawn when the caller token is explicitly delegatable', async () => {
    registerInbound(
      SWARM_ID,
      mockConnection(SWARM_ID, parentAgentId, ['map:*'], {
        tokenDelegatable: true,
      }),
    );

    const result = await handleSpawnRequest(
      { parent: parentAgentId, name: 'spawn-child-delegatable', requestedScopes: [] },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );
    expect(result.agent.id).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────
  // Parent validation (M1 of v4 review)
  // ──────────────────────────────────────────────────────────────

  it('accepts params.parent === hubAgentId without prior map/agents/register', async () => {
    // Operator-bootstrap path: onboarded swarm spawns a helper before
    // registering itself via map/agents/register. The hub agent id is
    // always a valid parent.
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, ['map:*']));

    const result = await handleSpawnRequest(
      { parent: parentAgentId, name: 'spawn-child-prereg', requestedScopes: [] },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );
    expect(result.agent.id).toBeTruthy();
  });

  it('accepts params.parent that matches a session-registered agent', async () => {
    const conn = mockConnection(SWARM_ID, parentAgentId, ['map:*']);
    const registeredAgentId = 'map-agent-xyz';
    conn.registeredAgents.set(registeredAgentId, {
      id: registeredAgentId,
      name: 'registered-coordinator',
      role: 'coordinator',
      state: 'ready',
      scopes: [],
      capabilities: {},
    });
    registerInbound(SWARM_ID, conn);

    const result = await handleSpawnRequest(
      { parent: registeredAgentId, name: 'spawn-child-viaregistered', requestedScopes: [] },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );
    expect(result.agent.metadata?.parentId).toBe(registeredAgentId);
  });

  it('rejects params.parent pointing at an unknown agent (audit-log spoof)', async () => {
    registerInbound(SWARM_ID, mockConnection(SWARM_ID, parentAgentId, ['map:*']));

    try {
      await handleSpawnRequest(
        { parent: 'some-agent-not-on-this-session', name: 'spawn-test-spoof', requestedScopes: [] },
        { swarmId: SWARM_ID, hubAgentId: parentAgentId },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/not registered on this session/);
      expect((err as Error & { code: number }).code).toBe(-32602);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Parent chain + cascade revocation (C3 of v4 review)
  // ──────────────────────────────────────────────────────────────

  it('stamps parentId on the child token when a parent token is threaded through', async () => {
    const { getTokenService } = await import('../../map/token-service.js');
    const ts = getTokenService();
    const parentToken = ts.createRootToken({
      agentId: parentAgentId,
      scopes: ['map:*'],
      ttlDays: 1,
      delegatable: true,
    });
    const serializedParent = ts.serialize(parentToken);

    registerInbound(
      SWARM_ID,
      mockConnection(SWARM_ID, parentAgentId, ['map:*'], {
        tokenDelegatable: true,
        tokenSerialized: serializedParent,
      }),
    );

    const result = await handleSpawnRequest(
      { parent: parentAgentId, name: 'spawn-child-chained', requestedScopes: ['map:agents:spawn'] },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );

    const verified = verifyToken(result.delegatedCredentials.credentials.token);
    expect(verified.valid).toBe(true);
    expect(verified.token?.parentId).toBe(parentAgentId);
    expect(verified.token?.currentDepth).toBeGreaterThan(0);
  });

  it('cascade-revokes descendants when an ancestor is revoked', async () => {
    const { getTokenService, revokeToken, unrevokeToken } = await import('../../map/token-service.js');
    const ts = getTokenService();

    // Mint the parent token
    const parentToken = ts.createRootToken({
      agentId: parentAgentId,
      scopes: ['map:*'],
      ttlDays: 1,
      delegatable: true,
    });
    const serializedParent = ts.serialize(parentToken);

    // Session auth'd with that parent token delegates a child
    registerInbound(
      SWARM_ID,
      mockConnection(SWARM_ID, parentAgentId, ['map:*'], {
        tokenDelegatable: true,
        tokenSerialized: serializedParent,
      }),
    );
    const result = await handleSpawnRequest(
      { parent: parentAgentId, name: 'spawn-child-cascade', requestedScopes: ['map:tasks:create'] },
      { swarmId: SWARM_ID, hubAgentId: parentAgentId },
    );
    const childTokenSerialized = result.delegatedCredentials.credentials.token;

    // Baseline: child verifies cleanly
    expect(verifyToken(childTokenSerialized).valid).toBe(true);

    // Revoke the parent — cascade should invalidate the child
    revokeToken(parentAgentId);
    const afterRevoke = verifyToken(childTokenSerialized);
    expect(afterRevoke.valid).toBe(false);
    expect(afterRevoke.error).toMatch(/revoked/i);

    // Cleanup for test isolation
    unrevokeToken(parentAgentId);
  });
});
