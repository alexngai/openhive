/**
 * Broader runtime test fixtures — gap G.
 *
 * The original Layer 3 E2E (`loadout-dispatch-runtime.test.ts`) verified
 * the materializer → ACP session wiring for the canonical happy path.
 * This file fills in the surrounding behaviour: concurrent spawns,
 * terminate semantics, subscriber callbacks, error propagation, retry
 * accumulation, and partial bindings.
 *
 * All tests run against a mocked AcpStreamManager — no live ACP needed.
 * Live-ACP smoke remains a separate concern.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { bundleLoadout, resolveStandaloneLoadout } from 'openteams';
import type { LoadoutDefinition, MAPResource } from 'openteams';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import * as mapDAL from '../../db/dal/map.js';
import { createOpenHiveAgentRuntime } from '../../dispatch/openhive-runtime.js';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
} from '../../openteams/map-handlers.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../map/connection-registry.js', () => ({
  findAcpAgentInfo: () => ({ targetId: 'agent-target-id' }),
}));

const TEST_ROOT = testRoot('loadout-dispatch-runtime-broader');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'loadout-dispatch-runtime-broader.db');

const LOADOUT_A: LoadoutDefinition = {
  name: 'la',
  capabilities: ['file.read'],
  mcp_servers: [{ name: 'serverA', command: 'node', args: ['./a.js'] }],
  prompt_addendum: 'A-ADD',
};

const LOADOUT_B: LoadoutDefinition = {
  name: 'lb',
  capabilities: ['exec.test'],
  mcp_servers: [{ name: 'serverB', command: 'node', args: ['./b.js'] }],
  prompt_addendum: 'B-ADD',
};

/** Configurable mock with per-stream recording so we can verify concurrent
 *  spawns don't cross-contaminate sessions. */
function makeMockManager() {
  type Recorded = {
    cwd: string;
    mcpServers: unknown[];
    prompt: string;
  };
  const byStream = new Map<string, Recorded>();
  const closes: string[] = [];
  let streamCounter = 0;

  const mgr = {
    createStreamShouldThrow: false as boolean,
    initShouldThrow: false as boolean,
    async createStream(_serverId: string, _agentId: string) {
      if (this.createStreamShouldThrow) {
        throw new Error('createStream boom');
      }
      streamCounter += 1;
      const streamId = `s-${streamCounter}`;
      byStream.set(streamId, { cwd: '', mcpServers: [], prompt: '' });
      return { streamId };
    },
    async initialize(streamId: string) {
      if (this.initShouldThrow) throw new Error('initialize boom');
      return { streamId };
    },
    async newSession(
      streamId: string,
      input: { cwd: string; mcpServers: unknown[] },
    ) {
      const r = byStream.get(streamId)!;
      r.cwd = input.cwd;
      r.mcpServers = input.mcpServers;
      return { sessionId: `sess-${streamId}` };
    },
    async prompt(
      streamId: string,
      input: { sessionId: string; prompt: Array<{ type: string; text?: string }> },
    ) {
      const r = byStream.get(streamId)!;
      r.prompt = input.prompt[0]?.text ?? '';
      return {};
    },
    async closeStream(id: string) {
      closes.push(id);
    },
  };
  return { mgr, byStream, closes };
}

