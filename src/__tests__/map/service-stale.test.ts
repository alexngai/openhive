/**
 * Tests for markStaleSwarms() from src/map/service.ts.
 *
 * Verifies that the periodic sweep correctly transitions stale swarms
 * to 'offline' while leaving recent and already-offline swarms untouched.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import { markStaleSwarms } from '../../map/service.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel — service.ts may import realtime for broadcasts
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('service-stale');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'service-stale.db');

// ============================================================================
// Helpers
// ============================================================================

/** Set last_seen_at to a specific number of minutes in the past via raw SQL. */
function setLastSeenMinutesAgo(swarmId: string, minutes: number): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE map_swarms SET last_seen_at = datetime('now', ?) WHERE id = ?`
  ).run(`-${minutes} minutes`, swarmId);
}

/** Read current status directly from the database. */
function getStatus(swarmId: string): string {
  const swarm = mapDAL.findSwarmById(swarmId);
  return swarm!.status;
}

// ============================================================================
// Tests
// ============================================================================

describe('markStaleSwarms', () => {
  let agentId: string;

  // IDs populated per-test via beforeEach
  let onlineStaleId: string;
  let unreachableStaleId: string;
  let onlineRecentId: string;
  let unreachableRecentId: string;
  let offlineId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'stale-test-agent',
      description: 'Agent for markStaleSwarms tests',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // Create a fresh set of swarms before each test so state doesn't leak.
  let counter = 0;
  beforeEach(() => {
    counter++;

    // Online swarm with stale last_seen_at (10 minutes ago, threshold default is 5)
    const onlineStale = mapDAL.createSwarm(agentId, {
      name: `online-stale-${counter}`,
      map_endpoint: `ws://localhost:${9000 + counter}/stale-online`,
      map_transport: 'websocket',
    });
    onlineStaleId = onlineStale.id;
    mapDAL.updateSwarm(onlineStaleId, { status: 'online' });
    setLastSeenMinutesAgo(onlineStaleId, 10);

    // Unreachable swarm with stale last_seen_at
    const unreachableStale = mapDAL.createSwarm(agentId, {
      name: `unreachable-stale-${counter}`,
      map_endpoint: `ws://localhost:${9000 + counter}/stale-unreachable`,
      map_transport: 'websocket',
    });
    unreachableStaleId = unreachableStale.id;
    mapDAL.updateSwarm(unreachableStaleId, { status: 'unreachable' });
    setLastSeenMinutesAgo(unreachableStaleId, 10);

    // Online swarm with recent last_seen_at (1 minute ago)
    const onlineRecent = mapDAL.createSwarm(agentId, {
      name: `online-recent-${counter}`,
      map_endpoint: `ws://localhost:${9000 + counter}/recent-online`,
      map_transport: 'websocket',
    });
    onlineRecentId = onlineRecent.id;
    mapDAL.updateSwarm(onlineRecentId, { status: 'online' });
    setLastSeenMinutesAgo(onlineRecentId, 1);

    // Unreachable swarm with recent last_seen_at
    const unreachableRecent = mapDAL.createSwarm(agentId, {
      name: `unreachable-recent-${counter}`,
      map_endpoint: `ws://localhost:${9000 + counter}/recent-unreachable`,
      map_transport: 'websocket',
    });
    unreachableRecentId = unreachableRecent.id;
    mapDAL.updateSwarm(unreachableRecentId, { status: 'unreachable' });
    setLastSeenMinutesAgo(unreachableRecentId, 1);

    // Already-offline swarm
    const offline = mapDAL.createSwarm(agentId, {
      name: `already-offline-${counter}`,
      map_endpoint: `ws://localhost:${9000 + counter}/offline`,
      map_transport: 'websocket',
    });
    offlineId = offline.id;
    mapDAL.updateSwarm(offlineId, { status: 'offline' });
    setLastSeenMinutesAgo(offlineId, 10);
  });

  it('sweeps online swarm with old last_seen_at to offline', () => {
    markStaleSwarms();
    expect(getStatus(onlineStaleId)).toBe('offline');
  });

  it('sweeps unreachable swarm with old last_seen_at to offline', () => {
    markStaleSwarms();
    expect(getStatus(unreachableStaleId)).toBe('offline');
  });

  it('leaves online swarm with recent last_seen_at as online', () => {
    markStaleSwarms();
    expect(getStatus(onlineRecentId)).toBe('online');
  });

  it('leaves unreachable swarm with recent last_seen_at as unreachable', () => {
    markStaleSwarms();
    expect(getStatus(unreachableRecentId)).toBe('unreachable');
  });

  it('returns the number of swarms that were swept', () => {
    const changed = markStaleSwarms();
    // onlineStale + unreachableStale = 2 from the current beforeEach batch
    // (prior batches were also swept in earlier tests, but those are already offline)
    expect(changed).toBe(2);
  });

  it('does not touch swarms already offline', () => {
    const swarmBefore = mapDAL.findSwarmById(offlineId)!;
    markStaleSwarms();
    const swarmAfter = mapDAL.findSwarmById(offlineId)!;
    expect(swarmAfter.status).toBe('offline');
    // updated_at should not change for already-offline swarms
    expect(swarmAfter.updated_at).toBe(swarmBefore.updated_at);
  });
});
