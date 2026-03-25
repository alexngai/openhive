/**
 * Cross-package E2E: cc-swarm buildTrajectoryCheckpoint() → OpenHive handleSyncMessage() → DB
 *
 * This test verifies end-to-end wire compatibility between cc-swarm's sessionlog
 * checkpoint builder and OpenHive's MAP sync listener + trajectory DAL.
 *
 * Real components:
 *   - cc-swarm: buildTrajectoryCheckpoint() — real function from references/claude-code-swarm
 *   - OpenHive: handleSyncMessage() — real sync listener
 *   - OpenHive: trajectory DAL — real SQLite DB
 *   - OpenHive: session stats aggregation — real SQL queries
 *
 * Mocked:
 *   - broadcastToChannel — no WebSocket server in tests
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as trajectoryDAL from '../../db/dal/trajectory-checkpoints.js';
import { handleSyncMessage } from '../../map/sync-listener.js';
import type { MapSyncMessage } from '../../map/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// cc-swarm real function — imported directly from references
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — .mjs import from TypeScript
import { buildTrajectoryCheckpoint } from '../../../references/claude-code-swarm/src/sessionlog.mjs';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

// cc-swarm's resolveTeamName/resolveScope are called by buildTrajectoryCheckpoint via config
// We mock the cc-swarm config module so it doesn't try to read .swarm/claude-swarm/config.json
vi.mock('../../../references/claude-code-swarm/src/config.mjs', () => ({
  readConfig: () => ({ sessionlog: { enabled: true, sync: 'metrics', mode: 'plugin' } }),
  resolveTeamName: () => 'test-swarm',
  resolveScope: () => 'swarm:test-swarm',
}));

const TEST_ROOT = testRoot('sessionlog-wire-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'sessionlog-wire.db');

describe('Sessionlog wire format E2E: cc-swarm → OpenHive', () => {
  let agentId: string;
  let swarmId: string;
  let sessionResourceId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    // Set up the receiving side: agent, swarm, session resource
    const { agent } = await agentsDAL.createAgent({ name: 'e2e-sessionlog-agent' });
    agentId = agent.id;

    const swarm = mapDAL.createSwarm(agentId, {
      name: 'test-swarm',
      map_endpoint: 'ws://localhost:9999/map',
      map_transport: 'websocket',
    });
    swarmId = swarm.id;
    mapDAL.updateSwarm(swarmId, { status: 'online' });

    const resource = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'e2e-sessionlog-session',
      git_remote_url: 'https://github.com/test/e2e-sessionlog.git',
      owner_agent_id: agentId,
    });
    sessionResourceId = resource.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('lifecycle sync level: stores checkpoint with defaults', () => {
    // Simulate sessionlog state at lifecycle sync level
    const sessionlogState = {
      sessionID: 'sess-lifecycle-001',
      phase: 'active',
      turnID: 'turn-3',
      startedAt: '2024-06-01T10:00:00Z',
      stepCount: 5,
      filesTouched: ['src/index.ts'],
      lastCheckpointID: 'cp-lifecycle-001',
      turnCheckpointIDs: ['cp-001', 'cp-002'],
      tokenUsage: { inputTokens: 8000, outputTokens: 2000 },
    };

    // cc-swarm builds the checkpoint (real function)
    const checkpoint = buildTrajectoryCheckpoint(sessionlogState, 'lifecycle', {});

    // Verify wire format shape
    expect(checkpoint.agent).toBe('test-swarm-sidecar');
    expect(checkpoint.session_id).toBe('sess-lifecycle-001');
    expect(checkpoint.files_touched).toEqual([]); // lifecycle level doesn't promote
    expect(checkpoint.checkpoints_count).toBe(0);
    expect(checkpoint.token_usage).toBeUndefined();

    // Feed through OpenHive sync listener (real function)
    const msg: MapSyncMessage = {
      jsonrpc: '2.0',
      method: 'trajectory/checkpoint',
      params: {
        resource_id: sessionResourceId,
        agent_id: agentId,
        commit_hash: 'lifecycle_hash_001',
        timestamp: new Date().toISOString(),
        checkpoint,
      } as Record<string, unknown>,
    } as unknown as MapSyncMessage;

    handleSyncMessage(msg, swarmId);

    // Verify stored in DB (real DAL)
    const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(sessionResourceId);
    const stored = checkpoints.find((c) => c.commit_hash === 'lifecycle_hash_001');
    expect(stored).toBeDefined();
    expect(stored!.agent).toBe('test-swarm-sidecar');
    expect(stored!.files_touched).toEqual([]);
    expect(stored!.token_usage).toBeNull();
  });

  it('metrics sync level: stores agent, files, tokens correctly', () => {
    const sessionlogState = {
      sessionID: 'sess-metrics-001',
      phase: 'idle',
      turnID: 'turn-7',
      startedAt: '2024-06-01T10:00:00Z',
      stepCount: 12,
      filesTouched: ['src/app.ts', 'src/config.ts', 'tests/app.test.ts'],
      lastCheckpointID: 'cp-metrics-001',
      turnCheckpointIDs: ['cp-010', 'cp-011', 'cp-012'],
      tokenUsage: {
        inputTokens: 25000,
        outputTokens: 8500,
        cacheCreationTokens: 1200,
        cacheReadTokens: 5000,
        apiCallCount: 15,
      },
    };

    // cc-swarm builds the checkpoint (real function)
    const checkpoint = buildTrajectoryCheckpoint(sessionlogState, 'metrics', {});

    // Feed through OpenHive sync listener (real function)
    const msg: MapSyncMessage = {
      jsonrpc: '2.0',
      method: 'trajectory/checkpoint',
      params: {
        resource_id: sessionResourceId,
        agent_id: agentId,
        commit_hash: 'metrics_hash_001',
        timestamp: new Date().toISOString(),
        checkpoint,
      } as Record<string, unknown>,
    } as unknown as MapSyncMessage;

    handleSyncMessage(msg, swarmId);

    // Verify stored in DB (real DAL)
    const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(sessionResourceId);
    const stored = checkpoints.find((c) => c.commit_hash === 'metrics_hash_001');
    expect(stored).toBeDefined();
    expect(stored!.agent).toBe('test-swarm-sidecar');
    expect(stored!.checkpoint_id).toBe('cp-metrics-001');
    expect(stored!.files_touched).toEqual(['src/app.ts', 'src/config.ts', 'tests/app.test.ts']);
    expect(stored!.checkpoints_count).toBe(3);
    expect(stored!.token_usage).toEqual({
      input_tokens: 25000,
      output_tokens: 8500,
      cache_creation_tokens: 1200,
      cache_read_tokens: 5000,
      api_call_count: 15,
    });

    // Verify stats aggregation (real SQL)
    const stats = trajectoryDAL.getSessionStats(sessionResourceId);
    expect(stats.total_input_tokens).toBeGreaterThanOrEqual(25000);
    expect(stats.total_output_tokens).toBeGreaterThanOrEqual(8500);
    expect(stats.total_files_touched).toBeGreaterThanOrEqual(3);
    expect(stats.total_checkpoints).toBeGreaterThanOrEqual(2);
  });

  it('full sync level: stores all wire fields plus metadata passthrough', () => {
    const sessionlogState = {
      sessionID: 'sess-full-001',
      phase: 'ended',
      turnID: 'turn-20',
      startedAt: '2024-06-01T10:00:00Z',
      endedAt: '2024-06-01T12:30:00Z',
      stepCount: 42,
      filesTouched: ['src/server.ts'],
      lastCheckpointID: 'cp-full-001',
      turnCheckpointIDs: ['cp-100'],
      tokenUsage: { inputTokens: 50000, outputTokens: 15000 },
      tasks: { 'task-1': { subject: 'Fix bug', status: 'completed' } },
      skillsUsed: [{ name: 'commit', usedAt: '2024-06-01T11:00:00Z' }],
    };

    // cc-swarm builds the checkpoint (real function)
    const checkpoint = buildTrajectoryCheckpoint(sessionlogState, 'full', {});

    // Verify metadata has the extra sessionlog fields
    expect(checkpoint.metadata.tasks).toEqual(sessionlogState.tasks);
    expect(checkpoint.metadata.skillsUsed).toEqual(sessionlogState.skillsUsed);
    expect(checkpoint.metadata.endedAt).toBe('2024-06-01T12:30:00Z');

    // Feed through OpenHive sync listener (real function)
    const msg: MapSyncMessage = {
      jsonrpc: '2.0',
      method: 'trajectory/checkpoint',
      params: {
        resource_id: sessionResourceId,
        agent_id: agentId,
        commit_hash: 'full_hash_001',
        timestamp: new Date().toISOString(),
        checkpoint,
      } as Record<string, unknown>,
    } as unknown as MapSyncMessage;

    handleSyncMessage(msg, swarmId);

    // Verify stored in DB
    const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(sessionResourceId);
    const stored = checkpoints.find((c) => c.commit_hash === 'full_hash_001');
    expect(stored).toBeDefined();
    expect(stored!.agent).toBe('test-swarm-sidecar');
    expect(stored!.files_touched).toEqual(['src/server.ts']);
    expect(stored!.token_usage).toEqual({
      input_tokens: 50000,
      output_tokens: 15000,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      api_call_count: 0,
    });
  });
});
