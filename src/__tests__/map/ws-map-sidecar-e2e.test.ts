/**
 * E2E Tests: OpenHive Hub + claude-code-swarm Sidecar Heartbeat
 *
 * Spins up a real OpenHive Fastify server with /ws/map (short heartbeat),
 * connects a real claude-code-swarm sidecar process, and verifies that the
 * sidecar stays connected through the hub's heartbeat mechanism.
 *
 * The MAP SDK has no application-level ping/pong handling. These tests
 * confirm that protocol-level ws.ping() + automatic pong responses keep
 * the connection alive.
 *
 * Uses a 500ms heartbeat interval to keep test runtime low.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { getAllInbound } from '../../map/connection-registry.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('ws-map-sidecar-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'sidecar-e2e.db');
const SERVER_PORT = 19660;
const HEARTBEAT_MS = 500;

const SIDECAR_SCRIPT = path.resolve(
  __dirname, '..', '..', '..', 'references', 'claude-code-swarm', 'scripts', 'map-sidecar.mjs',
);

// ============================================================================
// Sidecar Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Send a command to the sidecar's UNIX socket and return the parsed response. */
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

/** Wait for a condition, polling at intervalMs. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000, intervalMs = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface SidecarHandle {
  pid: number;
  child: ChildProcess;
  socketPath: string;
  pidPath: string;
  workDir: string;
  stderr: () => string;
  cleanup: () => void;
}

/** Start a real sidecar process pointing at the OpenHive server. */
async function startSidecar(serverUrl: string): Promise<SidecarHandle> {
  // Create temp workspace with .swarm/claude-swarm/ structure
  const workDir = fs.mkdtempSync(path.join('/tmp', 'openhive-sidecar-e2e-'));
  const mapDir = path.join(fs.realpathSync(workDir), '.swarm', 'claude-swarm', 'tmp', 'map');
  fs.mkdirSync(mapDir, { recursive: true });

  // Write minimal config
  const configDir = path.join(workDir, '.swarm', 'claude-swarm');
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ template: 'gsd' }));

  const socketPath = path.join(mapDir, 'sidecar.sock');
  const pidPath = path.join(mapDir, 'sidecar.pid');

  const args = [
    SIDECAR_SCRIPT,
    '--server', serverUrl,
    '--scope', 'swarm:heartbeat-e2e',
    '--system-id', 'system-heartbeat-e2e',
    '--inactivity-timeout', '120000',
  ];

  const child = spawn('node', args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: workDir,
  });
  child.unref();

  let stderr = '';
  child.stderr!.on('data', (data) => { stderr += data.toString(); });

  fs.writeFileSync(pidPath, String(child.pid));

  // Wait for socket to appear and respond
  const ready = await waitFor(async () => {
    if (!fs.existsSync(socketPath)) return false;
    const resp = await sendCommand(socketPath, { action: 'ping' });
    return resp !== null && (resp as any).ok === true;
  }, 15000);

  if (!ready) {
    try { process.kill(child.pid!, 'SIGTERM'); } catch { /* ignore */ }
    throw new Error(`Sidecar not ready after 15s.\nStderr: ${stderr}`);
  }

  return {
    pid: child.pid!,
    child,
    socketPath,
    pidPath,
    workDir,
    stderr: () => stderr,
    cleanup: () => {
      try { process.kill(child.pid!, 'SIGTERM'); } catch { /* ignore */ }
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

// Skip if sidecar script doesn't exist
const sidecarExists = fs.existsSync(SIDECAR_SCRIPT);

describe.skipIf(!sidecarExists)('E2E: OpenHive Hub + Sidecar Heartbeat', () => {
  let app: FastifyInstance;
  let config: Config;
  let ingestToken: string;
  let sidecar: SidecarHandle | null = null;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'sidecar-heartbeat-agent',
      description: 'Agent for sidecar heartbeat e2e tests',
    });

    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'sidecar-e2e',
      agent_id: agent.id,
    });
    ingestToken = plaintext_key;

    config = ConfigSchema.parse({
      port: SERVER_PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Sidecar E2E', description: 'Test' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open' },
    });

    setHeartbeatInterval(HEARTBEAT_MS);

    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app, config);

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  });

  afterAll(async () => {
    sidecar?.cleanup();
    sidecar = null;
    stopMapWebSocket();
    await app?.close();
    await sleep(200);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  afterEach(() => {
    if (sidecar) {
      sidecar.cleanup();
      sidecar = null;
    }
  });

  function serverUrl(): string {
    return `ws://127.0.0.1:${SERVER_PORT}/ws/map?token=${ingestToken}`;
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Sidecar survives hub heartbeat during idle period
  // ─────────────────────────────────────────────────────────────

  it('sidecar stays connected through hub heartbeat cycles', async () => {
    sidecar = await startSidecar(serverUrl());

    const pingResp = await sendCommand(sidecar.socketPath, { action: 'ping' });
    expect((pingResp as any)?.ok).toBe(true);

    // Hub should have an inbound connection
    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);

    // Wait for 5 heartbeat cycles (2.5s)
    await sleep(HEARTBEAT_MS * 5 + 200);

    // Sidecar should still be alive
    expect(isProcessAlive(sidecar.pid)).toBe(true);

    // Hub should still have the connection
    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);

    // Sidecar socket should still respond
    const ping2 = await sendCommand(sidecar.socketPath, { action: 'ping' });
    expect((ping2 as any)?.ok).toBe(true);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────
  // 2. Extended idle period
  // ─────────────────────────────────────────────────────────────

  it('sidecar survives extended idle period (10+ heartbeat cycles)', async () => {
    sidecar = await startSidecar(serverUrl());

    // Wait for 10+ heartbeat cycles (5+ seconds)
    await sleep(HEARTBEAT_MS * 10 + 500);

    // Still alive
    expect(isProcessAlive(sidecar.pid)).toBe(true);
    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);

    const resp = await sendCommand(sidecar.socketPath, { action: 'ping' });
    expect((resp as any)?.ok).toBe(true);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────
  // 3. Sidecar can spawn agents while heartbeat is active
  // ─────────────────────────────────────────────────────────────

  it('sidecar can spawn agents while heartbeat is active', async () => {
    sidecar = await startSidecar(serverUrl());

    // Wait for a few heartbeat cycles
    await sleep(HEARTBEAT_MS * 3);

    // Spawn an agent through the sidecar
    const spawnResp = await sendCommand(sidecar.socketPath, {
      action: 'spawn',
      agent: {
        name: 'test-worker',
        role: 'worker',
        metadata: { task: 'heartbeat-test' },
      },
    });
    expect((spawnResp as any)?.ok).toBe(true);

    // Wait for more heartbeat cycles
    await sleep(HEARTBEAT_MS * 3);

    // Still connected
    expect(isProcessAlive(sidecar.pid)).toBe(true);
    expect(getAllInbound().size).toBeGreaterThanOrEqual(1);

    // Hub should have the registered agent
    const connections = [...getAllInbound().values()];
    const connWithAgent = connections.find(c => c.registeredAgents.size > 0);
    expect(connWithAgent).toBeDefined();
  }, 30_000);
});
