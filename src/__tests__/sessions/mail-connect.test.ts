/**
 * Tests for POST /sessions/mail-connect.
 *
 * ChatFab mail mode needs a real session resource id because the shared mail
 * adapter sends SessionTarget messages to /sessions/:id/chat.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { createSwarm } from '../../db/dal/map.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('mail-connect');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'mail-connect.db');
const SWARM_ID = 'swarm_mail_connect';
const AGENT_ID = 'agent_mail_target';

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Mail Connect Test', description: 'Test' },
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
      await api.register(sessionsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('POST /sessions/mail-connect', () => {
  let app: FastifyInstance;
  let apiKey: string;
  let ownerId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const owner = await agentsDAL.createAgent({ name: 'mail-connect-owner' });
    ownerId = owner.agent.id;
    apiKey = owner.apiKey;

    createSwarm(ownerId, {
      id: SWARM_ID,
      name: 'mail-swarm',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
      capabilities: { mail: { canJoin: true } },
    });

    app = await createTestApp(createTestConfig());
  });

  afterAll(async () => {
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('creates a real session resource for a mail target', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/mail-connect',
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: { swarm_id: SWARM_ID, agent_id: AGENT_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_resource_id: string; created: boolean };
    expect(body.session_resource_id).toMatch(/^res_/);
    expect(body.created).toBe(true);

    const resource = resourcesDAL.findResourceById(body.session_resource_id);
    expect(resource?.resource_type).toBe('session');
    expect(resource?.owner_agent_id).toBe(ownerId);
    expect(resource?.git_remote_url).toBe(`map://mail/${SWARM_ID}/${AGENT_ID}`);
    expect(resource?.metadata).toMatchObject({
      source_swarm_id: SWARM_ID,
      mail_target_agent_id: AGENT_ID,
      transport: 'mail',
    });
  });

  it('reuses the same mail session resource for the same owner, swarm, and agent', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/mail-connect',
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: { swarm_id: SWARM_ID, agent_id: AGENT_ID },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/mail-connect',
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: { swarm_id: SWARM_ID, agent_id: AGENT_ID },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      session_resource_id: first.json().session_resource_id,
      created: false,
    });
  });

  it('returns 404 for an unknown swarm', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/mail-connect',
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: { swarm_id: 'missing-swarm', agent_id: AGENT_ID },
    });

    expect(res.statusCode).toBe(404);
  });
});
