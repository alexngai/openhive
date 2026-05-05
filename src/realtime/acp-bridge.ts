/**
 * ACP event bridge: SwarmCraft `wsHub` → OpenHive `/ws` (global channel).
 *
 * SwarmCraft broadcasts ACP streaming events (acp.session.update,
 * acp.prompt.completed, acp.permission.resolved, etc.) on its own
 * wsHub keyed by topic. The browser-side OpenHive client connects to
 * `/ws` and subscribes to the `global` channel — we install this
 * intercept so ACP events surface there.
 *
 * `permission_request` SessionUpdates ride inside `acp.session.update`
 * payloads; the bridge does not look inside, it just forwards. The
 * P3 prompt-iterator interception (overlay-gated) decides which
 * permission_request updates reach the consumer; ones that pass
 * through go to chat surfaces via this bridge.
 *
 * Filter: only forward from `topic === 'acp'`. SwarmCraft also
 * broadcasts each ACP event to the generic `'events'` topic; we'd
 * deliver duplicates to the global channel without this guard.
 */

import type { WSEvent, WSEventType } from "../types.js";

interface WsHubLike {
  broadcast: (message: unknown, topic?: string) => void;
}

type BroadcastFn = (
  channel: string,
  event: Omit<WSEvent, "timestamp" | "channel">,
) => void;

interface AcpBridgeMessage {
  type?: string;
  payload?: unknown;
  data?: unknown;
}

/**
 * Replace `wsHub.broadcast` with a wrapper that mirrors the original AND
 * forwards `acp.*` events from the `'acp'` topic into the host's broadcast
 * function (`broadcastToChannel('global', ...)`).
 *
 * Returns a function that restores the original broadcaster.
 */
export function installAcpBridge(
  wsHub: WsHubLike,
  broadcastToChannel: BroadcastFn,
): () => void {
  const orig = wsHub.broadcast.bind(wsHub);
  wsHub.broadcast = (message: unknown, topic?: string) => {
    orig(message, topic);
    const m = message as AcpBridgeMessage | null;
    if (
      topic === "acp" &&
      m?.type &&
      typeof m.type === "string" &&
      m.type.startsWith("acp.")
    ) {
      // ACP event types are not (yet) in the WSEventType union; cast since
      // the runtime treats `type` as an opaque string identifier.
      broadcastToChannel("global", {
        type: m.type as WSEventType,
        data: m.payload ?? m.data ?? m,
      });
    }
  };
  return () => {
    wsHub.broadcast = orig;
  };
}
