import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type {
  AgentStopReason,
  DispatchAgentRuntime,
  SpawnedAgent,
} from 'swarm-dispatch';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import type { Dispatch, DispatchLinkedTaskRef } from '../db/dal/dispatches.js';
import { findRepoById } from '../db/dal/repos.js';
import { findSwarmById } from '../db/dal/map.js';
import type { MapSwarm } from '../map/types.js';
import type { SyncableResource } from '../types.js';
import { markDelivery } from './delivery-tracker.js';

type JsonObject = Record<string, unknown>;

export interface CodexExecutorConfig {
  enabled?: boolean;
  target_kind?: string;
  map_server?: string;
  map_token?: string;
  command?: string;
  driver?: 'mcp' | 'exec';
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  timeoutMs?: number;
  attributionRefreshMs?: number;
  role_map?: JsonObject;
  concurrency_per_repo?: number;
}

interface CodexCoordinationPlane {
  startRun(info?: JsonObject): Promise<unknown> | unknown;
  stopRun(): Promise<unknown> | unknown;
  recordCascadeAttribution?: (input: unknown) => boolean;
}

interface CodexRuntimeHandle {
  runtime: DispatchAgentRuntime;
  stop(opts?: { awaitInflightMs?: number }): Promise<void> | void;
}

interface SwarmCodexModule {
  CoordinationPlane: new (opts: JsonObject) => CodexCoordinationPlane;
  createCodexDispatchRuntime(opts: JsonObject): Promise<CodexRuntimeHandle>;
}

interface RuntimeEntry {
  cwd: string;
  coord: CodexCoordinationPlane;
  handle: CodexRuntimeHandle;
  unsubscribeStopped: () => void;
}

export interface OpenHiveSwarmCodexRuntimeOptions {
  baseRuntime: DispatchAgentRuntime;
  config?: CodexExecutorConfig;
  findDispatch?: (id: string) => Dispatch | null;
  findSwarm?: (id: string) => MapSwarm | null;
  findRepo?: (id: string) => Pick<SyncableResource, 'local_path'> | null;
  getLinkedTasks?: (dispatchId: string) => DispatchLinkedTaskRef[];
  recordDelivery?: (taskId: string, hint: { transport: 'codex'; agent_id?: string }) => void;
  verifyGitRepo?: (cwd: string) => boolean;
  createCoordinationPlane?: (opts: JsonObject) => Promise<CodexCoordinationPlane> | CodexCoordinationPlane;
  createCodexRuntime?: (opts: JsonObject) => Promise<CodexRuntimeHandle>;
  loadSwarmCodex?: () => Promise<SwarmCodexModule>;
}

export type SwarmCodexDispatchRuntime = DispatchAgentRuntime & {
  stopAll(): Promise<void>;
};

const DEFAULT_TARGET_KIND = 'swarm-codex';
const DEFAULT_CODEX_SANDBOX: NonNullable<CodexExecutorConfig['sandbox']> = 'danger-full-access';

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function normalizeKind(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * v1 executor targeting is explicit. Hosted `kind="codex"` rows are not
 * dispatch executors unless the operator also marks the MAP swarm row with
 * the configured target kind/capability.
 */
export function isSwarmCodexExecutorTarget(
  swarm: MapSwarm | null | undefined,
  targetKind = DEFAULT_TARGET_KIND,
): boolean {
  if (!swarm) return false;
  const target = targetKind || DEFAULT_TARGET_KIND;
  const metadata = asObject(swarm.metadata);
  const capabilities = asObject(swarm.capabilities);
  const dispatch = asObject(capabilities.dispatch);

  const stringMarkers = [
    metadata.kind,
    metadata.executor_kind,
    metadata.dispatch_executor,
    capabilities.kind,
    capabilities.executor_kind,
    dispatch.kind,
    dispatch.executor,
  ].map(normalizeKind);

  if (stringMarkers.includes(target)) return true;
  if (capabilities.codex_executor === true) return true;
  if (dispatch.codex_executor === true) return true;

  const executors = Array.isArray(dispatch.executors)
    ? dispatch.executors.map(normalizeKind)
    : [];
  return executors.includes(target);
}

export function appendSwarmIdToMapServer(
  mapServer: string | undefined,
  swarmId: string,
  token?: string,
): string | undefined {
  if (!mapServer) return undefined;
  try {
    const url = new URL(mapServer);
    if (!url.searchParams.has('swarm_id')) url.searchParams.set('swarm_id', swarmId);
    if (token && !url.searchParams.has('token')) url.searchParams.set('token', token);
    return url.toString();
  } catch {
    const joiner = mapServer.includes('?') ? '&' : '?';
    const encoded = `swarm_id=${encodeURIComponent(swarmId)}`;
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    return `${mapServer}${joiner}${encoded}${tokenParam}`;
  }
}

export function resolveDispatchRepoPath(
  dispatch: Dispatch,
  repo: Pick<SyncableResource, 'local_path'> | null,
): string {
  const candidate = dispatch.clone_path ?? repo?.local_path ?? null;
  if (!candidate) {
    throw new Error(
      `swarm-codex executor requires dispatch.clone_path or repo.local_path for dispatch ${dispatch.id}`,
    );
  }
  return path.resolve(candidate);
}

function defaultVerifyGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

async function defaultLoadSwarmCodex(): Promise<SwarmCodexModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<SwarmCodexModule>;
  return dynamicImport('swarm-codex');
}

