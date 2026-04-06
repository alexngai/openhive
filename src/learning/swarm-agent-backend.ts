/**
 * Swarm Agent Backend & Delegate for Cognitive-Core
 *
 * Dispatches workspace template tasks to hosted/connected swarms running
 * macro-agent with cognitive-core integration. Uses macro-agent's native
 * agent spawning protocol:
 *
 *   1. OpenHive's AgenticTaskRunner prepares workspace (local filesystem)
 *   2. SwarmAgentDelegate sends task to swarm via MAP
 *   3. Swarm's MacroAgentBackend spawns an analyst agent in the workspace cwd
 *   4. Agent executes, writes output files, calls done()
 *   5. Result flows back to OpenHive
 *
 * Two dispatch protocols supported:
 *   - _macro/cognitive/command: For Atlas-level operations (batch, query, prune)
 *   - x-workspace/task.execute (WORKSPACE_METHODS.EXECUTE): For workspace template execution
 *     (the swarm agent reads prompt and writes to cwd)
 */

import WebSocket from 'ws';
import { nanoid } from 'nanoid';
import { WORKSPACE_METHODS } from 'agent-workspace';
import { getInbound, getAllInbound } from '../map/connection-registry.js';
import { type LearningLogger, defaultLogger } from './types.js';
import type { SwarmManager } from '../swarm/manager.js';
import type { Config } from '../config.js';
import type {
  AgentBackend,
  AgentSpawnConfig,
  AgentSession,
} from 'cognitive-core';

// AgentDelegate types (not exported from cognitive-core main entry)
interface AgentDelegateOptions {
  cwd: string;
  systemContext?: string;
  timeoutMs?: number;
}

interface AgentDelegateResult {
  success: boolean;
  output: string;
  structured?: unknown;
}

interface AgentDelegate {
  execute(prompt: string, options: AgentDelegateOptions): Promise<AgentDelegateResult>;
}

const WORKSPACE_EXECUTE_TIMEOUT_MS = 300_000;

// Pending requests waiting for responses
const pendingRequests = new Map<string, {
  resolve: (value: WorkspaceExecutionResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

interface WorkspaceExecutionResult {
  request_id: string;
  success: boolean;
  output: string;
  structured?: unknown;
  error?: string;
  duration_ms?: number;
}

/**
 * Handle an incoming workspace.result notification from a swarm.
 * Called by the notification interceptor in ws-map.ts.
 */
export function handleWorkspaceResult(params: Record<string, unknown>): void {
  const requestId = params.request_id as string;
  if (!requestId) return;

  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);

  // Use explicit success field if provided, fall back to !error check
  const success = typeof params.success === 'boolean' ? params.success : !params.error;

  pending.resolve({
    request_id: requestId,
    success,
    output: (params.output as string) || '',
    structured: params.structured,
    error: params.error as string | undefined,
    duration_ms: params.duration_ms as number | undefined,
  });
}

/**
 * AgentDelegate that dispatches workspace tasks to swarm agents.
 *
 * cognitive-core's AgenticTaskRunner prepares the workspace (input files,
 * skills, knowledge injection) and calls delegate.execute(prompt, { cwd }).
 * This delegate sends the task to a connected swarm via MAP.
 *
 * The swarm's macro-agent receives the workspace task and spawns an analyst
 * agent (via MacroAgentBackend) that executes in the workspace directory.
 */
export class SwarmAgentDelegate implements AgentDelegate {
  private config: Config;
  private swarmManager: SwarmManager | null;
  private lastUsedSwarmId: string | null = null;
  private log: LearningLogger;

  constructor(config: Config, swarmManager: SwarmManager | null, logger?: LearningLogger) {
    this.config = config;
    this.swarmManager = swarmManager;
    this.log = logger || defaultLogger;
  }

  async execute(prompt: string, options: AgentDelegateOptions): Promise<AgentDelegateResult> {
    const swarmId = await this.resolveSwarm();
    if (!swarmId) {
      return { success: false, output: '', structured: { error: 'No swarm available' } };
    }

    const conn = getInbound(swarmId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return { success: false, output: '', structured: { error: `Swarm ${swarmId} not connected` } };
    }

    const requestId = `ws-${nanoid(8)}`;
    const timeout = options.timeoutMs || WORKSPACE_EXECUTE_TIMEOUT_MS;

    // Send workspace execute request to the swarm.
    // The swarm handles this via its MAP notification handler.
    // For macro-agent with cognitive integration, the swarm's
    // MacroAgentBackend spawns an analyst agent in the cwd.
    const request = {
      jsonrpc: '2.0',
      method: WORKSPACE_METHODS.EXECUTE,
      params: {
        request_id: requestId,
        prompt,
        cwd: options.cwd,
        system_context: options.systemContext,
        timeout,
      },
    };

    try {
      conn.ws.send(JSON.stringify(request));
    } catch (err) {
      return { success: false, output: '', structured: { error: `Send failed: ${(err as Error).message}` } };
    }

    this.log.info(`Dispatched workspace task ${requestId} to swarm ${swarmId} (cwd: ${options.cwd})`);
    this.lastUsedSwarmId = swarmId;

    // Wait for result
    const result = await new Promise<WorkspaceExecutionResult | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(null);
      }, timeout);

      pendingRequests.set(requestId, { resolve, timer });
    });

    if (!result) {
      return { success: false, output: '', structured: { error: 'Workspace execution timed out' } };
    }

    return {
      success: result.success,
      output: result.output,
      structured: result.structured,
    };
  }

  private async resolveSwarm(): Promise<string | null> {
    const computeConfig = this.config.learning.compute;

    if (computeConfig.preferredSwarmId) {
      const conn = getInbound(computeConfig.preferredSwarmId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        return computeConfig.preferredSwarmId;
      }
    }

    const allConnected = getAllInbound();
    for (const [swarmId, conn] of allConnected) {
      if (conn.ws.readyState === WebSocket.OPEN && swarmId !== this.lastUsedSwarmId) {
        return swarmId;
      }
    }
    for (const [swarmId, conn] of allConnected) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        return swarmId;
      }
    }

    if (computeConfig.spawnIfNoneAvailable && this.swarmManager) {
      try {
        this.log.info('Spawning ephemeral learning swarm');
        const hosted = await this.swarmManager.spawn('system', {
          name: `learning-ephemeral-${nanoid(4)}`,
          provider: computeConfig.spawnProvider as 'local' | undefined,
          metadata: { role: 'learning-compute', ephemeral: true },
        });
        if (hosted?.swarm_id) return hosted.swarm_id;
      } catch (err) {
        this.log.warn('Failed to spawn ephemeral swarm:', (err as Error).message);
      }
    }

    return null;
  }
}

