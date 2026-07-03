/**
 * Tests for GET /sessions/pending-attention — the cockpit hydration
 * endpoint that snapshots in-memory pending permission requests from
 * both stores (SwarmCraft ACP streams + hosted-codex approval prompts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { sessionsRoutes } from '../../api/routes/sessions.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('pending-attention-route');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'pending-attention-route.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test OpenHive', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

const STREAM_ID = 'acp-stream-42';
const ACP_REQUEST_ID = `${STREAM_ID}:sess-abc:1751400000000`;

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Stub SwarmCraft's private pendingPermissions map (duck-typed by the route).
  (app as unknown as { swarmcraft: unknown }).swarmcraft = {
    acpStreamManager: {
      pendingPermissions: new Map([
        [
          ACP_REQUEST_ID,
          {
            streamId: STREAM_ID,
            request: { toolCall: { title: 'Write file src/index.ts' } },
          },
        ],
      ]),
      getStreamInfo: (id: string) =>
        id === STREAM_ID ? { serverId: 'swarm-acp-1' } : null,
    },
  };

  // Stub the hosted SwarmManager accessor.
  (app as unknown as { swarmManager: unknown }).swarmManager = {
    listPendingCodexPermissions: () => [
      {
        requestId: 'codex-req-7',
        hostedSwarmId: 'hosted-1',
        summary: 'npm install  (cwd: /repo)',
        requestedAt: 1751400001000,
      },
    ],
  };

  await app.register(
    async (api) => {
      await api.register(sessionsRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

describe('GET /sessions/pending-attention', () => {
  let app: FastifyInstance;
  let sessionResourceId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'pending-attention-agent',
      description: 'Agent for pending-attention route tests',
    });
    setLocalAgent(agent);

    // Session resource whose metadata records the live ACP stream id.
    const session = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'acp-session-under-approval',
      git_remote_url: 'local://test/acp-1',
      owner_agent_id: agent.id,
      metadata: { acpStreamId: STREAM_ID, sessionId: 'sess-abc' },
    });
    sessionResourceId = session.id;

    app = await createTestApp(createTestConfig());
  });

  afterAll(async () => {
    setLocalAgent(null);
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('returns pending items from both stores', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions/pending-attention',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(2);

    const acp = body.items.find((i) => i.source === 'acp')!;
    expect(acp).toBeDefined();
    expect(acp.kind).toBe('permission');
    expect(acp.request_id).toBe(ACP_REQUEST_ID);
    expect(acp.stream_id).toBe(STREAM_ID);
    expect(acp.session_resource_id).toBe(sessionResourceId);
    expect(acp.session_name).toBe('acp-session-under-approval');
    expect(acp.swarm_id).toBe('swarm-acp-1');
    expect(acp.description).toBe('Write file src/index.ts');
    // Parsed from the trailing requestId segment.
    expect(acp.requested_at).toBe(1751400000000);

    const hosted = body.items.find((i) => i.source === 'hosted')!;
    expect(hosted).toBeDefined();
    expect(hosted.kind).toBe('permission');
    expect(hosted.request_id).toBe('codex-req-7');
    expect(hosted.hosted_swarm_id).toBe('hosted-1');
    expect(hosted.description).toBe('npm install  (cwd: /repo)');
    expect(hosted.requested_at).toBe(1751400001000);
  });

  it('returns empty items when neither manager is present', async () => {
    const bare = Fastify({ logger: false });
    await bare.register(
      async (api) => {
        await api.register(sessionsRoutes, { config: createTestConfig() });
      },
      { prefix: '/api/v1' },
    );
    const res = await bare.inject({
      method: 'GET',
      url: '/api/v1/sessions/pending-attention',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
    await bare.close();
  });

  it('tolerates a malformed pendingPermissions shape (degrades to empty)', async () => {
    const weird = Fastify({ logger: false });
    (weird as unknown as { swarmcraft: unknown }).swarmcraft = {
      acpStreamManager: { pendingPermissions: 'not-a-map' },
    };
    await weird.register(
      async (api) => {
        await api.register(sessionsRoutes, { config: createTestConfig() });
      },
      { prefix: '/api/v1' },
    );
    const res = await weird.inject({
      method: 'GET',
      url: '/api/v1/sessions/pending-attention',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
    await weird.close();
  });
});
