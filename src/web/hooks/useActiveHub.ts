import { useSyncExternalStore } from 'react';
import { subscribeHub, getHubSnapshot, type HubSnapshot } from '../lib/hub';

/**
 * React binding for the active hub connection (src/web/lib/hub.ts).
 *
 * Returns `{ origin, token }` and re-renders the caller whenever either
 * changes — used by the WS hook, the ACP/mail adapter set, the terminal, and
 * the SwarmCraft embed config so they re-derive their URLs/credentials and
 * reconnect when the client is pointed at a different hub.
 */
export function useActiveHub(): HubSnapshot {
  return useSyncExternalStore(subscribeHub, getHubSnapshot, getHubSnapshot);
}
