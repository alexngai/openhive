/**
 * Swarm Agent Backend for Cognitive-Core
 *
 * Implements cognitive-core's AgentBackend interface by dispatching workspace
 * template tasks to hosted/connected swarms via MAP extension messages.
 *
 * Uses the same request-response pattern as trajectory/content.request:
 *   1. Hub sends x-openhive/learning.workspace.execute to swarm WS
 *   2. Swarm spawns a worker agent to execute the task
 *   3. Worker returns result as x-openhive/learning.workspace.result notification
 *   4. Hub's notification interceptor resolves the pending request
 */

import WebSocket from 'ws';
import { nanoid } from 'nanoid';
import { getInbound, getAllInbound } from '../map/connection-registry.js';
import type { SwarmManager } from '../swarm/manager.js';
import type { Config } from '../config.js';

const WORKSPACE_EXECUTE_TIMEOUT_MS = 300_000; // 5 minutes for LLM-heavy analysis

// Pending workspace execution requests waiting for responses
const pendingRequests = new Map<string, {
  resolve: (value: WorkspaceResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

export interface WorkspaceResult {
  request_id: string;
  output: unknown;
  error?: string;
  agent_id?: string;
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

  if (params.error) {
    pending.resolve(null);
    return;
  }

  pending.resolve({
    request_id: requestId,
    output: params.output,
    error: params.error as string | undefined,
    agent_id: params.agent_id as string | undefined,
    duration_ms: params.duration_ms as number | undefined,
  });
}

/**
 * AgentBackend implementation that dispatches workspace template tasks
 * to hosted/connected swarms.
 *
 * cognitive-core's AgenticTaskRunner calls spawn() when a workspace template
 * needs LLM-assisted analysis. This backend resolves a swarm, sends the task,
 * and waits for the result.
 */
export class SwarmAgentBackend {
  readonly name = 'openhive-swarm';
  readonly supportedTypes = ['claude-code'];

  private config: Config;
  private swarmManager: SwarmManager | null;
  private lastUsedSwarmId: string | null = null;
  private log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

  constructor(
    config: Config,
    swarmManager: SwarmManager | null,
    logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  ) {
    this.config = config;
    this.swarmManager = swarmManager;
    this.log = logger || {
      info: (...args: unknown[]) => console.log('[learning-backend]', ...args),
      warn: (...args: unknown[]) => console.warn('[learning-backend]', ...args),
    };
  }

  async isAvailable(): Promise<boolean> {
    const swarmId = await this.resolveSwarm();
    return swarmId !== null;
  }

  /**
   * Dispatch a workspace template task to a swarm agent.
   *
   * The task description contains the full workspace template prompt from
   * cognitive-core. The swarm agent receives it as a standard analysis task
   * and returns structured JSON output.
   */
  async spawn(config: {
    agentType: string;
    task: { id?: string; domain: string; description: string; context?: Record<string, unknown> };
    systemPromptAdditions?: string;
    timeout?: number;
  }): Promise<{
    id: string;
    state: string;
    result?: unknown;
    error?: string;
  }> {
    const swarmId = await this.resolveSwarm();
    if (!swarmId) {
      return {
        id: nanoid(),
        state: 'failed',
        error: 'No swarm available for workspace execution',
      };
    }

    const conn = getInbound(swarmId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return {
        id: nanoid(),
        state: 'failed',
        error: `Swarm ${swarmId} is not connected`,
      };
    }

    const requestId = `ws-${nanoid(8)}`;
    const timeout = config.timeout || WORKSPACE_EXECUTE_TIMEOUT_MS;

    // Send workspace execute request
    const request = {
      jsonrpc: '2.0',
      method: 'x-openhive/learning.workspace.execute',
      params: {
        request_id: requestId,
        task: {
          description: config.task.description,
          domain: config.task.domain,
          context: config.task.context || {},
        },
        system_prompt_additions: config.systemPromptAdditions,
        timeout,
      },
    };

    try {
      conn.ws.send(JSON.stringify(request));
    } catch (err) {
      return {
        id: requestId,
        state: 'failed',
        error: `Failed to send to swarm: ${(err as Error).message}`,
      };
    }

    this.log.info(`Dispatched workspace task ${requestId} to swarm ${swarmId}`);
    this.lastUsedSwarmId = swarmId;

    // Wait for result
    const result = await new Promise<WorkspaceResult | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(null);
      }, timeout);

      pendingRequests.set(requestId, { resolve, timer });
    });

    if (!result) {
      return {
        id: requestId,
        state: 'failed',
        error: 'Workspace execution timed out',
      };
    }

    if (result.error) {
      return {
        id: requestId,
        state: 'failed',
        error: result.error,
      };
    }

    return {
      id: requestId,
      state: 'completed',
      result: result.output,
    };
  }

  /**
   * Resolve a swarm to dispatch work to.
   * Priority: preferred → LRU among connected → spawn ephemeral.
   */
  private async resolveSwarm(): Promise<string | null> {
    const computeConfig = this.config.learning.compute;

    // 1. Preferred swarm
    if (computeConfig.preferredSwarmId) {
      const conn = getInbound(computeConfig.preferredSwarmId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        return computeConfig.preferredSwarmId;
      }
    }

    // 2. LRU among connected swarms
    const allConnected = getAllInbound();
    for (const [swarmId, conn] of allConnected) {
      if (conn.ws.readyState === WebSocket.OPEN && swarmId !== this.lastUsedSwarmId) {
        return swarmId;
      }
    }
    // Fallback to last used if it's the only one
    for (const [swarmId, conn] of allConnected) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        return swarmId;
      }
    }

    // 3. Spawn ephemeral swarm (if configured and SwarmManager available)
    if (computeConfig.spawnIfNoneAvailable && this.swarmManager) {
      try {
        this.log.info('No connected swarms available, spawning ephemeral learning swarm');
        const hosted = await this.swarmManager.spawn('system', {
          name: `learning-ephemeral-${nanoid(4)}`,
          provider: computeConfig.spawnProvider as 'local' | undefined,
          metadata: { role: 'learning-compute', ephemeral: true },
        });
        if (hosted?.swarm_id) {
          return hosted.swarm_id;
        }
      } catch (err) {
        this.log.warn('Failed to spawn ephemeral swarm:', (err as Error).message);
      }
    }

    return null;
  }
}
