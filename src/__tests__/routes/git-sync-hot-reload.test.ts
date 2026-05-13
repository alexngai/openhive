/**
 * E2E: PATCH /resources/:id/git-sync hot-reloads a running daemon
 *
 * Proves the hosted-swarm-propagation / hot-reload gap is closed:
 *   1. A task resource exists with a real running opentasks daemon
 *      that was started without git sync enabled
 *   2. User PATCHes the git_sync flag on via the REST endpoint
 *   3. The daemon's in-memory syncer is rebuilt in place — no restart
 *   4. Next sync.now commits to the bare remote, proving the syncer
 *      is live and reading the new config
 *
 * Uses a real Fastify hub + real opentasks daemon + real bare remote.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import {
  createDaemon,
  createStoreForLocation,
  createIPCClient,
  type Daemon,
  type GraphStore,
  type IPCClient,
} from 'opentasks';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { resourcesRoutes } from '../../api/routes/resources.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

function git(cwd: string, args: string): string {
  return execSync(`git -C "${cwd}" ${args}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

const TEST_ROOT = testRoot('git-sync-hot-reload');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'git-sync-hot-reload.db');

describe('E2E: PATCH git-sync hot-reloads a running daemon', { timeout: 45_000 }, () => {
  let app: FastifyInstance;
  let owner: { id: string; apiKey: string };
  let tempDir: string;
  let repoDir: string;
  let bareRemote: string;
  let opentasksPath: string;
  let store: GraphStore;
  let daemon: Daemon;
  let client: IPCClient;
  let resourceId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-sync-hot-reload-'));
    repoDir = path.join(tempDir, 'repo');
    bareRemote = path.join(tempDir, 'remote.git');
    opentasksPath = path.join(repoDir, '.opentasks');

    // Bare remote + working repo
    git(tempDir, `init --bare "${bareRemote}"`);
    await fs.mkdir(repoDir, { recursive: true });
    git(repoDir, 'init --initial-branch=main');
    git(repoDir, 'config user.email test@example.com');
    git(repoDir, 'config user.name Test');
    git(repoDir, `remote add origin "${bareRemote}"`);
    await fs.writeFile(path.join(repoDir, 'README.md'), '# test');
    git(repoDir, 'add README.md');
    git(repoDir, 'commit -m init');
    git(repoDir, 'push -u origin main');

    await fs.mkdir(opentasksPath, { recursive: true });

    // Start daemon with sync DISABLED — the whole point is that PATCH
    // flips it on without a restart.
    store = await createStoreForLocation(opentasksPath);
    daemon = createDaemon({
      locationPath: opentasksPath,
      version: '1.0.0-test',
      store,
      registryPath: path.join(tempDir, 'registry', 'registry.json'),
      shutdownTimeoutMs: 5000,
      // no sync config — daemon starts with git sync disabled
    });
    await daemon.start();

    client = createIPCClient(daemon.socketPath);
    await client.connect();

    // Start hub + routes
    const config: Config = ConfigSchema.parse({
      database: TEST_DB_PATH,
      instance: { name: 'Hot Reload Test', url: 'http://localhost:0' },
      admin: { createOnStartup: false },
      auth: { mode: 'local' },
      rateLimit: { enabled: false },
    });
    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(async (api) => {
      await api.register(resourcesRoutes, { config });
    }, { prefix: '/api/v1' });

    // Agent + resource wired to the daemon's workspace
    const ownerAgent = await agentsDAL.createAgent({
      name: 'hot-reload-owner',
      description: 'Owner for hot-reload tests',
    });
    owner = { id: ownerAgent.agent.id, apiKey: ownerAgent.apiKey };

    const taskResource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'hot-reload-task',
      git_remote_url: bareRemote,
      visibility: 'private',
      owner_agent_id: owner.id,
      sync_strategy: 'local',
      local_path: repoDir,
      metadata: { opentasks: true },
    });
    resourceId = taskResource.id;
  }, 30_000);

  afterAll(async () => {
    try { client?.disconnect(); } catch { /* ignore */ }
    try { await daemon?.stop(); } catch { /* ignore */ }
    try { await store?.close(); } catch { /* ignore */ }
    try { await app?.close(); } catch { /* ignore */ }
    closeDatabase();
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    cleanTestRoot(TEST_ROOT);
  }, 15_000);

  it('PATCH git-sync enables sync on the already-running daemon', async () => {
    // Pre-flight: daemon reports git sync disabled
    const preStatus = await client.request<{ enabled: boolean }>('sync.status');
    expect(preStatus.enabled).toBe(false);

    // User toggles the flag on via REST
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${resourceId}/git-sync`,
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      payload: { enabled: true, remote: 'origin' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.git_sync.enabled).toBe(true);

    // The response should include the daemon-applied status, proving
    // the hot-reload round-trip succeeded.
    expect(body.daemon_applied).toMatchObject({
      enabled: true,
      remote: 'origin',
    });

    // Daemon now reports enabled via its own status — no restart happened.
    const postStatus = await client.request<{ enabled: boolean; remote?: string }>('sync.status');
    expect(postStatus.enabled).toBe(true);
    expect(postStatus.remote).toBe('origin');

    // And sync.now now actually commits — proving the syncer is live.
    const node = await client.request<{ id: string }>('graph.create', {
      type: 'task',
      title: 'Landed after hot-reload',
      status: 'open',
    });
    expect(node.id).toBeTruthy();
    await client.request('flush');
    await new Promise((r) => setTimeout(r, 200));

    const syncRes = await client.request<{
      ran: boolean;
      result?: { commit: { committed: boolean }; push: { pushed: boolean } };
    }>('sync.now');
    expect(syncRes.ran).toBe(true);
    expect(syncRes.result?.commit.committed).toBe(true);
    expect(syncRes.result?.push.pushed).toBe(true);

    // Bare remote contains the new commit
    const remoteLog = git(bareRemote, 'log --oneline');
    expect(remoteLog).toContain('opentasks: sync graph');
  });

  it('PATCH git-sync disabled hot-disables a running sync', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/resources/${resourceId}/git-sync`,
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.daemon_applied?.enabled).toBe(false);

    const status = await client.request<{ enabled: boolean }>('sync.status');
    expect(status.enabled).toBe(false);

    const syncRes = await client.request<{ ran: boolean; reason?: string }>('sync.now');
    expect(syncRes.ran).toBe(false);
  });
});
