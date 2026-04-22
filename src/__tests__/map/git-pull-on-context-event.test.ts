/**
 * E2E: MAP `context.*` event → debounced git pull → daemon converges
 *
 * Proves the Item 3 loop end-to-end:
 *   1. Resource is flagged `git_sync.enabled` (+ pullOnSignal by default)
 *   2. A peer pushes a spec-kind context to the shared git remote directly
 *   3. A MAP `context.created` event arrives at the hub listener for that resource
 *   4. handleMapContextEvent → triggerPullForResource → daemon pulls
 *   5. Local graph.jsonl now contains the peer's node
 *
 * Runs a real opentasks daemon + a bare git remote + a peer workspace.
 * No hub WebSocket needed — we call handleMapContextEvent directly.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import {
  createDaemon,
  createStoreForLocation,
  type Daemon,
  type GraphStore,
} from 'opentasks';
import {
  setDefaultTaskGraph,
  unregisterInbound,
  registerInbound,
} from '../../map/connection-registry.js';
import { applyGitSyncConfig } from '../../swarmkit/git-sync-config.js';
import { _resetGitPullTriggerForTests } from '../../map/git-pull-trigger.js';
import { _resetSpecBroadcastDedup } from '../../map/spec-broadcast-dedup.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

function git(cwd: string, args: string): string {
  return execSync(`git -C "${cwd}" ${args}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

const TEST_ROOT = testRoot('git-pull-on-ctx');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'pull-on-ctx.db');

describe('E2E: MAP context event triggers git pull on a git-sync resource', { timeout: 60_000 }, () => {
  let tempDir: string;
  let repoDir: string;
  let bareRemote: string;
  let opentasksPath: string;
  let store: GraphStore;
  let daemon: Daemon;
  let peerRepo: string;
  let resourceId: string;
  let agentId: string;
  const swarmId = 'e2e-pull-swarm';

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-pull-on-ctx-'));
    repoDir = path.join(tempDir, 'repo');
    bareRemote = path.join(tempDir, 'remote.git');
    opentasksPath = path.join(repoDir, '.opentasks');
    peerRepo = path.join(tempDir, 'peer');

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

    // Start an opentasks daemon pointing at this workspace
    // with git_sync enabled so it can sync.pull on demand.
    applyGitSyncConfig(repoDir, { enabled: true, remote: 'origin' });
    store = await createStoreForLocation(opentasksPath);
    daemon = createDaemon({
      locationPath: opentasksPath,
      version: '1.0.0-test',
      store,
      registryPath: path.join(tempDir, 'registry', 'registry.json'),
      shutdownTimeoutMs: 5000,
      openTasksConfig: {
        sync: { git: { enabled: true, remote: 'origin' } },
      },
    });
    await daemon.start();

    // Register an agent + resource in OpenHive's DB so findResourceById +
    // canAccessResource work for the listener path.
    const a = await agentsDAL.createAgent({
      name: 'git-pull-ctx-agent',
      description: 'Test agent',
    });
    agentId = a.agent.id;

    const resource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'git-pull-ctx-graph',
      git_remote_url: bareRemote,
      visibility: 'shared',
      owner_agent_id: agentId,
      sync_strategy: 'local',
      local_path: repoDir,
      metadata: {
        opentasks: true,
        git_sync: { enabled: true, remote: 'origin' },
      },
    });
    resourceId = resource.id;

    // Connection registry: register the simulated inbound swarm so
    // getDefaultTaskGraph(swarmId) resolves to our resource.
    registerInbound(swarmId, {
      ws: { send: () => {}, close: () => {}, readyState: 1 } as any,
      agentId,
      swarmId,
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
    });
    setDefaultTaskGraph(swarmId, { resource_id: resourceId });

    // Clone the bare remote to a peer workspace and push a peer context
    git(tempDir, `clone "${bareRemote}" "${peerRepo}"`);
    git(peerRepo, 'config user.email peer@example.com');
    git(peerRepo, 'config user.name Peer');
    await fs.mkdir(path.join(peerRepo, '.opentasks'), { recursive: true });

    _resetGitPullTriggerForTests();
    _resetSpecBroadcastDedup();
  }, 45_000);

  afterAll(async () => {
    try { unregisterInbound(swarmId); } catch { /* ignore */ }
    try { await daemon?.stop(); } catch { /* ignore */ }
    try { await store?.close(); } catch { /* ignore */ }
    closeDatabase();
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    cleanTestRoot(TEST_ROOT);
  }, 15_000);

  it('a MAP context.created event causes the daemon to pull the peer push', async () => {
    // Silence broadcast to keep the test focused on convergence
    vi.doMock('../../realtime/index.js', () => ({
      broadcastToChannel: () => {},
    }));

    // --- Step 1: Peer writes a spec and pushes ---
    const peerSpecId = 'peer-spec-1';
    const specLine = JSON.stringify({
      id: peerSpecId,
      uuid: peerSpecId,
      type: 'context',
      title: 'Peer-authored spec',
      content: 'Body',
      status: 'open',
      archived: false,
      metadata: { kind: 'spec' },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(peerRepo, '.opentasks', 'graph.jsonl'),
      specLine + '\n',
    );
    git(peerRepo, 'add .opentasks/graph.jsonl');
    git(peerRepo, 'commit -m "peer: add spec"');
    git(peerRepo, 'push origin main');

    // Sanity: our local graph.jsonl doesn't yet contain the peer's spec
    const beforePath = path.join(opentasksPath, 'graph.jsonl');
    let beforeContent = '';
    try { beforeContent = await fs.readFile(beforePath, 'utf-8'); } catch { /* file may not exist yet */ }
    expect(beforeContent).not.toContain(peerSpecId);

    // --- Step 2: Fire a MAP context.created event for this resource ---
    // This mimics what the cc-swarm sidecar bridge would emit when a peer
    // agent authors a spec. The listener routes it to the pull trigger.
    const { handleMapContextEvent } = await import('../../coordination/listener.js');
    handleMapContextEvent(
      {
        type: 'context.created',
        context: {
          id: peerSpecId,
          title: 'Peer-authored spec',
          metadata: { kind: 'spec' },
        },
      },
      swarmId,
      `agent-on-${swarmId}`,
    );

    // --- Step 3: Wait for the debounced pull to fire + graph.jsonl to update ---
    const converged = await waitUntil(async () => {
      try {
        const content = await fs.readFile(beforePath, 'utf-8');
        return content.includes(peerSpecId);
      } catch { return false; }
    }, 15_000, 250);

    expect(converged).toBe(true);
    const afterContent = await fs.readFile(beforePath, 'utf-8');
    expect(afterContent).toContain(peerSpecId);
    expect(afterContent).toContain('Peer-authored spec');
  });

  it('skips the pull when pullOnSignal is false', async () => {
    _resetGitPullTriggerForTests();
    // Flip pullOnSignal off on the resource metadata
    const resource = resourcesDAL.findResourceById(resourceId);
    const nextMetadata = {
      ...((resource!.metadata as Record<string, unknown> | null) ?? {}),
      git_sync: { enabled: true, remote: 'origin', pullOnSignal: false },
    };
    resourcesDAL.updateResource(resourceId, { metadata: nextMetadata });

    // Peer pushes another spec
    const peerSpecId = 'peer-spec-no-signal';
    const specLine = JSON.stringify({
      id: peerSpecId,
      uuid: peerSpecId,
      type: 'context',
      title: 'No-signal spec',
      metadata: { kind: 'spec' },
      archived: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    // Pull latest first to clear any drift from the prior test
    git(peerRepo, 'pull --rebase origin main');
    await fs.appendFile(
      path.join(peerRepo, '.opentasks', 'graph.jsonl'),
      specLine + '\n',
    );
    git(peerRepo, 'add .opentasks/graph.jsonl');
    git(peerRepo, 'commit -m "peer: no-signal spec"');
    git(peerRepo, 'push origin main');

    const { handleMapContextEvent } = await import('../../coordination/listener.js');
    handleMapContextEvent(
      {
        type: 'context.created',
        context: {
          id: peerSpecId,
          title: 'No-signal spec',
          metadata: { kind: 'spec' },
        },
      },
      swarmId,
      `agent-on-${swarmId}`,
    );

    // Wait through the debounce window; no pull should have happened.
    await new Promise((r) => setTimeout(r, 3000));

    const content = await fs.readFile(
      path.join(opentasksPath, 'graph.jsonl'),
      'utf-8',
    );
    expect(content).not.toContain(peerSpecId);
  });
});
