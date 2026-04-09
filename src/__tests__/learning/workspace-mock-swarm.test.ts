/**
 * Mock Swarm Tests for Workspace Execution
 *
 * Tests the full round-trip: delegate sends MAP message to a simulated swarm,
 * the swarm "responds" via handleWorkspaceResult(), and the delegate resolves.
 *
 * Uses a mock WebSocket registered in the connection registry to simulate
 * a connected swarm without needing a real OpenSwarm process.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { createAgent } from '../../db/dal/agents.js';
import { registerInbound, unregisterInbound, getAllInbound } from '../../map/connection-registry.js';
import { AtlasService } from '../../learning/atlas-service.js';
import {
  SwarmAgentBackend,
  SwarmAgentDelegate,
  handleWorkspaceResult,
} from '../../learning/swarm-agent-backend.js';
import { ConfigSchema, type Config } from '../../config.js';

const TEST_ROOT = testRoot('learning-mock-swarm');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'test.db');

const MOCK_SWARM_ID = 'mock-swarm-001';

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    learning: {
      enabled: true,
      compute: { enabled: true, preferredSwarmId: MOCK_SWARM_ID },
    },
  });
}

/**
 * Create a mock WebSocket that captures sent messages.
 * Follows the pattern from ws-map.test.ts.
 */
function createMockWs(): WebSocket & { sentMessages: string[] } {
  const ws = new EventEmitter() as unknown as WebSocket & { sentMessages: string[] };
  (ws as any).readyState = WebSocket.OPEN;
  ws.sentMessages = [];
  (ws as any).send = vi.fn((data: string) => {
    ws.sentMessages.push(data);
  });
  (ws as any).close = vi.fn();
  (ws as any).terminate = vi.fn();
  return ws;
}

/**
 * Register a mock swarm connection in the registry.
 */
function registerMockSwarm(swarmId: string, ws: WebSocket): void {
  registerInbound(swarmId, {
    ws,
    agentId: 'mock-agent',
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map(),
    capabilities: { trajectory: { canServeContent: true } },
  });
}

