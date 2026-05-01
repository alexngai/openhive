/**
 * Shared helpers for composing a chat turn from staged chips + composer text.
 * Extracted from ChatPanel so tests can exercise the Send-path pure logic
 * without a full React render.
 *
 * See §4.6 / §8.1 of docs/CHAT_CONTEXT_INJECTION_DESIGN.md.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { ChatFabContextItem } from './chat-fab-item';
import type { ChatFabStagedChip } from './chat-fab-staged-chips-store';
import { getContextType } from './context-registry';
import { runLiveWithTimeout } from './live-refresh';
import { formatContextItem } from './ContextFormatter';

/** Hard cap per §8.1. Reject + toast if the composed turn exceeds this. */
export const MAX_USER_TURN_BYTES = 256 * 1024;

/**
 * Compose the final user turn: every chip's formatted fenced-block, then
 * the composer text (if any). Matches the shape the legacy injection path
 * produces, just for chips-mode collection semantics.
 *
 * Synchronous path — used when no QueryClient is available (fail-closed,
 * no live refresh). Each chip is formatted from its staged snapshot with
 * `stale=false`.
 */
export function composeTurn(
  chips: ChatFabStagedChip[],
  text: string,
): string {
  const parts: string[] = [];
  for (const chip of chips) {
    parts.push(formatChipForSend(chip.item));
  }
  const trimmed = text.trim();
  if (trimmed.length > 0) parts.push(trimmed);
  return parts.join('\n\n');
}

/**
 * Async compose — runs each chip's `live` loader in parallel (bounded by
 * the 200ms per-chip timeout), then formats with the possibly-fresh data +
 * stale flag. Total Send-path latency is bounded by the slowest chip's
 * 200ms window, not additive.
 *
 * §3.1.4 (live refresh bounded ≤ 250ms): the `Promise.all` waits on the
 * slowest timeout; remaining overhead is formatter work.
 * §3.1.5 (AbortSignal honored): handled inside `runLiveWithTimeout`.
 */
export async function composeTurnWithLiveRefresh(
  chips: ChatFabStagedChip[],
  text: string,
  queryClient: QueryClient,
): Promise<string> {
  const refreshed = await Promise.all(
    chips.map((chip) => applyLiveRefresh(chip, queryClient)),
  );

  const parts: string[] = [];
  for (const { item, stale } of refreshed) {
    parts.push(formatChipForSendWithFlags(item, { stale }));
  }
  const trimmed = text.trim();
  if (trimmed.length > 0) parts.push(trimmed);
  return parts.join('\n\n');
}

/**
 * Run `live` on a single chip with the 200ms wrapper; return a fresh item
 * (same `type` + `label`, possibly-updated `data`) plus the stale flag.
 *
 * `stale: true` iff the type has a `live` loader AND that loader returned
 * null — i.e., we have positive evidence the entity was deleted. Missing
 * loader, timeout, abort, or thrown → `stale: false`.
 */
export async function applyLiveRefresh(
  chip: ChatFabStagedChip,
  queryClient: QueryClient,
): Promise<{ item: ChatFabContextItem; stale: boolean }> {
  const spec = getContextType(chip.item.type);
  if (!spec) return { item: chip.item, stale: false };

  const { data, stale } = await runLiveWithTimeout(
    spec,
    chip.item.data,
    queryClient,
  );

  // Refresh the item only if the reference changed — keeps `===` stable
  // when live returned the same snapshot we had.
  if (data === chip.item.data) {
    return { item: chip.item, stale };
  }

  return {
    item: {
      ...chip.item,
      // label stays stable (e.g., "Spec: X"); the registry's label() is a
      // function of the current data so a caller that wants the live
      // label can recompute, but the chip label the user saw is what we
      // honor on send.
      data,
    } as ChatFabContextItem,
    stale,
  };
}

/**
 * Format a single chip for send. Identical output to `formatContextItem`
 * — used for the synchronous, no-QueryClient path.
 */
export function formatChipForSend(item: ChatFabContextItem): string {
  return formatContextItem(item);
}

/**
 * Format a single chip with explicit flags (e.g. `stale: true`). Registry
 * format functions receive the flags; the human-readable prefix is
 * preserved.
 */
export function formatChipForSendWithFlags(
  item: ChatFabContextItem,
  flags: { stale?: boolean },
): string {
  return formatContextItem(item, flags);
}

/**
 * Byte length of a UTF-8 string. `TextEncoder` is a jsdom/browser global
 * but not available in every Node version; fall back to Buffer when we're
 * on the server (tests running under node without --experimental-vm).
 */
export function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  // @ts-expect-error Buffer is a node global when we get here.
  return Buffer.byteLength(s, 'utf8');
}
