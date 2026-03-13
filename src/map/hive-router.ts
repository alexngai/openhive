/**
 * Hive Router — Resolve hive:<name> addresses and broadcast to members
 *
 * When an agent sends `map/send` to `hive:<name>`, this module:
 * 1. Resolves the hive by name
 * 2. Verifies the sender is a member
 * 3. Stores the message via agent-inbox router
 * 4. Fans out to all online member swarms via sendToSwarm()
 */

import { findHiveByName } from '../db/dal/hives.js';
import { listSwarms, getSwarmHives } from '../db/dal/map.js';
import { getInboxRouter, getFederation } from './inbox-bridge.js';
import { sendToSwarm } from './sync-listener.js';

export interface HiveRouteResult {
  messageId: string;
  hiveName: string;
  hiveId: string;
  recipientCount: number;
}

export interface HiveRouteError {
  code: number;
  message: string;
}

/**
 * Route a map/send message addressed to a hive.
 * Broadcasts to all online member swarms (excluding the sender).
 */
export async function routeHiveMessage(
  sourceSwarmId: string,
  params: Record<string, unknown>,
): Promise<HiveRouteResult | HiveRouteError> {
  // Parse hive address
  const toId = (params.to as { id?: string })?.id;
  if (!toId || !toId.startsWith('hive:')) {
    return { code: -32602, message: 'Invalid hive address format. Expected "hive:<name>"' };
  }
  const rawHiveName = toId.slice(5); // Remove "hive:" prefix

  // Check for federated address: hive:<name>@<system>
  if (rawHiveName.includes('@')) {
    const [name, remoteSystem] = rawHiveName.split('@');
    return routeFederatedHiveMessage(sourceSwarmId, name, remoteSystem, params);
  }

  const hiveName = rawHiveName;

  // Resolve hive
  const hive = findHiveByName(hiveName);
  if (!hive) {
    return { code: -32001, message: `Hive not found: ${hiveName}` };
  }

  // Verify sender is a member
  const senderHives = getSwarmHives(sourceSwarmId);
  const isMember = senderHives.some((sh) => sh.hive_id === hive.id);
  if (!isMember) {
    return { code: -32002, message: `Swarm is not a member of hive: ${hiveName}` };
  }

  // Get online member swarms
  const { data: memberSwarms } = listSwarms({ hive_id: hive.id, status: 'online' });

  // Build recipient list (all member swarms except sender)
  const targetSwarms = memberSwarms.filter((s) => s.id !== sourceSwarmId);
  const allMemberIds = memberSwarms.map((s) => s.id);

  // Store message via inbox router
  const message = await getInboxRouter().routeMessage({
    from: sourceSwarmId,
    to: allMemberIds,
    payload: params.payload,
    scope: hiveName,
    subject: (params.subject as string) ?? undefined,
    metadata: {
      hive_id: hive.id,
      hive_name: hiveName,
      source_swarm_id: sourceSwarmId,
    },
  });

  // Fan out to target swarms via dual-transport delivery
  const broadcastPayload = {
    jsonrpc: '2.0' as const,
    method: 'map/send',
    params: {
      from: { type: 'agent', id: `hive:${hiveName}` },
      to: { type: 'agent', id: `hive:${hiveName}` },
      payload: params.payload,
      messageId: message.id,
      subject: params.subject,
    },
  };

  let delivered = 0;
  for (const swarm of targetSwarms) {
    if (sendToSwarm(swarm.id, broadcastPayload)) {
      delivered++;
    }
  }

  return {
    messageId: message.id,
    hiveName,
    hiveId: hive.id,
    recipientCount: delivered,
  };
}

/**
 * Route a hive message to a remote system via federation.
 */
async function routeFederatedHiveMessage(
  sourceSwarmId: string,
  hiveName: string,
  remoteSystem: string,
  params: Record<string, unknown>,
): Promise<HiveRouteResult | HiveRouteError> {
  const fed = getFederation();
  if (!fed) {
    return { code: -32003, message: 'Federation is not enabled on this hub' };
  }

  // Store locally via inbox router
  const message = await getInboxRouter().routeMessage({
    from: sourceSwarmId,
    to: `@${remoteSystem}`, // broadcast to remote system
    payload: params.payload,
    scope: hiveName,
    subject: (params.subject as string) ?? undefined,
    metadata: {
      hive_name: hiveName,
      remote_system: remoteSystem,
      source_swarm_id: sourceSwarmId,
      federated: true,
    },
  });

  // Route via federation
  const result = await fed.route(message);

  return {
    messageId: message.id,
    hiveName: `${hiveName}@${remoteSystem}`,
    hiveId: `federated:${remoteSystem}`,
    recipientCount: result.delivered ? 1 : 0,
  };
}

/**
 * Check if a result is an error.
 */
export function isHiveRouteError(result: HiveRouteResult | HiveRouteError): result is HiveRouteError {
  return 'code' in result && 'message' in result && !('messageId' in result);
}
