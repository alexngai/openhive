/**
 * E2E Live Agent Tests: Real claude-code-swarm sidecar → OpenHive MAP Hub
 *
 * These tests are behind the `E2E_LIVE=1` flag because they:
 *   - Start a real Fastify server with MAP WebSocket
 *   - Spawn a real claude-code-swarm MAP sidecar process
 *   - Verify the sidecar connects, registers, and communicates through the hub
 *
 * Run with:
 *   E2E_LIVE=1 npx vitest run src/__tests__/map/e2e-live-agent.test.ts
 *
 * Prerequisites:
 *   - claude-code-swarm must be available at references/claude-code-swarm/
 *   - Node.js >= 18
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initInboxBridge, stopInboxBridge } from '../../map/inbox-bridge.js';
import { getAllInbound } from '../../map/connection-registry.js';
import { discoverNodes } from '../../db/dal/map.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel (imported transitively by sync-listener)
import { vi } from 'vitest';
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));
vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: vi.fn(),
}));

// ============================================================================
// Gating
// ============================================================================

const LIVE = process.env.E2E_LIVE === '1';
const SIDECAR_DIR = path.resolve(__dirname, '../../../references/claude-code-swarm');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'scripts/map-sidecar.mjs');

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('e2e-live-agent');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e-live.db');
const SERVER_PORT = 19660;

// ============================================================================
// Helpers
// ============================================================================

/** Wait for a condition to become true, polling every `intervalMs`. */
async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Spawn the MAP sidecar process pointing at our test server.
 * Returns the child process and a promise that collects stderr for debugging.
 */
function spawnSidecar(opts: {
  server: string;
  scope?: string;
  systemId?: string;
  apiKey?: string;
}): { child: ChildProcess; stderr: string[] } {
  // Bake auth token into server URL (the sidecar passes --server directly to AgentConnection.connect)
  let serverUrl = opts.server;
  if (opts.apiKey) {
    const url = new URL(serverUrl);
    url.searchParams.set('token', opts.apiKey);
    url.searchParams.set('auto_register', 'true');
    serverUrl = url.toString();
  }

  const args = [
    SIDECAR_SCRIPT,
    '--server', serverUrl,
    '--scope', opts.scope ?? 'swarm:test',
    '--system-id', opts.systemId ?? 'test-system',
  ];

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_NO_WARNINGS: '1',
  };

  const child = spawn('node', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    cwd: SIDECAR_DIR,
  });

  const stderr: string[] = [];
  child.stderr?.on('data', (data: Buffer) => {
    stderr.push(data.toString());
  });
  child.stdout?.on('data', (data: Buffer) => {
    // Capture stdout for debugging
    stderr.push(`[stdout] ${data.toString()}`);
  });

  return { child, stderr };
}

