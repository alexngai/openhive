/**
 * Tests for /specs API routes.
 *
 * Covers GET /specs (cross-resource aggregation), GET /specs/:resourceId/:specId
 * (linked nodes grouping), POST /specs (create + broadcast), and PATCH
 * /specs/:resourceId/:specId (update + broadcast). Mirrors the daemon mock
 * pattern from opentasks-content.test.ts so tests run without a daemon.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mock the daemon client. Routes use dynamic import of
// '../../map/task-daemon-client.js' so the mock target matches that path.
// ---------------------------------------------------------------------------

vi.mock('../../map/task-daemon-client.js', async () => {
  const { existsSync, readFileSync, writeFileSync } = await import('fs');
  const { join } = await import('path');

  class TaskDaemonError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'TaskDaemonError';
      this.code = code;
    }
  }

  function resolveDaemonSocket(opentasksDir: string): string {
    return join(opentasksDir, 'daemon.sock');
  }

  function _parseJsonl(opentasksDir: string): { nodes: any[]; edges: any[] } {
    const graphPath = join(opentasksDir, 'graph.jsonl');
    if (!existsSync(graphPath)) return { nodes: [], edges: [] };
    const lines = readFileSync(graphPath, 'utf-8').split('\n').filter((l: string) => l.trim());
    const nodes: any[] = [];
    const edges: any[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.from_id && obj.to_id) edges.push(obj);
        else nodes.push(obj);
      } catch { /* skip */ }
    }
    return { nodes, edges };
  }

  function _writeJsonl(opentasksDir: string, nodes: any[], edges: any[]): void {
    const graphPath = join(opentasksDir, 'graph.jsonl');
    const lines = [...nodes, ...edges].map((o) => JSON.stringify(o)).join('\n');
    writeFileSync(graphPath, lines + '\n');
  }

  return {
    TaskDaemonError,
    SPEC_METADATA_KIND: 'spec',
    resolveDaemonSocket,

    daemonQueryNodes: async (_socketPath: string, filter: any, opentasksDir?: string) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes } = _parseJsonl(opentasksDir);
      let items = nodes.filter((n: any) => !n.deleted);
      if (filter.archived === false) items = items.filter((n: any) => !n.archived);
      if (filter.type) items = items.filter((n: any) => n.type === filter.type);
      return { items, total: items.length, daemon_connected: true };
    },

    daemonGetGraph: async (_socketPath: string, opentasksDir?: string, options?: { includeArchived?: boolean }) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes, edges } = _parseJsonl(opentasksDir);
      const filtered = options?.includeArchived
        ? nodes.filter((n: any) => !n.deleted)
        : nodes.filter((n: any) => !n.deleted && !n.archived);
      return { nodes: filtered, edges };
    },

    daemonGetNodeWithNeighbors: async (_socketPath: string, nodeId: string, opentasksDir?: string) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes, edges } = _parseJsonl(opentasksDir);
      const node = nodes.find((n: any) => n.id === nodeId) ?? null;
      if (!node) return { node: null, neighbors: [], edges: [] };
      const connected = edges.filter((e: any) => e.from_id === nodeId || e.to_id === nodeId);
      const neighborIds = new Set<string>();
      for (const e of connected) {
        if (e.from_id !== nodeId) neighborIds.add(e.from_id);
        if (e.to_id !== nodeId) neighborIds.add(e.to_id);
      }
      const neighbors = nodes.filter((n: any) => neighborIds.has(n.id));
      return {
        node,
        neighbors,
        edges: connected.map((e: any) => ({ from_id: e.from_id, to_id: e.to_id, type: e.type })),
      };
    },

    daemonCreateSpec: async (
      _socketPath: string,
      params: { title: string; content?: string; priority?: number },
      opentasksDir?: string,
    ) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes, edges } = _parseJsonl(opentasksDir);
      const id = `s-${Math.random().toString(36).slice(2, 8)}`;
      const node = {
        id,
        type: 'spec',
        title: params.title,
        content: params.content ?? '',
        priority: params.priority,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      _writeJsonl(opentasksDir, [...nodes, node], edges);
      return node;
    },

    daemonUpdateSpec: async (
      _socketPath: string,
      specId: string,
      updates: Record<string, unknown>,
      opentasksDir?: string,
    ) => {
      if (!opentasksDir) throw new TaskDaemonError('DAEMON_NOT_RUNNING', 'No opentasksDir');
      const { nodes, edges } = _parseJsonl(opentasksDir);
      const idx = nodes.findIndex((n: any) => n.id === specId);
      if (idx < 0) throw new TaskDaemonError('NOT_FOUND', `Spec ${specId} not found`);
      nodes[idx] = { ...nodes[idx], ...updates, updated_at: new Date().toISOString() };
      _writeJsonl(opentasksDir, nodes, edges);
      return nodes[idx];
    },
  };
});

