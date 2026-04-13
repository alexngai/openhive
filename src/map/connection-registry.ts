/**
 * MAP Inbound Connection Registry
 *
 * In-memory registry tracking swarms that have connected inbound to the hub
 * via /ws/map. Separated from ws-map.ts to avoid circular imports with
 * sync-listener.ts (which needs getInbound for dual-transport delivery).
 */

import type { WebSocket } from 'ws';

export interface RegisteredAgent {
  id: string;
  name: string;
  role: string;
  state: string;
  scopes: string[];
  /** Capabilities declared by this specific agent during MAP registration. */
  capabilities?: Record<string, unknown>;
  /**
   * Metadata from the agent's registration. May include `localMapId`, which
   * identifies the agent on the swarm's own MAP server — the correct target
   * for ACP routing (different from this `id` which is the hub's ULID).
   */
  metadata?: Record<string, unknown>;
}

export interface MapInboundConnection {
  ws: WebSocket;
  agentId: string;
  swarmId: string;
  connectedAt: string;
  lastMessageAt: string;
  /** ISO timestamp when the agent-iam token expires (verified mode only). */
  tokenExpiresAt?: string;
  /** Whether an auth.expiring notification has already been sent for this session. */
  expiryNotified?: boolean;
  /** Agents registered on this connection (keyed by agent ID). */
  registeredAgents: Map<string, RegisteredAgent>;
  /** Legacy: capabilities from the last agent to register. Prefer per-agent capabilities. */
  capabilities?: Record<string, unknown>;
  /** Default OpenTasks graph for this connection (set via metadata.task_graph on registration). */
  defaultTaskGraph?: { resource_id?: string; path?: string; location_hash?: string };
  /**
   * When true, the WS has closed but we're retaining metadata (registeredAgents,
   * capabilities) for a grace period to survive brief sidecar reconnects. Active
   * connection queries (getInbound) skip stale entries; metadata-only reads can
   * opt into stale data via getInboundIncludingStale.
   */
  isStale?: boolean;
}

/**
 * Grace period to retain a connection's metadata after its WS closes. Allows a
 * reconnecting sidecar to inherit the prior registeredAgents so clients don't
 * see a brief metadata vacuum between disconnect and agent re-registration.
 */
const STALE_GRACE_MS = 30_000;

const inboundConnections: Map<string, MapInboundConnection> = new Map();

export function registerInbound(swarmId: string, conn: MapInboundConnection): void {
  const existing = inboundConnections.get(swarmId);
  if (existing) {
    // Seed the new connection's registeredAgents from the prior (possibly
    // stale) connection so brief reconnects don't lose localMapId,
    // provider_session_id, capabilities, etc. until agents re-register.
    for (const [id, agent] of existing.registeredAgents) {
      if (!conn.registeredAgents.has(id)) {
        conn.registeredAgents.set(id, agent);
      }
    }
    // If the existing is an active connection (not stale), close its WS.
    if (existing.ws !== conn.ws && !existing.isStale) {
      try { existing.ws.close(); } catch { /* ignore */ }
    }
  }
  inboundConnections.set(swarmId, conn);
}

export function unregisterInbound(swarmId: string): void {
  const conn = inboundConnections.get(swarmId);
  if (!conn) return;
  // Mark as stale rather than deleting immediately. Keep metadata in place so
  // a reconnecting sidecar inherits registeredAgents through registerInbound's
  // carry-over. After STALE_GRACE_MS, sweep if still stale (not replaced).
  conn.isStale = true;
  setTimeout(() => {
    const current = inboundConnections.get(swarmId);
    if (current === conn && current.isStale) {
      inboundConnections.delete(swarmId);
    }
  }, STALE_GRACE_MS);
}

/**
 * Get an active inbound connection. Skips stale entries — callers that need to
 * send WS messages should use this. For metadata-only reads during the stale
 * grace period, use `getInboundIncludingStale`.
 */
