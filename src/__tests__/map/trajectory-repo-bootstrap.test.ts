/**
 * Trajectory-handler repo bootstrap.
 *
 * When an agent's connection-aggregate capabilities include
 * `workspace.declare.enabled === true`, every checkpoint that carries
 * `gitRemoteUrl + projectPath` lazily upserts a repo + workspace binding.
 * This is the "agents that never explicitly declare still appear" path
 * (cf. agent-workspace/docs/design/agent-integration.md "Trajectory-
 * bootstrap interaction").
 *
 * Verifies:
 *   - Capability OFF → no repo / no binding / no broadcast
 *   - Capability ON  → repo + binding persisted, broadcast fired
 *   - Idempotent across repeat checkpoints; branch/HEAD refresh
 *   - No bootstrap when gitRemoteUrl or projectPath is missing
 *   - Origin is `trajectory_inferred` (distinguishes from explicit declare)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as repos from '../../db/dal/repos.js';
import * as workspaces from '../../db/dal/workspaces.js';
import { handleTrajectoryRequest } from '../../map/trajectory-handler.js';
import { registerInbound, unregisterInbound } from '../../map/connection-registry.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { WebSocket as WSType } from 'ws';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));
import { broadcastToChannel } from '../../realtime/index.js';
const mockBroadcast = vi.mocked(broadcastToChannel);

const TEST_ROOT = testRoot('trajectory-repo-bootstrap');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'trajectory-repo-bootstrap.db');

const REMOTE_URL = 'https://github.com/openhive-org/bootstrap-test';
const PROJECT_PATH = '/tmp/bootstrap-test';

function dummyWs(): WSType {
  return { readyState: 1, send: () => {}, close: () => {} } as unknown as WSType;
}

function seedSwarm(swarmId: string, ownerAgentId: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO map_swarms (id, name, map_endpoint, owner_agent_id, status)
     VALUES (?, ?, ?, ?, 'online')`,
  ).run(swarmId, swarmId, `ws://test/${swarmId}`, ownerAgentId);
}

function setCapability(
  swarmId: string,
  ownerAgentId: string,
  workspace: { declare: { enabled: boolean } } | null,
): void {
  const conn = {
    ws: dummyWs(),
    agentId: ownerAgentId,
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map(),
  };
  // Set the connection-level capabilities (sidecar pattern: single agent
  // registers and stores its capabilities). The aggregate function unions
  // across all registeredAgents and falls back to conn.capabilities.
  if (workspace !== null) {
    conn.registeredAgents.set('agent-1', {
      id: 'agent-1',
      name: 'sidecar',
      role: 'sidecar',
      state: 'registered',
      scopes: [],
      capabilities: { workspace },
    });
  }
  registerInbound(swarmId, conn as never);
}

describe('Trajectory handler — repo bootstrap', () => {
  let ownerAgentId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'bootstrap-owner',
      description: 'Owner for trajectory bootstrap tests',
    });
    ownerAgentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM workspaces').run();
    db.prepare(`DELETE FROM syncable_resources WHERE resource_type = 'repo'`).run();
    mockBroadcast.mockClear();
  });

  it('capability OFF → no repo upserted, no broadcast', () => {
    const swarmId = `bootstrap-off-${Date.now()}`;
    seedSwarm(swarmId, ownerAgentId);
    setCapability(swarmId, ownerAgentId, { declare: { enabled: false } });

    handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: 'cp-off-1',
          agent: 'sidecar',
          metadata: { gitRemoteUrl: REMOTE_URL, projectPath: PROJECT_PATH },
        },
      },
      { swarmId, agentId: ownerAgentId },
    );

    expect(repos.findRepoByCanonicalUrl(REMOTE_URL)).toBeNull();
    const workspaceCalls = mockBroadcast.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'workspace_added',
    );
    expect(workspaceCalls).toHaveLength(0);

    unregisterInbound(swarmId);
  });

  it('capability ON → repo + binding persisted, broadcast fired with trajectory_inferred origin', () => {
    const swarmId = `bootstrap-on-${Date.now()}`;
    seedSwarm(swarmId, ownerAgentId);
    setCapability(swarmId, ownerAgentId, { declare: { enabled: true } });

    handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: 'cp-on-1',
          agent: 'sidecar',
          branch: 'feature/x',
          metadata: {
            gitRemoteUrl: REMOTE_URL,
            projectPath: PROJECT_PATH,
            gitCommitHash: 'abc12345',
          },
        },
      },
      { swarmId, agentId: ownerAgentId },
    );

    const repo = repos.findRepoByCanonicalUrl(REMOTE_URL);
    expect(repo).not.toBeNull();
    expect(repo!.metadata).toMatchObject({ origin: 'trajectory_inferred' });

    const bindings = workspaces.listWorkspacesForRepo(repo!.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      local_path: PROJECT_PATH,
      current_branch: 'feature/x',
      head_sha: 'abc12345',
      visibility: 'hub_local',
    });

    const added = mockBroadcast.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === 'workspace_added',
    );
    // Two channels: map:repos + map:repo:<id>
    expect(added).toHaveLength(2);
    const channels = added.map((c) => c[0]);
    expect(channels).toContain('map:repos');
    expect(channels).toContain(`map:repo:${repo!.id}`);

    unregisterInbound(swarmId);
  });

  it('idempotent — repeat checkpoints update branch/HEAD without duplicating bindings', () => {
    const swarmId = `bootstrap-idem-${Date.now()}`;
    seedSwarm(swarmId, ownerAgentId);
    setCapability(swarmId, ownerAgentId, { declare: { enabled: true } });

    handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: 'cp-idem-1',
          agent: 'sidecar',
          branch: 'main',
          metadata: { gitRemoteUrl: REMOTE_URL, projectPath: PROJECT_PATH, gitCommitHash: 'sha1' },
        },
      },
      { swarmId, agentId: ownerAgentId },
    );

    handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: 'cp-idem-2',
          agent: 'sidecar',
          branch: 'feature/y',
          metadata: { gitRemoteUrl: REMOTE_URL, projectPath: PROJECT_PATH, gitCommitHash: 'sha2' },
        },
      },
      { swarmId, agentId: ownerAgentId },
    );

    const repo = repos.findRepoByCanonicalUrl(REMOTE_URL)!;
    const bindings = workspaces.listWorkspacesForRepo(repo.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      current_branch: 'feature/y',
      head_sha: 'sha2',
    });

    unregisterInbound(swarmId);
  });

  it('skips bootstrap when gitRemoteUrl is missing', () => {
    const swarmId = `bootstrap-missing-url-${Date.now()}`;
    seedSwarm(swarmId, ownerAgentId);
    setCapability(swarmId, ownerAgentId, { declare: { enabled: true } });

    handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: 'cp-missing-1',
          agent: 'sidecar',
          metadata: { projectPath: PROJECT_PATH },
        },
      },
      { swarmId, agentId: ownerAgentId },
    );

    expect(repos.listRepos()).toHaveLength(0);
    unregisterInbound(swarmId);
  });

  it('no capability declared → no bootstrap', () => {
    const swarmId = `bootstrap-no-cap-${Date.now()}`;
    seedSwarm(swarmId, ownerAgentId);
    setCapability(swarmId, ownerAgentId, null);

    handleTrajectoryRequest(
      'trajectory/checkpoint',
      {
        checkpoint: {
          id: 'cp-nocap-1',
          agent: 'sidecar',
          metadata: { gitRemoteUrl: REMOTE_URL, projectPath: PROJECT_PATH },
        },
      },
      { swarmId, agentId: ownerAgentId },
    );

    expect(repos.findRepoByCanonicalUrl(REMOTE_URL)).toBeNull();
    unregisterInbound(swarmId);
  });
});
