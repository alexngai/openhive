/**
 * Dispatch Mail Ingress
 *
 * Inbound hook for `map/dispatch/reply` notifications. The ws-map interceptor
 * forwards replies here; the mail-transport subscribes to fan them out into
 * swarm-dispatch's message port.
 *
 * Split from mail-transport.ts so ws-map can import without a cycle through
 * the mail module or the orchestrator wiring.
 */

export interface DispatchReplyPayload {
  swarmId: string;
  fromAgentId: string;
  message: Record<string, unknown>;
}

type Handler = (payload: DispatchReplyPayload) => void;

const handlers = new Set<Handler>();

export function pushDispatchMapReply(payload: DispatchReplyPayload): void {
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch {
      /* best-effort fan-out */
    }
  }
}

export function subscribeDispatchMapReply(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** Test helper. */
export function _resetDispatchMapReply(): void {
  handlers.clear();
}
