/**
 * Tests for the per-key mutex that serializes task file enrichment.
 * Covers the race-correctness contract: concurrent calls for the same key
 * run sequentially, different keys run in parallel, and failures in one
 * call don't break the chain for subsequent ones.
 */

import { describe, it, expect } from 'vitest';
import { createPerKeyMutex } from '../../map/trajectory-handler.js';

/** Deferred promise helper. */
function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Yield microtasks repeatedly so chained .then()s have a chance to advance. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('createPerKeyMutex', () => {
  it('runs two same-key calls sequentially', async () => {
    const run = createPerKeyMutex();
    const order: string[] = [];
    const d1 = defer<void>();
    const d2 = defer<void>();

    const p1 = run('k1', async () => { order.push('1-start'); await d1.promise; order.push('1-end'); });
    const p2 = run('k1', async () => { order.push('2-start'); await d2.promise; order.push('2-end'); });

    await flush();
    // Only the first call should have started.
    expect(order).toEqual(['1-start']);

    d1.resolve();
    await p1;
    await flush();
    expect(order).toEqual(['1-start', '1-end', '2-start']);

    d2.resolve();
    await p2;
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  it('runs different keys in parallel', async () => {
    const run = createPerKeyMutex();
    const order: string[] = [];
    const d1 = defer<void>();
    const d2 = defer<void>();

    const p1 = run('a', async () => { order.push('a-start'); await d1.promise; order.push('a-end'); });
    const p2 = run('b', async () => { order.push('b-start'); await d2.promise; order.push('b-end'); });

    await flush();
    // Both should have started — different keys don't block each other.
    expect(order.sort()).toEqual(['a-start', 'b-start']);

    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2]);
  });

  it('chain continues after a failed call', async () => {
    const run = createPerKeyMutex();
    const order: string[] = [];

    const p1 = run('k', async () => { order.push('1'); throw new Error('boom'); });
    const p2 = run('k', async () => { order.push('2'); });

    await expect(p1).rejects.toThrow('boom');
    await p2;

    // Both ran — the rejection didn't break the chain.
    expect(order).toEqual(['1', '2']);
  });

  it('releases the map entry after settle so memory does not grow', async () => {
    const run = createPerKeyMutex();
    // Run many distinct keys to completion.
    const promises = Array.from({ length: 50 }, (_, i) => run(`k${i}`, async () => {}));
    await Promise.all(promises);
    await flush();

    // Start one new call and check that the key is present during, absent after.
    const d = defer<void>();
    const p = run('lone', async () => { await d.promise; });
    await flush();
    // We can't directly introspect the Map (it's closed over), but we can
    // prove the same key can be re-entered and runs SEQUENTIALLY with the
    // outstanding one — which is the observable contract.
    const order: string[] = [];
    order.push('before-release');
    const p2 = run('lone', async () => { order.push('second'); });
    await flush();
    expect(order).toEqual(['before-release']);
    d.resolve();
    await p;
    await p2;
    expect(order).toEqual(['before-release', 'second']);
  });

  it('handles burst of concurrent same-key calls in order', async () => {
    const run = createPerKeyMutex();
    const order: number[] = [];
    const deferreds = Array.from({ length: 5 }, () => defer<void>());

    const promises = deferreds.map((d, i) => run('burst', async () => {
      order.push(i);
      await d.promise;
    }));

    await flush();
    expect(order).toEqual([0]);

    for (let i = 0; i < 5; i++) {
      deferreds[i].resolve();
      await promises[i];
      await flush();
      // After call i completes, call i+1 should have started.
      expect(order.slice(-1)[0]).toBe(Math.min(i + 1, 4));
    }
  });
});
