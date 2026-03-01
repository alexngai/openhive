/**
 * Tests for OpenHiveOpenTasksClient — JSONL parsing, graph summaries,
 * ready task computation, and edge cases.
 *
 * Daemon IPC is NOT tested here (requires a running Unix socket server).
 * These tests focus on the JSONL fallback paths which are the primary
 * code paths exercised when no daemon is available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { OpenHiveOpenTasksClient } from '../../opentasks-client/client.js';
import { testRoot, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('opentasks-client');

// ============================================================================
// JSONL Fixture Builders
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

function buildGraphJsonl(nodes: GraphNode[], edges: (GraphEdge)[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(JSON.stringify(node));
  }
  for (const edge of edges) {
    lines.push(JSON.stringify(edge));
  }
  return lines.join('\n') + '\n';
}

/** Create an .opentasks/ directory with graph.jsonl and optional config.json */
function createOpenTasksFixture(
  baseDir: string,
  opts: {
    nodes?: GraphNode[];
    edges?: GraphEdge[];
    config?: Record<string, unknown>;
  } = {},
): string {
  const opentasksDir = path.join(baseDir, '.opentasks');
  fs.mkdirSync(opentasksDir, { recursive: true });

  const nodes = opts.nodes || [];
  const edges = opts.edges || [];

  fs.writeFileSync(
    path.join(opentasksDir, 'graph.jsonl'),
    buildGraphJsonl(nodes, edges),
  );

  if (opts.config) {
    fs.writeFileSync(
      path.join(opentasksDir, 'config.json'),
      JSON.stringify(opts.config, null, 2),
    );
  }

  return opentasksDir;
}

// ============================================================================
// Tests
// ============================================================================

