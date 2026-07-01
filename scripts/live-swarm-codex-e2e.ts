import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { createHive, type HiveServer } from '../src/server.js';
import { getOrCreateLocalAgent } from '../src/db/dal/agents.js';
import { createDispatch, addDispatchLinkedTasks, findDispatchById, type Dispatch } from '../src/db/dal/dispatches.js';
import { createSwarm, findSwarmById } from '../src/db/dal/map.js';
import { createResource } from '../src/db/dal/syncable-resources.js';
import { listStreams, listChangesForStream } from '../src/db/dal/cascade-streams.js';
import { getConnectionHealth } from '../src/map/connection-registry.js';

type TerminalDispatchStatus = 'complete' | 'failed' | 'cancelled';

interface VerificationResult {
  root: string;
  repoDir: string;
  dbPath: string;
  port: number;
  dispatchId: string;
  swarmId: string;
  marker: string;
  finalDispatch: Dispatch;
  commitLog: string;
  mapHealth: ReturnType<typeof getConnectionHealth>;
  cascade: {
    streamId: string;
    changeId: string | null;
    commitHash: string | null;
    filesTouched: string[];
    taskResourceId: string | null;
    taskNodeId: string | null;
  };
  sessionlog: {
    stateDir: string;
    files: string[];
    stateFile: string | null;
    phase: string | null;
    firstPromptIncludesMarker: boolean;
    cachePath: string;
    cacheExists: boolean;
    cacheSessionId: string | null;
  };
}

const TERMINAL_STATUSES = new Set<TerminalDispatchStatus>(['complete', 'failed', 'cancelled']);

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assertCodexAvailable(): void {
  run('codex', ['--version'], process.cwd());
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  if (!port) throw new Error('failed to allocate a free port');
  return port;
}

async function waitFor<T>(
  label: string,
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`timed out waiting for ${label}.${suffix}`);
}

function prepareGitRepo(root: string): string {
  const repoDir = path.join(root, 'target-repo');
  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  run('git', ['config', 'user.email', 'openhive-e2e@example.local'], repoDir);
  run('git', ['config', 'user.name', 'OpenHive E2E'], repoDir);
  writeFileSync(path.join(repoDir, 'README.md'), '# OpenHive swarm-codex live e2e\n');
  run('git', ['add', 'README.md'], repoDir);
  run('git', ['commit', '-m', 'initial commit'], repoDir);
  return repoDir;
}

async function writeOpenHiveConfig(root: string, port: number): Promise<string> {
  const dataDir = path.join(root, 'openhive-home');
  const dbPath = path.join(dataDir, 'data', 'openhive.db');
  await mkdir(path.dirname(dbPath), { recursive: true });

  const configPath = path.join(root, 'openhive.config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        port,
        host: '127.0.0.1',
        mode: 'server',
        database: dbPath,
        instance: {
          name: 'OpenHive swarm-codex live e2e',
          description: 'Local verification harness',
          url: `http://127.0.0.1:${port}`,
          public: false,
        },
        admin: { createOnStartup: false, trustLocalMode: true },
        auth: { mode: 'local' },
        rateLimit: { enabled: false },
        cors: { enabled: false },
        mapHub: {
          enabled: true,
          trustModel: 'open',
          iamSecret: 'swarm-codex-live-e2e',
          staleThresholdMinutes: 60,
        },
        swarmHosting: { enabled: false },
        swarmcraft: { enabled: false },
        learning: { enabled: false },
        sync: { enabled: false },
        federation: { enabled: false, peers: [] },
        swarmhub: { enabled: false },
        autoPull: { intervalMinutes: 999 },
        sessions: { type: 'none' },
        dispatch: {
          globalConcurrency: 1,
          pollIntervalMs: 1000,
          reconcileIntervalMs: 1000,
          scorer: 'noop',
          retry: { maxRetries: 0, baseDelayMs: 1000, maxDelayMs: 1000 },
          continuation: { maxTurns: 1, maxThreadTurns: 0 },
          codex_executor: {
            enabled: true,
            target_kind: 'swarm-codex',
            command: 'codex',
            driver: 'mcp',
            timeoutMs: 300000,
            attributionRefreshMs: 1000,
            concurrency_per_repo: 1,
          },
        },
        cascade: { defaultClosePolicy: 'manual' },
      },
      null,
      2,
    ),
  );
  return configPath;
}