/**
 * AgentBackend wrapper for atlas.setAgentManager().
 * Delegates execution to SwarmAgentDelegate.
 */
export class SwarmAgentBackend implements AgentBackend {
  readonly name = 'openhive-swarm';
  readonly supportedTypes = ['claude-code'];

  private sessions = new Map<string, AgentSession>();
  private delegate: SwarmAgentDelegate;

  constructor(delegate: SwarmAgentDelegate) {
    this.delegate = delegate;
  }

  async isAvailable(): Promise<boolean> {
    const allConnected = getAllInbound();
    for (const [, conn] of allConnected) {
      if (conn.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  async spawn(config: AgentSpawnConfig): Promise<AgentSession> {
    const sessionId = `swarm-${nanoid(8)}`;
    const session: AgentSession = {
      id: sessionId,
      agentType: config.agentType,
      task: config.task,
      state: 'running',
      messages: [],
      toolCalls: [],
      startTime: new Date(),
      metadata: {},
    };

    this.sessions.set(sessionId, session);

    try {
      const result = await this.delegate.execute(
        config.task.description,
        {
          cwd: config.cwd || process.cwd(),
          systemContext: config.systemPromptAdditions,
          timeoutMs: config.timeout,
        },
      );

      session.state = result.success ? 'completed' : 'failed';
      session.endTime = new Date();
      session.result = result.structured || result.output;
      if (!result.success) {
        session.error = (result.structured as any)?.error || 'Execution failed';
      }
      session.messages.push({
        role: 'assistant',
        content: result.output,
        timestamp: new Date(),
      });
    } catch (err) {
      session.state = 'failed';
      session.endTime = new Date();
      session.error = (err as Error).message;
    }

    return session;
  }

  async getSession(sessionId: string): Promise<AgentSession | undefined> {
    return this.sessions.get(sessionId);
  }

  async terminate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && session.state === 'running') {
      session.state = 'failed';
      session.endTime = new Date();
      session.error = 'Terminated';
    }
  }
}
