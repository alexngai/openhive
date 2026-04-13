/**
 * Tests for OpenTasks mutation endpoints
 *
 * Covers:
 * - OpenTasks mutation REST endpoints (POST/PATCH .../opentasks/tasks)
 * - Daemon unavailability handling (503 Service Unavailable)
 * - Validation (missing title/status → 422)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Fastify from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
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

describe('OpenTasks Mutations', () => {
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
      app.decorateRequest('agent');

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
