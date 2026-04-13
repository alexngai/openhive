/**
 * E2E Tests: Session Chat Capability Flow
 *
 * Tests the full capability pipeline from agent registration through to
 * swarm-level capability aggregation and API exposure:
 *
 *   1. Sidecar connects with ingest key
 *   2. Agent registers with mail/messaging/ACP capabilities
 *   3. Capabilities stored per-agent on connection registry
 *   4. Aggregate capabilities persisted to database
 *   5. GET /map/swarms/:id returns aggregate capabilities
 *   6. Multiple agents on same swarm produce correct union
 *   7. hasCapability() path-based checks work correctly
 *
 * Validates both cc-swarm profile (mail only) and macro-agent profile
 * (mail + ACP), including the conditional inbox gating.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket, setHeartbeatInterval } from '../../map/ws-map.js';
import { getAllInbound, getAgentCapabilities, hasCapability } from '../../map/connection-registry.js';
import { findSwarmById } from '../../db/dal/map.js';
import { mapRoutes } from '../../api/routes/map.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ============================================================================
// Constants
// ============================================================================

const TEST_ROOT = testRoot('e2e-session-chat-caps');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'session-chat-caps.db');
const PORT = 19691;
const HEARTBEAT_MS = 500;

// ============================================================================
// Helpers
// ============================================================================

let rpcId = 0;

interface SidecarHandle {
  ws: WebSocket;
  swarmId: string;
  messages: Array<{ method?: string; id?: number; result?: any; error?: any; params?: any }>;
  close(): void;
}

function connectSidecar(token: string, swarmId: string): Promise<SidecarHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/map?token=${token}&swarm_id=${swarmId}`);
    const messages: SidecarHandle['messages'] = [];

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        if (msg.method === 'ping') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
        }
      } catch { /* ignore non-JSON */ }
    });

    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Connect timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve({ ws, swarmId, messages, close() { ws.close(); } }); });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function rpc(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);
    const handler = (data: Buffer | string) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, intervalMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Session Chat Capabilities', () => {
  let app: FastifyInstance;
  let ingestToken: string;
  const handles: SidecarHandle[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'session-chat-test-agent',
      description: 'Agent for session chat capability e2e',
    });

    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'session-chat-test',
      agent_id: agent.id,
    });
    ingestToken = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Session Chat Caps E2E' },
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
    for (const h of handles) {
      try { h.ws.terminate(); } catch { /* ignore */ }
    }
    handles.length = 0;
    setLocalAgent(null);
    stopMapWebSocket();
    await app?.close();
    await sleep(200);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    setHeartbeatInterval(30_000);
  });

  afterEach(async () => {
    for (const h of handles) {
      try { h.ws.terminate(); } catch { /* ignore */ }
    }
    handles.length = 0;
    await sleep(100);
  });

  // ── cc-swarm profile (mail + messaging, no ACP) ─────────────────────────

  describe('cc-swarm profile (inboxEnabled=true)', () => {
    it('registers with mail and messaging capabilities', async () => {
      const swarmId = `cc-swarm-inbox-${Date.now()}`;
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);

      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      const resp = await rpc(handle.ws, 'map/agents/register', {
        name: 'team-sidecar',
        role: 'sidecar',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true, canViewHistory: true },
          trajectory: { canReport: true, canServeContent: true },
          tasks: { canCreate: true, canAssign: true, canUpdate: true, canList: true },
        },
        metadata: { systemId: 'system-claude-swarm', type: 'claude-code-swarm-sidecar' },
      });

      expect(resp.result).toBeDefined();
      expect(resp.result.agent).toBeDefined();

      // Verify per-agent capabilities stored
      await waitFor(() => {
        const conn = getAllInbound().get(swarmId);
        return (conn?.registeredAgents.size ?? 0) > 0;
      });

      const agentCaps = getAgentCapabilities(swarmId);
      expect(agentCaps).toHaveLength(1);
      expect(agentCaps[0].role).toBe('sidecar');
      expect(agentCaps[0].capabilities.messaging).toEqual({ canSend: true, canReceive: true });
      expect(agentCaps[0].capabilities.mail).toEqual({ canCreate: true, canJoin: true, canViewHistory: true });
    });

    it('exposes capabilities via GET /map/swarms/:id', async () => {
      const swarmId = `cc-swarm-api-${Date.now()}`;
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);

      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      await rpc(handle.ws, 'map/agents/register', {
        name: 'team-sidecar',
        role: 'sidecar',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true, canViewHistory: true },
          trajectory: { canReport: true, canServeContent: true },
        },
        metadata: { systemId: 'test', type: 'claude-code-swarm-sidecar' },
      });

      // Wait for DB persistence
      await waitFor(() => {
        const swarm = findSwarmById(swarmId);
        return !!swarm?.capabilities;
      });

      // Check API response
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/map/swarms/${swarmId}`,
      });

      expect(res.statusCode).toBe(200);
      const swarm = JSON.parse(res.payload);
      expect(swarm.capabilities).toBeDefined();
      expect(swarm.capabilities.mail).toEqual({ canCreate: true, canJoin: true, canViewHistory: true });
      expect(swarm.capabilities.messaging).toEqual({ canSend: true, canReceive: true });
      // No ACP
      expect(swarm.capabilities.protocols).toBeUndefined();
    });

    it('hasCapability checks work for mail capabilities', async () => {
      const swarmId = `cc-swarm-hascap-${Date.now()}`;
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);

      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      await rpc(handle.ws, 'map/agents/register', {
        name: 'team-sidecar',
        role: 'sidecar',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true },
          trajectory: { canReport: true, canServeContent: true },
        },
      });

      await waitFor(() => getAllInbound().get(swarmId)?.registeredAgents.size! > 0);

      expect(hasCapability(swarmId, 'mail.canJoin')).toBe(true);
      expect(hasCapability(swarmId, 'mail.canCreate')).toBe(true);
      expect(hasCapability(swarmId, 'messaging.canReceive')).toBe(true);
      expect(hasCapability(swarmId, 'trajectory.canServeContent')).toBe(true);
      // No ACP
      expect(hasCapability(swarmId, 'protocols.acp')).toBe(false);
    });
  });

  // ── cc-swarm profile without inbox ────────────────────────────────────────

  describe('cc-swarm profile (inboxEnabled=false)', () => {
    it('registers without mail or messaging capabilities', async () => {
      const swarmId = `cc-swarm-noinbox-${Date.now()}`;
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);

      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      await rpc(handle.ws, 'map/agents/register', {
        name: 'team-sidecar',
        role: 'sidecar',
        capabilities: {
          // No messaging or mail — inbox not enabled
          trajectory: { canReport: true, canServeContent: true },
          tasks: { canCreate: true, canAssign: true, canUpdate: true, canList: true },
        },
        metadata: { systemId: 'test', type: 'claude-code-swarm-sidecar' },
      });

      await waitFor(() => getAllInbound().get(swarmId)?.registeredAgents.size! > 0);

      expect(hasCapability(swarmId, 'mail.canJoin')).toBe(false);
      expect(hasCapability(swarmId, 'messaging.canReceive')).toBe(false);
      expect(hasCapability(swarmId, 'trajectory.canServeContent')).toBe(true);
    });
  });

  // ── macro-agent profile (mail + messaging + ACP) ─────────────────────────

  describe('macro-agent profile (mail + ACP)', () => {
    it('registers with full chat capabilities including ACP', async () => {
      const swarmId = `macro-agent-${Date.now()}`;
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);

      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      await rpc(handle.ws, 'map/agents/register', {
        name: 'macro-agent-sidecar',
        role: 'sidecar',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true, canViewHistory: true },
          protocols: ['acp'],
          acp: { version: '2024-10-07' },
          trajectory: { canReport: true, canServeContent: false },
          tasks: { canCreate: true, canAssign: true, canUpdate: true, canList: true },
        },
        metadata: { systemId: 'macro-agent', type: 'macro-agent-sidecar' },
      });

      await waitFor(() => getAllInbound().get(swarmId)?.registeredAgents.size! > 0);

      // Per-agent capabilities
      const agentCaps = getAgentCapabilities(swarmId);
      expect(agentCaps).toHaveLength(1);
      expect(agentCaps[0].capabilities.protocols).toEqual(['acp']);
      expect(agentCaps[0].capabilities.acp).toEqual({ version: '2024-10-07' });
      expect(agentCaps[0].capabilities.mail).toEqual({ canCreate: true, canJoin: true, canViewHistory: true });

      // hasCapability checks
      expect(hasCapability(swarmId, 'mail.canJoin')).toBe(true);
      expect(hasCapability(swarmId, 'messaging.canReceive')).toBe(true);
      expect(hasCapability(swarmId, 'trajectory.canServeContent')).toBe(false);

      // DB persistence
      await waitFor(() => !!findSwarmById(swarmId)?.capabilities);
      const swarm = findSwarmById(swarmId);
      expect(swarm!.capabilities).toBeDefined();
      const caps = swarm!.capabilities as Record<string, unknown>;
      expect(caps.protocols).toEqual(['acp']);
      expect(caps.mail).toEqual({ canCreate: true, canJoin: true, canViewHistory: true });
    });
  });

  // ── Multi-agent capability aggregation ───────────────────────────────────

  describe('multi-agent capability aggregation', () => {
    it('aggregates capabilities from sidecar + sub-agent', async () => {
      const swarmId = `multi-agent-${Date.now()}`;
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);

      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      // Register sidecar with messaging/mail capabilities
      await rpc(handle.ws, 'map/agents/register', {
        name: 'team-sidecar',
        role: 'sidecar',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true },
          trajectory: { canReport: true, canServeContent: true },
        },
      });

      await waitFor(() => getAllInbound().get(swarmId)?.registeredAgents.size! > 0);

      // Register sub-agent with only trajectory capabilities (no mail)
      await rpc(handle.ws, 'map/agents/register', {
        agentId: 'sub-agent-1',
        name: 'worker-1',
        role: 'worker',
        capabilities: {
          trajectory: { canReport: true },
          observation: { canObserve: true },
        },
      });

      await waitFor(() => getAllInbound().get(swarmId)?.registeredAgents.size! >= 2);

      // Per-agent: capabilities are separate
      const agentCaps = getAgentCapabilities(swarmId);
      expect(agentCaps).toHaveLength(2);

      const sidecar = agentCaps.find(a => a.role === 'sidecar');
      const worker = agentCaps.find(a => a.role === 'worker');

      expect(sidecar!.capabilities.mail).toEqual({ canCreate: true, canJoin: true });
      expect(worker!.capabilities.mail).toBeUndefined();
      expect(worker!.capabilities.observation).toEqual({ canObserve: true });

      // hasCapability: checks across ALL agents (any-agent-has semantics)
      expect(hasCapability(swarmId, 'mail.canJoin')).toBe(true);       // from sidecar
      expect(hasCapability(swarmId, 'observation.canObserve')).toBe(true); // from worker
      expect(hasCapability(swarmId, 'trajectory.canServeContent')).toBe(true); // from sidecar

      // Aggregate: union of both agents
      await waitFor(() => !!findSwarmById(swarmId)?.capabilities);
      const swarm = findSwarmById(swarmId);
      const caps = swarm!.capabilities as Record<string, unknown>;
      expect(caps.mail).toEqual({ canCreate: true, canJoin: true });
      expect(caps.observation).toEqual({ canObserve: true });
      expect((caps.trajectory as any).canServeContent).toBe(true);
      expect((caps.trajectory as any).canReport).toBe(true);
    });

    it('aggregates protocol arrays across agents', async () => {
      const swarmId = `multi-proto-${Date.now()}`;
      const handle = await connectSidecar(ingestToken, swarmId);
      handles.push(handle);

      await waitFor(() => handle.messages.some(m => m.method === 'hub/welcome'));

      // Agent 1: supports ACP
      await rpc(handle.ws, 'map/agents/register', {
        name: 'sidecar',
        role: 'sidecar',
        capabilities: {
          protocols: ['acp'],
          mail: { canJoin: true },
        },
      });

      await waitFor(() => getAllInbound().get(swarmId)?.registeredAgents.size! > 0);

      // Agent 2: supports MCP
      await rpc(handle.ws, 'map/agents/register', {
        agentId: 'mcp-agent',
        name: 'mcp-bridge',
        role: 'bridge',
        capabilities: {
          protocols: ['mcp'],
        },
      });

      await waitFor(() => getAllInbound().get(swarmId)?.registeredAgents.size! >= 2);

      // Aggregate should union protocols
      await waitFor(() => {
        const swarm = findSwarmById(swarmId);
        const caps = swarm?.capabilities as Record<string, unknown> | null;
        return Array.isArray(caps?.protocols) && (caps.protocols as string[]).length >= 2;
      });

      const swarm = findSwarmById(swarmId);
      const protocols = (swarm!.capabilities as Record<string, unknown>).protocols as string[];
      expect(protocols).toContain('acp');
      expect(protocols).toContain('mcp');
      expect(protocols).toHaveLength(2);
    });
  });
});
