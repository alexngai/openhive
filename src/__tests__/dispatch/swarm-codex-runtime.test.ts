import { describe, expect, it, vi } from 'vitest';
import type { AgentStopReason, DispatchAgentRuntime } from 'swarm-dispatch';
import {
  appendSwarmIdToMapServer,
  createOpenHiveSwarmCodexRuntime,
  isSwarmCodexExecutorTarget,
  resolveDispatchRepoPath,
} from '../../dispatch/swarm-codex-runtime.js';
import type { Dispatch } from '../../db/dal/dispatches.js';
import type { MapSwarm } from '../../map/types.js';

function fakeBaseRuntime(): DispatchAgentRuntime & {
  spawnMock: ReturnType<typeof vi.fn>;
  terminateMock: ReturnType<typeof vi.fn>;
} {
  const stopped = new Set<(agentId: string, reason: AgentStopReason) => void>();
  const spawnMock = vi.fn(async () => ({ id: 'base-agent' }));
  const terminateMock = vi.fn(async () => {});
  return {
    spawnMock,
    terminateMock,
    spawn: spawnMock,
    terminate: terminateMock,
    onStopped(callback) {
      stopped.add(callback);
      return () => stopped.delete(callback);
    },
  };
}

function fakeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'dispatch-1',
    spec_resource_id: 'tasks',
    spec_id: 'spec-1',
    spec_captured_at: null,
    target_swarm_id: 'swarm-codex-1',
    status: 'queued',
    initiator_type: 'user',
    initiator_id: 'agent-1',
    session_ids: [],
    outcome: null,
    prompt_override: null,
    lease_token: null,
    lease_expires_at: null,
    attempt: 0,
    turn_count: 0,
    attempts_history: [],
    loadout_bundle_id: null,
    team_bundle_id: null,
    role: null,
    loadout_resource_id: null,
    team_template_resource_id: null,
    team_conversation_id: null,
    acp_lifecycle: null,
    mail_lifecycle: null,
    loadout_ref: null,
    loadout_status: null,
    loadout_error: null,
    conversation_id: null,
    repo_id: 'repo-1',
    canonical_url: null,
    branch: null,
    commit_sha: null,
    clone_policy: 'none',
    clone_path: '/tmp/project',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeSwarm(overrides: Partial<MapSwarm>): MapSwarm {
  return {
    id: 'swarm-codex-1',
    name: 'swarm-codex',
    description: null,
    map_endpoint: 'hub-inbound',
    map_transport: 'websocket',
    owner_agent_id: 'agent-1',
    status: 'online',
    last_seen_at: new Date().toISOString(),
    capabilities: null,
    auth_method: 'none',
    auth_token_hash: null,
    agent_count: 1,
    scope_count: 0,
    headscale_node_id: null,
    tailscale_ips: null,
    tailscale_dns_name: null,
    metadata: null,
    archived: false,
    canonical_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('swarm-codex runtime helpers', () => {
  it('requires an explicit swarm-codex executor marker', () => {
    expect(
      isSwarmCodexExecutorTarget(fakeSwarm({
        metadata: { kind: 'codex' },
        capabilities: null,
      })),
    ).toBe(false);

    expect(
      isSwarmCodexExecutorTarget(fakeSwarm({
        metadata: { kind: 'swarm-codex' },
        capabilities: null,
      })),
    ).toBe(true);

    expect(
      isSwarmCodexExecutorTarget(fakeSwarm({
        metadata: null,
        capabilities: {
          dispatch: { executors: ['swarm-codex'] },
        } as unknown as MapSwarm['capabilities'],
      })),
    ).toBe(true);
  });

  it('adds swarm_id and token to the local MAP server URL', () => {
    expect(
      appendSwarmIdToMapServer('ws://127.0.0.1:7836/ws/map', 'swarm-1', 'tok'),
    ).toBe('ws://127.0.0.1:7836/ws/map?swarm_id=swarm-1&token=tok');
  });

  it('resolves dispatch clone_path before repo local_path', () => {
    expect(
      resolveDispatchRepoPath(
        fakeDispatch({ clone_path: '/tmp/clone' }),
        { local_path: '/tmp/repo' },
      ),
    ).toBe('/tmp/clone');
  });
});

describe('createOpenHiveSwarmCodexRuntime', () => {
  it('delegates to the base runtime when target is not a swarm-codex executor', async () => {
    const base = fakeBaseRuntime();
    const runtime = createOpenHiveSwarmCodexRuntime({
      baseRuntime: base,
      config: { enabled: true },
      findDispatch: () => fakeDispatch(),
      findSwarm: () => fakeSwarm({ metadata: { kind: 'codex' }, capabilities: null }),
    });

    await runtime.spawn({ prompt: 'work', taskId: 'dispatch-1', role: 'worker' });

    expect(base.spawnMock).toHaveBeenCalledWith({
      prompt: 'work',
      taskId: 'dispatch-1',
      role: 'worker',
    });
  });

  it('spawns via swarm-codex, records delivery, and exposes linked task refs', async () => {
    const base = fakeBaseRuntime();
    const coord = {
      startRun: vi.fn(async () => {}),
      stopRun: vi.fn(async () => {}),
      recordCascadeAttribution: vi.fn(() => true),
    };
    const spawnMock = vi.fn(async () => ({ id: 'worker-dispatch-1-abc123' }));
    const stopMock = vi.fn(async () => {});
    const createCoordinationPlane = vi.fn(async (_opts: Record<string, unknown>) => coord);
    const createCodexRuntime = vi.fn(async (_opts: Record<string, unknown>) => ({
      runtime: {
        spawn: spawnMock,
        terminate: vi.fn(async () => {}),
        onStopped: vi.fn(() => vi.fn()),
      },
      stop: stopMock,
    }));
    const recordDelivery = vi.fn();

    const runtime = createOpenHiveSwarmCodexRuntime({
      baseRuntime: base,
      config: {
        enabled: true,
        map_server: 'ws://127.0.0.1:7836/ws/map',
      },
      findDispatch: () => fakeDispatch(),
      findSwarm: () => fakeSwarm({ metadata: { kind: 'swarm-codex' }, capabilities: null }),
      findRepo: () => ({ local_path: '/tmp/repo' }),
      getLinkedTasks: () => [{ resource_id: 'tasks', node_id: 'task-1' }],
      recordDelivery,
      verifyGitRepo: () => true,
      createCoordinationPlane,
      createCodexRuntime,
    });

    const spawned = await runtime.spawn({
      prompt: 'complete this',
      taskId: 'dispatch-1',
      role: 'worker',
    });

    expect(spawned.id).toBe('worker-dispatch-1-abc123');
    expect(spawnMock).toHaveBeenCalledWith({
      prompt: 'complete this',
      taskId: 'dispatch-1',
      role: 'worker',
    });
    expect(recordDelivery).toHaveBeenCalledWith('dispatch-1', {
      transport: 'codex',
      agent_id: 'worker-dispatch-1-abc123',
    });
    expect(createCoordinationPlane).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/project',
        runId: 'openhive-dispatch-1',
      }),
    );
    const coordArgs = createCoordinationPlane.mock.calls[0]?.[0] as {
      config: { map: { server: string }; sessionlog: { enabled: boolean; sync: string; mode: string } };
    };
    const coordConfig = coordArgs.config as {
      map: { server: string };
      sessionlog: { enabled: boolean; sync: string; mode: string };
    };
    expect(coordConfig.map.server).toContain('swarm_id=swarm-codex-1');
    expect(coordConfig.sessionlog).toEqual({
      enabled: true,
      sync: 'metrics',
      mode: 'plugin',
    });
    expect(coord.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchMode: 'autonomous' }),
    );
    const runtimeOpts = createCodexRuntime.mock.calls[0]?.[0] as {
      roleMap: { worker?: { sandbox?: string } };
      taskRefResolver: (input: { taskId: string }) => { resource_id: string; node_id: string } | null;
    };
    expect(runtimeOpts.roleMap.worker?.sandbox).toBe('danger-full-access');
    expect(runtimeOpts.taskRefResolver({ taskId: 'dispatch-1' })).toEqual({
      resource_id: 'tasks',
      node_id: 'task-1',
    });

    await runtime.stopAll();
    expect(stopMock).toHaveBeenCalledWith({ awaitInflightMs: 0 });
    expect(coord.stopRun).toHaveBeenCalled();
  });

  it('serializes same-repo codex dispatches by default', async () => {
    const base = fakeBaseRuntime();
    let stoppedCallback:
      | ((agentId: string, reason: AgentStopReason) => void)
      | undefined;
    const spawnMock = vi.fn(async ({ taskId }: { taskId: string }) => ({
      id: `worker-${taskId}`,
    }));

    const runtime = createOpenHiveSwarmCodexRuntime({
      baseRuntime: base,
      config: { enabled: true },
      findDispatch: (id) => fakeDispatch({ id }),
      findSwarm: () => fakeSwarm({ metadata: { kind: 'swarm-codex' } }),
      findRepo: () => ({ local_path: '/tmp/repo' }),
      verifyGitRepo: () => true,
      createCoordinationPlane: vi.fn(async () => ({
        startRun: vi.fn(async () => {}),
        stopRun: vi.fn(async () => {}),
      })),
      createCodexRuntime: vi.fn(async () => ({
        runtime: {
          spawn: spawnMock,
          terminate: vi.fn(async () => {}),
          onStopped(callback: (agentId: string, reason: AgentStopReason) => void) {
            stoppedCallback = callback;
            return vi.fn();
          },
        },
        stop: vi.fn(async () => {}),
      })),
    });

    const first = await runtime.spawn({
      prompt: 'first',
      taskId: 'dispatch-1',
      role: 'worker',
    });
    const secondPromise = runtime.spawn({
      prompt: 'second',
      taskId: 'dispatch-2',
      role: 'worker',
    });

    await Promise.resolve();
    expect(first.id).toBe('worker-dispatch-1');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    stoppedCallback?.('worker-dispatch-1', 'completed');
    const second = await secondPromise;
    expect(second.id).toBe('worker-dispatch-2');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
