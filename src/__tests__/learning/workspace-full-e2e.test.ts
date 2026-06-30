/**
 * Full E2E Test: Workspace Execution via CLI
 *
 * Starts OpenHive via the actual CLI (`node bin/openhive.js serve`) in a
 * child process with its own event loop. Spawns a mock swarm that connects
 * back via MAP WebSocket. Drives the test via HTTP requests.
 *
 * This is the most production-like test — the server runs from built dist/,
 * the mock swarm is a real child process, and all communication is over the
 * network.
 *
 * Prerequisites: `npm run build:server` must be run first.
 *
 * Skipped by default — run with LEARNING_FULL_E2E=true.
 *
 * Run:
 *   npm run build:server
 *   LEARNING_FULL_E2E=true npx vitest run src/__tests__/learning/workspace-full-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { testRoot, cleanTestRoot } from '../helpers/test-dirs.js';

const FULL_E2E = process.env.LEARNING_FULL_E2E === 'true';
const TEST_ROOT = testRoot('learning-full-e2e');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const CLI_PATH = path.join(PROJECT_ROOT, 'bin/openhive.js');

// Use real SwarmRunner if available, fall back to mock
const SWARM_RUNNER_PATH = process.env.SWARM_RUNNER_COMMAND || 'swarm-runner serve';

const SERVER_PORT = 19899;
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`;

const describeIf = FULL_E2E ? describe : describe.skip;

/** HTTP helper */
async function api(
  method: string,
  urlPath: string,
  body?: unknown,
  opts?: { admin?: boolean; timeout?: number },
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (opts?.admin) headers['X-Admin-Key'] = 'test-admin-key';

  const fetchOpts: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(opts?.timeout || 120_000),
  };
  if (body) fetchOpts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}/api/v1${urlPath}`, fetchOpts);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

describeIf('Full E2E: CLI + Mock Swarm + Workspace Dispatch', () => {
  let serverProcess: ChildProcess;
  let serverLogs: string[] = [];

  beforeAll(async () => {
    // Verify dist/ exists
    const cliExists = fs.existsSync(CLI_PATH);
    const distExists = fs.existsSync(path.join(PROJECT_ROOT, 'dist/cli.js'));
    if (!cliExists || !distExists) {
      throw new Error('dist/ not found. Run `npm run build:server` first.');
    }

    cleanTestRoot(TEST_ROOT);
    fs.mkdirSync(TEST_ROOT, { recursive: true });

    // Write config file
    const configPath = path.join(TEST_ROOT, 'openhive.config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      port: SERVER_PORT,
      host: '127.0.0.1',
      database: path.join(TEST_ROOT, 'data', 'openhive.db'),
      instance: { name: 'Full E2E', description: 'Test', url: BASE_URL },
      admin: { createOnStartup: true, key: 'test-admin-key' },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      cors: { enabled: true, origin: true },
      mapHub: { enabled: true, trustModel: 'open' },
      learning: {
        enabled: true,
        atlas: { minTrajectories: 2 },
        compute: { enabled: true },
      },
      swarmHosting: {
        enabled: true,
        default_provider: 'local',
        swarm_runner_command: SWARM_RUNNER_PATH,
        data_dir: path.join(TEST_ROOT, 'swarms'),
        port_range: [19800, 19810],
        max_swarms: 3,
        health_check_interval: 600000,
        auto_restart: false,
      },
    }));

    // Start server via CLI in a child process
    console.log('[full-e2e] Starting server via CLI...');
    serverProcess = spawn('node', [CLI_PATH, 'serve', '--config', configPath], {
      env: { ...process.env, OPENHIVE_HOME: TEST_ROOT },
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      serverLogs.push(line);
      if (line) console.log(`[server] ${line}`);
    });
    serverProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      serverLogs.push(line);
    });

    // Wait for server to be ready
    const ready = await waitFor(async () => {
      try {
        const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch { return false; }
    }, 30_000);

    if (!ready) {
      const lastLogs = serverLogs.slice(-10).join('\n');
      throw new Error(`Server failed to start.\nLast logs:\n${lastLogs}`);
    }
    console.log('[full-e2e] Server ready');

    // Wait for learning engine
    await waitFor(async () => {
      try {
        const { data } = await api('GET', '/learning/health');
        return data?.available === true;
      } catch { return false; }
    }, 10_000);
    console.log('[full-e2e] Learning engine available');

    // Spawn swarm via API — need to register an agent first
    // In local auth mode with admin.createOnStartup, a "local" agent exists
    // Use admin key for swarm spawn
    const spawnRes = await fetch(`${BASE_URL}/api/v1/map/hosted/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'test-admin-key' },
      body: JSON.stringify({ name: 'full-e2e-swarm' }),
      signal: AbortSignal.timeout(15_000),
    });
    const spawnData = await spawnRes.json() as any;
    console.log(`[full-e2e] Swarm spawn: ${spawnRes.status} ${spawnData.state || spawnData.error || ''}`);

    // Wait for agentic compute to be enabled
    await waitFor(async () => {
      const { data } = await api('GET', '/learning/health');
      return data?.agentic_compute === true;
    }, 15_000);

    // Wait for the swarm to actually connect to MAP hub (appear in connection registry)
    // Check via the MAP swarms API
    const swarmConnected = await waitFor(async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/v1/map/swarms`, {
          headers: { 'X-Admin-Key': 'test-admin-key' },
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) return false;
        const data = await res.json() as any;
        const online = data.data?.some((s: any) => s.status === 'online');
        return !!online;
      } catch { return false; }
    }, 20_000);
    console.log(`[full-e2e] Swarm online in MAP: ${swarmConnected}`);
  }, 60_000);

  afterAll(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 2000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    cleanTestRoot(TEST_ROOT);
  }, 15_000);

  it('should have learning engine with agentic compute', async () => {
    const { status, data } = await api('GET', '/learning/health');
    expect(status).toBe(200);
    expect(data.available).toBe(true);
    expect(data.agentic_compute).toBe(true);
    expect(data).toHaveProperty('session_banks');
    expect(data).toHaveProperty('maintenance');
    expect(data).toHaveProperty('distributed');
  });

  it('should ingest trajectories via /learning/ingest', async () => {
    const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');

    for (let i = 0; i < 3; i++) {
      const { status } = await api('POST', '/learning/ingest', {
        trajectory: createTrajectory({
          task: createTask({ domain: 'cli-e2e', description: `CLI E2E task ${i}` }),
          steps: [createStep({ action: `action-${i}`, observation: `result-${i}` })],
          outcome: successOutcome(`done-${i}`),
          agentId: `cli-agent-${i}`,
        }),
      });
      console.log(`[full-e2e] Ingest ${i}: status=${status}`);
    }

    const { data } = await api('GET', '/learning/experiences');
    console.log(`[full-e2e] Experiences after ingest: ${data.total}`);
    expect(data.total).toBeGreaterThanOrEqual(1);
  });

  it('should trigger batch learning with agentic dispatch', async () => {
    // Add a failed trajectory with >3 steps to trigger agentic trajectory-analysis
    const { createTrajectory, createTask, createStep, failureOutcome } = await import('cognitive-core');
    const { status: ingestStatus } = await api('POST', '/learning/ingest', {
      trajectory: createTrajectory({
        task: createTask({ domain: 'cli-e2e', description: 'Debug memory leak in event system' }),
        steps: [
          createStep({ action: 'profile heap', observation: 'heap growing over time' }),
          createStep({ action: 'identify event listeners', observation: '500+ active listeners' }),
          createStep({ action: 'add removeListener cleanup', observation: 'cleanup added' }),
          createStep({ action: 'retest under load', observation: 'heap still growing' }),
        ],
        outcome: failureOutcome('Memory leak persists after cleanup attempt'),
        agentId: 'cli-fail-agent',
      }),
    });
    console.log(`[full-e2e] Failed trajectory ingest: ${ingestStatus}`);

    // Trigger batch — with separate server process, the event loop can process
    // the swarm's workspace.result WS response while batch runs
    const { status, data } = await api('POST', '/learning/batch', undefined, {
      admin: true,
      timeout: 180_000, // 3min for real SwarmRunner startup + agentic dispatch
    });
    console.log(`[full-e2e] Batch result: ${JSON.stringify(data).substring(0, 500)}`);
    expect(status).toBe(200);
    expect(data).toBeDefined();
    expect(data.trajectoriesProcessed).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('should show results in all API endpoints', async () => {
    // Stats
    const { data: stats } = await api('GET', '/learning/stats');
    expect(stats.memory.experienceCount).toBeGreaterThanOrEqual(1);

    // Activity — should have instant + batch events
    const { data: activity } = await api('GET', '/learning/activity');
    expect(activity.total).toBeGreaterThanOrEqual(2);
    expect(activity.data.some((e: any) => e.type === 'instant')).toBe(true);
    expect(activity.data.some((e: any) => e.type === 'batch')).toBe(true);

    // Playbooks
    const { data: playbooks } = await api('GET', '/learning/playbooks');
    expect(playbooks).toHaveProperty('data');

    // Knowledge
    const { data: knowledge } = await api('GET', '/learning/knowledge');
    expect(knowledge).toHaveProperty('data');

    // Health with full monitoring data
    const { data: health } = await api('GET', '/learning/health');
    expect(health.available).toBe(true);
    expect(health.experience_count).toBeGreaterThanOrEqual(1);
  });
});
