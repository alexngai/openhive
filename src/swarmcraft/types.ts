/**
 * SwarmCraft Bridge Types
 *
 * Shared type definitions for the OpenHive → SwarmCraft data bridge.
 */

/** Per-sub-bridge enable/disable flags */
export interface BridgeConfig {
  swarms?: boolean;
  sessions?: boolean;
  resources?: boolean;
}

/** Handle returned by setupOpenHiveBridge for graceful shutdown */
export interface BridgeHandle {
  teardown(): void;
}

/** Context passed to each sub-bridge from the orchestrator */
export interface BridgeContext {
  /** SwarmCraft database provider */
  db: {
    agents: {
      create(data: Record<string, unknown>): Promise<unknown>;
      update(id: string, data: Record<string, unknown>): Promise<unknown>;
      get(id: string): Promise<Record<string, unknown> | null>;
    };
    tasks: {
      create(data: Record<string, unknown>): Promise<unknown>;
      update(id: string, data: Record<string, unknown>): Promise<unknown>;
      get(id: string): Promise<Record<string, unknown> | null>;
      assign(taskId: string, agentId: string): Promise<unknown>;
    };
    events: {
      create(data: Record<string, unknown>): Promise<unknown>;
    };
  };
  /** SwarmCraft WebSocket hub */
  wsHub: {
    broadcastAgentRegistered(agent: { id: string; name: string; type: string }): void;
    broadcastAgentStateChanged(agentId: string, previousState: string, newState: string): void;
    broadcastTaskAssigned(taskId: string, agentId: string, taskTitle: string): void;
    broadcastTaskStatusChanged(taskId: string, previousStatus: string, newStatus: string): void;
    broadcast(message: { type: string; payload: unknown }, topic?: string): void;
  };
  /** SwarmCraft position service for agent graph positioning */
  positionService: {
    recordAccess(agentId: string, filePath: string, accessType: 'read' | 'write'): Promise<unknown>;
  };
  /** SwarmCraft trajectory service (optional) */
  trajectoryService?: {
    startTurn(params: { turnId: string; agentId: string; sessionId: string; turnNumber: number; startedAt?: number }): Promise<unknown>;
    recordAction(params: { agentId: string; tool: string; filePath?: string; success?: boolean; timestamp?: number }): Promise<unknown>;
    endCurrentTurn(agentId: string): Promise<void>;
  };
}
