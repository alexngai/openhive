/**
 * Cascade ingestion rate-limit tests (E3 closure).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  consumeCascadeToken,
  getCascadeTokenCount,
  resetCascadeRateLimit,
  setCascadeRateLimitConfig,
} from '../../map/cascade-rate-limit.js';

describe('cascade rate-limit token bucket', () => {
  beforeEach(() => {
    resetCascadeRateLimit();
  });

  it('allows requests up to the configured capacity then rejects', () => {
    setCascadeRateLimitConfig({ capacity: 5, refillPerSecond: 0 });
    for (let i = 0; i < 5; i++) {
      expect(consumeCascadeToken('swarm-a'), `token ${i + 1}`).toBe(true);
    }
    expect(consumeCascadeToken('swarm-a')).toBe(false);
  });

  it('buckets are isolated per swarm', () => {
    setCascadeRateLimitConfig({ capacity: 2, refillPerSecond: 0 });
    expect(consumeCascadeToken('swarm-a')).toBe(true);
    expect(consumeCascadeToken('swarm-a')).toBe(true);
    expect(consumeCascadeToken('swarm-a')).toBe(false);
    // Different swarm still has a full bucket.
    expect(consumeCascadeToken('swarm-b')).toBe(true);
  });

  it('refills over time', async () => {
    setCascadeRateLimitConfig({ capacity: 1, refillPerSecond: 100 });
    expect(consumeCascadeToken('swarm-refill')).toBe(true);
    expect(consumeCascadeToken('swarm-refill')).toBe(false);
    // 20ms at 100/s refills 2 tokens — well over 1 needed.
    await new Promise((r) => setTimeout(r, 20));
    expect(consumeCascadeToken('swarm-refill')).toBe(true);
  });

  it('never exceeds capacity even with a long idle gap', async () => {
    setCascadeRateLimitConfig({ capacity: 3, refillPerSecond: 1000 });
    expect(consumeCascadeToken('swarm-cap')).toBe(true);
    await new Promise((r) => setTimeout(r, 30)); // would refill 30 tokens uncapped
    const tokensBefore = getCascadeTokenCount('swarm-cap')!;
    expect(tokensBefore).toBeLessThanOrEqual(3);
    // consume a token so we observe floor at 2 after refill
    consumeCascadeToken('swarm-cap');
    expect(getCascadeTokenCount('swarm-cap')!).toBeLessThanOrEqual(3);
  });

  it('lets unknown/empty swarm ids through without bucketing', () => {
    setCascadeRateLimitConfig({ capacity: 1, refillPerSecond: 0 });
    // 50 calls with "" should all pass — we can't bucket without an id.
    for (let i = 0; i < 50; i++) {
      expect(consumeCascadeToken('')).toBe(true);
    }
  });

  it('resetCascadeRateLimit() restores default config + clears buckets', () => {
    setCascadeRateLimitConfig({ capacity: 1, refillPerSecond: 0 });
    consumeCascadeToken('swarm-reset');
    expect(consumeCascadeToken('swarm-reset')).toBe(false);
    resetCascadeRateLimit();
    // Default capacity (400) is ample — first call succeeds.
    expect(consumeCascadeToken('swarm-reset')).toBe(true);
  });
});
