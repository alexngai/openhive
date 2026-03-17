/**
 * Tests for MAP OpenTasks request handler:
 * - Dispatches map/opentasks/* methods to OpenHiveOpenTasksClient
 * - Validates required params (resource_id)
 * - Validates resource access and type
 * - Returns correct result shapes
 * - Handles errors properly
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { handleOpenTasksRequest, OpenTasksRequestError } from '../../map/opentasks-handler.js';
import { MAP_OPENTASKS_METHODS } from '../../map/opentasks-types.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('opentasks-handler');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'handler-test.db');

// ============================================================================
// Fixture Helpers
// ============================================================================

interface GraphNode {
  id: string;
  type: 'task' | 'context' | 'feedback' | 'external';
  title?: string;
  status?: string;
  priority?: number;
  archived?: boolean;
}

interface GraphEdge {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  deleted?: boolean;
}

function buildGraphJsonl(nodes: GraphNode[], edges: GraphEdge[]): string {
  const lines: string[] = [];
  for (const node of nodes) lines.push(JSON.stringify(node));
  for (const edge of edges) lines.push(JSON.stringify(edge));
  return lines.join('\n') + '\n';
}

function createOpenTasksDir(
  baseDir: string,
  opts: { nodes?: GraphNode[]; edges?: GraphEdge[]; locationHash?: string; locationName?: string } = {},
): string {
  const opentasksDir = path.join(baseDir, '.opentasks');
  fs.mkdirSync(opentasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(opentasksDir, 'graph.jsonl'),
    buildGraphJsonl(opts.nodes || [], opts.edges || []),
  );
  if (opts.locationHash) {
    const config: Record<string, unknown> = {
      location: { hash: opts.locationHash, name: opts.locationName || opts.locationHash },
    };
    fs.writeFileSync(path.join(opentasksDir, 'config.json'), JSON.stringify(config));
  }
  return opentasksDir;
}

// ============================================================================
// Tests
// ============================================================================

describe('handleOpenTasksRequest', () => {
  let agentId: string;
  let resourceId: string;
  const ctx = { swarmId: 'swarm-test', agentId: '' };

  beforeAll(async () => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
    initDatabase(TEST_DB_PATH);

    // Create an agent
    const { agent } = await agentsDAL.createAgent({ name: 'test-agent' });
    agentId = agent.id;
    ctx.agentId = agentId;

    // Create an .opentasks directory with test data
    const fixtureDir = mkTestDir(TEST_ROOT, 'opentasks-fixture');
    const opentasksDir = createOpenTasksDir(fixtureDir, {
      nodes: [
        { id: 't-1', type: 'task', title: 'Ready Task', status: 'open', priority: 1 },
        { id: 't-2', type: 'task', title: 'Blocked Task', status: 'open', priority: 2 },
        { id: 't-3', type: 'task', title: 'Blocker', status: 'open', priority: 0 },
        { id: 't-4', type: 'task', title: 'Done', status: 'closed' },
        { id: 'c-1', type: 'context', title: 'Context Node' },
        { id: 'f-1', type: 'feedback', title: 'Feedback Node' },
      ],
      edges: [
        { id: 'e-1', from_id: 't-3', to_id: 't-2', type: 'blocks' },
      ],
    });

    // Register the resource pointing to the .opentasks directory
    const resource = resourcesDAL.createResource({
      name: 'test-opentasks',
      resource_type: 'task',
      git_remote_url: opentasksDir,
      owner_agent_id: agentId,
      visibility: 'public',
      metadata: { opentasks: true },
    });
    resourceId = resource.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ==========================================================================
  // map/opentasks/summary
  // ==========================================================================

  describe('map/opentasks/summary', () => {
    it('returns graph summary with correct counts', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { resource_id: resourceId },
        ctx,
      );

      expect(result).toHaveProperty('node_count', 6);
      expect(result).toHaveProperty('edge_count', 1);
      expect(result).toHaveProperty('context_count', 1);
      expect(result).toHaveProperty('feedback_count', 1);
      expect(result).toHaveProperty('daemon_connected', false);
      expect(result).toHaveProperty('task_counts');
      const summary = result as { task_counts: Record<string, number> };
      expect(summary.task_counts.open).toBe(3);
      expect(summary.task_counts.closed).toBe(1);
    });

    it('throws on missing resource_id', async () => {
      await expect(
        handleOpenTasksRequest(MAP_OPENTASKS_METHODS.SUMMARY, {}, ctx),
      ).rejects.toThrow(OpenTasksRequestError);
    });

    it('throws on null params', async () => {
      await expect(
        handleOpenTasksRequest(MAP_OPENTASKS_METHODS.SUMMARY, null, ctx),
      ).rejects.toThrow(OpenTasksRequestError);
    });
  });

  // ==========================================================================
  // map/opentasks/ready
  // ==========================================================================

  describe('map/opentasks/ready', () => {
    it('returns ready (unblocked open) tasks', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.READY,
        { resource_id: resourceId },
        ctx,
      ) as { items: Array<{ id: string }>; total: number };

      // t-1 (no blockers), t-3 (no blockers) are ready; t-2 is blocked by t-3
      const ids = result.items.map(i => i.id);
      expect(ids).toContain('t-1');
      expect(ids).toContain('t-3');
      expect(ids).not.toContain('t-2');
      expect(result.total).toBe(2);
    });

    it('sorts by priority (lower number = higher priority)', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.READY,
        { resource_id: resourceId },
        ctx,
      ) as { items: Array<{ id: string; priority?: number }> };

      // t-3 has priority 0, t-1 has priority 1
      expect(result.items[0].id).toBe('t-3');
      expect(result.items[1].id).toBe('t-1');
    });

    it('respects limit parameter', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.READY,
        { resource_id: resourceId, limit: 1 },
        ctx,
      ) as { items: unknown[]; total: number };

      expect(result.items).toHaveLength(1);
    });

    it('throws on missing resource_id', async () => {
      await expect(
        handleOpenTasksRequest(MAP_OPENTASKS_METHODS.READY, {}, ctx),
      ).rejects.toThrow(OpenTasksRequestError);
    });
  });

  // ==========================================================================
  // map/opentasks/query
  // ==========================================================================

  describe('map/opentasks/query', () => {
    it('returns fallback when daemon is not running', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.QUERY,
        { resource_id: resourceId },
        ctx,
      ) as { daemon_connected: boolean; items: unknown[] };

      expect(result.daemon_connected).toBe(false);
      expect(result.items).toEqual([]);
    });

    it('throws on missing resource_id', async () => {
      await expect(
        handleOpenTasksRequest(MAP_OPENTASKS_METHODS.QUERY, {}, ctx),
      ).rejects.toThrow(OpenTasksRequestError);
    });
  });

  // ==========================================================================
  // map/opentasks/status
  // ==========================================================================

  describe('map/opentasks/status', () => {
    it('returns daemon and graph file status', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.STATUS,
        { resource_id: resourceId },
        ctx,
      ) as {
        daemon_running: boolean;
        graph_file_exists: boolean;
        graph_last_modified: string | null;
      };

      expect(result.daemon_running).toBe(false);
      expect(result.graph_file_exists).toBe(true);
      expect(result.graph_last_modified).toBeTruthy();
    });

    it('throws on missing resource_id', async () => {
      await expect(
        handleOpenTasksRequest(MAP_OPENTASKS_METHODS.STATUS, {}, ctx),
      ).rejects.toThrow(OpenTasksRequestError);
    });
  });

  // ==========================================================================
  // Access control & validation
  // ==========================================================================

  describe('access control', () => {
    it('throws on non-existent resource', async () => {
      await expect(
        handleOpenTasksRequest(
          MAP_OPENTASKS_METHODS.SUMMARY,
          { resource_id: 'non-existent' },
          ctx,
        ),
      ).rejects.toThrow(/not found/i);
    });

    it('throws on non-opentasks resource', async () => {
      const dir = mkTestDir(TEST_ROOT, 'non-opentasks');
      const memResource = resourcesDAL.createResource({
        name: 'memory-bank',
        resource_type: 'memory_bank',
        git_remote_url: dir,
        owner_agent_id: agentId,
        visibility: 'public',
        metadata: {},
      });

      await expect(
        handleOpenTasksRequest(
          MAP_OPENTASKS_METHODS.SUMMARY,
          { resource_id: memResource.id },
          ctx,
        ),
      ).rejects.toThrow(/not an OpenTasks resource/i);
    });

    it('throws on access denied for private resource', async () => {
      const { agent: otherAgent } = await agentsDAL.createAgent({ name: 'other-agent' });
      const dir = mkTestDir(TEST_ROOT, 'private-opentasks');
      createOpenTasksDir(dir);

      const privateResource = resourcesDAL.createResource({
        name: 'private-tasks',
        resource_type: 'task',
        git_remote_url: path.join(dir, '.opentasks'),
        owner_agent_id: agentId,
        visibility: 'private',
        metadata: { opentasks: true },
      });

      await expect(
        handleOpenTasksRequest(
          MAP_OPENTASKS_METHODS.SUMMARY,
          { resource_id: privateResource.id },
          { swarmId: 'other-swarm', agentId: otherAgent.id },
        ),
      ).rejects.toThrow(/access denied/i);
    });
  });

  // ==========================================================================
  // Path-based resolution
  // ==========================================================================

  describe('path-based resolution', () => {
    let pathFixtureDir: string;
    let opentasksDirPath: string;

    beforeAll(() => {
      pathFixtureDir = mkTestDir(TEST_ROOT, 'path-fixture');
      opentasksDirPath = createOpenTasksDir(pathFixtureDir, {
        nodes: [
          { id: 'p-1', type: 'task', title: 'Path Task 1', status: 'open', priority: 1 },
          { id: 'p-2', type: 'task', title: 'Path Task 2', status: 'open', priority: 0 },
        ],
        edges: [],
      });
    });

    it('resolves by .opentasks directory path (auto-registers)', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { path: opentasksDirPath },
        ctx,
      );

      expect(result).toHaveProperty('node_count', 2);
      expect(result).toHaveProperty('daemon_connected', false);
    });

    it('resolves by parent directory path (finds .opentasks inside)', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { path: pathFixtureDir },
        ctx,
      );

      expect(result).toHaveProperty('node_count', 2);
    });

    it('returns correct ready tasks via path', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.READY,
        { path: opentasksDirPath },
        ctx,
      ) as { items: Array<{ id: string }>; total: number };

      const ids = result.items.map(i => i.id);
      expect(ids).toContain('p-1');
      expect(ids).toContain('p-2');
      expect(result.total).toBe(2);
    });

    it('reuses auto-registered resource on subsequent calls', async () => {
      // First call registers
      const result1 = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.STATUS,
        { path: opentasksDirPath },
        ctx,
      ) as { graph_file_exists: boolean };
      expect(result1.graph_file_exists).toBe(true);

      // Second call should find existing resource, not create a new one
      const result2 = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.STATUS,
        { path: opentasksDirPath },
        ctx,
      ) as { graph_file_exists: boolean };
      expect(result2.graph_file_exists).toBe(true);
    });

    it('throws on invalid path (no .opentasks)', async () => {
      const emptyDir = mkTestDir(TEST_ROOT, 'empty-dir');
      await expect(
        handleOpenTasksRequest(
          MAP_OPENTASKS_METHODS.SUMMARY,
          { path: emptyDir },
          ctx,
        ),
      ).rejects.toThrow(/no valid .opentasks directory/i);
    });

    it('throws when neither resource_id nor path nor location_hash is provided', async () => {
      await expect(
        handleOpenTasksRequest(MAP_OPENTASKS_METHODS.SUMMARY, {}, ctx),
      ).rejects.toThrow(/missing resource_id, path, or location_hash/i);
    });

    it('resolves symlinked path to same resource as real path', async () => {
      const symlinkDir = path.join(TEST_ROOT, 'symlink-fixture');
      try {
        fs.symlinkSync(pathFixtureDir, symlinkDir);
      } catch {
        // Skip if symlinks not supported (Windows without admin)
        return;
      }

      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { path: path.join(symlinkDir, '.opentasks') },
        ctx,
      );

      // Should resolve to the same underlying resource (2 nodes)
      expect(result).toHaveProperty('node_count', 2);

      fs.unlinkSync(symlinkDir);
    });

    it('resolves relative path to same resource', async () => {
      // Use a path with redundant segments that resolve() normalizes
      const redundantPath = path.join(pathFixtureDir, '..', path.basename(pathFixtureDir), '.opentasks');
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { path: redundantPath },
        ctx,
      );

      expect(result).toHaveProperty('node_count', 2);
    });

    it('prefers resource_id over path when both provided', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { resource_id: resourceId, path: opentasksDirPath },
        ctx,
      );

      // Should use the original resource (6 nodes) not the path fixture (2 nodes)
      expect(result).toHaveProperty('node_count', 6);
    });
  });

  // ==========================================================================
  // Location hash resolution (cross-instance identity)
  // ==========================================================================

  describe('location_hash resolution', () => {
    const HASH_A = 'k7m2x9p4';

    beforeAll(() => {
      const hashDir = mkTestDir(TEST_ROOT, 'hash-opentasks');
      const opentasksDir = createOpenTasksDir(hashDir, {
        nodes: [
          { id: 'h-1', type: 'task', title: 'Hash Task', status: 'open', priority: 1 },
        ],
        edges: [],
        locationHash: HASH_A,
        locationName: 'test-workspace',
      });

      resourcesDAL.createResource({
        name: 'hash-test/opentasks',
        resource_type: 'task',
        git_remote_url: opentasksDir,
        owner_agent_id: agentId,
        visibility: 'public',
        metadata: { opentasks: true, location_hash: HASH_A, location_name: 'test-workspace' },
      });
    });

    it('resolves resource by location_hash', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { location_hash: HASH_A },
        ctx,
      );

      expect(result).toHaveProperty('node_count', 1);
      expect(result).toHaveProperty('daemon_connected', false);
    });

    it('returns ready tasks via location_hash', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.READY,
        { location_hash: HASH_A },
        ctx,
      ) as { items: Array<{ id: string }>; total: number };

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('h-1');
    });

    it('throws on non-existent location_hash', async () => {
      await expect(
        handleOpenTasksRequest(
          MAP_OPENTASKS_METHODS.SUMMARY,
          { location_hash: 'nonexistent' },
          ctx,
        ),
      ).rejects.toThrow(/not found with location_hash/i);
    });

    it('prefers resource_id over location_hash', async () => {
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { resource_id: resourceId, location_hash: HASH_A },
        ctx,
      );

      // Should use the original resource (6 nodes) not the hash resource (1 node)
      expect(result).toHaveProperty('node_count', 6);
    });

    it('prefers path over location_hash', async () => {
      const pathDir = mkTestDir(TEST_ROOT, 'path-vs-hash');
      createOpenTasksDir(pathDir, {
        nodes: [
          { id: 'ph-1', type: 'task', title: 'PvH 1', status: 'open' },
          { id: 'ph-2', type: 'task', title: 'PvH 2', status: 'open' },
          { id: 'ph-3', type: 'task', title: 'PvH 3', status: 'open' },
        ],
        edges: [],
      });

      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { path: pathDir, location_hash: HASH_A },
        ctx,
      );

      // Should use path (3 nodes) not location_hash (1 node)
      expect(result).toHaveProperty('node_count', 3);
    });

    it('location_hash access denied for private resource from other agent', async () => {
      const { agent: otherAgent } = await agentsDAL.createAgent({ name: 'hash-test-other' });
      const privateDir = mkTestDir(TEST_ROOT, 'private-hash');
      const privateHash = 'priv8xyz';
      const privateOpentasksDir = createOpenTasksDir(privateDir, {
        locationHash: privateHash,
      });

      resourcesDAL.createResource({
        name: 'private-hash/opentasks',
        resource_type: 'task',
        git_remote_url: privateOpentasksDir,
        owner_agent_id: agentId,
        visibility: 'private',
        metadata: { opentasks: true, location_hash: privateHash },
      });

      // Other agent tries to access by location_hash — should not find it
      await expect(
        handleOpenTasksRequest(
          MAP_OPENTASKS_METHODS.SUMMARY,
          { location_hash: privateHash },
          { swarmId: 'other', agentId: otherAgent.id },
        ),
      ).rejects.toThrow(/not found with location_hash/i);
    });

    it('auto-registered resource is findable by location_hash', async () => {
      const autoDir = mkTestDir(TEST_ROOT, 'auto-hash');
      const autoHash = 'auto1234';
      createOpenTasksDir(autoDir, {
        nodes: [
          { id: 'a-1', type: 'task', title: 'Auto Hash Task', status: 'open' },
          { id: 'a-2', type: 'task', title: 'Auto Hash Task 2', status: 'open' },
        ],
        edges: [],
        locationHash: autoHash,
      });

      // First: auto-register via path
      await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { path: autoDir },
        ctx,
      );

      // Then: resolve via location_hash (should find the auto-registered resource)
      const result = await handleOpenTasksRequest(
        MAP_OPENTASKS_METHODS.SUMMARY,
        { location_hash: autoHash },
        ctx,
      );

      expect(result).toHaveProperty('node_count', 2);
    });
  });

  // ==========================================================================
  // Unknown method
  // ==========================================================================

  it('throws on unknown method', async () => {
    await expect(
      handleOpenTasksRequest('map/opentasks/delete', {}, ctx),
    ).rejects.toThrow(OpenTasksRequestError);
  });
});