describe('OpenHiveOpenTasksClient', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterAll(() => {
    cleanTestRoot(TEST_ROOT);
  });

  // --------------------------------------------------------------------------
  // getGraphSummary
  // --------------------------------------------------------------------------

  describe('getGraphSummary', () => {
    it('should return zeros for missing graph.jsonl', async () => {
      const dir = mkTestDir(TEST_ROOT, 'empty-dir');
      const opentasksDir = path.join(dir, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const summary = await client.getGraphSummary();

      expect(summary.node_count).toBe(0);
      expect(summary.edge_count).toBe(0);
      expect(summary.task_counts).toEqual({ open: 0, in_progress: 0, blocked: 0, closed: 0 });
      expect(summary.context_count).toBe(0);
      expect(summary.feedback_count).toBe(0);
      expect(summary.ready_count).toBe(0);
    });

    it('should count nodes and edges correctly', async () => {
      const dir = mkTestDir(TEST_ROOT, 'basic-graph');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Task 1', status: 'open' },
          { id: 't-2', type: 'task', title: 'Task 2', status: 'closed' },
          { id: 'c-1', type: 'context', title: 'Context 1' },
          { id: 'f-1', type: 'feedback', title: 'Feedback 1' },
        ],
        edges: [
          { id: 'e-1', from_id: 't-1', to_id: 't-2', type: 'blocks' },
          { id: 'e-2', from_id: 'c-1', to_id: 't-1', type: 'references' },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const summary = await client.getGraphSummary();

      expect(summary.node_count).toBe(4);
      expect(summary.edge_count).toBe(2);
      expect(summary.context_count).toBe(1);
      expect(summary.feedback_count).toBe(1);
    });

    it('should count task statuses correctly', async () => {
      const dir = mkTestDir(TEST_ROOT, 'task-statuses');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Open 1', status: 'open' },
          { id: 't-2', type: 'task', title: 'Open 2', status: 'open' },
          { id: 't-3', type: 'task', title: 'In Progress', status: 'in_progress' },
          { id: 't-4', type: 'task', title: 'Blocked', status: 'blocked' },
          { id: 't-5', type: 'task', title: 'Closed 1', status: 'closed' },
          { id: 't-6', type: 'task', title: 'Closed 2', status: 'closed' },
          { id: 't-7', type: 'task', title: 'Closed 3', status: 'closed' },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const summary = await client.getGraphSummary();

      expect(summary.task_counts).toEqual({
        open: 2,
        in_progress: 1,
        blocked: 1,
        closed: 3,
      });
    });

    it('should exclude archived nodes from task counts', async () => {
      const dir = mkTestDir(TEST_ROOT, 'archived-tasks');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Active Open', status: 'open' },
          { id: 't-2', type: 'task', title: 'Archived Open', status: 'open', archived: true },
          { id: 'c-1', type: 'context', title: 'Active Context' },
          { id: 'c-2', type: 'context', title: 'Archived Context', archived: true },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const summary = await client.getGraphSummary();

      expect(summary.task_counts.open).toBe(1);
      expect(summary.context_count).toBe(1);
    });

    it('should compute ready_count for unblocked open tasks', async () => {
      const dir = mkTestDir(TEST_ROOT, 'ready-count');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Unblocked', status: 'open' },
          { id: 't-2', type: 'task', title: 'Blocked by t-3', status: 'open' },
          { id: 't-3', type: 'task', title: 'Blocker (open)', status: 'open' },
        ],
        edges: [
          { id: 'e-1', from_id: 't-3', to_id: 't-2', type: 'blocks' },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const summary = await client.getGraphSummary();

      // t-1 is ready (no blockers), t-3 is ready (no blockers), t-2 is blocked by t-3
      expect(summary.ready_count).toBe(2);
    });

    it('should count tasks as ready when all blockers are closed', async () => {
      const dir = mkTestDir(TEST_ROOT, 'resolved-blockers');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Was blocked', status: 'open' },
          { id: 't-2', type: 'task', title: 'Resolved blocker', status: 'closed' },
        ],
        edges: [
          { id: 'e-1', from_id: 't-2', to_id: 't-1', type: 'blocks' },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const summary = await client.getGraphSummary();

      // t-1's blocker (t-2) is closed, so t-1 is ready
      expect(summary.ready_count).toBe(1);
    });

    it('should ignore deleted edges for blocking', async () => {
      const dir = mkTestDir(TEST_ROOT, 'deleted-edges');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Task', status: 'open' },
          { id: 't-2', type: 'task', title: 'Removed Blocker', status: 'open' },
        ],
        edges: [
          { id: 'e-1', from_id: 't-2', to_id: 't-1', type: 'blocks', deleted: true },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const summary = await client.getGraphSummary();

      // Deleted edge should not count as a blocker
      expect(summary.ready_count).toBe(2);
    });

    it('should handle malformed JSONL lines gracefully', async () => {
      const dir = mkTestDir(TEST_ROOT, 'malformed-jsonl');
      const opentasksDir = path.join(dir, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      // Mix valid and invalid lines
      const content = [
        JSON.stringify({ id: 't-1', type: 'task', title: 'Valid', status: 'open' }),
        'this is not json',
        '{"incomplete": true',
        JSON.stringify({ id: 'c-1', type: 'context', title: 'Also Valid' }),
      ].join('\n');
      fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), content);

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const summary = await client.getGraphSummary();

      expect(summary.node_count).toBe(2);
      expect(summary.task_counts.open).toBe(1);
      expect(summary.context_count).toBe(1);
    });

    it('should default task status to open when not specified', async () => {
      const dir = mkTestDir(TEST_ROOT, 'default-status');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'No Status' },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const summary = await client.getGraphSummary();

      // Default status is 'open'
      expect(summary.task_counts.open).toBe(1);
      expect(summary.ready_count).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // getReady (JSONL fallback path)
  // --------------------------------------------------------------------------

  describe('getReady', () => {
    it('should return empty array for missing graph.jsonl', async () => {
      const dir = mkTestDir(TEST_ROOT, 'ready-empty');
      const opentasksDir = path.join(dir, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const ready = await client.getReady();

      expect(ready).toEqual([]);
    });

    it('should return unblocked open tasks', async () => {
      const dir = mkTestDir(TEST_ROOT, 'ready-unblocked');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Ready Task', status: 'open' },
          { id: 't-2', type: 'task', title: 'Closed Task', status: 'closed' },
          { id: 't-3', type: 'task', title: 'In Progress', status: 'in_progress' },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const ready = await client.getReady();

      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe('t-1');
      expect(ready[0].title).toBe('Ready Task');
      expect(ready[0].type).toBe('task');
      expect(ready[0].status).toBe('open');
    });

    it('should exclude tasks with active blockers', async () => {
      const dir = mkTestDir(TEST_ROOT, 'ready-blocked');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Blocked', status: 'open' },
          { id: 't-2', type: 'task', title: 'Blocker', status: 'open' },
          { id: 't-3', type: 'task', title: 'Free', status: 'open' },
        ],
        edges: [
          { id: 'e-1', from_id: 't-2', to_id: 't-1', type: 'blocks' },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const ready = await client.getReady();

      const ids = ready.map(r => r.id);
      expect(ids).toContain('t-2');
      expect(ids).toContain('t-3');
      expect(ids).not.toContain('t-1');
    });

    it('should include tasks whose blockers are all closed', async () => {
      const dir = mkTestDir(TEST_ROOT, 'ready-resolved');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Unblocked Now', status: 'open' },
          { id: 't-2', type: 'task', title: 'Done Blocker', status: 'closed' },
        ],
        edges: [
          { id: 'e-1', from_id: 't-2', to_id: 't-1', type: 'blocks' },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const ready = await client.getReady();

      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe('t-1');
    });

    it('should exclude archived tasks', async () => {
      const dir = mkTestDir(TEST_ROOT, 'ready-archived');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Active', status: 'open' },
          { id: 't-2', type: 'task', title: 'Archived', status: 'open', archived: true },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const ready = await client.getReady();

      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe('t-1');
    });

    it('should sort by priority (lower = higher priority)', async () => {
      const dir = mkTestDir(TEST_ROOT, 'ready-priority');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-1', type: 'task', title: 'Low', status: 'open', priority: 4 },
          { id: 't-2', type: 'task', title: 'High', status: 'open', priority: 0 },
          { id: 't-3', type: 'task', title: 'Medium', status: 'open', priority: 2 },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const ready = await client.getReady();

      expect(ready.map(r => r.id)).toEqual(['t-2', 't-3', 't-1']);
    });

    it('should respect limit parameter', async () => {
      const dir = mkTestDir(TEST_ROOT, 'ready-limit');
      const nodes: GraphNode[] = [];
      for (let i = 0; i < 10; i++) {
        nodes.push({ id: `t-${i}`, type: 'task', title: `Task ${i}`, status: 'open', priority: i });
      }
      const opentasksDir = createOpenTasksFixture(dir, { nodes });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const ready = await client.getReady({ limit: 3 });

      expect(ready.length).toBe(3);
    });

    it('should use task id as title fallback', async () => {
      const dir = mkTestDir(TEST_ROOT, 'ready-no-title');
      const opentasksDir = createOpenTasksFixture(dir, {
        nodes: [
          { id: 't-no-title', type: 'task', status: 'open' },
        ],
      });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const ready = await client.getReady();

      expect(ready[0].title).toBe('t-no-title');
    });
  });

  // --------------------------------------------------------------------------
  // queryNodes (without daemon)
  // --------------------------------------------------------------------------

  describe('queryNodes', () => {
    it('should return null when daemon is not connected', async () => {
      const dir = mkTestDir(TEST_ROOT, 'query-no-daemon');
      const opentasksDir = path.join(dir, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const result = await client.queryNodes({ type: 'task' });

      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Connection state
  // --------------------------------------------------------------------------

  describe('connection state', () => {
    it('should report not connected by default', () => {
      const dir = mkTestDir(TEST_ROOT, 'conn-default');
      const opentasksDir = path.join(dir, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      expect(client.connected).toBe(false);
    });

    it('should report daemon not running when no socket exists', async () => {
      const dir = mkTestDir(TEST_ROOT, 'no-socket');
      const opentasksDir = path.join(dir, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const running = await client.isDaemonRunning();

      expect(running).toBe(false);
    });

    it('should fail to connect when no socket exists', async () => {
      const dir = mkTestDir(TEST_ROOT, 'no-connect');
      const opentasksDir = path.join(dir, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      const result = await client.connectDaemon();

      expect(result).toBe(false);
      expect(client.connected).toBe(false);
    });

    it('should read custom socket path from config.json', async () => {
      const dir = mkTestDir(TEST_ROOT, 'custom-socket');
      createOpenTasksFixture(dir, {
        nodes: [],
        config: {
          daemon: { socketPath: 'custom.sock' },
        },
      });

      const opentasksDir = path.join(dir, '.opentasks');
      const client = new OpenHiveOpenTasksClient(opentasksDir);

      // Even with custom socket path, it shouldn't be running
      const running = await client.isDaemonRunning();
      expect(running).toBe(false);
    });

    it('should handle disconnect gracefully when not connected', () => {
      const dir = mkTestDir(TEST_ROOT, 'disconnect-safe');
      const opentasksDir = path.join(dir, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      const client = new OpenHiveOpenTasksClient(opentasksDir);
      // Should not throw
      expect(() => client.disconnect()).not.toThrow();
    });
  });
});
