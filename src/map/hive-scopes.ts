/**
 * Hive Scopes — Maps OpenHive hives to agentic-mesh MapServer scopes
 *
 * Each hive maps to a MapServer scope named `hive:{hiveName}`. This enables
 * native scope-addressed broadcasting: server.send(from, { scope: 'hive:name' }, payload)
 * replaces the manual fan-out loop in hive-router.ts.
 *
 * Scope lifecycle mirrors hive lifecycle:
 * - Hive created → scope created
 * - Hive deleted → scope deleted
 * - Hive archived → scope left dormant (members stay, no messages)
 * - Join hive → joinScope
 * - Leave hive → leaveScope
 */

import { isMeshEnabled, getHubMapServer } from './mesh-peer.js';

const SCOPE_PREFIX = 'hive:';

// ─── Scope ID Helpers ────────────────────────────────────────────────────────

export function hiveScopeId(hiveName: string): string {
  return `${SCOPE_PREFIX}${hiveName}`;
}

// ─── Scope Lifecycle ─────────────────────────────────────────────────────────

/**
 * Create a MapServer scope for a hive.
 * No-op if mesh is not enabled or scope already exists.
 */
export function createHiveScope(hiveName: string): void {
  if (!isMeshEnabled()) return;

  const server = getHubMapServer();
  const scopeId = hiveScopeId(hiveName);

  // Check if scope already exists
  if (server.getScope(scopeId)) return;

  try {
    server.createScope({
      scopeId,
      name: hiveName,
      persistent: true,
      joinPolicy: 'open',
      sendPolicy: 'members',
      metadata: { type: 'hive' },
    });
  } catch (err) {
    console.warn(`[hive-scopes] Failed to create scope for hive ${hiveName}:`, (err as Error).message);
  }
}

/**
 * Delete a MapServer scope for a hive (hard delete only).
 * No-op if mesh is not enabled.
 */
export function deleteHiveScope(hiveName: string): void {
  if (!isMeshEnabled()) return;

  const server = getHubMapServer();
  const scopeId = hiveScopeId(hiveName);

  try {
    if (server.getScope(scopeId)) {
      server.deleteScope(scopeId);
    }
  } catch (err) {
    console.warn(`[hive-scopes] Failed to delete scope for hive ${hiveName}:`, (err as Error).message);
  }
}

/**
 * Add an agent to a hive's scope.
 * Creates the scope if it doesn't exist yet.
 */
export function joinHiveScope(hiveName: string, agentId: string): void {
  if (!isMeshEnabled()) return;

  const server = getHubMapServer();
  const scopeId = hiveScopeId(hiveName);

  // Ensure scope exists
  if (!server.getScope(scopeId)) {
    createHiveScope(hiveName);
  }

  try {
    server.joinScope(scopeId, agentId);
  } catch (err) {
    console.warn(`[hive-scopes] Failed to join scope ${scopeId} for agent ${agentId}:`, (err as Error).message);
  }
}

/**
 * Remove an agent from a hive's scope.
 */
export function leaveHiveScope(hiveName: string, agentId: string): void {
  if (!isMeshEnabled()) return;

  const server = getHubMapServer();
  const scopeId = hiveScopeId(hiveName);

  try {
    if (server.getScope(scopeId)) {
      server.leaveScope(scopeId, agentId);
    }
  } catch (err) {
    console.warn(`[hive-scopes] Failed to leave scope ${scopeId} for agent ${agentId}:`, (err as Error).message);
  }
}

/**
 * Broadcast a message to all members of a hive scope via MapServer.
 * Returns true if the message was sent via scope, false if mesh is not available.
 */
export async function broadcastToHiveScope(
  hiveName: string,
  fromAgent: string,
  payload: unknown,
  meta?: Record<string, unknown>,
): Promise<boolean> {
  if (!isMeshEnabled()) return false;

  const server = getHubMapServer();
  const scopeId = hiveScopeId(hiveName);

  // Only broadcast if scope exists
  if (!server.getScope(scopeId)) return false;

  try {
    await server.send(fromAgent, { scope: scopeId }, payload, meta);
    return true;
  } catch (err) {
    console.warn(`[hive-scopes] Scope broadcast failed for ${hiveName}:`, (err as Error).message);
    return false;
  }
}

/**
 * Get scope member agent IDs for a hive.
 * Returns empty array if mesh not enabled or scope doesn't exist.
 */
export function getHiveScopeMembers(hiveName: string): string[] {
  if (!isMeshEnabled()) return [];

  const server = getHubMapServer();
  const scopeId = hiveScopeId(hiveName);

  try {
    if (!server.getScope(scopeId)) return [];
    return server.getScopeMembers(scopeId);
  } catch {
    return [];
  }
}

/**
 * Sync scopes with existing hive data on startup.
 * Creates scopes for all existing hives and joins current members.
 * Called during server initialization after mesh peer is ready.
 */
export function syncHiveScopesFromDb(
  hives: Array<{ name: string }>,
  hiveMemberships: Array<{ hive_name: string; agent_id: string }>,
): void {
  if (!isMeshEnabled()) return;

  let scopesCreated = 0;
  let membersJoined = 0;

  // Create scopes for all hives
  for (const hive of hives) {
    createHiveScope(hive.name);
    scopesCreated++;
  }

  // Join members to their hive scopes
  for (const m of hiveMemberships) {
    joinHiveScope(m.hive_name, m.agent_id);
    membersJoined++;
  }

  if (scopesCreated > 0 || membersJoined > 0) {
    console.log(`[hive-scopes] Synced ${scopesCreated} scope(s), ${membersJoined} membership(s) from DB`);
  }
}