function firstTaskRef(refs: DispatchLinkedTaskRef[]): DispatchLinkedTaskRef | null {
  return refs[0] ?? null;
}

function buildRoleMap(
  cfg: CodexExecutorConfig,
  defaultRole: string,
): JsonObject {
  const sandbox = cfg.sandbox ?? DEFAULT_CODEX_SANDBOX;
  const configured = asObject(cfg.role_map);
  if (Object.keys(configured).length === 0) {
    return { [defaultRole]: { sandbox } };
  }
  return {
    map: configured,
    resolve: ({ role }: { role?: string }) => {
      const roleOpts = asObject(configured[role ?? defaultRole]);
      return roleOpts.sandbox ? roleOpts : { sandbox, ...roleOpts };
    },
  };
}

export function createOpenHiveSwarmCodexRuntime(
  opts: OpenHiveSwarmCodexRuntimeOptions,
): SwarmCodexDispatchRuntime {
  const cfg = opts.config ?? {};
  const enabled = cfg.enabled === true;
  const targetKind = cfg.target_kind ?? DEFAULT_TARGET_KIND;
  const baseRuntime = opts.baseRuntime;
  const findDispatch = opts.findDispatch ?? dispatchesDAL.findDispatchById;
  const findSwarm = opts.findSwarm ?? findSwarmById;
  const findRepo = opts.findRepo ?? findRepoById;
  const getLinkedTasks = opts.getLinkedTasks ?? dispatchesDAL.getDispatchLinkedTasks;
  const recordDelivery = opts.recordDelivery ?? markDelivery;
  const verifyGitRepo = opts.verifyGitRepo ?? defaultVerifyGitRepo;
  const loadSwarmCodex = opts.loadSwarmCodex ?? defaultLoadSwarmCodex;

  const entriesByCwd = new Map<string, RuntimeEntry>();
  const entryByAgent = new Map<string, RuntimeEntry>();
  const cwdByAgent = new Map<string, string>();
  const activeByCwd = new Map<string, number>();
  const waitersByCwd = new Map<string, Array<() => void>>();
  const stoppedListeners = new Set<(agentId: string, reason: AgentStopReason) => void>();

  function emitStopped(agentId: string, reason: AgentStopReason): void {
    for (const cb of stoppedListeners) {
      cb(agentId, reason);
    }
  }

  async function createCoord(optsForCoord: JsonObject): Promise<CodexCoordinationPlane> {
    if (opts.createCoordinationPlane) {
      return opts.createCoordinationPlane(optsForCoord);
    }
    const mod = await loadSwarmCodex();
    return new mod.CoordinationPlane(optsForCoord);
  }

  async function createCodexRuntime(optsForRuntime: JsonObject): Promise<CodexRuntimeHandle> {
    if (opts.createCodexRuntime) {
      return opts.createCodexRuntime(optsForRuntime);
    }
    const mod = await loadSwarmCodex();
    return mod.createCodexDispatchRuntime(optsForRuntime);
  }

  function resolveVerifiedCwd(dispatch: Dispatch): string {
    const repo = dispatch.repo_id ? findRepo(dispatch.repo_id) : null;
    const cwd = resolveDispatchRepoPath(dispatch, repo);
    if (!verifyGitRepo(cwd)) {
      throw new Error(`swarm-codex executor requires a git repository: ${cwd}`);
    }
    return cwd;
  }

  async function waitForRepoSlot(cwd: string): Promise<void> {
    const limit = cfg.concurrency_per_repo ?? 1;
    if (limit <= 0) return;
    while ((activeByCwd.get(cwd) ?? 0) >= limit) {
      await new Promise<void>((resolve) => {
        const queue = waitersByCwd.get(cwd) ?? [];
        queue.push(resolve);
        waitersByCwd.set(cwd, queue);
      });
    }
    activeByCwd.set(cwd, (activeByCwd.get(cwd) ?? 0) + 1);
  }

  function releaseRepoSlot(cwd: string): void {
    const next = Math.max(0, (activeByCwd.get(cwd) ?? 0) - 1);
    if (next === 0) activeByCwd.delete(cwd);
    else activeByCwd.set(cwd, next);
    const queue = waitersByCwd.get(cwd);
    const wake = queue?.shift();
    if (queue && queue.length === 0) waitersByCwd.delete(cwd);
    if (wake) wake();
  }

  async function ensureRuntime(dispatch: Dispatch, role: string, cwd: string): Promise<RuntimeEntry> {

    const existing = entriesByCwd.get(cwd);
    if (existing) return existing;

    const runId = `openhive-${dispatch.id}`;
    const mapServer = appendSwarmIdToMapServer(
      cfg.map_server,
      dispatch.target_swarm_id,
      cfg.map_token,
    );
    const coord = await createCoord({
      cwd,
      runId,
      config: {
        map: {
          enabled: Boolean(mapServer),
          server: mapServer,
          scope: `swarm:${dispatch.target_swarm_id}`,
          systemId: 'swarm-codex',
        },
        cascade: { enabled: true },
        opentasks: { enabled: false },
        inbox: { enabled: false },
        sessionlog: { enabled: true, sync: 'metrics', mode: 'plugin' },
      },
    });
    await coord.startRun({
      template: 'openhive-dispatch',
      roleNames: [role],
      dispatchMode: 'autonomous',
    });

    let handle: CodexRuntimeHandle;
    try {
      handle = await createCodexRuntime({
        cwd,
        coord,
        roleMap: buildRoleMap(cfg, role),
        driver: cfg.driver ?? 'mcp',
        command: cfg.command ?? 'codex',
        timeoutMs: cfg.timeoutMs,
        defaultRole: role,
        attributionRefreshMs: cfg.attributionRefreshMs ?? 2_000,
        taskRefResolver: ({ taskId }: { taskId: string }) => firstTaskRef(getLinkedTasks(taskId)),
      });
    } catch (err) {
      await coord.stopRun();
      throw err;
    }

    const entry: RuntimeEntry = {
      cwd,
      coord,
      handle,
      unsubscribeStopped: handle.runtime.onStopped((agentId, reason) => {
        entryByAgent.delete(agentId);
        const agentCwd = cwdByAgent.get(agentId);
        if (agentCwd) {
          cwdByAgent.delete(agentId);
          releaseRepoSlot(agentCwd);
        }
        emitStopped(agentId, reason);
      }),
    };
    entriesByCwd.set(cwd, entry);
    return entry;
  }

  const runtime: SwarmCodexDispatchRuntime = {
    async spawn(spawnOpts: { prompt: string; taskId: string; role: string }): Promise<SpawnedAgent> {
      if (!enabled) return baseRuntime.spawn(spawnOpts);

      const dispatch = findDispatch(spawnOpts.taskId);
      if (!dispatch) return baseRuntime.spawn(spawnOpts);

      const swarm = findSwarm(dispatch.target_swarm_id);
      if (!isSwarmCodexExecutorTarget(swarm, targetKind)) {
        return baseRuntime.spawn(spawnOpts);
      }

      const cwd = resolveVerifiedCwd(dispatch);
      await waitForRepoSlot(cwd);
      try {
        const entry = await ensureRuntime(dispatch, spawnOpts.role, cwd);
        const spawned = await entry.handle.runtime.spawn(spawnOpts);
        entryByAgent.set(spawned.id, entry);
        cwdByAgent.set(spawned.id, cwd);
        recordDelivery(spawnOpts.taskId, { transport: 'codex', agent_id: spawned.id });
        return spawned;
      } catch (err) {
        releaseRepoSlot(cwd);
        throw err;
      }
    },

    async terminate(agentId: string, reason: AgentStopReason): Promise<void> {
      const entry = entryByAgent.get(agentId);
      if (entry) {
        await entry.handle.runtime.terminate(agentId, reason);
        return;
      }
      await baseRuntime.terminate(agentId, reason);
    },

    onStopped(callback: (agentId: string, reason: AgentStopReason) => void): () => void {
      stoppedListeners.add(callback);
      const unsubscribeBase = baseRuntime.onStopped(callback);
      return () => {
        stoppedListeners.delete(callback);
        unsubscribeBase();
      };
    },

    onUsage: baseRuntime.onUsage
      ? (callback) => baseRuntime.onUsage!(callback)
      : undefined,

    async stopAll(): Promise<void> {
      for (const entry of entriesByCwd.values()) {
        entry.unsubscribeStopped();
        await entry.handle.stop({ awaitInflightMs: 0 });
        await entry.coord.stopRun();
      }
      entriesByCwd.clear();
      entryByAgent.clear();
      cwdByAgent.clear();
      activeByCwd.clear();
      for (const queue of waitersByCwd.values()) {
        for (const wake of queue) wake();
      }
      waitersByCwd.clear();
    },
  };

  return runtime;
}