// Stub the broadcast module so we can assert it was called without spinning up WS infra.
const broadcastSpy = vi.fn();
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, event: unknown) => broadcastSpy(channel, event),
  broadcast: vi.fn(),
}));

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as mapDAL from '../../db/dal/map.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import { buildDispatchSeedPrompt, specsRoutes } from '../../api/routes/specs.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';
import { registerInbound, unregisterInbound } from '../../map/connection-registry.js';
import { setAcpAvailabilityProbe, _resetDispatchRouting } from '../../dispatch/routing.js';

interface GraphNode {
  id: string;
  type: 'task' | 'context' | 'feedback' | 'spec' | 'issue';
  title?: string;
  content?: string;
  status?: string;
  priority?: number;
  archived?: boolean;
}

interface GraphEdge {
  from_id: string;
  to_id: string;
  type: string;
}

function buildGraphJsonl(nodes: GraphNode[], edges: GraphEdge[]): string {
  return [...nodes, ...edges].map((obj) => JSON.stringify(obj)).join('\n') + '\n';
}

function createOpenTasksFixture(
  baseDir: string,
  opts: { nodes?: GraphNode[]; edges?: GraphEdge[] } = {},
): string {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, 'graph.jsonl'),
    buildGraphJsonl(opts.nodes || [], opts.edges || []),
  );
  return baseDir;
}