describe('Mock Swarm — Workspace Execution Round-Trip', () => {
  let ownerAgentId: string;
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    initDatabase(TEST_DB_PATH);
    const { agent } = await createAgent({ name: 'mock-swarm-test', description: 'test' });
    ownerAgentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  });

  // Clean up connections between tests
  beforeEach(() => {
    for (const id of getAllInbound().keys()) {
      unregisterInbound(id);
    }
  });

  describe('SwarmAgentDelegate with mock swarm', () => {
    it('should send MAP message to connected swarm and resolve on result', async () => {
      const config = createTestConfig();
      const ws = createMockWs();
      registerMockSwarm(MOCK_SWARM_ID, ws);

      const delegate = new SwarmAgentDelegate(config, null);

      // Start execution — this sends a MAP message and waits for result
      const executePromise = delegate.execute(
        'Analyze these trajectories and extract playbooks',
        { cwd: '/tmp/test-workspace', systemContext: 'You are an analysis agent', timeoutMs: 10_000 },
      );

      // Allow async resolveSwarm + send to complete
      await new Promise(r => setTimeout(r, 10));

      // Verify the MAP message was sent
      expect(ws.sentMessages.length).toBe(1);
      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.jsonrpc).toBe('2.0');
      expect(sent.method).toBe('x-workspace/task.execute');
      expect(sent.params.prompt).toBe('Analyze these trajectories and extract playbooks');
      expect(sent.params.cwd).toBe('/tmp/test-workspace');
      expect(sent.params.system_context).toBe('You are an analysis agent');
      expect(sent.params.request_id).toBeDefined();

      // Simulate swarm responding with result
      handleWorkspaceResult({
        request_id: sent.params.request_id,
        output: 'Found 2 playbook patterns',
        structured: {
          playbooks: [
            { name: 'error-handling', confidence: 0.7 },
            { name: 'test-first', confidence: 0.6 },
          ],
        },
      });

      // Await the resolution
      const result = await executePromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe('Found 2 playbook patterns');
      expect(result.structured).toEqual({
        playbooks: [
          { name: 'error-handling', confidence: 0.7 },
          { name: 'test-first', confidence: 0.6 },
        ],
      });
    });

    it('should handle error response from swarm', async () => {
      const config = createTestConfig();
      const ws = createMockWs();
      registerMockSwarm(MOCK_SWARM_ID, ws);

      const delegate = new SwarmAgentDelegate(config, null);

      const executePromise = delegate.execute(
        'Analyze this',
        { cwd: '/tmp/test', timeoutMs: 10_000 },
      );

      await new Promise(r => setTimeout(r, 10));
      const sent = JSON.parse(ws.sentMessages[0]);

      // Simulate error response
      handleWorkspaceResult({
        request_id: sent.params.request_id,
        error: 'Agent ran out of context',
      });

      const result = await executePromise;
      expect(result.success).toBe(false);
    });

    it('should timeout when swarm does not respond', async () => {
      const config = createTestConfig();
      const ws = createMockWs();
      registerMockSwarm(MOCK_SWARM_ID, ws);

      const delegate = new SwarmAgentDelegate(config, null);

      // Very short timeout
      const result = await delegate.execute(
        'This will timeout',
        { cwd: '/tmp/test', timeoutMs: 50 },
      );

      expect(result.success).toBe(false);
    }, 5_000);

    it('should use preferred swarm when configured', async () => {
      const config = createTestConfig();
      const preferredWs = createMockWs();
      const otherWs = createMockWs();

      registerMockSwarm(MOCK_SWARM_ID, preferredWs); // preferred
      registerMockSwarm('other-swarm', otherWs);

      const delegate = new SwarmAgentDelegate(config, null);

      const executePromise = delegate.execute(
        'Test preferred routing',
        { cwd: '/tmp/test', timeoutMs: 10_000 },
      );

      await new Promise(r => setTimeout(r, 10));

      // Message should go to preferred swarm, not other
      expect(preferredWs.sentMessages.length).toBe(1);
      expect(otherWs.sentMessages.length).toBe(0);

      // Resolve it
      const sent = JSON.parse(preferredWs.sentMessages[0]);
      handleWorkspaceResult({ request_id: sent.params.request_id, output: 'ok' });
      await executePromise;
    });

    it('should fall back to other swarm when preferred is offline', async () => {
      const config = createTestConfig();
      const offlineWs = createMockWs();
      (offlineWs as any).readyState = WebSocket.CLOSED;
      const healthyWs = createMockWs();

      registerMockSwarm(MOCK_SWARM_ID, offlineWs); // preferred but offline
      registerMockSwarm('backup-swarm', healthyWs);

      const delegate = new SwarmAgentDelegate(config, null);

      const executePromise = delegate.execute(
        'Fallback test',
        { cwd: '/tmp/test', timeoutMs: 10_000 },
      );

      await new Promise(r => setTimeout(r, 10));

      // Should go to backup
      expect(offlineWs.sentMessages.length).toBe(0);
      expect(healthyWs.sentMessages.length).toBe(1);

      const sent = JSON.parse(healthyWs.sentMessages[0]);
      handleWorkspaceResult({ request_id: sent.params.request_id, output: 'from backup' });

      const result = await executePromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe('from backup');
    });
  });

  describe('SwarmAgentBackend with mock swarm', () => {
    it('should create completed session on successful execution', async () => {
      const config = createTestConfig();
      const ws = createMockWs();
      registerMockSwarm(MOCK_SWARM_ID, ws);

      const delegate = new SwarmAgentDelegate(config, null);
      const backend = new SwarmAgentBackend(delegate);

      const { createTask } = await import('cognitive-core');
      const spawnPromise = backend.spawn({
        agentType: 'claude-code',
        task: createTask({ domain: 'test', description: 'Backend spawn test' }),
        cwd: '/tmp/workspace',
        systemPromptAdditions: 'Context here',
        timeout: 10_000,
      });

      // Allow microtasks to flush (delegate.execute has async steps before send)
      await new Promise(r => setTimeout(r, 10));

      // Respond via MAP
      const sent = JSON.parse(ws.sentMessages[0]);
      handleWorkspaceResult({
        request_id: sent.params.request_id,
        output: 'Analysis complete',
        structured: { findings: ['pattern-a'] },
      });

      const session = await spawnPromise;
      expect(session.state).toBe('completed');
      expect(session.result).toEqual({ findings: ['pattern-a'] });
      expect(session.messages.length).toBe(1);
      expect(session.messages[0].role).toBe('assistant');
      expect(session.messages[0].content).toBe('Analysis complete');
      expect(session.error).toBeUndefined();

      // Session should be retrievable
      const retrieved = await backend.getSession(session.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.state).toBe('completed');
    });

    it('should create failed session on error response', async () => {
      const config = createTestConfig();
      const ws = createMockWs();
      registerMockSwarm(MOCK_SWARM_ID, ws);

      const delegate = new SwarmAgentDelegate(config, null);
      const backend = new SwarmAgentBackend(delegate);

      const { createTask } = await import('cognitive-core');
      const spawnPromise = backend.spawn({
        agentType: 'claude-code',
        task: createTask({ domain: 'test', description: 'Error test' }),
        timeout: 10_000,
      });

      await new Promise(r => setTimeout(r, 10));
      const sent = JSON.parse(ws.sentMessages[0]);
      handleWorkspaceResult({
        request_id: sent.params.request_id,
        error: 'Agent crashed',
      });

      const session = await spawnPromise;
      expect(session.state).toBe('failed');
      expect(session.error).toBeDefined();
    });

    it('should report available when mock swarm is connected', async () => {
      const config = createTestConfig();
      const ws = createMockWs();
      registerMockSwarm(MOCK_SWARM_ID, ws);

      const delegate = new SwarmAgentDelegate(config, null);
      const backend = new SwarmAgentBackend(delegate);

      expect(await backend.isAvailable()).toBe(true);
    });
  });

  describe('Atlas end-to-end with mock swarm', () => {
    it('should wire backend and process trajectory with agentic compute enabled', async () => {
      const config = createTestConfig();
      const ws = createMockWs();
      registerMockSwarm(MOCK_SWARM_ID, ws);

      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const delegate = new SwarmAgentDelegate(config, null);
      const backend = new SwarmAgentBackend(delegate);
      svc.enableAgenticCompute(backend, delegate);

      expect(svc.getAtlas()!.hasAgentExecution()).toBe(true);

      // Process a trajectory — instant loop runs programmatically
      const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
      const result = await svc.processTrajectory(createTrajectory({
        task: createTask({ domain: 'e2e-test', description: 'Full chain test' }),
        steps: [
          createStep({ action: 'read file src/main.ts', observation: 'function main() {}' }),
          createStep({ action: 'edit file src/main.ts', observation: 'file updated' }),
        ],
        outcome: successOutcome('refactored main function'),
        agentId: 'e2e-agent',
      }));

      expect(result).not.toBeNull();

      // Verify experience was stored
      const stats = await svc.getStats() as { memory: { experienceCount: number } };
      expect(stats.memory.experienceCount).toBeGreaterThanOrEqual(1);

      // Activity log should have the instant event
      const { data } = svc.getActivityLog();
      const instant = data.find(e => e.type === 'instant' && e.data?.domain === 'e2e-test');
      expect(instant).toBeDefined();

      await svc.close();
    });

    it('should run batch learning with mock swarm available', async () => {
      const config = createTestConfig();
      const ws = createMockWs();
      registerMockSwarm(MOCK_SWARM_ID, ws);

      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const delegate = new SwarmAgentDelegate(config, null);
      const backend = new SwarmAgentBackend(delegate);
      svc.enableAgenticCompute(backend, delegate);

      // Feed trajectories
      const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
      for (let i = 0; i < 3; i++) {
        await svc.processTrajectory(createTrajectory({
          task: createTask({ domain: 'batch-test', description: `Batch trajectory ${i}` }),
          steps: [createStep({ action: `action-${i}`, observation: `result-${i}` })],
          outcome: successOutcome(`done-${i}`),
          agentId: 'batch-agent',
        }));
      }

      // Run batch — heuristic path runs locally, agentic path may try swarm
      // If agentic triggers and sends to swarm, we need to respond.
      // Run batch in background and handle any MAP messages that appear.
      const batchPromise = svc.runBatchLearning();

      // Check if any MAP messages were sent (agentic path triggered)
      // Give the batch a moment to potentially dispatch
      await new Promise(r => setTimeout(r, 100));

      if (ws.sentMessages.length > 0) {
        // Respond to any workspace.execute messages
        for (const msg of ws.sentMessages) {
          const parsed = JSON.parse(msg);
          if (parsed.method === 'x-workspace/task.execute') {
            handleWorkspaceResult({
              request_id: parsed.params.request_id,
              output: 'Heuristic analysis sufficient',
              structured: { playbooks: [] },
            });
          }
        }
      }

      const batchResult = await batchPromise;
      expect(batchResult).toBeDefined();

      // Activity log should have batch entry
      const { data } = svc.getActivityLog();
      const batch = data.find(e => e.type === 'batch');
      expect(batch).toBeDefined();

      await svc.close();
    });
  });
});
