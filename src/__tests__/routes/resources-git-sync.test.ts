/**
 * Tests for the resource `git_sync` toggle endpoint.
 *
 *   PATCH /resources/:id/git-sync    — flip the flag + write opentasks config
 *   GET   /resources/:id/git-sync    — read the current flag
 *
 * Covers:
 *   - Happy path: enables sync, persists metadata, writes sync.git to config.json
 *   - Disabled flip clears enabled but preserves other fields
 *   - Rejects non-task resources
 *   - Rejects resources without a local_path
 *   - Rejects when caller has no access
 *   - GET returns null when never set
 *   - Schema validation rejects malformed bodies
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { resourcesRoutes } from '../../api/routes/resources.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('resources-git-sync');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'resources-git-sync.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Resources Git Sync Test', url: 'http://localhost:0' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(async (api) => {
    await api.register(resourcesRoutes, { config });
  }, { prefix: '/api/v1' });
  return app;
}

describe('PATCH/GET /resources/:id/git-sync', () => {
  let app: FastifyInstance;
  let owner: { id: string; apiKey: string };
  let stranger: { id: string; apiKey: string };
  let taskResourceId: string;
  let taskResourcePath: string;
  let memoryResourceId: string;
  let pathlessTaskResourceId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const config = createTestConfig();
    app = await createTestApp(config);

    const ownerAgent = await agentsDAL.createAgent({
      name: 'resources-git-sync-owner',
      description: 'Owner for git-sync tests',
    });
    owner = { id: ownerAgent.agent.id, apiKey: ownerAgent.apiKey };

    const strangerAgent = await agentsDAL.createAgent({
      name: 'resources-git-sync-stranger',
      description: 'Another agent for access tests',
    });
    stranger = { id: strangerAgent.agent.id, apiKey: strangerAgent.apiKey };

    // Task resource with a real local_path
    taskResourcePath = mkTestDir(TEST_ROOT, 'task-repo');
    fs.mkdirSync(path.join(taskResourcePath, '.opentasks'), { recursive: true });
    const taskResource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'git-sync-task',
      git_remote_url: taskResourcePath,
      visibility: 'private',
      owner_agent_id: owner.id,
      sync_strategy: 'local',
      local_path: taskResourcePath,
      metadata: { opentasks: true },
    });
    taskResourceId = taskResource.id;

    // Memory resource — git_sync should be rejected
    const memoryResource = resourcesDAL.createResource({
      resource_type: 'memory_bank',
      name: 'git-sync-mem',
      git_remote_url: 'https://example.com/mem.git',
      visibility: 'private',
      owner_agent_id: owner.id,
    });
    memoryResourceId = memoryResource.id;

    // Task resource without a local_path
    const pathlessTask = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'pathless-task',
      git_remote_url: 'https://example.com/t.git',
      visibility: 'private',
      owner_agent_id: owner.id,
    });
    pathlessTaskResourceId = pathlessTask.id;
  });

  afterAll(async () => {
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('enables git_sync, persists to metadata, and writes the daemon config', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${taskResourceId}/git-sync`,
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      payload: { enabled: true, remote: 'origin' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.git_sync).toMatchObject({ enabled: true, remote: 'origin' });
    expect(body.resource.metadata.git_sync).toMatchObject({ enabled: true });

    // Config on disk should have sync.git written
    const written = JSON.parse(
      fs.readFileSync(path.join(taskResourcePath, '.opentasks', 'config.json'), 'utf-8'),
    );
    expect(written.sync.git).toMatchObject({
      enabled: true,
      remote: 'origin',
      autoCommit: true,
      autoPush: true,
      pullOnStartup: true,
    });
  });

  it('GET returns the persisted git_sync block', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${taskResourceId}/git-sync`,
      headers: { Authorization: `Bearer ${owner.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.git_sync).toMatchObject({ enabled: true, remote: 'origin' });
  });

  it('disable flips enabled but preserves other metadata keys', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${taskResourceId}/git-sync`,
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.resource.metadata.git_sync.enabled).toBe(false);
    // Pre-existing `opentasks: true` marker must survive the merge.
    expect(body.resource.metadata.opentasks).toBe(true);

    // Config on disk reflects the flip too
    const written = JSON.parse(
      fs.readFileSync(path.join(taskResourcePath, '.opentasks', 'config.json'), 'utf-8'),
    );
    expect(written.sync.git.enabled).toBe(false);
    // Earlier write's remote should still be there
    expect(written.sync.git.remote).toBe('origin');
  });

  // -------------------------------------------------------------------------
  // Rejection paths
  // -------------------------------------------------------------------------

  it('returns 404 for a non-existent resource', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/resources/does-not-exist/git-sync',
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when a stranger tries to toggle', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${taskResourceId}/git-sync`,
      headers: { Authorization: `Bearer ${stranger.apiKey}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects non-task resources (400)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${memoryResourceId}/git-sync`,
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('task resources');
  });

  it('rejects task resources without a local_path (400)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${pathlessTaskResourceId}/git-sync`,
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('local_path');
  });

  it('rejects a malformed body (400 validation)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${taskResourceId}/git-sync`,
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      payload: { enabled: 'yes please' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Validation Error');
  });

  it('GET returns null when git_sync has never been set on this resource', async () => {
    // Use the pathless task (never had PATCH called on it)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/resources/${pathlessTaskResourceId}/git-sync`,
      headers: { Authorization: `Bearer ${owner.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).git_sync).toBeNull();
  });
});