describe('loadout dispatch runtime — broader coverage', () => {
  let agentId: string;
  let swarmId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'broader-agent',
      description: 'broader tests',
    });
    agentId = agent.id;
    swarmId = mapDAL.createSwarm(agentId, {
      name: 'broader-swarm',
      map_endpoint: 'http://localhost:0/map',
    }).id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
    _resetOpenteamsMapHandlers();
    // Silence expected warnings (hash-mismatch tests, missing-bundle).
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // ── Concurrent spawns ──────────────────────────────────────────────────

  it('threads taskId correctly across concurrent spawns (no cross-contamination)', async () => {
    // Seed two distinct loadouts.
    const bA = bundleLoadout(resolveStandaloneLoadout(LOADOUT_A), {
      version: '0.0.0',
      name: 'la',
    });
    const bB = bundleLoadout(resolveStandaloneLoadout(LOADOUT_B), {
      version: '0.0.0',
      name: 'lb',
    });
    await getOpenteamsBundleStore().put(bA as unknown as MAPResource);
    await getOpenteamsBundleStore().put(bB as unknown as MAPResource);

    const dA = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_a',
      spec_id: 'cA',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
      loadout_bundle_id: bA.id,
    });
    const dB = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_b',
      spec_id: 'cB',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
      loadout_bundle_id: bB.id,
    });

    const { mgr, byStream } = makeMockManager();
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });

    // Fire both spawns in parallel.
    await Promise.all([
      runtime.spawn({ taskId: dA.id, prompt: 'A-PROMPT' } as any),
      runtime.spawn({ taskId: dB.id, prompt: 'B-PROMPT' } as any),
    ]);

    const recs = Array.from(byStream.values());
    expect(recs).toHaveLength(2);

    // Each session should see the loadout that matches its dispatch — never crossed.
    const aRec = recs.find((r) => r.prompt.startsWith('A-ADD'));
    const bRec = recs.find((r) => r.prompt.startsWith('B-ADD'));
    expect(aRec).toBeDefined();
    expect(bRec).toBeDefined();
    expect(aRec!.mcpServers).toEqual([
      { name: 'serverA', command: 'node', args: ['./a.js'] },
    ]);
    expect(bRec!.mcpServers).toEqual([
      { name: 'serverB', command: 'node', args: ['./b.js'] },
    ]);
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  it('terminate(agentId) calls closeStream on the manager', async () => {
    const { mgr, closes } = makeMockManager();
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });
    await runtime.terminate('stream-id-9', 'completed');
    expect(closes).toEqual(['stream-id-9']);
  });

  it('terminate swallows closeStream errors (stream already closed)', async () => {
    const { mgr } = makeMockManager();
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });
    mgr.closeStream = async () => {
      throw new Error('already closed');
    };
    // Should not throw.
    await expect(runtime.terminate('stream-x', 'completed')).resolves.toBeUndefined();
  });

  it('onStopped subscribers can be added and removed', () => {
    const { mgr } = makeMockManager();
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });
    const fn = vi.fn();
    const unsub = runtime.onStopped(fn);
    // unsub returns a function and does not throw.
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('onUsage subscribers can be added and removed', () => {
    const { mgr } = makeMockManager();
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });
    const fn = vi.fn();
    const unsub = runtime.onUsage!(fn);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  // ── Error propagation ──────────────────────────────────────────────────

  it('spawn() rejects when createStream throws', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c1',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
    });
    const { mgr } = makeMockManager();
    mgr.createStreamShouldThrow = true;
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });
    await expect(
      runtime.spawn({ taskId: d.id, prompt: 'p' } as any),
    ).rejects.toThrow(/createStream boom/);
  });

  it('spawn() rejects when initialize throws', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c2',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
    });
    const { mgr } = makeMockManager();
    mgr.initShouldThrow = true;
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });
    await expect(
      runtime.spawn({ taskId: d.id, prompt: 'p' } as any),
    ).rejects.toThrow(/initialize boom/);
  });

  // ── Retry semantics ────────────────────────────────────────────────────

  it('retried spawn() accumulates session_ids on the dispatch row', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c3',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
    });
    const { mgr } = makeMockManager();
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });
    await runtime.spawn({ taskId: d.id, prompt: 'first' } as any);
    await runtime.spawn({ taskId: d.id, prompt: 'second-attempt' } as any);
    const after = dispatchesDAL.findDispatchById(d.id);
    expect(after?.session_ids).toEqual(['sess-s-1', 'sess-s-2']);
  });

  // ── Partial bindings ───────────────────────────────────────────────────

  it('team_bundle_id set but loadout_bundle_id null → behaves like no binding', async () => {
    // Today the runtime only materializes loadouts. team-only is reserved
    // for the openteams.spawn flow (Layer 4) — for now it just means
    // "spec-only dispatch with team context recorded on the row".
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c4',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
      team_bundle_id: 'sha256:9f3a',
      role: 'executor',
    });
    const { mgr, byStream } = makeMockManager();
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });
    await runtime.spawn({ taskId: d.id, prompt: 'p' } as any);
    const rec = Array.from(byStream.values())[0];
    expect(rec.mcpServers).toEqual([]);
    expect(rec.prompt).toBe('p');
  });

  // ── Hash mismatch ──────────────────────────────────────────────────────

  it('falls back gracefully when the pinned bundle has a tampered hash', async () => {
    const bundle = bundleLoadout(resolveStandaloneLoadout(LOADOUT_A), {
      version: '0.0.0',
      name: 'la',
    });
    // Persist a tampered copy under the same id — name doesn't match the hash.
    const tampered = {
      ...bundle,
      metadata: {
        ...bundle.metadata,
        resolved: { ...bundle.metadata.resolved, name: 'TAMPERED' },
      },
    };
    await getOpenteamsBundleStore().put(tampered as unknown as MAPResource);

    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_x',
      spec_id: 'c5',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
      loadout_bundle_id: bundle.id,
    });

    const { mgr, byStream } = makeMockManager();
    const runtime = createOpenHiveAgentRuntime({ getAcpStreamManager: () => mgr });
    // Should not throw — runtime logs and proceeds without the binding.
    await runtime.spawn({ taskId: d.id, prompt: 'fallback' } as any);
    const rec = Array.from(byStream.values())[0];
    expect(rec.mcpServers).toEqual([]);
    expect(rec.prompt).toBe('fallback');
  });
});
