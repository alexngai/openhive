/**
 * E2E: real Fastify hub + real MAP AgentConnection + real RepoClient.
 *
 * Mimics the macro-agent sidecar's wire-up exactly (see
 * `references/macro-agent/src/map/sidecar.ts` step 6 in `wireSubModules`):
 *   1. AgentConnection.connect() to /ws/map (open mode)
 *   2. Build RepoClient with a transport that maps notify → callExtension
 *      (because OpenHive registers x-workspace/repo.* as request handlers,
 *      not notification handlers).
 *   3. RepoClient.declare(snapshot)
 *   4. Assert: repo persisted in DB, workspace binding persisted, broadcast
 *      fired on map:repos + map:repo:<id>.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { AgentConnection } from '@multi-agent-protocol/sdk';
import { RepoClient, type RepoClientTransport } from 'agent-workspace/kinds/repo';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as repos from '../../db/dal/repos.js';
import * as workspaces from '../../db/dal/workspaces.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { setLocalAgent } from '../../api/middleware/auth.js';
import { setupMapWebSocket, stopMapWebSocket } from '../../map/ws-map.js';
import { mapRoutes } from '../../api/routes/map.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));
import { broadcastToChannel } from '../../realtime/index.js';
const mockedBroadcast = vi.mocked(broadcastToChannel);

const TEST_ROOT = testRoot('repo-sidecar-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'repo-sidecar-e2e.db');
const PORT = 19811;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

describe('E2E: macro-agent sidecar repo flow against real openhive hub', () => {
  let app: FastifyInstance;
  let apiKey: string;
  const activeAgents: AgentConnection[] = [];

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'repo-e2e-owner',
      description: 'Owner agent for repo sidecar e2e',
    });
    const { plaintext_key } = createIngestKey(agent.id, {
      label: 'repo-e2e',
      agent_id: agent.id,
    });
    apiKey = plaintext_key;
    setLocalAgent(agent);

    const config = ConfigSchema.parse({
      port: PORT,
      host: '127.0.0.1',
      database: TEST_DB_PATH,
      instance: { name: 'Repo Sidecar E2E' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
      mapHub: { enabled: true, trustModel: 'open', missedPongsBeforeTerminate: 3 },
    });

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupMapWebSocket(app, config);
    await app.register(
      async (api) => { await api.register(mapRoutes, { config }); },
      { prefix: '/api/v1' },
    );
    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 15_000);

  afterAll(async () => {
    for (const a of activeAgents) {
      try { await a.disconnect(); } catch { /* ignore */ }
    }
    activeAgents.length = 0;
    setLocalAgent(null);
    stopMapWebSocket();
    await app?.close();
    await sleep(200);
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('sidecar declare round-trip → repo persisted + broadcast fired', async () => {
    const swarmId = `repo-e2e-${Date.now()}`;
    const hubUrl = `ws://127.0.0.1:${PORT}/ws/map?token=${apiKey}&swarm_id=${swarmId}`;

    // Connect a real AgentConnection — same client class the sidecar uses.
    const conn = await AgentConnection.connect(hubUrl, {
      name: 'macro-agent-sidecar',
      role: 'sidecar',
      auth: { method: 'none' as const },
    });
    activeAgents.push(conn);
    expect(conn.isConnected).toBe(true);

    mockedBroadcast.mockClear();

    // Build RepoClient with the exact transport adapter the sidecar uses.
    const transport: RepoClientTransport = {
      notify: async (method, params) => {
        await (conn as any).callExtension(method, params);
      },
      request: (method, params) => (conn as any).callExtension(method, params),
    };
    const client = new RepoClient(transport);

    // Declare a single workspace, mirroring what the sidecar does when
    // WORKSPACE_REPO_URL + WORKSPACE_LOCAL_PATH are set.
    await client.declare([{
      remoteUrl: 'https://github.com/openhive-org/sidecar-test',
      localPath: '/tmp/sidecar-test',
      currentBranch: 'main',
    }]);

    // Hub should have persisted the repo.
    const ok = await waitFor(
      () => repos.findRepoByCanonicalUrl('https://github.com/openhive-org/sidecar-test') !== null,
      3000,
    );
    expect(ok).toBe(true);

    const repo = repos.findRepoByCanonicalUrl('https://github.com/openhive-org/sidecar-test')!;
    expect(repo).not.toBeNull();
    expect(repo.metadata).toMatchObject({ origin: 'agent_declared' });

    // Workspace binding row should exist for the connection's agent.
    // The agent is identified on the hub via session.metadata.hubAgentId
    // (set on connect). Look up by repo + check there is exactly one row.
    const allBindings = workspaces.listWorkspacesForRepo(repo.id);
    expect(allBindings).toHaveLength(1);
    expect(allBindings[0]).toMatchObject({
      local_path: '/tmp/sidecar-test',
      current_branch: 'main',
    });

    // Realtime broadcast fired on both channels (workspace_added × 2).
    const added = mockedBroadcast.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'workspace_added',
    );
    expect(added).toHaveLength(2);
    const channels = added.map((c) => c[0]);
    expect(channels).toContain('map:repos');
    expect(channels).toContain(`map:repo:${repo.id}`);
  }, 20_000);
});
