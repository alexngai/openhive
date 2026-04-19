/**
 * Integration test for the swarm-lifecycle fan-out contract.
 *
 * Exercises the production code path: REST/RPC handler → service layer
 * → `broadcastSwarmLifecycleEvent` → `broadcastToChannel` × 2.
 *
 * The unit-level helper test in `swarm-events.test.ts` only proves the
 * helper itself fans out correctly. This test proves that callers
 * actually use the helper (and not a leftover direct `broadcastToChannel`
 * call that misses one of the two channels).
 *
 * If a future refactor accidentally reverts a call site back to a direct
 * `broadcastToChannel('map:discovery', …)` without the per-swarm partner
 * (the original bug class), one of these assertions fails immediately.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel — the helper's only exit point. We assert
// against this to verify both channels were hit by the helper.
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';
import { registerSwarm, registerNode } from '../../map/service.js';

const TEST_ROOT = testRoot('swarm-lifecycle-fanout');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'swarm-lifecycle-fanout.db');

const mockedBroadcast = vi.mocked(broadcastToChannel);

interface FanoutCheck {
  type: string;
  swarmId: string;
}

/** Asserts the same event was sent to both `map:discovery` and `map:swarm:${id}`. */
function expectFanout({ type, swarmId }: FanoutCheck): void {
  const matching = mockedBroadcast.mock.calls.filter(
    ([, ev]) => (ev as { type: string }).type === type,
  );
  expect(
    matching.length,
    `expected at least 2 broadcasts of type ${type}, got ${matching.length}`,
  ).toBeGreaterThanOrEqual(2);
  const channels = matching.map(c => c[0]);
  expect(channels).toContain('map:discovery');
  expect(channels).toContain(`map:swarm:${swarmId}`);
}

describe('Swarm lifecycle WS fan-out (integration)', () => {
  let ownerId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const owner = await agentsDAL.createAgent({ name: 'fanout-owner' });
    ownerId = owner.agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    mockedBroadcast.mockClear();
  });

  it('registerSwarm fans out swarm_registered to fleet + per-swarm channels', () => {
    const result = registerSwarm(ownerId, {
      name: 'fanout-test-A',
      description: 'integration: registerSwarm fan-out',
      map_endpoint: 'https://fanout.test/A/map',
    });
    const swarmId = result.swarm.id;

    expectFanout({ type: 'swarm_registered', swarmId });
  });

  it('registerNode fans out node_registered to fleet + per-swarm channels', () => {
    // Set up a swarm to register a node into (clear the broadcast log
    // before the act so swarm_registered's fan-out doesn't pollute the
    // assertion).
    const swarm = registerSwarm(ownerId, {
      name: 'fanout-test-B',
      description: 'integration: registerNode fan-out',
      map_endpoint: 'https://fanout.test/B/map',
    });
    mockedBroadcast.mockClear();

    registerNode(ownerId, {
      swarm_id: swarm.swarm.id,
      map_agent_id: 'agent-fanout-1',
      role: 'coordinator',
    });

    expectFanout({ type: 'node_registered', swarmId: swarm.swarm.id });
  });

  it('every swarm-lifecycle broadcast targeting map:discovery has a matching per-swarm broadcast', () => {
    // Stronger structural guard: across all calls produced by a typical
    // workflow, every map:discovery broadcast should have a sibling
    // `map:swarm:${id}` broadcast for the SAME event type with the
    // SAME data. A bare `broadcastToChannel('map:discovery', …)` for a
    // swarm-lifecycle event (the original bug pattern) leaves the per-
    // swarm sibling missing, which this test would catch.
    const swarm = registerSwarm(ownerId, {
      name: 'fanout-test-C',
      description: 'integration: structural fan-out symmetry',
      map_endpoint: 'https://fanout.test/C/map',
    });
    registerNode(ownerId, {
      swarm_id: swarm.swarm.id,
      map_agent_id: 'agent-fanout-c1',
      role: 'coordinator',
    });

    const swarmId = swarm.swarm.id;
    const discoveryEvents = mockedBroadcast.mock.calls.filter(
      ([ch]) => ch === 'map:discovery',
    );
    const perSwarmEvents = mockedBroadcast.mock.calls.filter(
      ([ch]) => ch === `map:swarm:${swarmId}`,
    );

    // For every fleet broadcast there should be a corresponding per-swarm
    // broadcast of the same type. (Not asserting equality because some
    // events on map:discovery — e.g. count-only stale-sweep notices —
    // may legitimately be fleet-only; but for events tied to a specific
    // swarm, both channels should fire.)
    const fleetTypes = discoveryEvents.map(c => (c[1] as { type: string }).type);
    const perSwarmTypes = perSwarmEvents.map(c => (c[1] as { type: string }).type);
    for (const t of fleetTypes) {
      expect(
        perSwarmTypes,
        `event type "${t}" was broadcast on map:discovery but missing on map:swarm:${swarmId} — likely a direct broadcastToChannel call that bypassed broadcastSwarmLifecycleEvent`,
      ).toContain(t);
    }
  });
});
