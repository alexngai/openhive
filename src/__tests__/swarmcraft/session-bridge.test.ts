import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mapHubEvents } from '../../map/service.js';

// Mock DALs
vi.mock('../../db/dal/trajectory-checkpoints.js', () => ({
  listAllSessions: vi.fn(() => ({ data: [], total: 0 })),
  listCheckpointsForSession: vi.fn(() => ({ data: [], total: 0 })),
  getSessionStats: vi.fn(() => ({
    total_checkpoints: 0, total_input_tokens: 0, total_output_tokens: 0,
    total_files_touched: 0, latest_agent: null, first_synced_at: null, last_synced_at: null,
  })),
}));
vi.mock('../../db/dal/syncable-resources.js', () => ({
  findResourceById: vi.fn(() => null),
}));
vi.mock('../../db/dal/map.js', () => ({
  findSwarmById: vi.fn(() => null),
}));

import { setupSessionBridge } from '../../swarmcraft/session-bridge.js';

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
    trajectoryService: {
      startTurn: vi.fn(async () => ({})),
      recordAction: vi.fn(async () => ({})),
      endCurrentTurn: vi.fn(async () => {}),
    },
  };
}

describe('Session Bridge', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    mapHubEvents.removeAllListeners('trajectory_checkpoint');
  });

  it('should create a session agent on trajectory_checkpoint', async () => {
    const handle = await setupSessionBridge(ctx as any);

    mapHubEvents.emit('trajectory_checkpoint', {
      session_resource_id: 'res-1',
      checkpoint_id: 'cp-1',
      agent: 'sidecar',
      files_touched: ['src/index.ts'],
      source_swarm_id: 'swarm-1',
      created: true,
    });

    // Allow async handler to run
    await new Promise(r => setTimeout(r, 10));

    expect(ctx.db.agents.create).toHaveBeenCalled();
    expect(ctx.wsHub.broadcastAgentRegistered).toHaveBeenCalled();
    handle.teardown();
  });

  it('should normalize absolute paths to relative using projectPath', async () => {
    const handle = await setupSessionBridge(ctx as any);

    mapHubEvents.emit('trajectory_checkpoint', {
      session_resource_id: 'res-1',
      checkpoint_id: 'cp-1',
      agent: 'sidecar',
      files_touched: ['/Users/test/my-project/src/server.ts'],
      projectPath: '/Users/test/my-project',
      source_swarm_id: 'swarm-1',
      created: true,
    });

    await new Promise(r => setTimeout(r, 10));

    // normalizeFilePath strips the project root to produce relative paths
    const calls = ctx.positionService.recordAccess.mock.calls;
    const paths = calls.map((c: unknown[]) => c[1]);
    expect(paths).toContain('src/server.ts');

    handle.teardown();
  });

  it('should pass through already-relative paths unchanged', async () => {
    const handle = await setupSessionBridge(ctx as any);

    mapHubEvents.emit('trajectory_checkpoint', {
      session_resource_id: 'res-1',
      checkpoint_id: 'cp-1',
      agent: 'sidecar',
      files_touched: ['src/server.ts'],
      projectPath: '/Users/test/my-project',
      source_swarm_id: 'swarm-1',
      created: true,
    });

    await new Promise(r => setTimeout(r, 10));

    const calls = ctx.positionService.recordAccess.mock.calls;
    const paths = calls.map((c: unknown[]) => c[1]);
    // Already relative, so normalizeFilePath returns it as-is
    expect(paths).toContain('src/server.ts');

    handle.teardown();
  });

  it('should record without project prefix when projectPath is absent', async () => {
    const handle = await setupSessionBridge(ctx as any);

    mapHubEvents.emit('trajectory_checkpoint', {
      session_resource_id: 'res-1',
      checkpoint_id: 'cp-1',
      agent: 'sidecar',
      files_touched: ['src/app.ts'],
      source_swarm_id: 'swarm-1',
      created: true,
    });

    await new Promise(r => setTimeout(r, 10));

    const calls = ctx.positionService.recordAccess.mock.calls;
    const paths = calls.map((c: unknown[]) => c[1]);
    expect(paths).toContain('src/app.ts');

    handle.teardown();
  });

  it('should record trajectory turns and actions', async () => {
    const handle = await setupSessionBridge(ctx as any);

    mapHubEvents.emit('trajectory_checkpoint', {
      session_resource_id: 'res-1',
      checkpoint_id: 'cp-1',
      agent: 'sidecar',
      files_touched: ['a.ts', 'b.ts'],
      projectPath: '/test/proj',
      source_swarm_id: 'swarm-1',
      created: true,
    });

    await new Promise(r => setTimeout(r, 10));

    expect(ctx.trajectoryService.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'cp-1', agentId: expect.stringContaining('oh-session-') }),
    );
    expect(ctx.trajectoryService.recordAction).toHaveBeenCalledTimes(2);
    expect(ctx.trajectoryService.endCurrentTurn).toHaveBeenCalled();

    handle.teardown();
  });

  it('should remove listeners on teardown', async () => {
    const handle = await setupSessionBridge(ctx as any);
    const count = mapHubEvents.listenerCount('trajectory_checkpoint');

    handle.teardown();

    expect(mapHubEvents.listenerCount('trajectory_checkpoint')).toBeLessThan(count);
  });
});
