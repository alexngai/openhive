/**
 * live-refresh.ts unit tests.
 *
 * Covers §3.1.4 (live refresh bounded) and §3.1.5 (AbortSignal honored).
 */

import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  runLiveWithTimeout,
  LIVE_REFRESH_TIMEOUT_MS,
} from '../../components/chat-fab/live-refresh';
import type { ContextTypeSpec } from '../../components/chat-fab/context-registry';

function baseSpec<T>(
  live: ContextTypeSpec<T>['live'],
): ContextTypeSpec<T> {
  return {
    type: 't',
    kind: 'ns:t',
    description: '',
    icon: '📎',
    label: () => 'label',
    identity: () => ({ id: 'x' }),
    format: () => '<context kind="ns:t" id="x"></context>',
    live,
  };
}

function freshQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

describe('runLiveWithTimeout', () => {
  it('returns fresh data when live() resolves under 200ms', async () => {
    const fresh = { id: 'fresh' };
    const snapshot = { id: 'snap' };
    const spec = baseSpec<{ id: string }>(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return fresh;
    });

    const { data, stale } = await runLiveWithTimeout(spec, snapshot, freshQc());
    expect(data).toBe(fresh);
    expect(stale).toBe(false);
  });

  it('returns snapshot when live() is slower than 200ms', async () => {
    const snapshot = { id: 'snap' };
    const spec = baseSpec<{ id: string }>(
      async (_, { signal }) =>
        new Promise<{ id: string }>((_resolve, reject) => {
          const t = setTimeout(() => reject(new Error('should have aborted')), 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const start = Date.now();
    const { data, stale } = await runLiveWithTimeout(spec, snapshot, freshQc());
    const elapsed = Date.now() - start;

    expect(data).toBe(snapshot);
    expect(stale).toBe(false);
    // §3.1.4: bounded under 250ms
    expect(elapsed).toBeLessThan(250);
    expect(elapsed).toBeGreaterThanOrEqual(LIVE_REFRESH_TIMEOUT_MS - 20);
  });

  it('marks stale when live() returns null', async () => {
    const snapshot = { id: 'snap' };
    const spec = baseSpec<{ id: string }>(async () => null);

    const { data, stale } = await runLiveWithTimeout(spec, snapshot, freshQc());
    expect(data).toBe(snapshot);
    expect(stale).toBe(true);
  });

  it('returns snapshot (no throw) when live() throws', async () => {
    const snapshot = { id: 'snap' };
    const spec = baseSpec<{ id: string }>(async () => {
      throw new Error('boom');
    });

    const { data, stale } = await runLiveWithTimeout(spec, snapshot, freshQc());
    expect(data).toBe(snapshot);
    expect(stale).toBe(false);
  });

  it('returns snapshot when live() throws synchronously', async () => {
    const snapshot = { id: 'snap' };
    const spec: ContextTypeSpec<{ id: string }> = {
      ...baseSpec<{ id: string }>(() => {
        throw new Error('sync boom');
      }),
    };

    const { data, stale } = await runLiveWithTimeout(spec, snapshot, freshQc());
    expect(data).toBe(snapshot);
    expect(stale).toBe(false);
  });

  it('returns snapshot when no live loader is registered', async () => {
    const snapshot = { id: 'snap' };
    const spec: ContextTypeSpec<{ id: string }> = {
      type: 't',
      kind: 'ns:t',
      description: '',
      icon: '📎',
      label: () => 'label',
      identity: () => ({ id: 'x' }),
      format: () => 'x',
    };

    const { data, stale } = await runLiveWithTimeout(spec, snapshot, freshQc());
    expect(data).toBe(snapshot);
    expect(stale).toBe(false);
  });

  it('§3.1.5 aborts the signal on timeout — signal.aborted becomes true', async () => {
    const snapshot = { id: 'snap' };
    const qc = freshQc();

    let receivedSignal: AbortSignal | undefined;

    const spec = baseSpec<{ id: string }>(
      (_, { signal }) =>
        new Promise<{ id: string } | null>((_resolve, reject) => {
          receivedSignal = signal;
          const t = setTimeout(() => reject(new Error('not aborted')), 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const { data, stale } = await runLiveWithTimeout(spec, snapshot, qc);
    expect(data).toBe(snapshot);
    expect(stale).toBe(false);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
  });

  it('§3.1.5 signal passed to live() aborts the inner awaited promise', async () => {
    // The real spec.live uses queryClient.fetchQuery({ signal }). Inside
    // the timeout wrapper, the live() body awaits that call. When our
    // timeout fires and aborts the signal, any awaitable that listens for
    // abort rejects — which is what `fetchQuery({ signal })` does in
    // practice inside tanstack-query v5.
    //
    // This test simulates that exact chain without coupling to a tanstack
    // internal: a Promise inside live() that rejects on abort. We assert
    // the rejection fires and the wrapper still returns the snapshot.
    const qc = freshQc();
    const snapshot = { id: 'snap' };
    let rejectedAs: unknown;

    const spec = baseSpec<{ id: string }>(async (_, { signal }) => {
      try {
        await new Promise<{ id: string }>((_, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
        return null;
      } catch (err) {
        rejectedAs = err;
        throw err;
      }
    });

    const { data, stale } = await runLiveWithTimeout(spec, snapshot, qc);
    expect(data).toBe(snapshot);
    expect(stale).toBe(false);

    // Give the inner catch a microtask to record the rejection (race:
    // the wrapper returns first; the abort listener fires on the same
    // microtask queue).
    await new Promise((r) => setTimeout(r, 10));
    expect(rejectedAs).toBeDefined();
    expect((rejectedAs as DOMException).name).toBe('AbortError');
  });

  it('discards settled value if it arrives after signal.aborted', async () => {
    const snapshot = { id: 'snap' };
    const late = { id: 'late' };

    const spec = baseSpec<{ id: string }>((_, { signal }) => {
      // Resolve AFTER the timeout. Simulates a promise that races the
      // 200ms timer and loses.
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(late), LIVE_REFRESH_TIMEOUT_MS + 50);
        signal.addEventListener('abort', () => {
          // Even though we abort, we intentionally still resolve with `late`
          // to exercise the "discard late-arriving value" path.
          clearTimeout(t);
          setTimeout(() => resolve(late), 5);
        });
      });
    });

    const { data, stale } = await runLiveWithTimeout(spec, snapshot, freshQc());
    expect(data).toBe(snapshot);
    expect(stale).toBe(false);
  });

  it('accepts a synchronously-returned T (non-promise)', async () => {
    const snapshot = { id: 'snap' };
    const fresh = { id: 'sync-fresh' };
    const spec = baseSpec<{ id: string }>(() => fresh);

    const { data, stale } = await runLiveWithTimeout(spec, snapshot, freshQc());
    expect(data).toBe(fresh);
    expect(stale).toBe(false);
  });
});
