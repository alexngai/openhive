import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

import { mapHubEvents } from '../../map/service.js';

// ── DAL mocks (populated per-test) ───────────────────────────────────
const listSwarmsMock = vi.fn(() => ({ data: [], total: 0 }));
const discoverNodesMock = vi.fn(() => ({ data: [], total: 0 }));
const updateSwarmMock = vi.fn();
const findSwarmByIdMock = vi.fn(() => null);

vi.mock('../../db/dal/map.js', () => ({
  listSwarms: (...args: unknown[]) => listSwarmsMock(...args),
  discoverNodes: (...args: unknown[]) => discoverNodesMock(...args),
  updateSwarm: (...args: unknown[]) => updateSwarmMock(...args),
  findSwarmById: (...args: unknown[]) => findSwarmByIdMock(...args),
}));

import { setupSwarmBridge } from '../../swarmcraft/swarm-bridge.js';
import { agentIdFromNode, agentIdFromSwarm } from '../../swarmcraft/constants.js';

const SWARM_ID = 'swarm-abc';
const RAW_AGENT_ID = 'alice';
const OH_NODE_ID = agentIdFromNode(SWARM_ID, RAW_AGENT_ID);
const OH_SWARM_ID = agentIdFromSwarm(SWARM_ID);

// ── Test context factory ─────────────────────────────────────────────
function createCtx(existingAgent: Record<string, unknown> | null = null) {
  const close = vi.fn(async () => {});
  const ctx = {
    db: {
      agents: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
        get: vi.fn(async () => existingAgent),
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
    positionService: { recordAccess: vi.fn(async () => ({})) },
    acpStreamManager: { closeStreamsForAgent: close },
  };
  return { ctx, closeStreamsForAgent: close };
}

function emitAndDrain(event: string, payload: unknown): Promise<void> {
  mapHubEvents.emit(event, payload);
  return new Promise(r => setTimeout(r, 10));
}

// ── Tests ────────────────────────────────────────────────────────────
describe('swarm-bridge — agent projection', () => {
  afterEach(() => {
    mapHubEvents.removeAllListeners('node_registered');
    mapHubEvents.removeAllListeners('node_unregistered');
    mapHubEvents.removeAllListeners('node_state_changed');
    mapHubEvents.removeAllListeners('swarm_registered');
    mapHubEvents.removeAllListeners('swarm_offline');
    vi.clearAllMocks();
  });

  it('projects node_registered as oh-node-* with capabilities + metadata', async () => {
    const { ctx } = createCtx();
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('node_registered', {
      node_id: RAW_AGENT_ID,
      swarm_id: SWARM_ID,
      map_agent_id: RAW_AGENT_ID,
      name: 'Alice',
      role: 'coordinator',
      state: 'registered',
      capabilities: { protocols: ['acp'], messaging: { canReceive: true } },
      metadata: { sessionId: 'sess-1' },
    });

    expect(ctx.db.agents.create).toHaveBeenCalledTimes(1);
    const payload = (ctx.db.agents.create as any).mock.calls[0][0];
    expect(payload.id).toBe(OH_NODE_ID);
    expect(payload.name).toBe('Alice');
    expect(payload.type).toBe('coordinator');
    expect(payload.capabilities).toEqual({
      protocols: ['acp'],
      messaging: { canReceive: true },
    });
    expect(payload.mapServerId).toBe(SWARM_ID);
    expect(payload.stateMetadata).toMatchObject({
      source: 'openhive-hub',
      swarmId: SWARM_ID,
      mapAgentId: RAW_AGENT_ID,
      agentMetadata: { sessionId: 'sess-1' },
    });
    expect(ctx.wsHub.broadcastAgentRegistered).toHaveBeenCalledWith({
      id: OH_NODE_ID,
      name: 'Alice',
      type: 'coordinator',
    });

    handle.teardown();
  });
});

describe('swarm-bridge — ACP stream cleanup (inbound mapHubEvents)', () => {
  afterEach(() => {
    mapHubEvents.removeAllListeners('node_unregistered');
    mapHubEvents.removeAllListeners('node_state_changed');
    vi.clearAllMocks();
  });

  it('node_unregistered: closes ACP streams using RAW map id and marks oh-node-* stopped', async () => {
    const { ctx, closeStreamsForAgent } = createCtx({ state: 'active' });
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('node_unregistered', {
      swarm_id: SWARM_ID,
      map_agent_id: RAW_AGENT_ID,
    });

    // Called with raw id, NOT the oh-node-* projection id
    expect(closeStreamsForAgent).toHaveBeenCalledTimes(1);
    expect(closeStreamsForAgent).toHaveBeenCalledWith(RAW_AGENT_ID);
    expect(closeStreamsForAgent).not.toHaveBeenCalledWith(OH_NODE_ID);

    expect(ctx.db.agents.update).toHaveBeenCalledWith(OH_NODE_ID, { state: 'stopped' });
    expect(ctx.wsHub.broadcastAgentStateChanged).toHaveBeenCalledWith(OH_NODE_ID, 'active', 'stopped');

    handle.teardown();
  });

  it('node_unregistered: closes ACP streams even when no projected oh-node-* row exists', async () => {
    const { ctx, closeStreamsForAgent } = createCtx(null);
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('node_unregistered', {
      swarm_id: SWARM_ID,
      map_agent_id: RAW_AGENT_ID,
    });

    expect(closeStreamsForAgent).toHaveBeenCalledWith(RAW_AGENT_ID);
    expect(ctx.db.agents.update).not.toHaveBeenCalled();
    expect(ctx.wsHub.broadcastAgentStateChanged).not.toHaveBeenCalled();

    handle.teardown();
  });

  it('node_unregistered: skips update when agent is already stopped', async () => {
    const { ctx, closeStreamsForAgent } = createCtx({ state: 'stopped' });
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('node_unregistered', {
      swarm_id: SWARM_ID,
      map_agent_id: RAW_AGENT_ID,
    });

    // Cleanup still fires (idempotent, safe even when already stopped)
    expect(closeStreamsForAgent).toHaveBeenCalledWith(RAW_AGENT_ID);
    // But we don't issue a redundant update/broadcast
    expect(ctx.db.agents.update).not.toHaveBeenCalled();
    expect(ctx.wsHub.broadcastAgentStateChanged).not.toHaveBeenCalled();

    handle.teardown();
  });

  it.each(['stopped', 'failed', 'orphaned'])(
    'node_state_changed → %s closes ACP streams using RAW map id',
    async (terminalState) => {
      const { ctx, closeStreamsForAgent } = createCtx({ state: 'active' });
      const handle = await setupSwarmBridge(ctx as any);

      await emitAndDrain('node_state_changed', {
        swarm_id: SWARM_ID,
        map_agent_id: RAW_AGENT_ID,
        previous_state: 'active',
        new_state: terminalState,
      });

      expect(closeStreamsForAgent).toHaveBeenCalledTimes(1);
      expect(closeStreamsForAgent).toHaveBeenCalledWith(RAW_AGENT_ID);

      handle.teardown();
    },
  );

  it.each(['idle', 'busy', 'suspended', 'active'])(
    'node_state_changed → %s (non-terminal) does NOT close ACP streams',
    async (nonTerminalState) => {
      const { ctx, closeStreamsForAgent } = createCtx({ state: 'active' });
      const handle = await setupSwarmBridge(ctx as any);

      await emitAndDrain('node_state_changed', {
        swarm_id: SWARM_ID,
        map_agent_id: RAW_AGENT_ID,
        previous_state: 'active',
        new_state: nonTerminalState,
      });

      expect(closeStreamsForAgent).not.toHaveBeenCalled();

      handle.teardown();
    },
  );

  it('node_state_changed → terminal still fires ACP cleanup when no projection row exists', async () => {
    const { ctx, closeStreamsForAgent } = createCtx(null);
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('node_state_changed', {
      swarm_id: SWARM_ID,
      map_agent_id: RAW_AGENT_ID,
      previous_state: 'active',
      new_state: 'failed',
    });

    expect(closeStreamsForAgent).toHaveBeenCalledWith(RAW_AGENT_ID);
    expect(ctx.db.agents.update).not.toHaveBeenCalled();

    handle.teardown();
  });

  it('does not crash when acpStreamManager is absent', async () => {
    const { ctx } = createCtx({ state: 'active' });
    delete (ctx as any).acpStreamManager;
    const handle = await setupSwarmBridge(ctx as any);

    await expect(
      emitAndDrain('node_unregistered', {
        swarm_id: SWARM_ID,
        map_agent_id: RAW_AGENT_ID,
      }),
    ).resolves.toBeUndefined();

    expect(ctx.db.agents.update).toHaveBeenCalledWith(OH_NODE_ID, { state: 'stopped' });

    handle.teardown();
  });

  it('surfaces closeStreamsForAgent rejection as warning (does not throw)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const close = vi.fn(async () => {
      throw new Error('stream-close-failed');
    });
    const ctx = {
      db: {
        agents: {
          create: vi.fn(async () => ({})),
          update: vi.fn(async () => ({})),
          get: vi.fn(async () => ({ state: 'active' })),
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
      positionService: { recordAccess: vi.fn(async () => ({})) },
      acpStreamManager: { closeStreamsForAgent: close },
    };
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('node_unregistered', {
      swarm_id: SWARM_ID,
      map_agent_id: RAW_AGENT_ID,
    });
    // Give the unhandled-rejection handler a tick to run
    await new Promise(r => setTimeout(r, 10));

    expect(close).toHaveBeenCalledWith(RAW_AGENT_ID);
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some(c => String(c[0]).includes('closeStreamsForAgent')),
    ).toBe(true);

    warnSpy.mockRestore();
    handle.teardown();
  });
});

