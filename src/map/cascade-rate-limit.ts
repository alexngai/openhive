/**
 * Per-swarm rate limiting for cascade event ingestion.
 *
 * Token-bucket keyed by `source_swarm_id`. Protects the hub from a buggy or
 * misbehaving sidecar that emits `x-cascade/*` events at an unreasonable
 * rate. Real workloads fire at a human-scale pace (one stream.committed
 * per git commit, one stream.merged per mergeStream call, etc.), so the
 * default budget is generous enough to never limit legitimate work.
 *
 * Implementation notes:
 * - In-process only; OpenHive doesn't run multi-replica hubs today.
 * - Buckets are lazily created and never evicted. The memory cost is one
 *   small object per swarm the hub has ever seen; acceptable for the
 *   current operator footprint.
 * - Enforcement is at dispatch time — before the handler touches the DB —
 *   so rejection is cheap and doesn't partially project events.
 */

export interface CascadeRateLimitConfig {
  /** Max tokens the bucket can hold (burst capacity). Default: 400. */
  capacity: number;
  /** Tokens replenished per second. Default: 200. */
  refillPerSecond: number;
}

const DEFAULT_CONFIG: CascadeRateLimitConfig = {
  capacity: 400,
  refillPerSecond: 200,
};

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();
let activeConfig: CascadeRateLimitConfig = DEFAULT_CONFIG;

/** Override the rate-limit settings (tests / operator config). */
export function setCascadeRateLimitConfig(config: Partial<CascadeRateLimitConfig>): void {
  activeConfig = { ...activeConfig, ...config };
}

/** Reset all buckets + restore default config. Intended for tests. */
export function resetCascadeRateLimit(): void {
  buckets.clear();
  activeConfig = DEFAULT_CONFIG;
}

/**
 * Consume one token for `swarmId`. Returns `true` if allowed, `false` if
 * the bucket is empty. Callers should translate `false` into a JSON-RPC
 * error to the sidecar so the runtime can back off.
 */
export function consumeCascadeToken(swarmId: string): boolean {
  if (!swarmId) return true; // can't bucket an unknown swarm; let it through
  const now = Date.now();
  let bucket = buckets.get(swarmId);
  if (!bucket) {
    bucket = { tokens: activeConfig.capacity, lastRefillMs: now };
    buckets.set(swarmId, bucket);
  }
  // Refill based on elapsed time.
  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  if (elapsedSec > 0) {
    bucket.tokens = Math.min(
      activeConfig.capacity,
      bucket.tokens + elapsedSec * activeConfig.refillPerSecond,
    );
    bucket.lastRefillMs = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Inspect the current token count for a swarm (tests / observability). */
export function getCascadeTokenCount(swarmId: string): number | null {
  const b = buckets.get(swarmId);
  return b ? b.tokens : null;
}
