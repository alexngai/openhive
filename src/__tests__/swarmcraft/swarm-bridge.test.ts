import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mapHubEvents } from '../../map/service.js';

// Mock DAL before importing the bridge — setupSwarmBridge calls listSwarms()
// and findSwarmById() during hydration, and discoverNodes during per-swarm hydrate.
vi.mock('../../db/dal/map.js', () => ({
  listSwarms: vi.fn(() => ({ data: [], total: 0 })),
  discoverNodes: vi.fn(() => ({ data: [], total: 0 })),
  updateSwarm: vi.fn(),
  findSwarmById: vi.fn(() => null),
}));

import { setupSwarmBridge } from '../../swarmcraft/swarm-bridge.js';

function createMockContext() {
  return {
    db: {
      agents: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
        get: vi.fn(async () => null),
        bulkUpdatePresenceByServer: vi.fn(async () => 0),
        list: vi.fn(async () => ({ agents: [], total: 0 })),
      },
      tasks: { create: vi.fn(), update: vi.fn(), get: vi.fn(), assign: vi.fn() },
      events: { create: vi.fn() },
    },
    wsHub: {
      broadcastAgentRegistered: vi.fn(),
      broadcastAgentStateChanged: vi.fn(),
      broadcastAgentPresenceChanged: vi.fn(),
      broadcastTaskAssigned: vi.fn(),
      broadcastTaskStatusChanged: vi.fn(),
      broadcast: vi.fn(),
    },
    positionService: {
      recordAccess: vi.fn(async () => ({})),
    },
  };
}

describe('Swarm Bridge — peerMapId projection', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mapHubEvents.removeAllListeners('node_registered');
    mapHubEvents.removeAllListeners('swarm_registered');
    mapHubEvents.removeAllListeners('swarm_offline');
  });

  it('writes peerMapId into stateMetadata.agentMetadata on node_registered', async () => {
    // SwarmCraft's useAgentCapabilities.ts reads the peer-side target id from
    // exactly this nested path. If the bridge writes it flat (as `mapAgentId`
    // only), ACP routing for hub-projected agents silently falls through to
    // the hub-assigned id, which the peer's MAP server can't resolve.
    const handle = await setupSwarmBridge(ctx as any);

    mapHubEvents.emit('node_registered', {
      node_id: 'node-1',
      swarm_id: 'swarm-1',
      map_agent_id: 'peer-ulid-42',
      name: 'coordinator',
      role: 'coordinator',
      state: 'active',
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.db.agents.create).toHaveBeenCalledTimes(1);
    const call = (ctx.db.agents.create as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      stateMetadata: {
        mapAgentId?: string;
        agentMetadata?: { peerMapId?: string };
      };
    };

    expect(call.stateMetadata.mapAgentId).toBe('peer-ulid-42');
    expect(call.stateMetadata.agentMetadata).toEqual({ peerMapId: 'peer-ulid-42' });

    handle.teardown();
  });

  it('still writes the flat mapAgentId for other consumers', async () => {
    const handle = await setupSwarmBridge(ctx as any);

    mapHubEvents.emit('node_registered', {
      node_id: 'node-2',
      swarm_id: 'swarm-2',
      map_agent_id: 'peer-ulid-99',
      name: null,
      role: null,
      state: 'idle',
    });

    await new Promise((r) => setTimeout(r, 10));

    const call = (ctx.db.agents.create as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      stateMetadata: Record<string, unknown>;
    };
    // Flat form preserved — nothing else in the codebase should have to be
    // updated to find the peer id.
    expect(call.stateMetadata.mapAgentId).toBe('peer-ulid-99');
    expect(call.stateMetadata.swarmId).toBe('swarm-2');

    handle.teardown();
  });
});