describe('swarm-bridge — swarm reactivation (swarm_online)', () => {
  afterEach(() => {
    mapHubEvents.removeAllListeners('swarm_online');
    mapHubEvents.removeAllListeners('swarm_registered');
    vi.clearAllMocks();
    findSwarmByIdMock.mockReturnValue(null);
  });

  it('reactivates stopped oh-swarm-* row to active with broadcast', async () => {
    findSwarmByIdMock.mockReturnValue({
      map_endpoint: 'hub-inbound',
      capabilities: { messaging: true, mail: true },
    } as any);
    const { ctx } = createCtx({ state: 'stopped' });
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('swarm_online', {
      swarm_id: SWARM_ID,
      name: 'my-swarm',
    });

    expect(ctx.db.agents.get).toHaveBeenCalledWith(OH_SWARM_ID);
    expect(ctx.db.agents.update).toHaveBeenCalledWith(
      OH_SWARM_ID,
      expect.objectContaining({ name: 'my-swarm', state: 'active', mapServerId: SWARM_ID }),
    );
    expect(ctx.wsHub.broadcastAgentStateChanged).toHaveBeenCalledWith(
      OH_SWARM_ID,
      'stopped',
      'active',
    );
    expect(ctx.db.agents.create).not.toHaveBeenCalled();

    handle.teardown();
  });

  it('creates oh-swarm-* row when it does not exist (late-arrival hydration miss)', async () => {
    findSwarmByIdMock.mockReturnValue({
      map_endpoint: 'hub-inbound',
      capabilities: { messaging: true },
    } as any);
    const { ctx } = createCtx(null);
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('swarm_online', {
      swarm_id: SWARM_ID,
      name: 'late-swarm',
    });

    expect(ctx.db.agents.create).toHaveBeenCalledTimes(1);
    const payload = (ctx.db.agents.create as any).mock.calls[0][0];
    expect(payload.id).toBe(OH_SWARM_ID);
    expect(payload.type).toBe('swarm');
    expect(payload.state).toBe('active');
    expect(payload.capabilities).toEqual(['messaging']);
    expect(ctx.wsHub.broadcastAgentRegistered).toHaveBeenCalledWith({
      id: OH_SWARM_ID,
      name: 'late-swarm',
      type: 'swarm',
    });

    handle.teardown();
  });

  it('is a no-op when swarm is already active (no broadcast, no update)', async () => {
    findSwarmByIdMock.mockReturnValue({ map_endpoint: 'hub-inbound', capabilities: {} } as any);
    const { ctx } = createCtx({ state: 'active' });
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('swarm_online', {
      swarm_id: SWARM_ID,
      name: 'my-swarm',
    });

    expect(ctx.db.agents.update).not.toHaveBeenCalled();
    expect(ctx.db.agents.create).not.toHaveBeenCalled();
    expect(ctx.wsHub.broadcastAgentStateChanged).not.toHaveBeenCalled();
    expect(ctx.wsHub.broadcastAgentRegistered).not.toHaveBeenCalled();

    handle.teardown();
  });

  it('falls back to default capabilities when hub swarm record is missing', async () => {
    findSwarmByIdMock.mockReturnValue(null);
    const { ctx } = createCtx(null);
    const handle = await setupSwarmBridge(ctx as any);

    await emitAndDrain('swarm_online', {
      swarm_id: SWARM_ID,
      name: 'mystery-swarm',
    });

    const payload = (ctx.db.agents.create as any).mock.calls[0][0];
    expect(payload.capabilities).toEqual(['observation', 'messaging', 'lifecycle']);
    expect(payload.stateMetadata.endpoint).toBe('hub-inbound');

    handle.teardown();
  });
});