const TEST_ROOT = testRoot('specs-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'specs-routes.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test OpenHive', description: 'Test instance' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(specsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('Specs routes', () => {
  let app: FastifyInstance;
  let testAgent: { id: string; apiKey: string };
  let otherAgent: { id: string; apiKey: string };
  let resourceA: { id: string };
  let resourceB: { id: string };
  let memoryResource: { id: string };
  let dirA: string;
  let dirB: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const config = createTestConfig();
    app = await createTestApp(config);

    const a1 = await agentsDAL.createAgent({
      name: 'specs-test-agent',
      description: 'Owner of test specs',
    });
    testAgent = { id: a1.agent.id, apiKey: a1.apiKey };

    const a2 = await agentsDAL.createAgent({
      name: 'specs-other-agent',
      description: 'No-access agent',
    });
    otherAgent = { id: a2.agent.id, apiKey: a2.apiKey };

    // Resource A: 3 specs (one archived) + linked task + feedback
    dirA = mkTestDir(TEST_ROOT, 'graph-a');
    createOpenTasksFixture(dirA, {
      nodes: [
        {
          id: 's-aaa', type: 'spec', title: 'Auth rewrite', content: 'rewrite the auth flow',
          priority: 0, archived: false,
        },
        {
          id: 's-bbb', type: 'spec', title: 'Search redesign', content: 'better search UX',
          priority: 2, archived: false,
        },
        {
          id: 's-ccc', type: 'spec', title: 'Old idea', content: 'no longer relevant',
          priority: 3, archived: true,
        },
        {
          id: 't-aaa', type: 'task', title: 'Add OAuth provider', status: 'open', priority: 1,
        },
        {
          id: 'f-aaa', type: 'feedback', title: 'Concern about token storage',
          content: 'tokens should be httpOnly cookies',
        },
      ],
      edges: [
        { from_id: 's-aaa', to_id: 't-aaa', type: 'implements' },
        { from_id: 'f-aaa', to_id: 's-aaa', type: 'references' },
      ],
    });
    resourceA = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'Graph A',
      description: 'first task graph',
      git_remote_url: dirA,
      visibility: 'private',
      owner_agent_id: testAgent.id,
      metadata: { opentasks: true },
    });

    // Resource B: 1 spec, no edges
    dirB = mkTestDir(TEST_ROOT, 'graph-b');
    createOpenTasksFixture(dirB, {
      nodes: [
        {
          id: 's-zzz', type: 'spec', title: 'Billing v2', content: 'invoicing rework',
          priority: 1, archived: false,
        },
      ],
    });
    resourceB = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'Graph B',
      description: 'second task graph',
      git_remote_url: dirB,
      visibility: 'private',
      owner_agent_id: testAgent.id,
      metadata: { opentasks: true },
    });

    // Non-opentasks resource for negative tests
    const memDir = mkTestDir(TEST_ROOT, 'memory-bank');
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# memory');
    memoryResource = resourcesDAL.createResource({
      resource_type: 'memory_bank',
      name: 'Test Memory',
      git_remote_url: memDir,
      visibility: 'private',
      owner_agent_id: testAgent.id,
    });
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    broadcastSpy.mockClear();
  });

  // ==========================================================================
  // GET /specs
  // ==========================================================================

  describe('GET /specs', () => {
    it('aggregates specs across all accessible resources', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // 2 active specs in A + 1 in B = 3 (s-ccc is archived)
      const ids = body.data.map((s: { id: string }) => s.id).sort();
      expect(ids).toEqual(['s-aaa', 's-bbb', 's-zzz']);
      expect(body.total).toBe(3);
    });

    it('annotates specs with resource_id and resource_name', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const body = JSON.parse(res.body);
      const aSpec = body.data.find((s: { id: string }) => s.id === 's-aaa');
      expect(aSpec).toBeDefined();
      expect(aSpec.resource_id).toBe(resourceA.id);
      expect(aSpec.resource_name).toBe('Graph A');
      expect(aSpec.source).toBe('local');
    });

    it('omits archived specs by default', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const body = JSON.parse(res.body);
      expect(body.data.find((s: { id: string }) => s.id === 's-ccc')).toBeUndefined();
    });

    it('includes archived when include_archived=true', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/specs?include_archived=true',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const body = JSON.parse(res.body);
      const archived = body.data.find((s: { id: string }) => s.id === 's-ccc');
      expect(archived).toBeDefined();
      expect(archived.archived).toBe(true);
    });

    it('narrows by resource_id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/specs?resource_id=${resourceB.id}`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('s-zzz');
    });

    it('rejects resource_id pointing at a non-opentasks resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/specs?resource_id=${memoryResource.id}`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for unknown resource_id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/specs?resource_id=res_does_not_exist',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/specs' });
      expect(res.statusCode).toBe(401);
    });

    it('returns empty list for an outsider with no resource access', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${otherAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toEqual([]);
    });

    it('surfaces context-with-metadata.kind=spec nodes alongside provider-emitted type=spec nodes', async () => {
      // Resource A's fixture already has 2 active provider-style specs
      // (s-aaa, s-bbb). Add a context node tagged as a spec to verify the
      // dual-source read path. Direct file write so we don't need the daemon.
      const graphPath = path.join(dirA, 'graph.jsonl');
      const existing = fs.readFileSync(graphPath, 'utf-8');
      const ctxSpec = {
        id: 'c-userspec',
        type: 'context',
        title: 'User-authored spec',
        content: 'Created via openhive UI',
        priority: 1,
        archived: false,
        metadata: { kind: 'spec' },
      };
      fs.writeFileSync(graphPath, existing + JSON.stringify(ctxSpec) + '\n');

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/specs?resource_id=${resourceA.id}`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const ids = body.data.map((s: { id: string }) => s.id).sort();
      expect(ids).toContain('c-userspec');
      expect(ids).toContain('s-aaa');
      expect(ids).toContain('s-bbb');
    });

    it('paginates via limit/offset', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/specs?limit=1&offset=0',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(1);
      // Total reflects whatever specs exist at this point. Earlier tests may
      // have appended new spec nodes; the assertion guards the basic shape
      // (page size honored, total >= page) without coupling to fixture order.
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.limit).toBe(1);
      expect(body.offset).toBe(0);
    });
  });

  // ==========================================================================
  // GET /specs/:resourceId/:specId
  // ==========================================================================

  describe('GET /specs/:resourceId/:specId', () => {
    it('returns spec + linked nodes grouped by kind', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/specs/${resourceA.id}/s-aaa`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.spec.id).toBe('s-aaa');
      expect(body.spec.title).toBe('Auth rewrite');
      // Linked task surfaced
      expect(body.linked.tasks.map((n: { id: string }) => n.id)).toContain('t-aaa');
      // Linked feedback surfaced
      expect(body.linked.feedback.map((n: { id: string }) => n.id)).toContain('f-aaa');
      // Edges include both connections
      expect(body.edges).toHaveLength(2);
    });

    it('returns 404 when spec id is unknown in the resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/specs/${resourceA.id}/s-not-real`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 when caller has no access to the resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/specs/${resourceA.id}/s-aaa`,
        headers: { Authorization: `Bearer ${otherAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects non-opentasks resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/specs/${memoryResource.id}/s-aaa`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ==========================================================================
  // POST /specs
  // ==========================================================================

  describe('POST /specs', () => {
    it('creates a spec, returns it normalized, and broadcasts spec.created', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: {
          resource_id: resourceB.id,
          title: 'Brand new spec',
          content: 'fresh content',
          priority: 1,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.spec.title).toBe('Brand new spec');
      expect(body.spec.resource_id).toBe(resourceB.id);
      expect(body.spec.priority).toBe(1);

      expect(broadcastSpy).toHaveBeenCalledWith(
        'map:tasks',
        expect.objectContaining({
          type: 'spec.created',
          data: expect.objectContaining({
            resource_id: resourceB.id,
            initiator: { type: 'user', id: testAgent.id },
          }),
        }),
      );
    });

    it('rejects missing title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { resource_id: resourceB.id },
      });
      expect(res.statusCode).toBe(422);
    });

    it('rejects missing resource_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'no resource' },
      });
      expect(res.statusCode).toBe(422);
    });

    it('rejects non-opentasks resource', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { resource_id: memoryResource.id, title: 'wrong type' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 403 when caller has no access', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/specs',
        headers: { Authorization: `Bearer ${otherAgent.apiKey}` },
        payload: { resource_id: resourceA.id, title: 'sneaky' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ==========================================================================
  // PATCH /specs/:resourceId/:specId
  // ==========================================================================

  describe('PATCH /specs/:resourceId/:specId', () => {
    it('updates a spec field and broadcasts spec.updated', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/specs/${resourceA.id}/s-bbb`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { title: 'Search redesign v2' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.spec.title).toBe('Search redesign v2');

      expect(broadcastSpy).toHaveBeenCalledWith(
        'map:tasks',
        expect.objectContaining({
          type: 'spec.updated',
          data: expect.objectContaining({ resource_id: resourceA.id }),
        }),
      );
    });

    it('archives a spec when archived: true is passed', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/specs/${resourceB.id}/s-zzz`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { archived: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.spec.archived).toBe(true);
    });

    it('rejects update with no fields', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/specs/${resourceA.id}/s-aaa`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: {},
      });
      expect(res.statusCode).toBe(422);
    });

    it('returns 403 when caller has no access', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/specs/${resourceA.id}/s-aaa`,
        headers: { Authorization: `Bearer ${otherAgent.apiKey}` },
        payload: { title: 'nope' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ==========================================================================
  // POST /specs/:resourceId/:specId/dispatch (Stream 2 PR 1b)
  // ==========================================================================

  describe('POST /specs/:resourceId/:specId/dispatch', () => {
    let swarmA: { id: string; name: string };
    let swarmB: { id: string; name: string };

    beforeAll(async () => {
      const a = mapDAL.createSwarm(testAgent.id, {
        name: 'swarm-alpha',
        map_endpoint: 'ws://example.invalid/swarm-alpha',
      });
      const b = mapDAL.createSwarm(testAgent.id, {
        name: 'swarm-beta',
        map_endpoint: 'ws://example.invalid/swarm-beta',
      });
      swarmA = { id: a.id, name: a.name };
      swarmB = { id: b.id, name: b.name };

      // Register both swarms as mail-capable so the dispatch pre-flight gate
      // allows queueing. Tests here don't exercise the orchestrator — rows
      // are inspected directly via the DAL.
      const fakeWs = () => ({ readyState: 1, send() {}, close() {} } as unknown as import('ws').WebSocket);
      for (const s of [swarmA, swarmB]) {
        registerInbound(s.id, {
          ws: fakeWs(),
          agentId: 'mailagent',
          swarmId: s.id,
          connectedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          registeredAgents: new Map([
            [
              'mailagent',
              {
                id: 'mailagent',
                name: 'mailagent',
                role: 'worker',
                state: 'active',
                scopes: [],
                capabilities: { mail: { canJoin: true } },
              },
            ],
          ]),
        });
      }
      setAcpAvailabilityProbe(() => true);
    });

    afterAll(() => {
      unregisterInbound(swarmA.id);
      unregisterInbound(swarmB.id);
      _resetDispatchRouting();
    });

    beforeEach(() => {
      // Wipe dispatches so per-test counts are deterministic.
      getDatabase().prepare('DELETE FROM dispatches').run();
    });

    it('creates one dispatch per target swarm', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [swarmA.id, swarmB.id] },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.dispatches).toHaveLength(2);

      const swarmIds = body.dispatches.map((d: { target_swarm_id: string }) => d.target_swarm_id);
      expect(swarmIds.sort()).toEqual([swarmA.id, swarmB.id].sort());

      // Each dispatch row was actually written.
      const persisted = dispatchesDAL.listDispatches({ spec_id: 's-aaa' });
      expect(persisted.total).toBe(2);
      persisted.data.forEach((d) => {
        expect(d.status).toBe('queued');
        expect(d.initiator_type).toBe('user');
        expect(d.initiator_id).toBe(testAgent.id);
      });
    });

    it('captures spec.updated_at as captured_at', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [swarmA.id] },
      });
      const body = JSON.parse(res.body);
      // Fixture has no updated_at on s-aaa; whatever the daemon mock returned
      // for that field should round-trip into the dispatch.
      expect(body.dispatches[0].spec_captured_at !== undefined).toBe(true);
    });

    it('builds a seed prompt with <dispatch> header, spec body, ## Tasks, and ## Additional instructions', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: {
          target_swarms: [swarmA.id],
          prompt: 'be careful with the migration',
        },
      });
      const body = JSON.parse(res.body);
      const seed: string = body.dispatches[0].seed_prompt;
      expect(seed).toMatch(/^<dispatch id="disp_/);
      expect(seed).toContain(`spec="${resourceA.id}:s-aaa"`);
      expect(seed).toContain('map/dispatches/report');
      expect(seed).toContain('# Auth rewrite');
      expect(seed).toContain('rewrite the auth flow');
      expect(seed).toContain('## Tasks');
      // Linked task t-aaa from the fixture
      expect(seed).toContain('`t-aaa`');
      expect(seed).toContain('## Additional instructions');
      expect(seed).toContain('be careful with the migration');
    });

    it('omits empty optional sections', async () => {
      // s-bbb (Search redesign) has no linked tasks in the fixture
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-bbb/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [swarmA.id] },
      });
      const seed: string = JSON.parse(res.body).dispatches[0].seed_prompt;
      expect(seed).not.toContain('## Tasks');
      expect(seed).not.toContain('## Additional instructions');
    });

    it('includes target_swarm_name in response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [swarmA.id] },
      });
      const body = JSON.parse(res.body);
      expect(body.dispatches[0].target_swarm_name).toBe(swarmA.name);
    });

    it('broadcasts dispatch.created on map:dispatches per dispatch', async () => {
      broadcastSpy.mockClear();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [swarmA.id, swarmB.id] },
      });
      expect(res.statusCode).toBe(201);
      const dispatchCalls = broadcastSpy.mock.calls.filter(
        (c) => c[0] === 'map:dispatches' && (c[1] as { type: string }).type === 'dispatch.created',
      );
      expect(dispatchCalls).toHaveLength(2);
      const payload = dispatchCalls[0]![1] as { data: { initiator: { type: string; id: string } } };
      expect(payload.data.initiator).toEqual({ type: 'user', id: testAgent.id });
    });

    it('dedupes target_swarms', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [swarmA.id, swarmA.id, swarmA.id] },
      });
      expect(JSON.parse(res.body).dispatches).toHaveLength(1);
    });

    it('rejects empty target_swarms', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [] },
      });
      expect(res.statusCode).toBe(422);
    });

    it('returns 404 when target swarm does not exist', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: ['swarm_nope'] },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 503 when target swarm has no viable dispatch transport', async () => {
      // A swarm that exists but has no registered agents / no capabilities.
      const unreachable = mapDAL.createSwarm(testAgent.id, {
        name: 'swarm-unreachable',
        map_endpoint: 'ws://example.invalid/unreachable',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [unreachable.id] },
      });

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.message).toMatch(/no transport available/);

      // No rows should have been queued.
      expect(dispatchesDAL.listDispatches({ target_swarm_id: unreachable.id }).total).toBe(0);
    });

    it('returns 404 for an unknown spec', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-doesnt-exist/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [swarmA.id] },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 when caller has no access to the spec', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${resourceA.id}/s-aaa/dispatch`,
        headers: { Authorization: `Bearer ${otherAgent.apiKey}` },
        payload: { target_swarms: [swarmA.id] },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects when the spec resource is not opentasks', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/specs/${memoryResource.id}/anything/dispatch`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        payload: { target_swarms: [swarmA.id] },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ==========================================================================
  // buildDispatchSeedPrompt unit tests
  // ==========================================================================

  describe('buildDispatchSeedPrompt', () => {
    it('produces a header with dispatch id, spec ref, and captured_at', () => {
      const out = buildDispatchSeedPrompt({
        dispatchId: 'disp_xyz',
        resourceId: 'res_a',
        specId: 's-1',
        capturedAt: '2026-04-15T20:00:00Z',
        title: 'T',
        content: '',
        linkedTasks: [],
      });
      expect(out).toMatch(
        /<dispatch id="disp_xyz" spec="res_a:s-1" captured_at="2026-04-15T20:00:00Z">/,
      );
      expect(out).toContain('</dispatch>');
    });

    it('omits captured_at attribute when null', () => {
      const out = buildDispatchSeedPrompt({
        dispatchId: 'disp_xyz',
        resourceId: 'res_a',
        specId: 's-1',
        capturedAt: null,
        title: 'T',
        content: '',
        linkedTasks: [],
      });
      expect(out).not.toContain('captured_at=');
    });

    it('falls back to "Untitled spec" when title is empty', () => {
      const out = buildDispatchSeedPrompt({
        dispatchId: 'd', resourceId: 'r', specId: 's', capturedAt: null,
        title: '', content: '', linkedTasks: [],
      });
      expect(out).toContain('# Untitled spec');
    });

    it('renders task entries with status prefix when present', () => {
      const out = buildDispatchSeedPrompt({
        dispatchId: 'd', resourceId: 'r', specId: 's', capturedAt: null,
        title: 'T', content: '',
        linkedTasks: [
          { id: 't-1', title: 'first', status: 'open' },
          { id: 't-2', title: 'second' },
        ],
      });
      expect(out).toContain('- [open] `t-1` — first');
      expect(out).toContain('- `t-2` — second');
    });

    it('omits ## Tasks header when no linked tasks', () => {
      const out = buildDispatchSeedPrompt({
        dispatchId: 'd', resourceId: 'r', specId: 's', capturedAt: null,
        title: 'T', content: '', linkedTasks: [],
      });
      expect(out).not.toContain('## Tasks');
    });

    it('omits ## Additional instructions when prompt_override is missing or whitespace', () => {
      const a = buildDispatchSeedPrompt({
        dispatchId: 'd', resourceId: 'r', specId: 's', capturedAt: null,
        title: 'T', content: '', linkedTasks: [],
      });
      const b = buildDispatchSeedPrompt({
        dispatchId: 'd', resourceId: 'r', specId: 's', capturedAt: null,
        title: 'T', content: '', linkedTasks: [], promptOverride: '   ',
      });
      expect(a).not.toContain('## Additional instructions');
      expect(b).not.toContain('## Additional instructions');
    });
  });
});
