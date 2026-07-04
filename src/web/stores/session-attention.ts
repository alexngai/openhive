/**
 * Session attention store — tracks *why* a thread needs the user, across
 * every session surface, so the cockpit (sidebar badge, attention queue,
 * thread rows) can aggregate without each surface being mounted.
 *
 * Two attention kinds:
 * - `idle`       — agent finished a turn / is awaiting input. One per thread,
 *                  cleared when the user views the thread.
 * - `permission` — agent is blocked on a tool-approval request. N per thread,
 *                  cleared only when the request is resolved (any tab), never
 *                  by merely viewing the thread.
 *
 * Items are keyed by thread using the same `flavor:id` scheme as the Threads
 * page selection keys (`session:<resourceId>`, `hosted-chat:<hostedSwarmId>`).
 * Permission events whose session can't be resolved yet fall back to a
 * `stream:<acpStreamId>` key so counts stay correct even before the sessions
 * list cache is populated.
 *
 * Fed by `useGlobalAttention` (mounted once in Layout).
 */

import { create } from 'zustand';

export type AttentionKind = 'idle' | 'permission' | 'dispatch';

export interface AttentionItem {
  /** Thread selection key: `session:<id>` | `hosted-chat:<id>` | `stream:<id>` fallback. */
  threadKey: string;
  kind: AttentionKind;
  swarmId: string;
  /** Human-readable label for queue rendering (node state or permission summary). */
  description: string;
  timestamp: number;
  /** Permission routing — set for kind 'permission' only. */
  requestId?: string;
  /** ACP reply route (`POST /api/swarmcraft/acp/streams/:streamId/permission`). */
  streamId?: string;
  /** Hosted reply route (`POST /map/hosted/:id/chat/permission/:requestId`). */
  hostedSwarmId?: string;
}

export function sessionThreadKey(sessionResourceId: string): string {
  return `session:${sessionResourceId}`;
}

export function hostedChatThreadKey(hostedSwarmId: string): string {
  return `hosted-chat:${hostedSwarmId}`;
}

export function streamThreadKey(acpStreamId: string): string {
  return `stream:${acpStreamId}`;
}

/** Attention key for a completed/dead dispatch — deep-links to `/dispatch/<id>`. */
export function dispatchThreadKey(dispatchId: string): string {
  return `dispatch:${dispatchId}`;
}

/** Internal map key: one slot per thread for idle, one per request for permissions. */
function idleKey(threadKey: string): string {
  return `${threadKey}#idle`;
}
function permissionKey(threadKey: string, requestId: string): string {
  return `${threadKey}#perm:${requestId}`;
}
function dispatchKey(threadKey: string): string {
  return `${threadKey}#dispatch`;
}

export interface MarkPermissionInput {
  threadKey: string;
  requestId: string;
  description: string;
  swarmId?: string;
  streamId?: string;
  hostedSwarmId?: string;
}

interface SessionAttentionState {
  items: Map<string, AttentionItem>;

  /** Upsert the (single) idle item for a thread. */
  markIdle: (threadKey: string, swarmId: string, state: string) => void;
  /** Upsert a permission item (one per requestId). */
  markPermission: (input: MarkPermissionInput) => void;
  /** Upsert the (single) dispatch-completion item for a dispatch. */
  markDispatch: (threadKey: string, swarmId: string, description: string) => void;
  /** Remove a permission item by requestId (answered here or in another tab). */
  resolvePermission: (requestId: string) => void;
  /** Clear the idle item only — viewing a thread must not hide pending permissions. */
  clearIdle: (threadKey: string) => void;
  /** Clear everything for a thread (e.g. thread closed/stopped). */
  clearThread: (threadKey: string) => void;
  clearAll: () => void;

  hasAttention: (threadKey: string) => boolean;
  hasPermission: (threadKey: string) => boolean;
  itemsForThread: (threadKey: string) => AttentionItem[];
  attentionCount: () => number;
}

export const useSessionAttentionStore = create<SessionAttentionState>((set, get) => ({
  items: new Map(),

  markIdle: (threadKey, swarmId, state) => {
    set((prev) => {
      const items = new Map(prev.items);
      items.set(idleKey(threadKey), {
        threadKey,
        kind: 'idle',
        swarmId,
        description: state,
        timestamp: Date.now(),
      });
      return { items };
    });
  },

  markPermission: ({ threadKey, requestId, description, swarmId, streamId, hostedSwarmId }) => {
    set((prev) => {
      const items = new Map(prev.items);
      items.set(permissionKey(threadKey, requestId), {
        threadKey,
        kind: 'permission',
        swarmId: swarmId ?? '',
        description,
        timestamp: Date.now(),
        requestId,
        streamId,
        hostedSwarmId,
      });
      return { items };
    });
  },

  markDispatch: (threadKey, swarmId, description) => {
    set((prev) => {
      const items = new Map(prev.items);
      items.set(dispatchKey(threadKey), {
        threadKey,
        kind: 'dispatch',
        swarmId,
        description,
        timestamp: Date.now(),
      });
      return { items };
    });
  },

  resolvePermission: (requestId) => {
    const current = get().items;
    let found = false;
    for (const item of current.values()) {
      if (item.kind === 'permission' && item.requestId === requestId) {
        found = true;
        break;
      }
    }
    if (!found) return;
    set((prev) => {
      const items = new Map(prev.items);
      for (const [key, item] of items) {
        if (item.kind === 'permission' && item.requestId === requestId) {
          items.delete(key);
        }
      }
      return { items };
    });
  },

  clearIdle: (threadKey) => {
    if (!get().items.has(idleKey(threadKey))) return;
    set((prev) => {
      const items = new Map(prev.items);
      items.delete(idleKey(threadKey));
      return { items };
    });
  },

  clearThread: (threadKey) => {
    const current = get().items;
    let found = false;
    for (const item of current.values()) {
      if (item.threadKey === threadKey) {
        found = true;
        break;
      }
    }
    if (!found) return;
    set((prev) => {
      const items = new Map(prev.items);
      for (const [key, item] of items) {
        if (item.threadKey === threadKey) items.delete(key);
      }
      return { items };
    });
  },

  clearAll: () => {
    set({ items: new Map() });
  },

  hasAttention: (threadKey) => {
    for (const item of get().items.values()) {
      if (item.threadKey === threadKey) return true;
    }
    return false;
  },

  hasPermission: (threadKey) => {
    for (const item of get().items.values()) {
      if (item.threadKey === threadKey && item.kind === 'permission') return true;
    }
    return false;
  },

  itemsForThread: (threadKey) => {
    const result: AttentionItem[] = [];
    for (const item of get().items.values()) {
      if (item.threadKey === threadKey) result.push(item);
    }
    return result;
  },

  attentionCount: () => {
    return get().items.size;
  },
}));
