/**
 * Context-type registry.
 *
 * Pages register their on-screen entities as context items; the registry
 * provides the format/identity/label for each type. See §4.1 of
 * docs/CHAT_CONTEXT_INJECTION_DESIGN.md.
 *
 * Registrations live in `./context-types/*`. Importing
 * `./context-types/index.ts` triggers registration of all built-ins via
 * side-effect imports.
 */

import type { QueryClient } from '@tanstack/react-query';

export interface ContextTypeSpec<T = unknown> {
  /** Short key used in UI/registry lookups, e.g. 'spec'. */
  type: string;

  /**
   * Qualified kind emitted on fenced blocks, e.g. 'openhive:spec'.
   * Self-describes the entity type so agents reading a turn in isolation
   * (e.g. from history replay, across hubs) know what it is without
   * external vocabulary.
   */
  kind: string;

  /**
   * Short human description. Used in hover preview and reserved for a
   * future capability advertisement channel.
   */
  description: string;

  /** Emoji or icon token shown in the menu. */
  icon: string;

  /** Human label, e.g. (data) => `Spec: ${data.title}`. */
  label: (data: T) => string;

  /**
   * Produces the fenced-block markdown injected into the chat turn.
   *
   * `flags.stale` (step 7) — when true, the fenced block carries a
   * `stale="true"` attr. Used when the live loader returns null
   * (source entity vanished between staging and Send) per §4.6.
   */
  format: (data: T, flags?: { stale?: boolean }) => string;

  /**
   * Identifying attributes emitted on the fenced block. Always includes
   * at least `{ id }`. Agents use these to *act* on the entity (update a
   * spec, query task state, reference in tool calls).
   */
  identity: (data: T) => Record<string, string>;

  /**
   * Optional: re-fetch live data at inject time. Runs with a 200ms soft
   * timeout. The signal is aborted when the timeout fires; honor it by
   * passing `{ signal }` to `fetchQuery`.
   *
   * Returning null means "use the snapshot". Settled values arriving
   * after `signal.aborted` are discarded.
   */
  live?: (
    data: T,
    ctx: { queryClient: QueryClient; signal: AbortSignal },
  ) => Promise<T | null> | T | null;
}

// Module-level registry. `.set()` overwrite semantics keep HMR idempotent;
// the first load captures each type, a Vite module swap re-registers (and
// re-overwrites) the same entries.
const registry = new Map<string, ContextTypeSpec<unknown>>();

export function registerContextType<T>(spec: ContextTypeSpec<T>): void {
  registry.set(spec.type, spec as unknown as ContextTypeSpec<unknown>);
}

export function getContextType(type: string): ContextTypeSpec | undefined {
  return registry.get(type);
}

export function listContextTypes(): ContextTypeSpec[] {
  return Array.from(registry.values());
}