describe('Swarm Bridge — swarm_offline presence cascade', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mapHubEvents.removeAllListeners('node_registered');
    mapHubEvents.removeAllListeners('swarm_registered');
    mapHubEvents.removeAllListeners('swarm_offline');
  });

  it('broadcasts agent.presence.changed for every row listed as online (parent + children) in a single pass', async () => {
    // Arrange: parent swarm row exists, two child agents on that server
    // are currently online. The DAL-list mock returns all three (parent
    // included because it's also presence='online' at snapshot time).
    (ctx.db.agents.get as any).mockImplementation(async (id: string) => {
      if (id === 'oh-swarm-swarm-1') return { state: 'active' };
      return null;
    });
    (ctx.db.agents.list as any).mockResolvedValue({
      agents: [
        { id: 'oh-swarm-swarm-1' },
        { id: 'oh-node-swarm-1-child-a' },
        { id: 'oh-node-swarm-1-child-b' },
      ],
      total: 3,
    });

    const handle = await setupSwarmBridge(ctx as any);
    mapHubEvents.emit('swarm_offline', { swarm_id: 'swarm-1' });
    await new Promise((r) => setTimeout(r, 10));

    // Parent state transition still reported.
    expect(ctx.wsHub.broadcastAgentStateChanged).toHaveBeenCalledWith(
      'oh-swarm-swarm-1', 'active', 'stopped',
    );

    // One presence broadcast per row that was online at snapshot time.
    // Parent gets exactly one (we removed the earlier duplicate-broadcast
    // from before the list + skip-in-loop pair).
    const presenceCalls = (ctx.wsHub.broadcastAgentPresenceChanged as any).mock.calls as Array<[string, string]>;
    const ids = presenceCalls.map(c => c[0]).sort();
    expect(ids).toEqual([
      'oh-node-swarm-1-child-a',
      'oh-node-swarm-1-child-b',
      'oh-swarm-swarm-1',
    ]);
    for (const [, presence] of presenceCalls) {
      expect(presence).toBe('offline');
    }

    // Bulk flip still ran.
    expect(ctx.db.agents.bulkUpdatePresenceByServer).toHaveBeenCalledWith('swarm-1', 'offline');

    handle.teardown();
  });

  it('lists BEFORE mutating the parent (so the snapshot includes it)', async () => {
    // Regression guard: an earlier version flipped the parent first and
    // then listed, which caused the parent row to disappear from the
    // affected set AND in the live case let `agent.unregistered` races
    // drain the list entirely. The order matters — list must capture
    // both parent + children while they're all still online.
    const order: string[] = [];
    (ctx.db.agents.get as any).mockImplementation(async () => {
      order.push('get');
      return { state: 'active' };
    });
    (ctx.db.agents.list as any).mockImplementation(async () => {
      order.push('list');
      return { agents: [{ id: 'oh-swarm-swarm-ord' }], total: 1 };
    });
    (ctx.db.agents.update as any).mockImplementation(async () => {
      order.push('update');
      return {};
    });

    const handle = await setupSwarmBridge(ctx as any);
    mapHubEvents.emit('swarm_offline', { swarm_id: 'swarm-ord' });
    await new Promise((r) => setTimeout(r, 10));

    // The first DAL op must be `list`. `get` can happen anywhere AFTER list
    // but `update` must come after list too.
    expect(order[0]).toBe('list');
    expect(order.indexOf('update')).toBeGreaterThan(order.indexOf('list'));

    handle.teardown();
  });

  it('lists filtered to online-only so already-offline agents do not re-broadcast', async () => {
    // Guard against spamming the WS topic with redundant events on every
    // swarm disconnect — the list call must pin presence:'online' so only
    // rows that actually transitioned fire a broadcast.
    const handle = await setupSwarmBridge(ctx as any);
    mapHubEvents.emit('swarm_offline', { swarm_id: 'swarm-xyz' });
    await new Promise((r) => setTimeout(r, 10));

    const listCall = (ctx.db.agents.list as any).mock.calls[0]?.[0];
    expect(listCall).toMatchObject({
      mapServerId: 'swarm-xyz',
      presence: 'online',
    });

    handle.teardown();
  });

  it('bulk flip still runs even when list fails (best-effort cascade)', async () => {
    // The list is a non-critical enrichment — if it throws we should still
    // flip presence in the DB so the source of truth is correct, even if
    // the UI misses the real-time event and has to reload.
    (ctx.db.agents.list as any).mockRejectedValue(new Error('boom'));

    const handle = await setupSwarmBridge(ctx as any);
    mapHubEvents.emit('swarm_offline', { swarm_id: 'swarm-err' });
    await new Promise((r) => setTimeout(r, 10));

    expect(ctx.db.agents.bulkUpdatePresenceByServer).toHaveBeenCalledWith('swarm-err', 'offline');

    handle.teardown();
  });

  it('dedupes rapid re-fires of swarm_offline for the same swarm', async () => {
    // ws-map.ts + service.markStaleSwarms both emit `swarm_offline` for
    // the same swarm within ms of each other. Only the first invocation
    // should do real work — the second would find 0 rows online and emit
    // zero broadcasts anyway, but re-running list + bulkUpdate is wasted.
    (ctx.db.agents.get as any).mockResolvedValue({ state: 'active' });
    (ctx.db.agents.list as any).mockResolvedValue({
      agents: [{ id: 'oh-swarm-dupe' }],
      total: 1,
    });

    const handle = await setupSwarmBridge(ctx as any);

    // Emit twice back-to-back within the dedup window.
    mapHubEvents.emit('swarm_offline', { swarm_id: 'swarm-dupe' });
    mapHubEvents.emit('swarm_offline', { swarm_id: 'swarm-dupe' });
    await new Promise((r) => setTimeout(r, 10));

    // Only the first invocation should have touched the DAL.
    expect((ctx.db.agents.list as any).mock.calls.length).toBe(1);
    expect((ctx.db.agents.bulkUpdatePresenceByServer as any).mock.calls.length).toBe(1);
    // And the broadcast set is not duplicated (would be 2 if dedup missed).
    expect((ctx.wsHub.broadcastAgentPresenceChanged as any).mock.calls.length).toBe(1);

    handle.teardown();
  });

  it('DOES process a different swarm in the same window (dedup is per-swarm-id)', async () => {
    (ctx.db.agents.get as any).mockResolvedValue({ state: 'active' });
    (ctx.db.agents.list as any).mockResolvedValue({ agents: [{ id: 'x' }], total: 1 });

    const handle = await setupSwarmBridge(ctx as any);

    mapHubEvents.emit('swarm_offline', { swarm_id: 'swarm-A' });
    mapHubEvents.emit('swarm_offline', { swarm_id: 'swarm-B' });
    await new Promise((r) => setTimeout(r, 10));

    // Two distinct swarm IDs, both should run.
    expect((ctx.db.agents.list as any).mock.calls.length).toBe(2);

    handle.teardown();
  });
});
