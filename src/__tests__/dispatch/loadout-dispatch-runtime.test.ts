/**
 * Layer 3 — End-to-end dispatch runtime test with an openteams loadout.
 *
 * Spawns through `createOpenHiveAgentRuntime` against a mock ACP stream
 * manager and asserts that:
 *
 *   - The materialized MCP servers from the loadout reach `newSession`.
 *   - The loadout's `promptAddendum` prepends the spec-derived prompt at
 *     `prompt()` time.
 *   - Dispatches without a `loadout_bundle_id` go through unchanged
 *     (empty mcpServers, untouched prompt) — backwards compat.
 *   - Missing-bundle paths log and continue rather than crashing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  bundleLoadout,
  resolveStandaloneLoadout,
} from 'openteams';
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
import {
  registerLoadoutForDispatch,
  peekLoadoutForDispatch,
  _resetLoadoutSideChannelForTest,
} from '../../dispatch/loadout-side-channel.js';
import type { MaterializedLoadout } from '../../openteams/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Stub the connection registry — the real one needs an active MAP server +
// connected swarm; for unit-level coverage we just return a deterministic
// ACP target so spawn() can proceed into the runtime steps we care about.
vi.mock('../../map/connection-registry.js', () => ({
  findAcpAgentInfo: () => ({ targetId: 'agent-target-id' }),
}));

const TEST_ROOT = testRoot('loadout-dispatch-runtime');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'loadout-dispatch-runtime.db');

const LOADOUT_DEF: LoadoutDefinition = {
  name: 'dispatch-lo',
  capabilities: ['file.read'],
  mcp_servers: [{ name: 'opentasks', command: 'node', args: ['./mcp.js'] }],
  prompt_addendum: 'WORK SAFELY',
};

interface RecordedCall {
  newSession?: { cwd: string; mcpServers: unknown[] };
  prompt?: { sessionId: string; prompt: Array<{ type: string; text?: string }> };
}

function makeMockAcpManager(): { mgr: any; recorded: RecordedCall } {
  const recorded: RecordedCall = {};
  const mgr = {
    async createStream(_serverId: string, _agentId: string) {
      return { streamId: 'mock-stream-1' };
    },
    async closeStream(_id: string) {
      /* no-op */
    },
    async initialize(_streamId: string) {
      return {};
    },
    async newSession(_streamId: string, input: { cwd: string; mcpServers: unknown[] }) {
      recorded.newSession = input;
      return { sessionId: 'mock-session-1' };
    },
    async prompt(
      _streamId: string,
      input: { sessionId: string; prompt: Array<{ type: string; text?: string }> },
    ) {
      recorded.prompt = input;
      return {};
    },
  };
  return { mgr, recorded };
}

describe('loadout dispatch runtime — E2E spawn', () => {
  let agentId: string;
  let swarmId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'lo-disp-agent',
      description: 'runtime test',
    });
    agentId = agent.id;
    swarmId = mapDAL.createSwarm(agentId, {
      name: 'lo-disp-swarm',
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
    _resetLoadoutSideChannelForTest();
  });

  it('feeds materialized MCP servers + prompt addendum into the ACP session', async () => {
    // Seed the bundle store with the loadout.
    const resolved = resolveStandaloneLoadout(LOADOUT_DEF);
    const bundle = bundleLoadout(resolved, { version: '0.0.0', name: 'dispatch-lo' });
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

    // Create a dispatch pinning that bundle.
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'c-1',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
      loadout_bundle_id: bundle.id,
    });

    // Post-merge: the runtime reads the materialized loadout from an
    // in-memory side-channel rather than re-materializing from the
    // bundle store inline. Build a minimal materialized loadout that
    // mirrors LOADOUT_DEF and register it for this dispatch.
    const materialized: MaterializedLoadout = {
      capabilities: ['file.read'],
      mcpScope: [],
      mcpProviders: [
        { name: 'opentasks', command: 'node', args: ['./mcp.js'] },
      ],
      permissions: { allow: [], deny: [], ask: [] },
      promptAddendum: 'WORK SAFELY',
      skills: null,
      unresolvedRefs: [],
      materializedAt: new Date().toISOString(),
    };
    registerLoadoutForDispatch(d.id, materialized);

    const { mgr, recorded } = makeMockAcpManager();
    const runtime = createOpenHiveAgentRuntime({
      getAcpStreamManager: () => mgr,
    });

    await runtime.spawn({ taskId: d.id, prompt: 'do the spec work' } as any);

    // The runtime threads the side-channel loadout through resolveTarget
    // → createStream → createSession/sendPrompt so newSession gets the
    // materialized mcpServers and the prompt gets the addendum prefix.
    expect(peekLoadoutForDispatch(d.id)).toBeNull();
    expect(recorded.newSession?.mcpServers).toEqual([
      { name: 'opentasks', command: 'node', args: ['./mcp.js'] },
    ]);
    const promptText = recorded.prompt?.prompt[0]?.text ?? '';
    expect(promptText).toBe('WORK SAFELY\n\ndo the spec work');
  });

  it('falls back to empty mcpServers + untouched prompt when no loadout binding', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'c-2',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const { mgr, recorded } = makeMockAcpManager();
    const runtime = createOpenHiveAgentRuntime({
      getAcpStreamManager: () => mgr,
    });

    await runtime.spawn({ taskId: d.id, prompt: 'legacy seed prompt' } as any);

    expect(recorded.newSession?.mcpServers).toEqual([]);
    expect(recorded.prompt?.prompt[0]?.text).toBe('legacy seed prompt');
  });

  it('proceeds without binding when the pinned bundle is missing from the store', async () => {
    // Don't seed the store — the dispatch points at a hash that doesn't exist.
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'c-3',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
      loadout_bundle_id: 'sha256:vanished',
    });

    const { mgr, recorded } = makeMockAcpManager();
    const runtime = createOpenHiveAgentRuntime({
      getAcpStreamManager: () => mgr,
    });

    // Suppress the expected warning.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runtime.spawn({ taskId: d.id, prompt: 'fallback prompt' } as any);
    } finally {
      warnSpy.mockRestore();
    }

    expect(recorded.newSession?.mcpServers).toEqual([]);
    expect(recorded.prompt?.prompt[0]?.text).toBe('fallback prompt');
  });

  it('persists the new sessionId onto the dispatch row', async () => {
    const d = dispatchesDAL.createDispatch({
      spec_resource_id: 'res_spec',
      spec_id: 'c-4',
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: agentId,
    });

    const { mgr } = makeMockAcpManager();
    const runtime = createOpenHiveAgentRuntime({
      getAcpStreamManager: () => mgr,
    });

    await runtime.spawn({ taskId: d.id, prompt: 'hi' } as any);

    const after = dispatchesDAL.findDispatchById(d.id);
    expect(after?.session_ids).toContain('mock-session-1');
  });
});
