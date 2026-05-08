/**
 * Tests for repo-aware dispatch routing in createOpenHiveRoster.
 *
 * When a dispatch carries a repo_id (via the repo side-channel), the roster
 * sorts agents on bound swarms (swarms with an active workspace for that repo)
 * ahead of agents on unbound swarms. This is a soft preference — unbound
 * agents are still returned, just ranked lower.
 *
 * These tests need both:
 *   1. The connection registry (in-memory, populated via registerInbound)
 *   2. A real SQLite database (for workspaces table queries)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createOpenHiveRoster } from '../../dispatch/openhive-roster.js';
import {
  registerInbound,
  unregisterInbound,
  type RegisteredAgent,
} from '../../map/connection-registry.js';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import {
  setActiveDispatchRepoId,
  _resetRepoSideChannelForTest,
} from '../../dispatch/repo-side-channel.js';
import * as repos from '../../db/dal/repos.js';
import * as workspaces from '../../db/dal/workspaces.js';
import { ensureNodeWithId } from '../../db/dal/map.js';

const TEST_ROOT = testRoot('roster-repo');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'roster-repo.db');

const OWNER_AGENT = 'agent_owner_roster';

let testCounter = 0;
function freshId(prefix: string): string {
  testCounter += 1;
  return `${prefix}-${testCounter}`;
}

function fakeWs(): import('ws').WebSocket {
  return { readyState: 1, send() {}, close() {} } as unknown as import('ws').WebSocket;
}

interface FakeAgentSpec {
  id: string;
  role?: string;
  state?: string;
}

function registerSwarm(swarmId: string, agents: FakeAgentSpec[]) {
  const registered = new Map<string, RegisteredAgent>();
  for (const a of agents) {
    registered.set(a.id, {
      id: a.id,
      name: a.id,
      role: a.role ?? 'worker',
      state: a.state ?? 'active',
      scopes: [],
      capabilities: {},
    });
  }
  registerInbound(swarmId, {
    ws: fakeWs(),
    agentId: agents[0]?.id ?? 'primary',
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: registered,
  });
}

function seedSwarm(id: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, status, owner_agent_id, created_at, updated_at)
    VALUES (?, ?, ?, 'online', ?, datetime('now'), datetime('now'))
  `).run(id, id, `ws://localhost/${id}`, OWNER_AGENT);
}

function seedAgent(id: string): void {
  const db = getDatabase();
  db.prepare('INSERT OR IGNORE INTO agents (id, name) VALUES (?, ?)').run(id, id);
}

function seedNode(id: string, swarmId: string): void {
  ensureNodeWithId({ id, swarm_id: swarmId, map_agent_id: id });
}

function seedRepoResource(canonicalUrl: string): string {
  const repo = repos.upsertRepoByCanonicalUrl(
    { canonicalUrl, host: 'github.com', owner: 'test', name: 'repo' },
    { origin: 'user_defined', visibility: 'hub_local', owner_agent_id: OWNER_AGENT },
  );
  return repo.id;
}

function seedWorkspace(
  repoId: string,
  agentId: string,
  swarmId: string,
): void {
  workspaces.upsertWorkspace({
    repo_id: repoId,
    agent_id: agentId,
    swarm_id: swarmId,
    local_path: `/workspace/${agentId}`,
    visibility: 'hub_local',
  });
}

describe('createOpenHiveRoster — repo-aware routing', () => {
  const trackedSwarms = new Set<string>();

  function track(swarmId: string): string {
    trackedSwarms.add(swarmId);
    return swarmId;
  }

  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
    const db = getDatabase();
    db.pragma('foreign_keys = OFF');
    seedAgent(OWNER_AGENT);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    trackedSwarms.clear();
  });

  afterEach(() => {
    for (const id of trackedSwarms) unregisterInbound(id);
    trackedSwarms.clear();
    _resetRepoSideChannelForTest();
  });

  it('prefers agents on swarms bound to the active repo', async () => {
    const boundSwarm = track(freshId('swarm-bound'));
    const unboundSwarm = track(freshId('swarm-unbound'));
    const agentBound = freshId('agent-bound');
    const agentUnbound = freshId('agent-unbound');

    // DB setup: swarm + node + workspace binding
    seedSwarm(boundSwarm);
    seedSwarm(unboundSwarm);
    seedAgent(agentBound);
    seedAgent(agentUnbound);
    seedNode(agentBound, boundSwarm);
    seedNode(agentUnbound, unboundSwarm);
    const repoId = seedRepoResource('https://github.com/test/bound-repo');
    seedWorkspace(repoId, agentBound, boundSwarm);

    // Connection registry
    registerSwarm(boundSwarm, [{ id: agentBound }]);
    registerSwarm(unboundSwarm, [{ id: agentUnbound }]);

    // Activate the repo side-channel
    setActiveDispatchRepoId(repoId);

    const roster = createOpenHiveRoster();
    const candidates = await roster.findAvailable({ role: 'worker', notBusy: true });

    const relevant = candidates.filter(
      (c) => c.system === boundSwarm || c.system === unboundSwarm,
    );
    expect(relevant.length).toBe(2);
    // Bound agent should come first
    expect(relevant[0]!.agentId).toBe(agentBound);
    expect(relevant[0]!.system).toBe(boundSwarm);
    expect(relevant[1]!.agentId).toBe(agentUnbound);
    expect(relevant[1]!.system).toBe(unboundSwarm);
  });

  it('falls through to normal ordering when no swarm has bindings for the repo', async () => {
    const swarmA = track(freshId('swarm-a'));
    const swarmB = track(freshId('swarm-b'));
    const agentA = freshId('agent-a');
    const agentB = freshId('agent-b');

    seedSwarm(swarmA);
    seedSwarm(swarmB);
    seedAgent(agentA);
    seedAgent(agentB);
    seedNode(agentA, swarmA);
    seedNode(agentB, swarmB);

    // No workspace bindings — repo exists but no swarm has it
    const repoId = seedRepoResource('https://github.com/test/no-bindings');

    registerSwarm(swarmA, [{ id: agentA }]);
    registerSwarm(swarmB, [{ id: agentB }]);

    setActiveDispatchRepoId(repoId);

    const roster = createOpenHiveRoster();
    const candidates = await roster.findAvailable({ role: 'worker', notBusy: true });

    const relevant = candidates.filter(
      (c) => c.system === swarmA || c.system === swarmB,
    );
    // Both returned, no preference applied
    expect(relevant.length).toBe(2);
  });

  it('returns normal ordering when no repo_id is active (existing behavior)', async () => {
    const swarmA = track(freshId('swarm-no-repo-a'));
    const swarmB = track(freshId('swarm-no-repo-b'));
    const agentA = freshId('agent-no-repo-a');
    const agentB = freshId('agent-no-repo-b');

    registerSwarm(swarmA, [{ id: agentA }]);
    registerSwarm(swarmB, [{ id: agentB }]);

    // No setActiveDispatchRepoId — side channel is cleared in afterEach

    const roster = createOpenHiveRoster();
    const candidates = await roster.findAvailable({ role: 'worker', notBusy: true });

    const relevant = candidates.filter(
      (c) => c.system === swarmA || c.system === swarmB,
    );
    expect(relevant.length).toBe(2);
  });

  it('repo preference works alongside sidecar fallback', async () => {
    const boundSwarm = track(freshId('swarm-sidecar-bound'));
    const unboundSwarm = track(freshId('swarm-sidecar-unbound'));
    const sidecarBound = freshId('sidecar-bound');
    const sidecarUnbound = freshId('sidecar-unbound');

    seedSwarm(boundSwarm);
    seedSwarm(unboundSwarm);
    seedAgent(sidecarBound);
    seedAgent(sidecarUnbound);
    seedNode(sidecarBound, boundSwarm);
    seedNode(sidecarUnbound, unboundSwarm);
    const repoId = seedRepoResource('https://github.com/test/sidecar-repo');
    seedWorkspace(repoId, sidecarBound, boundSwarm);

    // Both swarms only have sidecars — role 'executor' triggers fallback
    registerSwarm(boundSwarm, [{ id: sidecarBound, role: 'sidecar' }]);
    registerSwarm(unboundSwarm, [{ id: sidecarUnbound, role: 'sidecar' }]);

    setActiveDispatchRepoId(repoId);

    const roster = createOpenHiveRoster();
    const candidates = await roster.findAvailable({ role: 'executor', notBusy: true });

    const relevant = candidates.filter(
      (c) => c.system === boundSwarm || c.system === unboundSwarm,
    );
    expect(relevant.length).toBe(2);
    // Bound sidecar should come first even in fallback path
    expect(relevant[0]!.agentId).toBe(sidecarBound);
    expect(relevant[0]!.system).toBe(boundSwarm);
  });

  it('does not filter out unbound agents — soft sort only', async () => {
    const boundSwarm = track(freshId('swarm-soft-bound'));
    const unboundSwarm = track(freshId('swarm-soft-unbound'));
    const agentBound = freshId('agent-soft-bound');
    const agentUnbound = freshId('agent-soft-unbound');

    seedSwarm(boundSwarm);
    seedSwarm(unboundSwarm);
    seedAgent(agentBound);
    seedAgent(agentUnbound);
    seedNode(agentBound, boundSwarm);
    seedNode(agentUnbound, unboundSwarm);
    const repoId = seedRepoResource('https://github.com/test/soft-sort');
    seedWorkspace(repoId, agentBound, boundSwarm);

    registerSwarm(boundSwarm, [{ id: agentBound }]);
    registerSwarm(unboundSwarm, [{ id: agentUnbound }]);

    setActiveDispatchRepoId(repoId);

    const roster = createOpenHiveRoster();
    const candidates = await roster.findAvailable({ role: 'worker', notBusy: true });

    const agentIds = candidates
      .filter((c) => c.system === boundSwarm || c.system === unboundSwarm)
      .map((c) => c.agentId);
    // Both agents are present — no one was excluded
    expect(agentIds).toContain(agentBound);
    expect(agentIds).toContain(agentUnbound);
  });

  it('skips repo preference when only one candidate exists', async () => {
    const swarm = track(freshId('swarm-single'));
    const agent = freshId('agent-single');

    seedSwarm(swarm);
    seedAgent(agent);
    seedNode(agent, swarm);
    const repoId = seedRepoResource('https://github.com/test/single-agent');
    seedWorkspace(repoId, agent, swarm);

    registerSwarm(swarm, [{ id: agent }]);
    setActiveDispatchRepoId(repoId);

    const roster = createOpenHiveRoster();
    const candidates = await roster.findAvailable({ role: 'worker', notBusy: true });

    const relevant = candidates.filter((c) => c.system === swarm);
    expect(relevant.length).toBe(1);
    expect(relevant[0]!.agentId).toBe(agent);
  });
});