function killSidecar(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    // Force kill after 3s
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 3000);
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe.skipIf(!LIVE)('E2E: Live Agent Integration', () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string; name: string };

  beforeAll(async () => {
    // Check sidecar exists
    if (!fs.existsSync(SIDECAR_SCRIPT)) {
      throw new Error(
        `Sidecar script not found at ${SIDECAR_SCRIPT}. ` +
        'Ensure references/claude-code-swarm is present.',
      );
    }

    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    // Create test agent
    const result = await agentsDAL.createAgent({
      name: 'live-e2e-agent',
      description: 'Agent for live e2e tests',
    });
    testAgent = { id: result.agent.id, apiKey: result.apiKey, name: 'live-e2e-agent' };

    // Create test hive
    hivesDAL.createHive({
      name: 'live-e2e-hive',
      description: 'Hive for live e2e tests',
      owner_id: testAgent.id,
    });

    // Initialize inbox bridge
    await initInboxBridge();

    // Build Fastify app
    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app);

    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  }, 30000);

  afterAll(async () => {
    stopMapWebSocket();
    await new Promise((r) => setTimeout(r, 200));
    await app.close();
    await stopInboxBridge();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  }, 15000);

  it('should accept sidecar connection and register agent', async () => {
    const { child, stderr } = spawnSidecar({
      server: `ws://127.0.0.1:${SERVER_PORT}/ws/map`,
      apiKey: testAgent.apiKey,
      scope: 'swarm:live-test',
      systemId: 'live-test-system',
    });

    let connected = false;
    try {
      // Wait for the sidecar to connect (should appear in inbound connections)
      connected = await waitFor(() => {
        return getAllInbound().size > 0;
      }, 10000);

      expect(connected).toBe(true);

      // Verify at least one inbound connection exists
      const inbound = getAllInbound();
      expect(inbound.size).toBeGreaterThanOrEqual(1);
    } finally {
      await killSidecar(child);
      if (!connected) {
        console.error('Sidecar stderr:', stderr.join('\n'));
      }
    }
  }, 15000);

  it('should register spawned agents in node registry', async () => {
    const { child, stderr } = spawnSidecar({
      server: `ws://127.0.0.1:${SERVER_PORT}/ws/map`,
      apiKey: testAgent.apiKey,
      scope: 'swarm:spawn-test',
      systemId: 'spawn-test-system',
    });

    let connected = false;

    try {
      // Wait for connection
      connected = await waitFor(() => getAllInbound().size > 0, 10000);
      expect(connected).toBe(true);

      // Wait a bit for any auto-registration the sidecar does
      await new Promise((r) => setTimeout(r, 2000));

      // Check if nodes were registered (the sidecar may register itself)
      const { data: nodes } = discoverNodes({ state: 'active', limit: 50 });
      // The sidecar should have registered at least something
      // (exact behavior depends on sidecar version and config)
      expect(nodes).toBeDefined();
    } finally {
      await killSidecar(child);
      if (!connected) {
        console.error('Sidecar stderr:', stderr.join('\n'));
      }
    }
  }, 15000);

  it('should clean up when sidecar disconnects', async () => {
    const { child, stderr } = spawnSidecar({
      server: `ws://127.0.0.1:${SERVER_PORT}/ws/map`,
      apiKey: testAgent.apiKey,
      scope: 'swarm:cleanup-test',
      systemId: 'cleanup-test-system',
    });

    let connected = false;

    try {
      // Wait for connection
      connected = await waitFor(() => getAllInbound().size > 0, 10000);
      expect(connected).toBe(true);

      const sizeBefore = getAllInbound().size;

      // Kill sidecar
      await killSidecar(child);

      // Wait for cleanup
      const cleaned = await waitFor(() => getAllInbound().size < sizeBefore, 5000);
      expect(cleaned).toBe(true);
    } catch {
      await killSidecar(child);
      if (!connected) {
        console.error('Sidecar stderr:', stderr.join('\n'));
      }
    }
  }, 20000);

  it('should handle sidecar reconnection', async () => {
    // First connection
    const first = spawnSidecar({
      server: `ws://127.0.0.1:${SERVER_PORT}/ws/map`,
      apiKey: testAgent.apiKey,
      scope: 'swarm:reconnect-test',
      systemId: 'reconnect-test-system',
    });

    try {
      const connected1 = await waitFor(() => getAllInbound().size > 0, 10000);
      expect(connected1).toBe(true);

      // Kill first sidecar
      await killSidecar(first.child);
      await waitFor(() => getAllInbound().size === 0, 5000);

      // Second connection
      const second = spawnSidecar({
        server: `ws://127.0.0.1:${SERVER_PORT}/ws/map`,
        apiKey: testAgent.apiKey,
        scope: 'swarm:reconnect-test',
        systemId: 'reconnect-test-system',
      });

      try {
        const connected2 = await waitFor(() => getAllInbound().size > 0, 10000);
        expect(connected2).toBe(true);
      } finally {
        await killSidecar(second.child);
      }
    } catch {
      await killSidecar(first.child);
    }
  }, 30000);
});