function latestSessionlogFiles(repoDir: string): { stateDir: string; files: string[] } {
  const stateDir = path.join(repoDir, '.git', 'sessionlog-sessions');
  if (!existsSync(stateDir)) return { stateDir, files: [] };
  const files = readdirSync(stateDir)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => {
      const aTime = statSync(path.join(stateDir, a)).mtimeMs;
      const bTime = statSync(path.join(stateDir, b)).mtimeMs;
      return bTime - aTime;
    });
  return { stateDir, files };
}

async function main(): Promise<VerificationResult> {
  assertCodexAvailable();

  const root = mkdtempSync(path.join(tmpdir(), 'openhive-swarm-codex-live-'));
  const repoDir = prepareGitRepo(root);
  const port = await getFreePort();
  const configPath = await writeOpenHiveConfig(root, port);
  const dbPath = path.join(root, 'openhive-home', 'data', 'openhive.db');
  const marker = `marker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const swarmId = `swarm-codex-live-${Date.now()}`;
  const taskResourceId = 'tasks-live-swarm-codex-e2e';
  const taskNodeId = `task-${marker}`;

  const savedEnv = new Map<string, string | undefined>();
  for (const key of [
    'OPENHIVE_HOME',
    'OPENHIVE_DATABASE',
    'OPENHIVE_PORT',
    'OPENHIVE_HOST',
    'SWARMHUB_API_URL',
    'SWARMHUB_HIVE_TOKEN',
  ]) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.OPENHIVE_HOME = path.join(root, 'openhive-home');

  let server: HiveServer | null = null;
  try {
    server = await createHive(configPath);

    const owner = await getOrCreateLocalAgent();
    createSwarm(owner.id, {
      id: swarmId,
      name: 'swarm-codex local executor',
      description: 'Local swarm-codex executor target for live e2e',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
      metadata: { kind: 'swarm-codex', origin: 'live-e2e' },
      capabilities: {
        dispatch: { executors: ['swarm-codex'], codex_executor: true },
        codex_executor: true,
        protocols: ['map', 'git-cascade'],
      } as never,
    });

    const repo = createResource({
      resource_type: 'repo',
      name: 'swarm-codex-live-e2e-repo',
      description: 'Temporary repo for swarm-codex live e2e',
      git_remote_url: `file://${repoDir}`,
      visibility: 'private',
      owner_agent_id: owner.id,
      scope: 'manual',
      sync_strategy: 'metadata',
      local_path: repoDir,
      metadata: { origin: 'live-e2e' },
    });

    const prompt = [
      'You are verifying OpenHive dispatch through swarm-codex.',
      `In this git repo, create a file named LIVE_CODEX_E2E.txt containing exactly this marker on its own line: ${marker}`,
      `Then run git status, git add LIVE_CODEX_E2E.txt, and git commit -m "live e2e codex dispatch ${marker}".`,
      'Do not modify any other files. Do not ask questions. Finish after the commit is created.',
    ].join('\n');

    const dispatch = createDispatch({
      target_swarm_id: swarmId,
      initiator_type: 'user',
      initiator_id: owner.id,
      prompt_override: prompt,
      repo_id: repo.id,
      clone_path: repoDir,
      status: 'queued',
      role: 'worker',
      acp_lifecycle: 'fresh',
      mail_lifecycle: 'fresh',
    });
    addDispatchLinkedTasks(dispatch.id, [{ resource_id: taskResourceId, node_id: taskNodeId }]);

    const address = await server.start();
    console.log(`[live-e2e] OpenHive listening at ${address}`);
    console.log(`[live-e2e] temp root: ${root}`);
    console.log(`[live-e2e] dispatch: ${dispatch.id}`);
    console.log(`[live-e2e] repo: ${repoDir}`);

    await waitFor(
      'MAP inbound swarm-codex connection',
      () => {
        const health = getConnectionHealth(swarmId, 3);
        return health && health.registeredAgentCount > 0 ? health : null;
      },
      120000,
      1000,
    );

    const finalDispatch = await waitFor(
      'dispatch terminal status',
      () => {
        const current = findDispatchById(dispatch.id);
        if (!current) throw new Error(`dispatch disappeared: ${dispatch.id}`);
        if (TERMINAL_STATUSES.has(current.status as TerminalDispatchStatus)) return current;
        return null;
      },
      420000,
      2000,
    );

    if (finalDispatch.status !== 'complete') {
      throw new Error(
        `dispatch ended ${finalDispatch.status}: ${JSON.stringify(finalDispatch.outcome)} ${JSON.stringify(finalDispatch.attempts_history)}`,
      );
    }
    if (!finalDispatch.attempts_history.some((attempt) => attempt.transport === 'codex')) {
      throw new Error(`dispatch did not record codex transport: ${JSON.stringify(finalDispatch.attempts_history)}`);
    }

    const commitLog = await waitFor(
      'Codex-created git commit',
      () => {
        try {
          const output = run('git', ['log', '--oneline', '--', 'LIVE_CODEX_E2E.txt'], repoDir);
          return output.includes(marker) ? output : null;
        } catch {
          return null;
        }
      },
      60000,
      1000,
    );
    const fileBody = readFileSync(path.join(repoDir, 'LIVE_CODEX_E2E.txt'), 'utf8').trim();
    if (fileBody !== marker) {
      throw new Error(`LIVE_CODEX_E2E.txt contained ${JSON.stringify(fileBody)}, expected ${JSON.stringify(marker)}`);
    }

    const cascadeHit = await waitFor(
      'git-cascade projected commit with task attribution',
      () => {
        const { streams } = listStreams({
          source_swarm_id: swarmId,
          task_resource_id: taskResourceId,
          task_node_id: taskNodeId,
          limit: 20,
        });
        for (const stream of streams) {
          const changes = listChangesForStream(stream.id);
          for (const change of changes) {
            const files = Array.isArray(change.files_touched) ? change.files_touched : [];
            if (
              files.includes('LIVE_CODEX_E2E.txt') ||
              change.message_summary?.includes(marker) ||
              change.task_node_id === taskNodeId
            ) {
              return { stream, change };
            }
          }
        }
        return null;
      },
      120000,
      1000,
    );

    const sessionlog = latestSessionlogFiles(repoDir);
    const cachePath = path.join(repoDir, '.swarm', 'codex-swarm', 'tmp', 'map', 'sessionlog-state.json');
    if (sessionlog.files.length === 0) {
      throw new Error(`sessionlog did not create SessionState files under ${sessionlog.stateDir}`);
    }
    if (!existsSync(cachePath)) {
      throw new Error(`sessionlog metrics sync did not write ${cachePath}`);
    }
    const stateFile = path.join(sessionlog.stateDir, sessionlog.files[0]);
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      phase?: string;
      firstPrompt?: string;
    };
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      session_id?: string;
      metadata?: { firstPrompt?: string };
    };
    if (!state.firstPrompt?.includes(marker) && !cache.metadata?.firstPrompt?.includes(marker)) {
      throw new Error(`sessionlog did not record the dispatched prompt marker ${marker}`);
    }

    const mapHealth = getConnectionHealth(swarmId, 3);
    const swarm = findSwarmById(swarmId);
    if (!mapHealth || !swarm || swarm.agent_count < 1) {
      throw new Error(`MAP connection did not remain visible. health=${JSON.stringify(mapHealth)} swarm=${JSON.stringify(swarm)}`);
    }

    return {
      root,
      repoDir,
      dbPath,
      port,
      dispatchId: dispatch.id,
      swarmId,
      marker,
      finalDispatch,
      commitLog,
      mapHealth,
      cascade: {
        streamId: cascadeHit.stream.stream_id,
        changeId: cascadeHit.change.change_id,
        commitHash: cascadeHit.change.commit_hash,
        filesTouched: cascadeHit.change.files_touched,
        taskResourceId: cascadeHit.change.task_resource_id,
        taskNodeId: cascadeHit.change.task_node_id,
      },
      sessionlog: {
        stateDir: sessionlog.stateDir,
        files: sessionlog.files.slice(0, 5),
        stateFile,
        phase: state.phase ?? null,
        firstPromptIncludesMarker: Boolean(
          state.firstPrompt?.includes(marker) || cache.metadata?.firstPrompt?.includes(marker),
        ),
        cachePath,
        cacheExists: existsSync(cachePath),
        cacheSessionId: cache.session_id ?? null,
      },
    };
  } finally {
    if (server) {
      await server.stop().catch((err) => {
        console.warn(`[live-e2e] server stop failed: ${(err as Error).message}`);
      });
    }
    for (const [key, value] of savedEnv.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main()
  .then((result) => {
    console.log('[live-e2e] PASS');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[live-e2e] FAIL');
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