describe('swarm-bridge — ACP stream cleanup (outbound mapClientManager)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mapClientManager agent.unregistered closes ACP streams with raw id', async () => {
    const { ctx, closeStreamsForAgent } = createCtx(null);
    const mcm = new EventEmitter() as EventEmitter & {
      connect(opts: Record<string, unknown>): Promise<void>;
    };
    (mcm as any).connect = vi.fn(async () => {});

    const handle = await setupSwarmBridge(ctx as any, mcm as any);

    mcm.emit('agent.unregistered', {
      serverId: SWARM_ID,
      agentId: RAW_AGENT_ID,
    });
    await new Promise(r => setTimeout(r, 10));

    expect(closeStreamsForAgent).toHaveBeenCalledTimes(1);
    expect(closeStreamsForAgent).toHaveBeenCalledWith(RAW_AGENT_ID);

    handle.teardown();
  });

  it.each(['stopped', 'failed', 'orphaned'])(
    'mapClientManager agent.state.changed → %s closes ACP streams with raw id',
    async (terminalState) => {
      const { ctx, closeStreamsForAgent } = createCtx(null);
      const mcm = new EventEmitter() as EventEmitter & {
        connect(opts: Record<string, unknown>): Promise<void>;
      };
      (mcm as any).connect = vi.fn(async () => {});

      const handle = await setupSwarmBridge(ctx as any, mcm as any);

      mcm.emit('agent.state.changed', {
        serverId: SWARM_ID,
        agentId: RAW_AGENT_ID,
        previousState: 'active',
        newState: terminalState,
      });
      await new Promise(r => setTimeout(r, 10));

      expect(closeStreamsForAgent).toHaveBeenCalledWith(RAW_AGENT_ID);

      handle.teardown();
    },
  );

  it('mapClientManager agent.state.changed → non-terminal does NOT close ACP streams', async () => {
    const { ctx, closeStreamsForAgent } = createCtx(null);
    const mcm = new EventEmitter() as EventEmitter & {
      connect(opts: Record<string, unknown>): Promise<void>;
    };
    (mcm as any).connect = vi.fn(async () => {});

    const handle = await setupSwarmBridge(ctx as any, mcm as any);

    mcm.emit('agent.state.changed', {
      serverId: SWARM_ID,
      agentId: RAW_AGENT_ID,
      previousState: 'active',
      newState: 'idle',
    });
    await new Promise(r => setTimeout(r, 10));

    expect(closeStreamsForAgent).not.toHaveBeenCalled();

    handle.teardown();
  });

  it('teardown removes outbound listeners', async () => {
    const { ctx, closeStreamsForAgent } = createCtx(null);
    const mcm = new EventEmitter() as EventEmitter & {
      connect(opts: Record<string, unknown>): Promise<void>;
    };
    (mcm as any).connect = vi.fn(async () => {});

    const handle = await setupSwarmBridge(ctx as any, mcm as any);
    handle.teardown();

    mcm.emit('agent.unregistered', {
      serverId: SWARM_ID,
      agentId: RAW_AGENT_ID,
    });
    await new Promise(r => setTimeout(r, 10));

    expect(closeStreamsForAgent).not.toHaveBeenCalled();
  });
});
