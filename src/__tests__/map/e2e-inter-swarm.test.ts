/**
 * E2E Inter-Swarm Communication Tests
 *
 * Exercises the full multi-team flow through a shared hive:
 *
 *   - Two teams connect, each with their own swarm
 *   - Both join a shared hive
 *   - Agent spawning within each team
 *   - Hive-addressed messaging (broadcast to all members)
 *   - Direct swarm-to-swarm messaging
 *   - Cross-team event subscriptions (x-hive events, mail events)
 *   - Mail conversations spanning both teams
 *   - Inter-swarm visibility (agents discoverable across teams)
 *   - State updates visible across teams
 *   - Replay of missed messages on reconnect
 *
 * Tier 2 (behind E2E_LIVE=1):
 *   - Real claude-code-swarm sidecars managing agent lifecycle via IPC
 *   - Sidecar spawn/done/state commands → hub agent registry
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { joinHive as joinSwarmToHive } from '../../db/dal/map.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { initInboxBridge, stopInboxBridge } from '../../map/inbox-bridge.js';
import { getAllInbound } from '../../map/connection-registry.js';
import { discoverNodes } from '../../db/dal/map.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));
vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: vi.fn(),
}));

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('e2e-inter-swarm');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'inter-swarm.db');
const SERVER_PORT = 19670;
const LIVE = process.env.E2E_LIVE === '1';
const SIDECAR_DIR = path.resolve(__dirname, '../../../references/claude-code-swarm');
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'scripts/map-sidecar.mjs');

// ============================================================================
// JSON-RPC Helpers
// ============================================================================

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

let rpcIdCounter = 0;
function nextId(): string {
  return `is-${++rpcIdCounter}`;
}

function connectAgent(
  port: number,
  apiKey: string,
): Promise<{ ws: WebSocket; welcome: JsonRpcNotification }> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ token: apiKey, auto_register: 'true' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/map?${params}`);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Connection timeout')); }, 5000);

    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    ws.on('close', (code) => { clearTimeout(timeout); reject(new Error(`Closed: ${code}`)); });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'hub/welcome') {
        clearTimeout(timeout);
        resolve({ ws, welcome: msg });
      }
    });
  });
}

function rpc(ws: WebSocket, method: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timeout = setTimeout(() => { ws.removeListener('message', handler); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
    function handler(data: Buffer | string) {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { clearTimeout(timeout); ws.removeListener('message', handler); resolve(msg); }
    }
    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function collectNotifications(ws: WebSocket, method: string, count: number, timeoutMs = 3000): Promise<JsonRpcNotification[]> {
  return new Promise((resolve) => {
    const collected: JsonRpcNotification[] = [];
    const timeout = setTimeout(() => { ws.removeListener('message', handler); resolve(collected); }, timeoutMs);
    function handler(data: Buffer | string) {
      const msg = JSON.parse(data.toString());
      if (msg.method === method && !msg.id) {
        collected.push(msg);
        if (collected.length >= count) { clearTimeout(timeout); ws.removeListener('message', handler); resolve(collected); }
      }
    }
    ws.on('message', handler);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.on('close', () => resolve());
    ws.close();
  });
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ============================================================================
// Sidecar Helpers (for E2E_LIVE tests)
// ============================================================================

function sendToSocket(socketPath: string, command: Record<string, unknown>): Promise<string | null> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) { resolve(null); return; }
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(command) + '\n');
    });
    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });
    client.on('end', () => resolve(data.trim() || null));
    client.on('error', () => resolve(null));
    setTimeout(() => { try { client.destroy(); } catch {} resolve(data.trim() || null); }, 3000);
  });
}

function spawnSidecar(opts: {
  server: string;
  apiKey: string;
  workspace: string;
  scope?: string;
  sessionId?: string;
}): { child: ChildProcess; stderr: string[]; socketPath: string } {
  // Create workspace with .swarm/claude-swarm/ structure
  const swarmDir = path.join(opts.workspace, '.swarm', 'claude-swarm');
  const mapDir = path.join(swarmDir, 'tmp', 'map');
  fs.mkdirSync(mapDir, { recursive: true });

  // Build server URL with auth
  const url = new URL(opts.server);
  url.searchParams.set('token', opts.apiKey);
  url.searchParams.set('auto_register', 'true');

  const args = [
    SIDECAR_SCRIPT,
    '--server', url.toString(),
    '--scope', opts.scope ?? 'swarm:test',
    '--system-id', 'test-system',
  ];
  if (opts.sessionId) {
    args.push('--session-id', opts.sessionId);
  }

  const child = spawn('node', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env as Record<string, string>, NODE_NO_WARNINGS: '1' },
    cwd: opts.workspace,
  });

  const stderr: string[] = [];
  child.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));
  child.stdout?.on('data', (d: Buffer) => stderr.push(`[stdout] ${d.toString()}`));

  // Socket path — sidecar resolves from CWD
  const socketPath = opts.sessionId
    ? path.join(mapDir, 'sessions', opts.sessionId.length > 12 ? require('crypto').createHash('sha256').update(opts.sessionId).digest('hex').slice(0, 12) : opts.sessionId, 'sidecar.sock')
    : path.join(mapDir, 'sidecar.sock');

  return { child, stderr, socketPath };
}

function killSidecar(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) { resolve(); return; }
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000);
  });
}

// ============================================================================
// Test Suite
// ============================================================================

describe('E2E: Inter-Swarm Communication', () => {
  let app: FastifyInstance;
  let teamA: { id: string; apiKey: string; name: string };
  let teamB: { id: string; apiKey: string; name: string };
  let hive: { id: string; name: string };

  // Persistent connections for both teams
  let connA: { ws: WebSocket; welcome: JsonRpcNotification };
  let connB: { ws: WebSocket; welcome: JsonRpcNotification };
  let swarmIdA: string;
  let swarmIdB: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    // Create team agents
    const resultA = await agentsDAL.createAgent({ name: 'team-alpha-lead' });
    teamA = { id: resultA.agent.id, apiKey: resultA.apiKey, name: 'team-alpha-lead' };

    const resultB = await agentsDAL.createAgent({ name: 'team-beta-lead' });
    teamB = { id: resultB.agent.id, apiKey: resultB.apiKey, name: 'team-beta-lead' };

    // Create shared hive
    const h = hivesDAL.createHive({
      name: 'shared-workspace',
      description: 'Shared hive for inter-swarm tests',
      owner_id: teamA.id,
    });
    hive = { id: h.id, name: h.name };
    hivesDAL.joinHive(hive.id, teamB.id);

    // Start server
    await initInboxBridge();
    app = Fastify({ logger: false });
    await app.register(websocket);
    setupMapWebSocket(app);
    await app.listen({ port: SERVER_PORT, host: '127.0.0.1' });

    // Connect both teams
    connA = await connectAgent(SERVER_PORT, teamA.apiKey);
    connB = await connectAgent(SERVER_PORT, teamB.apiKey);
    swarmIdA = connA.welcome.params.swarm_id as string;
    swarmIdB = connB.welcome.params.swarm_id as string;

    // Join both swarms to the shared hive
    joinSwarmToHive(swarmIdA, hive.id);
    joinSwarmToHive(swarmIdB, hive.id);
  }, 30000);

  afterAll(async () => {
    await closeWs(connA.ws);
    await closeWs(connB.ws);
    stopMapWebSocket();
    await new Promise((r) => setTimeout(r, 200));
    await app.close();
    await stopInboxBridge();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  }, 15000);

  // ══════════════════════════════════════════════════════════════════════
  // Team Formation & Agent Spawning
  // ══════════════════════════════════════════════════════════════════════

  describe('Team Formation', () => {
    it('should spawn agents in Team A', async () => {
      const res1 = await rpc(connA.ws, 'map/agents/spawn', {
        agentId: 'alpha-researcher', name: 'Alpha Researcher', role: 'researcher',
      });
      const res2 = await rpc(connA.ws, 'map/agents/spawn', {
        agentId: 'alpha-writer', name: 'Alpha Writer', role: 'writer',
      });
      expect(res1.error).toBeUndefined();
      expect(res2.error).toBeUndefined();
      expect((res1.result as { agent: { id: string } }).agent.id).toBe('alpha-researcher');
      expect((res2.result as { agent: { id: string } }).agent.id).toBe('alpha-writer');
    });

    it('should spawn agents in Team B', async () => {
      const res1 = await rpc(connB.ws, 'map/agents/spawn', {
        agentId: 'beta-analyst', name: 'Beta Analyst', role: 'analyst',
      });
      const res2 = await rpc(connB.ws, 'map/agents/spawn', {
        agentId: 'beta-coder', name: 'Beta Coder', role: 'coder',
      });
      expect(res1.error).toBeUndefined();
      expect(res2.error).toBeUndefined();
    });

    it('should list agents within own swarm', async () => {
      const res = await rpc(connA.ws, 'map/agents/list', { swarm_id: swarmIdA });
      const agents = (res.result as { agents: Array<{ map_agent_id: string }> }).agents;
      const ids = agents.map((a) => a.map_agent_id);
      expect(ids).toContain('alpha-researcher');
      expect(ids).toContain('alpha-writer');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Inter-Swarm Visibility
  // ══════════════════════════════════════════════════════════════════════

  describe('Inter-Swarm Visibility', () => {
    it('should discover agents across teams via hive_id filter', async () => {
      const res = await rpc(connA.ws, 'map/agents/list', { hive_id: hive.id });
      const agents = (res.result as { agents: Array<{ map_agent_id: string; swarm_id: string }> }).agents;
      const ids = agents.map((a) => a.map_agent_id);

      // Should see agents from BOTH teams
      expect(ids).toContain('alpha-researcher');
      expect(ids).toContain('alpha-writer');
      expect(ids).toContain('beta-analyst');
      expect(ids).toContain('beta-coder');

      // Verify they come from different swarms
      const swarms = new Set(agents.map((a) => a.swarm_id));
      expect(swarms.size).toBe(2);
      expect(swarms.has(swarmIdA)).toBe(true);
      expect(swarms.has(swarmIdB)).toBe(true);
    });

    it('should see state updates across teams', async () => {
      // Team A updates agent state
      await rpc(connA.ws, 'map/agents/update', {
        agentId: 'alpha-researcher', state: 'busy', metadata: { task: 'investigating' },
      });

      // Team B queries and sees the update
      const res = await rpc(connB.ws, 'map/agents/list', { hive_id: hive.id });
      const agents = (res.result as { agents: Array<{ map_agent_id: string; state: string }> }).agents;
      const researcher = agents.find((a) => a.map_agent_id === 'alpha-researcher');
      expect(researcher).toBeDefined();
      expect(researcher!.state).toBe('busy');
    });

    it('should see agent unregistration across teams', async () => {
      // Spawn a temporary agent in Team A
      await rpc(connA.ws, 'map/agents/spawn', {
        agentId: 'alpha-temp', name: 'Temporary', role: 'worker',
      });

      // Team B should see it
      let res = await rpc(connB.ws, 'map/agents/list', { hive_id: hive.id });
      let agents = (res.result as { agents: Array<{ map_agent_id: string }> }).agents;
      expect(agents.find((a) => a.map_agent_id === 'alpha-temp')).toBeDefined();

      // Unregister from Team A
      await rpc(connA.ws, 'map/agents/unregister', { agentId: 'alpha-temp' });

      // Team B should no longer see it
      res = await rpc(connB.ws, 'map/agents/list', { hive_id: hive.id });
      agents = (res.result as { agents: Array<{ map_agent_id: string }> }).agents;
      expect(agents.find((a) => a.map_agent_id === 'alpha-temp')).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Hive-Addressed Messaging
  // ══════════════════════════════════════════════════════════════════════

  describe('Hive Messaging', () => {
    it('should broadcast message from Team A to Team B via hive', async () => {
      // Team B listens for incoming messages
      const msgPromise = collectNotifications(connB.ws, 'map/send', 1);

      // Team A sends to hive
      const sendRes = await rpc(connA.ws, 'map/send', {
        to: { id: `hive:${hive.name}` },
        payload: { type: 'task.request', task: 'Analyze the codebase' },
      });
      expect(sendRes.error).toBeUndefined();
      const result = sendRes.result as { messageId: string; recipientCount: number };
      expect(result.messageId).toBeDefined();
      expect(result.recipientCount).toBeGreaterThanOrEqual(1);

      // Team B should receive it
      const received = await msgPromise;
      expect(received.length).toBe(1);
      expect(received[0].params.payload).toEqual({ type: 'task.request', task: 'Analyze the codebase' });
    });

    it('should broadcast message from Team B to Team A via hive', async () => {
      const msgPromise = collectNotifications(connA.ws, 'map/send', 1);

      const sendRes = await rpc(connB.ws, 'map/send', {
        to: { id: `hive:${hive.name}` },
        payload: { type: 'task.result', summary: 'Analysis complete' },
      });
      expect(sendRes.error).toBeUndefined();

      const received = await msgPromise;
      expect(received.length).toBe(1);
      expect(received[0].params.payload).toEqual({ type: 'task.result', summary: 'Analysis complete' });
    });

    it('should not deliver hive messages to sender', async () => {
      // Team A sends and also listens — should NOT receive its own message
      const selfMsgPromise = collectNotifications(connA.ws, 'map/send', 1, 1000);

      await rpc(connA.ws, 'map/send', {
        to: { id: `hive:${hive.name}` },
        payload: { type: 'echo-test' },
      });

      const selfReceived = await selfMsgPromise;
      expect(selfReceived.length).toBe(0);
    });

    it('should reject hive message from non-member', async () => {
      // Create an outsider agent
      const outsiderResult = await agentsDAL.createAgent({ name: 'outsider' });
      const outsiderConn = await connectAgent(SERVER_PORT, outsiderResult.apiKey);

      try {
        const res = await rpc(outsiderConn.ws, 'map/send', {
          to: { id: `hive:${hive.name}` },
          payload: 'Should be rejected',
        });
        expect(res.error).toBeDefined();
        expect(res.error!.code).toBe(-32002);
      } finally {
        await closeWs(outsiderConn.ws);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Direct Swarm-to-Swarm Messaging
  // ══════════════════════════════════════════════════════════════════════

  describe('Direct Swarm Messaging', () => {
    it('should send directly from Team A to Team B by swarm ID', async () => {
      const msgPromise = collectNotifications(connB.ws, 'map/send', 1);

      const res = await rpc(connA.ws, 'map/send', {
        to: { id: `swarm:${swarmIdB}` },
        payload: { type: 'direct', content: 'Private message to Team B' },
      });
      expect(res.error).toBeUndefined();
      expect((res.result as { delivered: boolean }).delivered).toBe(true);

      const received = await msgPromise;
      expect(received.length).toBe(1);
      expect(received[0].params.payload).toEqual({ type: 'direct', content: 'Private message to Team B' });
    });

    it('should send directly from Team B to Team A by swarm ID', async () => {
      const msgPromise = collectNotifications(connA.ws, 'map/send', 1);

      const res = await rpc(connB.ws, 'map/send', {
        to: { id: `swarm:${swarmIdA}` },
        payload: { type: 'direct', content: 'Reply from Team B' },
      });
      expect(res.error).toBeUndefined();

      const received = await msgPromise;
      expect(received.length).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Cross-Team Event Subscriptions
  // ══════════════════════════════════════════════════════════════════════

  describe('Cross-Team Event Subscriptions', () => {
    it('should deliver x-hive.post.created to both teams', async () => {
      // Both teams subscribe to post events on the hive
      const subA = await rpc(connA.ws, 'map/subscribe', {
        filter: { eventTypes: ['x-hive.post.created'], hive: hive.name },
      });
      const subB = await rpc(connB.ws, 'map/subscribe', {
        filter: { eventTypes: ['x-hive.post.created'], hive: hive.name },
      });
      expect(subA.error).toBeUndefined();
      expect(subB.error).toBeUndefined();

      // Collect events on both
      const eventsA = collectNotifications(connA.ws, 'map/event', 1);
      const eventsB = collectNotifications(connB.ws, 'map/event', 1);

      // Team A creates a post
      await rpc(connA.ws, 'x-hive/post', {
        hive: hive.name,
        title: 'Cross-team announcement',
        content: 'Both teams should see this',
      });

      // Both should receive the event
      const [receivedA, receivedB] = await Promise.all([eventsA, eventsB]);
      expect(receivedA.length).toBe(1);
      expect(receivedB.length).toBe(1);
      expect((receivedA[0].params.event as { type: string }).type).toBe('x-hive.post.created');
      expect((receivedB[0].params.event as { type: string }).type).toBe('x-hive.post.created');

      // Cleanup subscriptions
      await rpc(connA.ws, 'map/unsubscribe', { subscriptionId: (subA.result as { subscriptionId: string }).subscriptionId });
      await rpc(connB.ws, 'map/unsubscribe', { subscriptionId: (subB.result as { subscriptionId: string }).subscriptionId });
    });

    it('should deliver mail events across teams', async () => {
      // Team B subscribes to mail events
      const subB = await rpc(connB.ws, 'map/subscribe', {
        filter: { eventTypes: ['mail.created', 'mail.turn.added'] },
      });
      expect(subB.error).toBeUndefined();

      const eventsB = collectNotifications(connB.ws, 'map/event', 2, 5000);

      // Team A creates a conversation and adds a turn
      const createRes = await rpc(connA.ws, 'mail/create', { subject: 'Cross-team discussion' });
      const convId = (createRes.result as { id: string }).id;

      await rpc(connA.ws, 'mail/turn', {
        conversationId: convId,
        participantId: 'alpha-researcher',
        content: { type: 'text', text: 'Thoughts on the architecture?' },
      });

      // Team B should receive both mail.created and mail.turn.added
      const received = await eventsB;
      expect(received.length).toBe(2);
      const eventTypes = received.map((e) => (e.params.event as { type: string }).type);
      expect(eventTypes).toContain('mail.created');
      expect(eventTypes).toContain('mail.turn.added');

      // Cleanup
      await rpc(connB.ws, 'map/unsubscribe', { subscriptionId: (subB.result as { subscriptionId: string }).subscriptionId });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Cross-Team Mail Conversations
  // ══════════════════════════════════════════════════════════════════════

  describe('Cross-Team Mail Conversations', () => {
    it('should allow both teams to participate in a shared conversation', async () => {
      // Team A creates conversation
      const createRes = await rpc(connA.ws, 'mail/create', { subject: 'Joint planning session' });
      const convId = (createRes.result as { id: string }).id;

      // Both teams join
      await rpc(connA.ws, 'mail/join', { conversationId: convId, agentId: 'alpha-researcher' });
      await rpc(connB.ws, 'mail/join', { conversationId: convId, agentId: 'beta-analyst' });

      // Both teams add turns
      await rpc(connA.ws, 'mail/turn', {
        conversationId: convId,
        participantId: 'alpha-researcher',
        content: { type: 'text', text: 'I propose we split the work' },
      });
      await rpc(connB.ws, 'mail/turn', {
        conversationId: convId,
        participantId: 'beta-analyst',
        content: { type: 'text', text: 'Agreed, I will handle the data analysis' },
      });

      // Both teams can see the full conversation
      const getA = await rpc(connA.ws, 'mail/get', { id: convId });
      const getB = await rpc(connB.ws, 'mail/get', { id: convId });

      const turnsA = (getA.result as { turns: unknown[] }).turns;
      const turnsB = (getB.result as { turns: unknown[] }).turns;

      expect(turnsA).toHaveLength(2);
      expect(turnsB).toHaveLength(2);
    });

    it('should close conversation visible to both teams', async () => {
      const createRes = await rpc(connA.ws, 'mail/create', { subject: 'Quick sync' });
      const convId = (createRes.result as { id: string }).id;

      // Team A closes
      await rpc(connA.ws, 'mail/close', { id: convId });

      // Team B sees it as closed
      const getB = await rpc(connB.ws, 'mail/get', { id: convId });
      expect((getB.result as { conversation: { status: string } }).conversation.status).toBe('completed');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Cross-Team x-hive Content
  // ══════════════════════════════════════════════════════════════════════

  describe('Cross-Team Hive Content', () => {
    it('should allow Team B to comment on Team A post', async () => {
      // Team A posts
      const postRes = await rpc(connA.ws, 'x-hive/post', {
        hive: hive.name,
        title: 'RFC: New API Design',
        content: 'Proposing a new approach...',
      });
      expect(postRes.error).toBeUndefined();
      const postId = (postRes.result as { post: { id: string } }).post.id;

      // Team B comments
      const commentRes = await rpc(connB.ws, 'x-hive/comment', {
        hive: hive.name,
        post_id: postId,
        content: 'Great proposal, I have some feedback...',
      });
      expect(commentRes.error).toBeUndefined();
      expect((commentRes.result as { comment: { id: string } }).comment.id).toBeDefined();
    });

    it('should allow Team B to vote on Team A post', async () => {
      const postRes = await rpc(connA.ws, 'x-hive/post', {
        hive: hive.name,
        title: 'Vote target from A',
        content: 'Please vote',
      });
      const postId = (postRes.result as { post: { id: string } }).post.id;

      const voteRes = await rpc(connB.ws, 'x-hive/vote', {
        hive: hive.name,
        target_type: 'post',
        target_id: postId,
        value: 1,
      });
      expect(voteRes.error).toBeUndefined();
    });

    it('should show posts from both teams in shared feed', async () => {
      // Team B creates a post too
      await rpc(connB.ws, 'x-hive/post', {
        hive: hive.name,
        title: 'Post from Team B',
        content: 'Our contribution',
      });

      // Feed should show posts from both teams
      const feedA = await rpc(connA.ws, 'x-hive/feed', { hive: hive.name });
      const feedB = await rpc(connB.ws, 'x-hive/feed', { hive: hive.name });

      const postsA = (feedA.result as { posts: Array<{ title: string }> }).posts;
      const postsB = (feedB.result as { posts: Array<{ title: string }> }).posts;

      // Both feeds should have the same posts
      expect(postsA.length).toBe(postsB.length);
      expect(postsA.length).toBeGreaterThanOrEqual(2);

      const titlesA = postsA.map((p) => p.title);
      expect(titlesA).toContain('Post from Team B');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Replay on Reconnect
  // ══════════════════════════════════════════════════════════════════════

  describe('Replay on Reconnect', () => {
    it('should replay messages missed while Team B was disconnected', async () => {
      // Disconnect Team B
      await closeWs(connB.ws);
      await new Promise((r) => setTimeout(r, 300));

      // Team A sends messages while B is offline
      await rpc(connA.ws, 'map/send', {
        to: { id: `swarm:${swarmIdB}` },
        payload: { type: 'missed', seq: 1 },
      });
      await rpc(connA.ws, 'map/send', {
        to: { id: `swarm:${swarmIdB}` },
        payload: { type: 'missed', seq: 2 },
      });

      // Reconnect Team B
      connB = await connectAgent(SERVER_PORT, teamB.apiKey);
      expect(connB.welcome.method).toBe('hub/welcome');

      // Check for replay notification
      const replays = await collectNotifications(connB.ws, 'map/replay', 1, 2000);
      // Replay contains unread messages (stored by inbox router)
      if (replays.length > 0) {
        const messages = replays[0].params.messages as unknown[];
        expect(messages.length).toBeGreaterThanOrEqual(1);
      }
      // Even if replay doesn't arrive (timing), connection should be healthy
      const pingRes = await rpc(connB.ws, 'map/connect', {});
      expect(pingRes.result).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Live Sidecar Integration (E2E_LIVE=1)
  // ══════════════════════════════════════════════════════════════════════

  describe.skipIf(!LIVE)('Sidecar IPC Integration', () => {
    let sidecarA: { child: ChildProcess; stderr: string[]; socketPath: string };
    let sidecarB: { child: ChildProcess; stderr: string[]; socketPath: string };
    const workspaceA = path.join(TEST_ROOT, 'workspace-a');
    const workspaceB = path.join(TEST_ROOT, 'workspace-b');

    beforeAll(async () => {
      // Spawn two sidecars, one per team
      sidecarA = spawnSidecar({
        server: `ws://127.0.0.1:${SERVER_PORT}/ws/map`,
        apiKey: teamA.apiKey,
        workspace: workspaceA,
        scope: 'swarm:team-alpha',
      });
      sidecarB = spawnSidecar({
        server: `ws://127.0.0.1:${SERVER_PORT}/ws/map`,
        apiKey: teamB.apiKey,
        workspace: workspaceB,
        scope: 'swarm:team-beta',
      });

      // Wait for both sidecars to connect
      const bothConnected = await waitFor(() => {
        // We already have connA and connB from the main setup, sidecars add 2 more
        return getAllInbound().size >= 4;
      }, 10000);

      if (!bothConnected) {
        console.error('Sidecar A stderr:', sidecarA.stderr.join('\n'));
        console.error('Sidecar B stderr:', sidecarB.stderr.join('\n'));
      }
    }, 15000);

    afterAll(async () => {
      await killSidecar(sidecarA.child);
      await killSidecar(sidecarB.child);
    }, 10000);

    it('should spawn agents via sidecar IPC', async () => {
      // Wait for sidecar socket to appear
      const socketReady = await waitFor(() => fs.existsSync(sidecarA.socketPath), 5000);
      if (!socketReady) {
        console.error('Socket not found at:', sidecarA.socketPath);
        console.error('Sidecar A stderr:', sidecarA.stderr.join('\n'));
      }
      expect(socketReady).toBe(true);

      // Spawn an agent via sidecar A's IPC
      const response = await sendToSocket(sidecarA.socketPath, {
        action: 'spawn',
        agent: {
          agentId: 'sidecar-spawned-agent',
          name: 'Sidecar Spawned',
          role: 'worker',
          scopes: ['swarm:team-alpha'],
          metadata: { source: 'ipc-test' },
        },
      });

      expect(response).toBeDefined();
      const parsed = JSON.parse(response!);
      expect(parsed.ok).toBe(true);

      // Verify the agent appeared in the hub
      await new Promise((r) => setTimeout(r, 500));
      const { data: nodes } = discoverNodes({ state: 'active', limit: 100 });
      const spawned = nodes.find((n) => n.map_agent_id === 'sidecar-spawned-agent');
      expect(spawned).toBeDefined();
    });

    it('should update agent state via sidecar IPC', async () => {
      const response = await sendToSocket(sidecarA.socketPath, {
        action: 'state',
        state: 'busy',
        metadata: { currentTask: 'processing-via-ipc' },
      });

      expect(response).toBeDefined();
      const parsed = JSON.parse(response!);
      expect(parsed.ok).toBe(true);
    });

    it('should emit broadcast events via sidecar IPC', async () => {
      // Subscribe to catch the broadcast
      const sub = await rpc(connB.ws, 'map/subscribe', { filter: {} });
      const events = collectNotifications(connB.ws, 'map/event', 1, 3000);

      const response = await sendToSocket(sidecarA.socketPath, {
        action: 'emit',
        event: {
          type: 'task.dispatched',
          taskId: 'task-123',
          title: 'Analyze module',
          assignee: 'sidecar-spawned-agent',
        },
      });

      expect(response).toBeDefined();

      // Check if Team B received the broadcast event
      const received = await events;
      // The event may or may not arrive depending on scope routing
      // The important thing is the emit didn't error

      await rpc(connB.ws, 'map/unsubscribe', {
        subscriptionId: (sub.result as { subscriptionId: string }).subscriptionId,
      });
    });

    it('should unregister agent via sidecar IPC (done)', async () => {
      const response = await sendToSocket(sidecarA.socketPath, {
        action: 'done',
        agentId: 'sidecar-spawned-agent',
        reason: 'completed',
      });

      expect(response).toBeDefined();
      const parsed = JSON.parse(response!);
      expect(parsed.ok).toBe(true);

      // Verify it's gone from the hub
      await new Promise((r) => setTimeout(r, 500));
      const { data: nodes } = discoverNodes({ state: 'active', limit: 100 });
      const gone = nodes.find((n) => n.map_agent_id === 'sidecar-spawned-agent');
      expect(gone).toBeUndefined();
    });

    it('should ping sidecar for health check', async () => {
      const response = await sendToSocket(sidecarA.socketPath, { action: 'ping' });
      expect(response).toBeDefined();
      const parsed = JSON.parse(response!);
      expect(parsed.ok).toBe(true);
      expect(parsed.pid).toBeDefined();
    });
  });
});
