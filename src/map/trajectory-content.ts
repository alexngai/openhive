/**
 * Trajectory Content Fetcher
 *
 * Requests session transcript content from a connected swarm on-demand.
 *
 * Uses the MAP SDK's onNotification API (patched) for the request-response pattern:
 *   1. Hub sends `trajectory/content.request` JSON-RPC notification to swarm WS
 *   2. Swarm's AgentConnection.onNotification handler fires
 *   3. Sidecar reads transcript, sends response as `trajectory/content.response` notification
 *   4. Hub's notification interceptor (ws-map.ts) catches the response and resolves
 *
 * The response comes back as a raw JSON-RPC notification on the inbound WebSocket,
 * intercepted before the MAPServer processes it.
 */

import WebSocket from 'ws';
import { nanoid } from 'nanoid';
import { getInbound } from './connection-registry.js';
import { listCheckpointsForSession } from '../db/dal/trajectory-checkpoints.js';

const CONTENT_REQUEST_TIMEOUT_MS = 30_000;

// Pending content requests waiting for responses
const pendingRequests = new Map<string, {
  resolve: (value: ContentResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

export interface ContentResponse {
  transcript: string;
  metadata: Record<string, unknown>;
  prompts: string;
  context: string;
}

/**
 * Handle an incoming trajectory/content.response notification from a swarm.
 * Called by the notification interceptor in ws-map.ts.
 */
export function handleContentResponse(params: Record<string, unknown>): void {
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
    transcript: (params.transcript as string) || '',
    metadata: (params.metadata as Record<string, unknown>) || {},
    prompts: (params.prompts as string) || '',
    context: (params.context as string) || '',
  });
}

/**
 * Fetch transcript content from a connected swarm for a session resource.
 *
 * Looks up the swarm that owns the session, sends a content request
 * notification via the inbound WebSocket, and waits for the response.
 *
 * @returns transcript string or null if swarm is offline/unavailable
 */
export async function fetchTranscriptFromSwarm(
  sessionResourceId: string,
): Promise<string | null> {
  // Find which swarm owns this session by looking at the latest checkpoint
  const { data: checkpoints } = listCheckpointsForSession(sessionResourceId, 1, 0);
  if (checkpoints.length === 0) return null;

  const swarmId = checkpoints[0].source_swarm_id;
  if (!swarmId) return null;

  const conn = getInbound(swarmId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) return null;

  // Check if the swarm declared trajectory content serving capability
  const trajCaps = conn.capabilities?.trajectory as Record<string, unknown> | undefined;
  if (!trajCaps?.canServeContent) return null;

  const checkpointId = checkpoints[0].checkpoint_id;
  const requestId = `content-${nanoid(8)}`;

  // Send content request as a JSON-RPC notification to the swarm's WebSocket.
  // The sidecar's AgentConnection.onNotification('trajectory/content.request', ...)
  // handler will fire and process this.
  const request = {
    jsonrpc: '2.0',
    method: 'trajectory/content.request',
    params: {
      request_id: requestId,
      checkpoint_id: checkpointId,
    },
  };

  try {
    conn.ws.send(JSON.stringify(request));
  } catch {
    return null;
  }

  // Wait for the response notification (handled by handleContentResponse)
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(null);
    }, CONTENT_REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, {
      resolve: (response) => resolve(response?.transcript ?? null),
      timer,
    });
  });
}