export function getInbound(swarmId: string): MapInboundConnection | undefined {
  const conn = inboundConnections.get(swarmId);
  if (!conn || conn.isStale) return undefined;
  return conn;
}

/**
 * Like `getInbound` but also returns connections in the stale grace period.
 * Safe for reading registeredAgents/capabilities/metadata — but do NOT use the
 * returned `ws` (it's closed if isStale is true).
 */
export function getInboundIncludingStale(swarmId: string): MapInboundConnection | undefined {
  return inboundConnections.get(swarmId);
}

/**
 * Returns active (non-stale) inbound connections. Iteration/usage helpers
 * filter stale entries so existing callers see pre-stale-grace behavior.
 */
export function getAllInbound(): Map<string, MapInboundConnection> {
  const result = new Map<string, MapInboundConnection>();
  for (const [id, conn] of inboundConnections) {
    if (!conn.isStale) result.set(id, conn);
  }
  return result;
}

export function getInboundCount(): number {
  // Count only non-stale; stale entries are invisible to health reporting.
  let n = 0;
  for (const conn of inboundConnections.values()) {
    if (!conn.isStale) n++;
  }
  return n;
}

/**
 * Collect capabilities from all registered agents on a connection.
 * Returns an array of per-agent capability sets (preserving attribution).
 * Callers decide how to query: check a specific agent, or any-agent-has.
 */
export function getAgentCapabilities(swarmId: string): Array<{ agentId: string; role: string; capabilities: Record<string, unknown> }> {
  const conn = inboundConnections.get(swarmId);
  if (!conn || conn.isStale) return [];

  const result: Array<{ agentId: string; role: string; capabilities: Record<string, unknown> }> = [];
  for (const agent of conn.registeredAgents.values()) {
    if (agent.capabilities) {
      result.push({ agentId: agent.id, role: agent.role, capabilities: agent.capabilities });
    }
  }
  return result;
}

/**
 * Find the first agent on the connection that supports ACP.
 * Returns the ID to target on the swarm's own MAP server (localMapId from
 * metadata when available; falls back to the hub-assigned id). ACP streams
 * are created against the swarm's MAP server, so targeting requires an ID
 * that resolves there — the hub-assigned id won't.
 */
export function findAcpAgent(swarmId: string): string | undefined {
  const info = findAcpAgentInfo(swarmId);
  return info?.targetId;
}

/**
 * Find the first ACP-capable agent along with its metadata. Used when the
 * caller needs more than just the target ID — e.g., provider_session_id for
 * associating OpenHive sessions with the underlying Claude Code transcript.
 */
export function findAcpAgentInfo(swarmId: string): {
  targetId: string;
  hubAgentId: string;
  metadata: Record<string, unknown> | undefined;
} | undefined {
  const conn = inboundConnections.get(swarmId);
  if (!conn || conn.isStale) return undefined;

  for (const agent of conn.registeredAgents.values()) {
    const caps = agent.capabilities;
    if (!caps) continue;
    const protocols = Array.isArray(caps.protocols) ? caps.protocols as string[] : [];
    if (protocols.includes('acp')) {
      const localMapId = agent.metadata?.localMapId;
      const targetId = (typeof localMapId === 'string' && localMapId) ? localMapId : agent.id;
      return { targetId, hubAgentId: agent.id, metadata: agent.metadata };
    }
  }
  return undefined;
}

/**
 * Check if ANY agent on the connection declares a specific capability.
 * Useful for gating operations that can be handled by any agent on the swarm.
 *
 * @param path — dot-separated capability path, e.g. 'mail.canJoin', 'trajectory.canServeContent'
 */
export function hasCapability(swarmId: string, path: string): boolean {
  const conn = inboundConnections.get(swarmId);
  if (!conn || conn.isStale) return false;

  const parts = path.split('.');

  // Check per-agent capabilities first
  for (const agent of conn.registeredAgents.values()) {
    if (agent.capabilities && checkPath(agent.capabilities, parts)) return true;
  }

  // Fall back to connection-level capabilities (legacy)
  if (conn.capabilities && checkPath(conn.capabilities, parts)) return true;

  return false;
}

