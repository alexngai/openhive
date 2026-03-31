/**
 * Tests for OpenTasks mutation endpoints and compatibility shim
 *
 * Covers:
 * - OpenTasks mutation MAP methods (create-task, update-status)
 * - OpenTasks mutation REST endpoints (POST/PATCH .../opentasks/tasks)
 * - Compatibility shim (x-openhive/task.assign → OpenTasks graph mutation)
 * - JSONL append format correctness
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Fastify from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { shimTaskAssign, shimTaskStatus } from '../../coordination/compat.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';
import type { Config } from '../../config.js';

const TEST_ROOT = testRoot('opentasks-mutations');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'ot-mutations.db');

function createOpenTasksDir(name: string): string {
  const dir = mkTestDir(TEST_ROOT, name);
  const otDir = mkTestDir(dir, '.opentasks');
  fs.writeFileSync(path.join(otDir, 'config.json'), JSON.stringify({
    location: { hash: `test-${name}`, name },
  }));
  fs.writeFileSync(path.join(otDir, 'graph.jsonl'),
    '{"id":"t1","type":"task","title":"Existing task","status":"open"}\n'
  );
  return otDir;
}

function readGraphLines(graphPath: string): Array<Record<string, unknown>> {
  const content = fs.readFileSync(graphPath, 'utf-8');
  return content.split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

describe('OpenTasks Mutations & Compatibility Shim', () => {
  let agentId: string;
  let apiKey: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const result = await agentsDAL.createAgent({
      name: 'ot-mutations-test-agent',
      description: 'Agent for OpenTasks mutation tests',
    });
    agentId = result.agent.id;
    apiKey = result.apiKey;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ============================================================================
  // Compatibility Shim Tests
  // ============================================================================

  describe('Compatibility Shim', () => {
    let otDir: string;
    let compatAgentId: string;
    beforeAll(async () => {
      // Use a dedicated agent so the shim finds only this agent's resources
      const { agent } = await agentsDAL.createAgent({
        name: 'compat-shim-agent',
        description: 'Agent for compat shim tests',
      });
      compatAgentId = agent.id;

      otDir = createOpenTasksDir(`compat-${Date.now()}`);
      resourcesDAL.createResource({
        resource_type: 'task',
        name: 'compat-test-resource',
        git_remote_url: otDir,
        owner_agent_id: compatAgentId,
        sync_strategy: 'local',
        local_path: otDir,
        metadata: { opentasks: true },
      });
    });

    it('should create OpenTasks node from task.assign params', () => {
      const nodeId = shimTaskAssign({
        task_id: 'ct_old_123',
        title: 'Shimmed task',
        description: 'Created via compat shim',
        priority: 'high',
        assigned_by: compatAgentId,
        assigned_to_swarm: 'swarm_target',
        hive_id: 'hive_1',
      }, compatAgentId);

      expect(nodeId).toBeTruthy();
      expect(nodeId!.startsWith('task_')).toBe(true);

      // Verify the node was written to graph.jsonl
      const graphPath = path.join(otDir, 'graph.jsonl');
      const lines = readGraphLines(graphPath);
      const shimmed = lines.find(l => l.id === nodeId);
      expect(shimmed).toBeDefined();
      expect(shimmed!.title).toBe('Shimmed task');
      expect(shimmed!.priority).toBe(3); // 'high' → 3
      expect(shimmed!._coordination).toBeDefined();
      const coord = shimmed!._coordination as Record<string, unknown>;
      expect(coord.assigned_to_swarm).toBe('swarm_target');
      expect(coord.hive_id).toBe('hive_1');
    });

    it('should update status via shim', () => {
      // First create a task
      const nodeId = shimTaskAssign({
        task_id: 'ct_status_test',
        title: 'Task for status update',
        description: '',
        priority: 'medium',
        assigned_by: compatAgentId,
        assigned_to_swarm: 'swarm_2',
        hive_id: 'hive_1',
      }, compatAgentId)!;

      // Update its status via shim
      const handled = shimTaskStatus({
        task_id: nodeId,
        status: 'completed',
        result: { output: 'done' },
      }, compatAgentId);

      expect(handled).toBe(true);

      // Verify the update was appended
      const graphPath = path.join(otDir, 'graph.jsonl');
      const lines = readGraphLines(graphPath);
      const updates = lines.filter(l => l.id === nodeId);
      const lastUpdate = updates[updates.length - 1];
      expect(lastUpdate.status).toBe('completed');
      expect((lastUpdate.result as Record<string, unknown>).output).toBe('done');
    });

    it('should map coordination statuses to OpenTasks statuses', () => {
      const nodeId = shimTaskAssign({
        task_id: 'ct_map_status',
        title: 'Status mapping test',
        description: '',
        priority: 'low',
        assigned_by: compatAgentId,
        assigned_to_swarm: 'swarm_3',
        hive_id: 'hive_1',
      }, compatAgentId)!;

      shimTaskStatus({ task_id: nodeId, status: 'accepted' }, compatAgentId);

      const graphPath = path.join(otDir, 'graph.jsonl');
      const lines = readGraphLines(graphPath);
      const lastUpdate = lines.filter(l => l.id === nodeId).pop()!;
      expect(lastUpdate.status).toBe('in_progress'); // 'accepted' → 'in_progress'
    });

    it('should return null when no OpenTasks resource exists', () => {
      const result = shimTaskAssign({
        task_id: 'ct_no_resource',
        title: 'No resource',
        description: '',
        priority: 'low',
        assigned_by: 'agent_nonexistent_xyz',
        assigned_to_swarm: 'swarm_1',
        hive_id: 'hive_1',
      }, 'agent_nonexistent_xyz');

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // REST Mutation Endpoint Tests
  // ============================================================================

  describe('REST Mutation Endpoints', () => {
    let app: ReturnType<typeof Fastify>;
    let otDir: string;
    let resourceId: string;

    beforeAll(async () => {
      otDir = createOpenTasksDir(`rest-mutations-${Date.now()}`);
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'rest-mutation-test',
        git_remote_url: otDir,
        owner_agent_id: agentId,
        sync_strategy: 'local',
        local_path: otDir,
        metadata: { opentasks: true },
      });
      resourceId = resource.id;

      const config = ConfigSchema.parse({
        database: TEST_DB_PATH,
        instance: { name: 'Test', description: 'Test' },
        admin: { createOnStartup: false },
        auth: { mode: 'local' },
        rateLimit: { enabled: false },
      }) as Config;
      app = Fastify({ logger: false });
      app.decorateRequest('agent', null);

      await app.register(
        async (api: typeof app) => {
          await api.register(resourceContentRoutes, { config });
        },
        { prefix: '/api/v1' },
      );

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('should return 503 when daemon is not running for POST', async () => {
      // REST task mutations now route through the OpenTasks daemon.
      // Without a running daemon, the endpoint returns 503.
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${apiKey}` },
        payload: { title: 'REST created task', priority: 2 },
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Service Unavailable');
    });

    it('should reject POST without title', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks`,
        headers: { Authorization: `Bearer ${apiKey}` },
        payload: { priority: 2 },
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 503 when daemon is not running for PATCH', async () => {
      // REST task mutations now route through the OpenTasks daemon.
      // Without a running daemon, the endpoint returns 503.
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/task_fake`,
        headers: { Authorization: `Bearer ${apiKey}` },
        payload: { status: 'in_progress' },
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Service Unavailable');
    });

    it('should reject PATCH without status', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/resources/${resourceId}/content/opentasks/tasks/task_fake`,
        headers: { Authorization: `Bearer ${apiKey}` },
        payload: {},
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 404 for non-existent resource', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/resources/res_nonexistent/content/opentasks/tasks',
        headers: { Authorization: `Bearer ${apiKey}` },
        payload: { title: 'Orphan task' },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
