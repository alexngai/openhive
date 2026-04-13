/**
 * Workspace Handler Integration Test
 *
 * Tests the OpenHive → macro-agent workspace handler bridge:
 *
 * 1. OpenHive's SwarmAgentDelegate sends workspace.execute
 * 2. macro-agent's handleWorkspaceExecute receives it
 * 3. MacroAgentBackend spawns analyst agent
 * 4. Agent executes in workspace, writes output
 * 5. workspace.result sent back to OpenHive
 * 6. SwarmAgentDelegate resolves with result
 *
 * Uses mock WebSocket + mock backend to test the protocol integration
 * without requiring a real swarm process.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { createAgent } from '../../db/dal/agents.js';
import { registerInbound, unregisterInbound, getAllInbound } from '../../map/connection-registry.js';
import {
  SwarmAgentDelegate,
  SwarmAgentBackend,
  handleWorkspaceResult,
} from '../../learning/swarm-agent-backend.js';
import { ConfigSchema, type Config } from '../../config.js';

const TEST_ROOT = testRoot('learning-ws-handler-integration');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'test.db');
const MOCK_SWARM_ID = 'mock-handler-swarm';

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
 * Create a mock WebSocket that simulates macro-agent's workspace handler.
 *
 * When it receives workspace.execute, it:
 * 1. Writes output files to the cwd (simulating an analyst agent)
 * 2. Sends workspace.result back (simulating handleWorkspaceExecute)
 */
function createMockSwarmWithHandler(): WebSocket & { sentMessages: string[] } {
  const ws = new EventEmitter() as unknown as WebSocket & { sentMessages: string[] };
  (ws as any).readyState = WebSocket.OPEN;
  ws.sentMessages = [];

  (ws as any).send = vi.fn((data: string) => {
    ws.sentMessages.push(data);

    // Parse and handle workspace.execute messages
    try {
      const msg = JSON.parse(data);
      if (msg.method === 'x-workspace/task.execute') {
        const params = msg.params;

        // Simulate analyst agent: write output files to cwd
        if (params.cwd && fs.existsSync(params.cwd)) {
          const outputDir = path.join(params.cwd, 'output');
          fs.mkdirSync(outputDir, { recursive: true });
          fs.writeFileSync(
            path.join(outputDir, 'analysis.json'),
            JSON.stringify({
              success: true,
              keySteps: [0, 1],
              stepAttribution: [0.8, 0.6],
              errorPatterns: [],
              abstractable: true,
              trainingExamples: [],
            }),
          );
        }

        // Simulate workspace.result response (async, on next tick)
        setTimeout(() => {
          handleWorkspaceResult({
            request_id: params.request_id,
            success: true,
            output: JSON.stringify({ success: true, keySteps: [0, 1] }),
            structured: { success: true, keySteps: [0, 1] },
            duration_ms: 150,
          });
        }, 50);
      }
    } catch { /* not JSON, ignore */ }
  });

  (ws as any).close = vi.fn();
  (ws as any).terminate = vi.fn();
  return ws;
}

describe('Workspace Handler Integration', () => {
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    initDatabase(TEST_DB_PATH);
    await createAgent({ name: 'handler-test', description: 'test' });
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  });

  beforeEach(() => {
    for (const id of getAllInbound().keys()) {
      unregisterInbound(id);
    }
  });

  it('should complete full workspace round-trip with mock handler', async () => {
    const config = createTestConfig();
    const ws = createMockSwarmWithHandler();

    registerInbound(MOCK_SWARM_ID, {
      ws,
      agentId: 'mock-agent',
      swarmId: MOCK_SWARM_ID,
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
    });

    const delegate = new SwarmAgentDelegate(config, null);

    // Create a workspace with input files
    const workspaceDir = path.join(TEST_ROOT, `workspace-${Date.now()}`);
    fs.mkdirSync(path.join(workspaceDir, 'input'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, 'input', 'trajectories.json'),
      JSON.stringify([{ task: 'test', steps: [] }]),
    );

    const result = await delegate.execute(
      'Analyze the trajectories in input/ and write results to output/',
      { cwd: workspaceDir, timeoutMs: 10_000 },
    );

    // Verify the delegate resolved with the mock handler's result
    expect(result.success).toBe(true);
    expect(result.structured).toEqual({ success: true, keySteps: [0, 1] });

    // Verify the mock wrote output files to the workspace
    const outputPath = path.join(workspaceDir, 'output', 'analysis.json');
    expect(fs.existsSync(outputPath)).toBe(true);
    const outputContent = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(outputContent.success).toBe(true);
    expect(outputContent.keySteps).toEqual([0, 1]);
    expect(outputContent.abstractable).toBe(true);

    // Verify the MAP message was sent correctly
    expect(ws.sentMessages.length).toBe(1);
    const sent = JSON.parse(ws.sentMessages[0]);
    expect(sent.method).toBe('x-workspace/task.execute');
    expect(sent.params.prompt).toContain('Analyze the trajectories');
    expect(sent.params.cwd).toBe(workspaceDir);
  });

  it('should handle failed workspace execution', async () => {
    const config = createTestConfig();
    const ws = new EventEmitter() as unknown as WebSocket & { sentMessages: string[] };
    (ws as any).readyState = WebSocket.OPEN;
    ws.sentMessages = [];
    (ws as any).send = vi.fn((data: string) => {
      ws.sentMessages.push(data);
      // Simulate failure response
      const msg = JSON.parse(data);
      if (msg.method === 'x-workspace/task.execute') {
        setTimeout(() => {
          handleWorkspaceResult({
            request_id: msg.params.request_id,
            error: 'Agent crashed during analysis',
          });
        }, 50);
      }
    });
    (ws as any).close = vi.fn();

    registerInbound(MOCK_SWARM_ID, {
      ws,
      agentId: 'mock-agent',
      swarmId: MOCK_SWARM_ID,
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
    });

    const delegate = new SwarmAgentDelegate(config, null);
    const result = await delegate.execute('test', { cwd: '/tmp/test', timeoutMs: 10_000 });

    expect(result.success).toBe(false);
  });

  it('should work with SwarmAgentBackend session tracking', async () => {
    const config = createTestConfig();
    const ws = createMockSwarmWithHandler();

    registerInbound(MOCK_SWARM_ID, {
      ws,
      agentId: 'mock-agent',
      swarmId: MOCK_SWARM_ID,
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
    });

    const delegate = new SwarmAgentDelegate(config, null);
    const backend = new SwarmAgentBackend(delegate);

    const { createTask } = await import('cognitive-core');
    const workspaceDir = path.join(TEST_ROOT, `ws-backend-${Date.now()}`);
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Allow async send to complete
    const spawnPromise = backend.spawn({
      agentType: 'claude-code',
      task: createTask({ domain: 'test', description: 'Backend workspace test' }),
      cwd: workspaceDir,
      timeout: 10_000,
    });

    await new Promise(r => setTimeout(r, 100)); // Let send + handler fire

    const session = await spawnPromise;
    expect(session.state).toBe('completed');
    expect(session.result).toEqual({ success: true, keySteps: [0, 1] });

    // Session should be retrievable
    const retrieved = await backend.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.state).toBe('completed');
  });
});
