/**
 * SwarmCraft ↔ OpenHive Data Bridge (Orchestrator)
 *
 * Initializes all sub-bridges that project OpenHive domain data into
 * SwarmCraft's visualization layer. Call setupOpenHiveBridge() after
 * the SwarmCraft plugin has been registered on the Fastify instance.
 */

import { setupSwarmBridge } from './swarm-bridge.js';
import { setupSessionBridge } from './session-bridge.js';
import { setupResourceBridge } from './resource-bridge.js';
import { setupRepoBridge } from './repo-bridge.js';
import type { BridgeConfig, BridgeHandle, BridgeContext } from './types.js';

interface SwarmCraftInstance {
  db: BridgeContext['db'] & {
    projects?: {
      getByPath(path: string): Promise<{ id: string; status: string } | null>;
      create(data: { id: string; name: string; path: string; gitUrl?: string; branch?: string; commitHash?: string }): Promise<unknown>;
      update(id: string, data: Record<string, unknown>): Promise<unknown>;
    };
  };
  wsHub: BridgeContext['wsHub'];
  positionService: BridgeContext['positionService'];
  trajectoryService?: BridgeContext['trajectoryService'];
  mapClientManager?: { connect(opts: Record<string, unknown>): Promise<void> };
  /**
   * SwarmCraft ACP stream manager. The bridge calls
   * `closeStreamsForAgent(rawMapAgentId)` on agent termination because
   * the built-in MAP agent-lifecycle handlers in swarmcraft are skipped
   * via `skipAgentLifecycle: true` (the bridge owns agent projection).
   * Wires listeners on both inbound (mapHubEvents) and outbound
   * (mapClientManager) lifecycle events.
   */
  acpStreamManager?: BridgeContext['acpStreamManager'];
  pipelineService?: { startAnalysis(repoPath: string): string; loadProject(projectId: string): Promise<unknown>; isReady(): boolean };
}

/**
 * Set up the full OpenHive → SwarmCraft data bridge.
 *
 * @param sc - The SwarmCraft context from `fastify.swarmcraft`
 * @param config - Optional per-bridge enable/disable flags (all enabled by default)
 */
export async function setupOpenHiveBridge(
  sc: SwarmCraftInstance,
  config?: BridgeConfig,
): Promise<BridgeHandle> {
  const ctx: BridgeContext = {
    db: sc.db,
    wsHub: sc.wsHub,
    positionService: sc.positionService,
    trajectoryService: sc.trajectoryService,
    acpStreamManager: sc.acpStreamManager,
  };

  const teardowns: Array<() => void> = [];

  console.log('[swarmcraft-bridge] Initializing OpenHive data bridge...');

  // Phase 1: Swarm + Node agents (includes MAP client auto-connect)
  if (config?.swarms !== false) {
    const handle = await setupSwarmBridge(ctx, sc.mapClientManager);
    teardowns.push(handle.teardown);
    console.log('[swarmcraft-bridge] Swarm bridge ready');
  }

  // Phase 2: Session agents + trajectory data
  if (config?.sessions !== false) {
    const handle = await setupSessionBridge(ctx);
    teardowns.push(handle.teardown);
    console.log('[swarmcraft-bridge] Session bridge ready');
  }

  // Phase 3: Tasks — handled by OpenTasks via frontend hook (useOpenTasksAggregated),
  // no server-side bridge needed. Coordination events go to OpenTasks via compat shim.

  // Phase 4: Auto-register repos from swarm trajectory checkpoints
  if (sc.pipelineService) {
    const handle = await setupRepoBridge(sc.pipelineService, sc.db.projects);
    teardowns.push(handle.teardown);
    console.log('[swarmcraft-bridge] Repo bridge ready');
  }

  // Phase 5: Resource metadata enrichment (memories, skills)
  if (config?.resources !== false) {
    const handle = await setupResourceBridge(ctx);
    teardowns.push(handle.teardown);
    console.log('[swarmcraft-bridge] Resource bridge ready');
  }

  console.log('[swarmcraft-bridge] All bridges initialized');

  return {
    teardown() {
      for (const fn of teardowns) fn();
      console.log('[swarmcraft-bridge] All bridges torn down');
    },
  };
}
