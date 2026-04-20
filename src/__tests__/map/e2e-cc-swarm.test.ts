/**
 * E2E Tests: claude-code-swarm Integration
 *
 * Tests connection persistence using the actual claude-code-swarm package:
 *
 * Part 1: connectToMAP() — uses cc-swarm's own connection function which
 *   wraps AgentConnection with the sidecar's exact capabilities, metadata,
 *   and reconnection config.
 *
 * Part 2: Real sidecar process — spawns the actual map-sidecar.mjs script
 *   as a child process and communicates via its UNIX socket, exactly like
 *   Claude Code does in production.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { initTokenService, _resetTokenService } from '../../map/token-service.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { getAllInbound } from '../../map/connection-registry.js';
import { findSwarmById } from '../../db/dal/map.js';
import { mapRoutes } from '../../api/routes/map.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// cc-swarm imports — no type declarations shipped, treat as any
// @ts-expect-error — claude-code-swarm ships no .d.ts
import { connectToMAP, buildTrajectoryCheckpoint } from 'claude-code-swarm';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('e2e-cc-swarm');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e-cc-swarm.db');
const PORT = 19679;
const HEARTBEAT_MS = 300;

const SIDECAR_SCRIPT = path.resolve(
  'node_modules', 'claude-code-swarm', 'scripts', 'map-sidecar.mjs',
);

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** Send a command to a sidecar's UNIX socket. */
function sendCommand(socketPath: string, command: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(command) + '\n');
    });
    let buffer = '';
    client.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        client.end();
        try { resolve(JSON.parse(line)); } catch { resolve(null); }
      }
    });
    client.on('error', () => resolve(null));
    setTimeout(() => { client.destroy(); resolve(null); }, timeoutMs);
  });
}

// ============================================================================
// Part 1: connectToMAP() — cc-swarm's own connection function
// ============================================================================