function checkPath(obj: Record<string, unknown>, parts: string[]): boolean {
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current === true;
}

/**
 * Get the aggregate capabilities to persist to the database.
 * Collects all per-agent capabilities into a single object for the swarm record.
 * Uses union semantics: true wins for booleans, arrays are merged.
 */
export function getAggregateCapabilities(swarmId: string): Record<string, unknown> | undefined {
  const conn = inboundConnections.get(swarmId);
  if (!conn || conn.isStale) return undefined;

  const sources: Array<Record<string, unknown>> = [];
  for (const agent of conn.registeredAgents.values()) {
    if (agent.capabilities) sources.push(agent.capabilities);
  }

  if (sources.length === 0) return conn.capabilities;
  if (sources.length === 1) return sources[0];

  return aggregateCapabilities(sources);
}

function aggregateCapabilities(sources: Array<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const existing = result[key];

      if (key === 'protocols' && Array.isArray(value)) {
        const merged = new Set([
          ...(Array.isArray(existing) ? existing as string[] : []),
          ...value as string[],
        ]);
        result[key] = [...merged];
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const existingObj = (existing && typeof existing === 'object' && !Array.isArray(existing))
          ? existing as Record<string, unknown>
          : {};
        const merged: Record<string, unknown> = { ...existingObj };
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (v === true || merged[k] === undefined) {
            merged[k] = v;
          }
        }
        result[key] = merged;
      } else if (value === true || existing === undefined) {
        result[key] = value;
      }
    }
  }

  return result;
}

export function setDefaultTaskGraph(swarmId: string, target: { resource_id?: string; path?: string; location_hash?: string }): void {
  const conn = inboundConnections.get(swarmId);
  if (conn) conn.defaultTaskGraph = target;
}

export function getDefaultTaskGraph(swarmId: string): { resource_id?: string; path?: string; location_hash?: string } | undefined {
  return inboundConnections.get(swarmId)?.defaultTaskGraph;
}

// ============================================================================
// Connection Health
// ============================================================================

export interface ConnectionHealth {
  swarmId: string;
  agentId: string;
  transport: 'inbound';
  connectedAt: string;
  lastMessageAt: string;
  missedPongs: number;
  maxMissedPongs: number;
  tokenExpiresAt?: string;
  registeredAgentCount: number;
  registeredAgents: Array<{ id: string; name: string; role: string; state: string; capabilities?: Record<string, unknown> }>;
  /** Aggregate capabilities across all registered agents (union). */
  capabilities?: Record<string, unknown>;
}

/**
 * Get structured health data for a single inbound connection.
 */
export function getConnectionHealth(swarmId: string, maxMissedPongs: number): ConnectionHealth | undefined {
  const conn = inboundConnections.get(swarmId);
  if (!conn || conn.isStale) return undefined;

  return {
    swarmId: conn.swarmId,
    agentId: conn.agentId,
    transport: 'inbound',
    connectedAt: conn.connectedAt,
    lastMessageAt: conn.lastMessageAt,
    missedPongs: (conn.ws as any).missedPongs ?? 0,
    maxMissedPongs,
    tokenExpiresAt: conn.tokenExpiresAt,
    registeredAgentCount: conn.registeredAgents.size,
    registeredAgents: Array.from(conn.registeredAgents.values()).map(a => ({
      id: a.id, name: a.name, role: a.role, state: a.state, capabilities: a.capabilities,
    })),
    capabilities: getAggregateCapabilities(swarmId) ?? conn.capabilities,
  };
}

/**
 * Get structured health data for all inbound connections.
 */
export function getAllConnectionHealth(maxMissedPongs: number): ConnectionHealth[] {
  const results: ConnectionHealth[] = [];
  for (const [swarmId, conn] of inboundConnections) {
    if (conn.isStale) continue; // Don't report stale connections in health
    const health = getConnectionHealth(swarmId, maxMissedPongs);
    if (health) results.push(health);
  }
  return results;
}
