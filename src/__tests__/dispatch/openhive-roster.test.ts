/**
 * Tests for createOpenHiveRoster — the AgentRoster adapter that the dispatch
 * orchestrator uses to find delivery targets.
 *
 * Catches a real production bug discovered during live-agent E2E testing:
 * sidecar-only swarms (the default state of a freshly-spawned macro-agent
 * before any coordinators boot) had every dispatch silently fall through
 * to spawn-then-fail because:
 *   1. `state: 'registered'` mapped to `'dormant'` (filtered out by
 *      `notBusy: true`)
 *   2. `role: 'sidecar'` didn't match the orchestrator's `role: 'worker'`
 *      filter
 *
 * Both filters had to lose the sidecar for the bug to manifest. The fix in
 * `openhive-roster.ts` adds 'registered' to the active states and projects
 * sidecar role as 'worker' for routing purposes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createOpenHiveRoster } from '../../dispatch/openhive-roster.js';
import {
  registerInbound,
  unregisterInbound,
  type RegisteredAgent,
} from '../../map/connection-registry.js';

function fakeWs(): import('ws').WebSocket {
  return { readyState: 1, send() {}, close() {} } as unknown as import('ws').WebSocket;
}

interface FakeAgentSpec {
  id: string;
  role?: string;
  state?: string;
  capabilities?: Record<string, unknown>;
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
      capabilities: a.capabilities ?? {},
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

// Each test gets its own unique swarm IDs to avoid carry-over via the
// connection-registry's stale-grace logic (registerInbound merges agents
// from a prior — possibly stale — connection with the same swarmId).
let testCounter = 0;
function freshSwarmId(label: string): string {
  testCounter += 1;
  return `${label}-${testCounter}`;
}

describe('createOpenHiveRoster', () => {
  const tracked = new Set<string>();

  function track(swarmId: string): string {
    tracked.add(swarmId);
    return swarmId;
  }

  beforeEach(() => {
    tracked.clear();
  });

  afterEach(() => {
    for (const id of tracked) unregisterInbound(id);
    tracked.clear();
  });

  // ── Bug regression: sidecar-only swarm must be discoverable ──────────────

  it('REGRESSION: sidecar-only swarm with state=registered surfaces in findAvailable({ role: "worker", notBusy: true })', async () => {
    // This is the exact shape macro-agent's sidecar publishes when a fresh
    // swarm spawns: state='registered' (no state-changed event yet), role='sidecar'.
    const swarmId = track(freshSwarmId('swarm-sidecar'));
    registerSwarm(swarmId, [
      {
        id: 'sidecar-01',
        role: 'sidecar',
        state: 'registered',
        capabilities: { mail: { canJoin: true }, messaging: { canReceive: true } },
      },
    ]);

    const roster = createOpenHiveRoster();
    const candidates = await roster.findAvailable({ role: 'worker', notBusy: true });

    const matching = candidates.filter((c) => c.system === swarmId);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.agentId).toBe('sidecar-01');
  });

  it('sidecar role projects to worker for routing (so default role filter matches)', async () => {
    const swarmId = track(freshSwarmId('swarm-sidecar'));
    registerSwarm(swarmId, [
      { id: 'sidecar-01', role: 'sidecar', state: 'active' },
    ]);

    const roster = createOpenHiveRoster();
    const workerCandidates = (await roster.findAvailable({ role: 'worker' }))
      .filter((c) => c.system === swarmId);
    expect(workerCandidates).toHaveLength(1);
    expect(workerCandidates[0]?.agentId).toBe('sidecar-01');

    // The literal 'sidecar' role still hits the sidecar — but now via the
    // universal-fallback path (no exact match → fall back to sidecar)
    // rather than the projection. The wider fallback layer was added so
    // dispatches with `team_role_ref.role: 'executor'` (etc.) can route
    // to sidecar-only swarms instead of dying when prefer-route can't
    // find an exact-role match. See `openhive-roster.ts:findAvailable`.
    const sidecarCandidates = (await roster.findAvailable({ role: 'sidecar' }))
      .filter((c) => c.system === swarmId);
    expect(sidecarCandidates).toHaveLength(1);
    expect(sidecarCandidates[0]?.agentId).toBe('sidecar-01');
  });

  it('sidecar acts as fallback for arbitrary roles when no exact match exists', async () => {
    const swarmId = track(freshSwarmId('swarm-sidecar-fallback'));
    registerSwarm(swarmId, [
      { id: 'sidecar-01', role: 'sidecar', state: 'active' },
    ]);

    const roster = createOpenHiveRoster();
    // The original regression: spec carries team_role_ref with role
    // 'executor'; on a sidecar-only swarm, the exact-role filter would
    // eliminate everything and prefer-route would fall through to ACP,
    // dying without a coordinator. Sidecar fallback keeps mail alive.
    const candidates = (await roster.findAvailable({ role: 'executor' }))
      .filter((c) => c.system === swarmId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agentId).toBe('sidecar-01');
  });

  it('exact-role agents win over sidecar fallback when both exist', async () => {
    const swarmId = track(freshSwarmId('swarm-mixed'));
    registerSwarm(swarmId, [
      { id: 'sidecar-01', role: 'sidecar', state: 'active' },
      { id: 'executor-01', role: 'executor', state: 'active' },
    ]);

    const roster = createOpenHiveRoster();
    const candidates = (await roster.findAvailable({ role: 'executor' }))
      .filter((c) => c.system === swarmId);
    // Real executor wins; sidecar is only the fallback.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agentId).toBe('executor-01');
  });

  // ── State mapping ────────────────────────────────────────────────────────

  it('maps registered → active (the regression case)', async () => {
    const swarmId = track(freshSwarmId('swarm-state'));
    registerSwarm(swarmId, [
      { id: 'agent-1', role: 'worker', state: 'registered' },
    ]);

    const roster = createOpenHiveRoster();
    const candidates = (await roster.findAvailable({ role: 'worker', notBusy: true }))
      .filter((c) => c.system === swarmId);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agentId).toBe('agent-1');
  });

  it('preserves existing active/idle mappings (no regression on previously-working states)', async () => {
    const swarmId = track(freshSwarmId('swarm-state'));
    registerSwarm(swarmId, [
      { id: 'a-active', role: 'worker', state: 'active' },
      { id: 'a-idle', role: 'worker', state: 'idle' },
    ]);

    const roster = createOpenHiveRoster();
    const candidates = (await roster.findAvailable({ role: 'worker', notBusy: true }))
      .filter((c) => c.system === swarmId);

    expect(candidates.map((c) => c.agentId).sort()).toEqual(['a-active', 'a-idle']);
  });

  it('maps busy → away (excluded by notBusy)', async () => {
    const swarmId = track(freshSwarmId('swarm-busy'));
    registerSwarm(swarmId, [
      { id: 'busy-agent', role: 'worker', state: 'busy' },
    ]);

    const roster = createOpenHiveRoster();
    const candidates = (await roster.findAvailable({ role: 'worker', notBusy: true }))
      .filter((c) => c.system === swarmId);

    expect(candidates).toHaveLength(0);
  });

  it('maps stopped/failed → expired (excluded)', async () => {
    const swarmId = track(freshSwarmId('swarm-stopped'));
    registerSwarm(swarmId, [
      { id: 'dead-1', role: 'worker', state: 'stopped' },
      { id: 'dead-2', role: 'worker', state: 'failed' },
    ]);

    const roster = createOpenHiveRoster();
    const candidates = (await roster.findAvailable({ role: 'worker', notBusy: true }))
      .filter((c) => c.system === swarmId);

    expect(candidates).toHaveLength(0);
  });

  it('maps unknown states → dormant (excluded)', async () => {
    const swarmId = track(freshSwarmId('swarm-mystery'));
    registerSwarm(swarmId, [
      { id: 'mystery', role: 'worker', state: 'somethingelse' },
    ]);

    const roster = createOpenHiveRoster();
    const candidates = (await roster.findAvailable({ role: 'worker', notBusy: true }))
      .filter((c) => c.system === swarmId);

    expect(candidates).toHaveLength(0);
  });

  // ── Role projection ──────────────────────────────────────────────────────

  it('non-sidecar roles pass through unchanged', async () => {
    const swarmId = track(freshSwarmId('swarm-roles'));
    registerSwarm(swarmId, [
      { id: 'coord-1', role: 'coordinator', state: 'active' },
      { id: 'review-1', role: 'reviewer', state: 'active' },
    ]);

    const roster = createOpenHiveRoster();

    expect(
      (await roster.findAvailable({ role: 'coordinator' })).filter((c) => c.system === swarmId),
    ).toHaveLength(1);
    expect(
      (await roster.findAvailable({ role: 'reviewer' })).filter((c) => c.system === swarmId),
    ).toHaveLength(1);
    expect(
      (await roster.findAvailable({ role: 'worker' })).filter((c) => c.system === swarmId),
    ).toHaveLength(0);
  });

  it('a swarm with both a sidecar and a worker exposes both as worker candidates', async () => {
    const swarmId = track(freshSwarmId('swarm-mixed'));
    registerSwarm(swarmId, [
      { id: 'sidecar-01', role: 'sidecar', state: 'active' },
      { id: 'worker-01', role: 'worker', state: 'active' },
    ]);

    const roster = createOpenHiveRoster();
    const workers = (await roster.findAvailable({ role: 'worker' }))
      .filter((c) => c.system === swarmId);

    expect(workers.map((c) => c.agentId).sort()).toEqual(['sidecar-01', 'worker-01']);
  });

  // ── Empty / no-swarm cases ───────────────────────────────────────────────

  it('returns empty when swarm has no registered agents', async () => {
    const swarmId = track(freshSwarmId('swarm-empty'));
    registerSwarm(swarmId, []);

    const roster = createOpenHiveRoster();
    const candidates = (await roster.findAvailable({ role: 'worker', notBusy: true }))
      .filter((c) => c.system === swarmId);

    expect(candidates).toHaveLength(0);
  });
});
