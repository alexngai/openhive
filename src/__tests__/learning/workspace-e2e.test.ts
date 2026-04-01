/**
 * E2E tests for the workspace execution flow:
 *   Atlas → AgenticTaskRunner → WorkspaceManager → SwarmAgentDelegate → MAP → result
 *
 * These tests verify the full chain including workspace isolation,
 * delegate dispatch, and result handling.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { createAgent } from '../../db/dal/agents.js';
import { AtlasService } from '../../learning/atlas-service.js';
import {
  SwarmAgentBackend,
  SwarmAgentDelegate,
  handleWorkspaceResult,
} from '../../learning/swarm-agent-backend.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { AgentSpawnConfig } from 'cognitive-core';

const TEST_ROOT = testRoot('learning-workspace-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'test.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test', url: 'http://localhost:3000' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    learning: {
      enabled: true,
      compute: { enabled: true },
    },
  });
}

// ============================================================================
// handleWorkspaceResult unit tests
// ============================================================================

describe('handleWorkspaceResult', () => {
  it('should ignore unknown request IDs without throwing', () => {
    // Should not throw — orphaned result from a timed-out or cancelled request
    expect(() => handleWorkspaceResult({
      request_id: 'nonexistent-id',
      output: 'orphaned result',
    })).not.toThrow();
  });

  it('should ignore missing request ID without throwing', () => {
    expect(() => handleWorkspaceResult({
      output: 'no id',
    })).not.toThrow();
  });

  it('should ignore empty params without throwing', () => {
    expect(() => handleWorkspaceResult({})).not.toThrow();
  });
});

// ============================================================================
// SwarmAgentDelegate tests
// ============================================================================

describe('SwarmAgentDelegate', () => {
  it('should return failure when no swarms connected', async () => {
    const config = createTestConfig();
    // No swarm manager, no connected swarms → should fail gracefully
    const delegate = new SwarmAgentDelegate(config, null);

    const result = await delegate.execute('test prompt', {
      cwd: '/tmp/test-workspace',
      timeoutMs: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.output).toBe('');
  });
});

// ============================================================================
// SwarmAgentBackend tests
// ============================================================================

describe('SwarmAgentBackend', () => {
  let config: Config;

  beforeAll(() => {
    config = createTestConfig();
  });

  it('should implement AgentBackend interface', () => {
    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);

    expect(backend.name).toBe('openhive-swarm');
    expect(backend.supportedTypes).toContain('claude-code');
    expect(typeof backend.isAvailable).toBe('function');
    expect(typeof backend.spawn).toBe('function');
    expect(typeof backend.getSession).toBe('function');
    expect(typeof backend.terminate).toBe('function');
  });

  it('should report unavailable when no swarms connected', async () => {
    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);

    const available = await backend.isAvailable();
    expect(available).toBe(false);
  });

  it('should create and track sessions', async () => {
    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);

    const { createTask } = await import('cognitive-core');
    const spawnConfig: AgentSpawnConfig = {
      agentType: 'claude-code',
      task: createTask({ domain: 'test', description: 'Test task' }),
      cwd: '/tmp/test-workspace',
      timeout: 5000,
    };

    // Will fail because no swarm is connected, but should still create a session
    const session = await backend.spawn(spawnConfig);

    expect(session.id).toBeDefined();
    expect(session.agentType).toBe('claude-code');
    expect(session.state).toBe('failed'); // No swarm available
    expect(session.error).toBeDefined();

    // Session should be retrievable
    const retrieved = await backend.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);
  });

  it('should handle terminate on running sessions', async () => {
    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);

    const { createTask } = await import('cognitive-core');
    const session = await backend.spawn({
      agentType: 'claude-code',
      task: createTask({ domain: 'test', description: 'Terminate test' }),
      timeout: 5000,
    });

    // Session already failed (no swarm), but terminate should not throw
    await backend.terminate(session.id);

    const terminated = await backend.getSession(session.id);
    expect(terminated).toBeDefined();
  });

  it('should return undefined for unknown session IDs', async () => {
    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);

    const session = await backend.getSession('nonexistent');
    expect(session).toBeUndefined();
  });
});

// ============================================================================
// Atlas + Backend integration tests
// ============================================================================

describe('Atlas + SwarmAgentBackend integration', () => {
  let ownerAgentId: string;
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    initDatabase(TEST_DB_PATH);
    const { agent } = await createAgent({ name: 'workspace-test', description: 'test' });
    ownerAgentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  });

  it('should enable agentic compute with backend and delegate', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);

    // Should not throw
    svc.enableAgenticCompute(backend, delegate);

    // Atlas should now report agent execution capability
    const atlas = svc.getAtlas()!;
    expect(atlas.hasAgentExecution()).toBe(true);

    await svc.close();
  });

  it('should report agentic compute in health status', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    // Before enabling
    const statusBefore = await svc.getDetailedStatus();
    expect(statusBefore.agentic_compute).toBe(false);

    // Enable
    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);
    svc.enableAgenticCompute(backend, delegate);

    // After enabling
    const statusAfter = await svc.getDetailedStatus();
    expect(statusAfter.agentic_compute).toBe(true);

    await svc.close();
  });

  it('should still process trajectories programmatically after enabling agentic', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);
    svc.enableAgenticCompute(backend, delegate);

    // Feed a trajectory — instant loop should still work (no LLM needed)
    const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
    const trajectory = createTrajectory({
      task: createTask({ domain: 'test', description: 'Post-agentic trajectory' }),
      steps: [createStep({ action: 'read file', observation: 'contents' })],
      outcome: successOutcome('done'),
      agentId: 'test-agent',
    });

    const result = await svc.processTrajectory(trajectory);
    expect(result).not.toBeNull();

    // Verify experience stored
    const stats = await svc.getStats() as { memory: { experienceCount: number } };
    expect(stats.memory.experienceCount).toBeGreaterThanOrEqual(1);

    await svc.close();
  });

  it('should handle batch learning with agentic backend (falls back to heuristic when no swarm)', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);
    svc.enableAgenticCompute(backend, delegate);

    // Feed a trajectory
    const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
    await svc.processTrajectory(createTrajectory({
      task: createTask({ domain: 'test', description: 'Batch with agentic' }),
      steps: [createStep({ action: 'test', observation: 'result' })],
      outcome: successOutcome('done'),
      agentId: 'test',
    }));

    // Batch learning should work — if complexity is heuristic, no swarm needed.
    // If complexity triggers agentic and no swarm is available, it should
    // either fall back or fail gracefully.
    const result = await svc.runBatchLearning();
    expect(result).toBeDefined();

    await svc.close();
  });
});