describe('E2E: cc-swarm connectToMAP()', () => {
  let app: FastifyInstance;
  let ingestToken: string;
  const activeConnections: any[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'cc-swarm-e2e-agent',
      description: 'Agent for cc-swarm e2e tests',
    });

    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'cc-swarm-e2e',
      agent_id: agent.id,
    });
    ingestToken = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'cc-swarm E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: {
        enabled: true,
        trustModel: 'open',
        missedPongsBeforeTerminate: 3,
      },
    });

    setHeartbeatInterval(HEARTBEAT_MS);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => { await api.register(mapRoutes, { config }); },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    for (const c of activeConnections) {
      try { await c.disconnect(); } catch { /* ignore */ }
    }
    activeConnections.length = 0;

    setLocalAgent(null);
    stopMapWebSocket();
    await app?.close();
    await sleep(200);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  afterEach(async () => {
    for (const c of activeConnections) {
      try { await c.disconnect(); } catch { /* ignore */ }
    }
    activeConnections.length = 0;
    await sleep(200);
  });

  function serverUrl(swarmId: string): string {
    return `ws://127.0.0.1:${PORT}/ws/map?token=${ingestToken}&swarm_id=${swarmId}`;
  }

  // ─── 1. connectToMAP establishes connection with sidecar config ────

  it('connectToMAP() connects with sidecar capabilities and metadata', async () => {
    const swarmId = `ccswarm-connect-${Date.now()}`;
    const connection = await connectToMAP({
      server: serverUrl(swarmId),
      scope: 'swarm:test-team',
      systemId: 'system-e2e-test',
      projectContext: {
        project: 'openhive',
        branch: 'agents',
      },
    });

    expect(connection).not.toBeNull();
    activeConnections.push(connection);

    // Hub should have the inbound connection
    await waitFor(() => getAllInbound().has(swarmId));
    expect(getAllInbound().has(swarmId)).toBe(true);

    // Connection should have registered agents with capabilities
    await waitFor(() => {
      const conn = getAllInbound().get(swarmId);
      return (conn?.registeredAgents.size ?? 0) > 0;
    });

    const conn = getAllInbound().get(swarmId);
    expect(conn!.registeredAgents.size).toBeGreaterThanOrEqual(1);

    // Swarm should be enriched with project metadata
    const swarm = findSwarmById(swarmId);
    expect(swarm?.status).toBe('online');
  }, 15_000);

  // ─── 2. Connection survives heartbeat via SDK reconnection ─────────

  it('cc-swarm connection survives heartbeat cycles', async () => {
    const swarmId = `ccswarm-heartbeat-${Date.now()}`;
    const connection = await connectToMAP({
      server: serverUrl(swarmId),
      scope: 'swarm:heartbeat-test',
      systemId: 'system-heartbeat',
    });
    expect(connection).not.toBeNull();
    activeConnections.push(connection);

    await waitFor(() => getAllInbound().has(swarmId));

    // Survive multiple heartbeat cycles
    await sleep(HEARTBEAT_MS * 6);

    expect(connection.isConnected).toBe(true);
    expect(getAllInbound().has(swarmId)).toBe(true);
    expect(findSwarmById(swarmId)?.status).toBe('online');
  }, 15_000);

  // ─── 3. Hub termination → cc-swarm SDK auto-reconnects ────────────

  it('cc-swarm reconnects after hub terminates connection', async () => {
    const swarmId = `ccswarm-reconnect-${Date.now()}`;
    const connection = await connectToMAP({
      server: serverUrl(swarmId),
      scope: 'swarm:reconnect-test',
      systemId: 'system-reconnect',
    });
    expect(connection).not.toBeNull();
    activeConnections.push(connection);

    await waitFor(() => getAllInbound().has(swarmId));

    // Force hub to terminate the connection
    const conn = getAllInbound().get(swarmId);
    conn!.ws.terminate();

    // Wait for SDK reconnection (new connection appears)
    const reconnected = await waitFor(
      () => {
        const c = getAllInbound().get(swarmId);
        return c !== undefined && c.ws !== conn!.ws;
      },
      15_000,
    );

    expect(reconnected).toBe(true);
    expect(findSwarmById(swarmId)?.status).toBe('online');
  }, 20_000);

  // ─── 4. Health API reflects cc-swarm connection ────────────────────

  it('connection health API shows cc-swarm agent', async () => {
    const swarmId = `ccswarm-health-${Date.now()}`;
    const connection = await connectToMAP({
      server: serverUrl(swarmId),
      scope: 'swarm:health-test',
      systemId: 'system-health',
    });
    expect(connection).not.toBeNull();
    activeConnections.push(connection);

    await waitFor(() => {
      const conn = getAllInbound().get(swarmId);
      return (conn?.registeredAgents.size ?? 0) > 0;
    });

    await sleep(HEARTBEAT_MS * 2);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/map/connections/${swarmId}`,
    });

    expect(res.statusCode).toBe(200);
    const health = JSON.parse(res.payload);
    expect(health.swarmId).toBe(swarmId);
    expect(health.missedPongs).toBe(0);
    expect(health.registeredAgentCount).toBeGreaterThanOrEqual(1);

    // Should have sidecar-style agent
    const agent = health.registeredAgents[0];
    expect(agent.name).toContain('sidecar');
    expect(agent.role).toBe('sidecar');
  }, 15_000);

  // ─── 5. Full lifecycle with trajectory checkpoint ──────────────────

  it('full lifecycle: connect → checkpoint → terminate → reconnect', async () => {
    const swarmId = `ccswarm-lifecycle-${Date.now()}`;
    const connection = await connectToMAP({
      server: serverUrl(swarmId),
      scope: 'swarm:lifecycle-test',
      systemId: 'system-lifecycle',
      projectContext: { project: 'openhive', branch: 'agents' },
    });
    expect(connection).not.toBeNull();
    activeConnections.push(connection);

    await waitFor(() => {
      const conn = getAllInbound().get(swarmId);
      return (conn?.registeredAgents.size ?? 0) > 0;
    });

    // Send a trajectory checkpoint via the SDK (like sessionlog hooks do)
    try {
      connection.sendNotification('trajectory/checkpoint', {
        resource_id: 'res_cc_session',
        agent_id: connection.agentId,
        commit_hash: 'ccswarm123',
        timestamp: new Date().toISOString(),
        checkpoint: buildTrajectoryCheckpoint({
          agent: 'Claude Code',
          filesTouched: ['src/map/ws-map.ts'],
          tokenUsage: { input: 1000, output: 500 },
          branch: 'agents',
          project: 'openhive',
          firstPrompt: 'Fix connection persistence',
          checkpointsCount: 1,
        }),
      });
    } catch {
      // sendNotification may not be available on all SDK versions
    }

    await sleep(200);
    expect(findSwarmById(swarmId)?.status).toBe('online');

    // Terminate connection — SDK reconnects fast, so we verify the full
    // cycle completed by checking the connection is a new WS instance
    const conn = getAllInbound().get(swarmId);
    const oldWs = conn!.ws;
    conn!.ws.terminate();

    // Wait for SDK to reconnect with a new WebSocket instance
    const reconnected = await waitFor(
      () => {
        const c = getAllInbound().get(swarmId);
        return c !== undefined && c.ws !== oldWs;
      },
      15_000,
    );
    expect(reconnected).toBe(true);

    // After reconnection, swarm should be online
    expect(findSwarmById(swarmId)?.status).toBe('online');
  }, 25_000);
});

// ============================================================================
// Part 2: Real sidecar process (spawns map-sidecar.mjs)
// ============================================================================

const sidecarExists = fs.existsSync(SIDECAR_SCRIPT);

describe.skipIf(!sidecarExists)('E2E: cc-swarm Real Sidecar Process', () => {
  let app: FastifyInstance;
  let ingestToken: string;
  let sidecar: { pid: number; child: ChildProcess; socketPath: string; workDir: string; cleanup: () => void } | null = null;

  beforeAll(async () => {
    // Use a separate DB to avoid conflicts with Part 1
    const sidecarDb = testDbPath(TEST_ROOT, 'e2e-cc-swarm-sidecar.db');
    initDatabase(sidecarDb);
    initTokenService(undefined, TEST_ROOT);

    const { agent } = await agentsDAL.createAgent({
      name: 'cc-sidecar-e2e-agent',
    });
    // Sidecars need `map:agents:spawn` to register child agents in v4
    // (capability enforcement at the spawn handler, not the ingest layer).
    agentsDAL.grantAgentCapability(agent.id, 'map:agents:spawn');

    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'cc-sidecar-e2e',
      agent_id: agent.id,
    });
    ingestToken = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT + 1, // Use different port than Part 1
      host: '127.0.0.1',
      database: sidecarDb,
      instance: { name: 'Sidecar Process E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: {
        enabled: true,
        trustModel: 'open',
        missedPongsBeforeTerminate: 3,
      },
    });

    setHeartbeatInterval(HEARTBEAT_MS);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => { await api.register(mapRoutes, { config }); },
      { prefix: '/api/v1' },
    );

    await app.listen({ port: PORT + 1, host: '127.0.0.1' });
  }, 15000);

  afterAll(async () => {
    sidecar?.cleanup();
    sidecar = null;
    setLocalAgent(null);
    stopMapWebSocket();
    await app?.close();
    await sleep(200);
    _resetTokenService();
    closeDatabase();
    setHeartbeatInterval(30_000);
  });

  afterEach(() => {
    if (sidecar) {
      sidecar.cleanup();
      sidecar = null;
    }
  });

  async function spawnSidecar(): Promise<typeof sidecar> {
    // Create temp workspace with .swarm/claude-swarm/ structure
    const workDir = fs.mkdtempSync(path.join('/tmp', 'openhive-ccswarm-e2e-'));
    const mapDir = path.join(fs.realpathSync(workDir), '.swarm', 'claude-swarm', 'tmp', 'map');
    fs.mkdirSync(mapDir, { recursive: true });

    const configDir = path.join(workDir, '.swarm', 'claude-swarm');
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ template: 'gsd' }));

    const socketPath = path.join(mapDir, 'sidecar.sock');

    const serverUrl = `ws://127.0.0.1:${PORT + 1}/ws/map?token=${ingestToken}`;
    const child = spawn('node', [
      SIDECAR_SCRIPT,
      '--server', serverUrl,
      '--scope', 'swarm:sidecar-e2e',
      '--system-id', 'system-sidecar-e2e',
      '--inactivity-timeout', '120000',
    ], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      cwd: workDir,
    });
    child.unref();

    let stderr = '';
    child.stderr!.on('data', (data) => { stderr += data.toString(); });

    // Wait for socket to respond
    const ready = await waitFor(async () => {
      if (!fs.existsSync(socketPath)) return false;
      const resp = await sendCommand(socketPath, { action: 'ping' });
      return resp !== null && (resp as any).ok === true;
    }, 15000, 200);

    if (!ready) {
      try { process.kill(child.pid!, 'SIGTERM'); } catch { /* ignore */ }
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new Error(`Sidecar not ready after 15s.\nStderr: ${stderr}`);
    }

    return {
      pid: child.pid!,
      child,
      socketPath,
      workDir,
      cleanup: () => {
        try { process.kill(child.pid!, 'SIGTERM'); } catch { /* ignore */ }
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
      },
    };
  }

  // ─── 1. Real sidecar connects and registers ───────────────────────

  it('real sidecar process connects to hub and stays alive', async () => {
    sidecar = await spawnSidecar();

    // Sidecar should respond to ping
    const pingResp = await sendCommand(sidecar!.socketPath, { action: 'ping' });
    expect((pingResp as any)?.ok).toBe(true);

    // Hub should have an inbound connection
    await waitFor(() => getAllInbound().size > 0);
    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);

    // Survive heartbeat cycles
    await sleep(HEARTBEAT_MS * 5);

    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);

    // Sidecar should still be responding
    const ping2 = await sendCommand(sidecar!.socketPath, { action: 'ping' });
    expect((ping2 as any)?.ok).toBe(true);
  }, 30_000);

  // ─── 2. Real sidecar spawns agent and it appears in health ────────

  it('sidecar spawns agent visible in connection health', async () => {
    sidecar = await spawnSidecar();

    await waitFor(() => getAllInbound().size > 0);

    // Spawn an agent via sidecar socket
    const spawnResp = await sendCommand(sidecar!.socketPath, {
      action: 'spawn',
      agent: {
        name: 'test-worker',
        role: 'worker',
        metadata: { task: 'connection-test' },
      },
    });
    expect((spawnResp as any)?.ok).toBe(true);

    await sleep(300);

    // Connection should show registered agents
    const connections = [...getAllInbound().values()];
    const connWithAgent = connections.find(c => c.registeredAgents.size > 0);
    expect(connWithAgent).toBeDefined();

    // Health API should reflect the agent
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/map/connections',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.inbound.length).toBeGreaterThanOrEqual(1);

    const health = body.inbound.find((c: any) => c.registeredAgentCount > 0);
    expect(health).toBeDefined();
  }, 30_000);

  // ─── 3. Real sidecar sends trajectory checkpoint ──────────────────

  it('sidecar sends trajectory checkpoint to hub', async () => {
    sidecar = await spawnSidecar();

    await waitFor(() => getAllInbound().size > 0);

    // Send trajectory checkpoint via sidecar socket
    await sendCommand(sidecar!.socketPath, {
      action: 'trajectory-checkpoint',
      checkpoint: {
        agent: 'Claude Code',
        files_touched: ['src/map/ws-map.ts'],
        token_usage: { input: 500, output: 200 },
        branch: 'agents',
        project: 'openhive',
        firstPrompt: 'Fix heartbeat persistence',
        checkpoints_count: 1,
      },
    });
    // Checkpoint delivery is fire-and-forget; response may vary
    // The important thing is the sidecar doesn't crash
    expect(sidecar!.child.killed).toBe(false);

    await sleep(300);

    // Connection should still be alive
    const ping = await sendCommand(sidecar!.socketPath, { action: 'ping' });
    expect((ping as any)?.ok).toBe(true);
  }, 30_000);
});
