import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { getOrCreateLocalAgent } from '../../db/dal/agents.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { mapRoutes } from '../../api/routes/map.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';

const TEST_ROOT = testRoot('map-heartbeat');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'map-heartbeat.db');

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
  await app.register(
    async (api) => {
      await api.register(mapRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('POST /map/swarms/:id/heartbeat', () => {
  let app: FastifyInstance;
  let config: Config;
  let ownerAgent: { id: string; api_key: string };
  let otherAgent: { id: string; api_key: string };
  let swarmId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    config = createTestConfig();

    // Set up local auth so all requests are auto-authenticated as the local agent
    const agent = await getOrCreateLocalAgent();
    setLocalAgent(agent);

    app = await createTestApp(config);

    // Register the owner agent
    const ownerResult = await agentsDAL.createAgent({
      name: 'heartbeat-owner',
      description: 'Owner agent for heartbeat tests',
    });
    ownerAgent = { id: ownerResult.agent.id, api_key: ownerResult.apiKey };

    // Register another agent (non-owner)
    const otherResult = await agentsDAL.createAgent({
      name: 'heartbeat-other',
      description: 'Non-owner agent for heartbeat tests',
    });
    otherAgent = { id: otherResult.agent.id, api_key: otherResult.apiKey };

    // Register a swarm owned by ownerAgent
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/map/swarms',
      headers: { authorization: `Bearer ${ownerAgent.api_key}` },
      payload: {
        name: 'heartbeat-test-swarm',
        description: 'Swarm for heartbeat test',
        map_endpoint: 'https://swarm.test/map',
      },
    });

    expect(registerRes.statusCode).toBe(201);
    const body = JSON.parse(registerRes.payload);
    swarmId = body.swarm.id;
  });

  afterAll(async () => {
    setLocalAgent(null);
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('returns 200 with status ok and timestamp for owner', async () => {
    (broadcastToChannel as ReturnType<typeof vi.fn>).mockClear();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/swarms/${swarmId}/heartbeat`,
      headers: { authorization: `Bearer ${ownerAgent.api_key}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    // Timestamp should be a valid ISO string
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('broadcasts swarm_heartbeat event to map:discovery channel', async () => {
    (broadcastToChannel as ReturnType<typeof vi.fn>).mockClear();

    await app.inject({
      method: 'POST',
      url: `/api/v1/map/swarms/${swarmId}/heartbeat`,
      headers: { authorization: `Bearer ${ownerAgent.api_key}` },
    });

    expect(broadcastToChannel).toHaveBeenCalledWith('map:discovery', {
      type: 'swarm_heartbeat',
      data: { swarm_id: swarmId },
    });
  });

  it('returns 403 when called by a non-owner agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/map/swarms/${swarmId}/heartbeat`,
      headers: { authorization: `Bearer ${otherAgent.api_key}` },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.message).toContain('do not own');
  });
});
