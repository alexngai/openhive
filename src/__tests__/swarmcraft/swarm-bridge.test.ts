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
      },
      tasks: { create: vi.fn(), update: vi.fn(), get: vi.fn(), assign: vi.fn() },
      events: { create: vi.fn() },
    },
    wsHub: {
      broadcastAgentRegistered: vi.fn(),
      broadcastAgentStateChanged: vi.fn(),
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
