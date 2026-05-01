/**
 * Live-refresh wrapper — runs a context type's `live` loader with a 200ms
 * soft timeout and an AbortSignal honored by the loader.
 *
 * See §3.1.4, §3.1.5, §4.4 of docs/CHAT_CONTEXT_INJECTION_DESIGN.md.
 *
 * Timeout semantics:
 *   - Fresh AbortController per invocation; signal is passed to `live()`.
 *   - On timeout, `abort()` fires. Implementations pass `signal` to
 *     `fetchQuery`, so in-flight requests cancel cleanly.
 *   - If the promise settles AFTER `signal.aborted` is true, the value is
 *     discarded — we fall back to the snapshot.
 *   - `null` from `live()` means "no fresh value" → fall back to snapshot,
 *     with `stale: true` reported so the fenced block can carry the marker.
 *   - Thrown errors collapse to snapshot + stale=false (the type didn't
 *     claim freshness either way — the loader simply failed).
 */

import type { QueryClient } from '@tanstack/react-query';
import type { ContextTypeSpec } from './context-registry';

export const LIVE_REFRESH_TIMEOUT_MS = 200;

export interface LiveRefreshResult<T> {
  /** The value to format and send (fresh if live resolved in time, else snapshot). */
  data: T;
  /**
   * True iff the type declared a `live` loader AND that loader explicitly
   * returned null — meaning the source entity vanished between staging and
   * send. Per §4.6 this surfaces as `stale="true"` on the fenced block.
   *
   * Timeout / abort / throw / missing-live-loader → `stale: false`. We only
   * report stale when we have a positive signal of deletion.
   */
  stale: boolean;
}

/**
 * Run `spec.live()` with a 200ms timeout. Returns the snapshot on
 * timeout/abort/throw/no-loader; reports `stale: true` only when the loader
 * explicitly returned null.
 */
export async function runLiveWithTimeout<T>(
  spec: ContextTypeSpec<T>,
  data: T,
  queryClient: QueryClient,
): Promise<LiveRefreshResult<T>> {
  if (!spec.live) return { data, stale: false };

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<'__timeout__'>((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve('__timeout__');
    }, LIVE_REFRESH_TIMEOUT_MS);
  });

  let livePromise: Promise<T | null> | T | null;
  try {
    livePromise = spec.live(data, {
      queryClient,
      signal: controller.signal,
    });
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    if (import.meta.env?.DEV) {
      // eslint-disable-next-line no-console
      console.warn('[chat-fab] live() threw, using snapshot:', err);
    }
    return { data, stale: false };
  }

  try {
    const settled = await Promise.race([
      Promise.resolve(livePromise).then(
        (v) => ({ ok: true as const, v }),
        (err) => ({ ok: false as const, err }),
      ),
      timeoutPromise,
    ]);

    if (settled === '__timeout__') {
      // Timeout won — snapshot, no stale claim (we don't know).
      return { data, stale: false };
    }

    if (!settled.ok) {
      if (import.meta.env?.DEV) {
        // eslint-disable-next-line no-console
        console.warn('[chat-fab] live() rejected, using snapshot:', settled.err);
      }
      return { data, stale: false };
    }

    // If the signal aborted while the promise was pending, the value is
    // poisoned — discard it. Defensive against a race where the promise
    // resolves on the same tick the timeout fires.
    if (controller.signal.aborted) {
      return { data, stale: false };
    }

    if (settled.v == null) {
      // Explicit null → source entity vanished. Snapshot with stale marker.
      return { data, stale: true };
    }

    return { data: settled.v, stale: false };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
