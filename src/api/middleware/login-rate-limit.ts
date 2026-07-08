/**
 * In-memory brute-force throttle for the password login endpoint.
 *
 * Counts FAILED attempts per key (client IP) in a fixed window; once the
 * threshold is exceeded, the key is blocked until the window elapses. A
 * successful login clears the key, so a legitimate operator is never locked out
 * for the occasional typo.
 *
 * In-memory + per-process — fine for a single-node self-hosted hub. Behind a
 * reverse proxy, configure Fastify `trustProxy` so `request.ip` is the real
 * client address rather than the proxy's.
 */

interface Bucket {
  failures: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface LoginThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  /** Injectable timestamp for deterministic tests; defaults to Date.now(). */
  now?: number;
}

/** Is this key currently blocked from attempting a login? */
export function isLoginRateLimited(
  key: string,
  opts: LoginThrottleOptions = {},
): { limited: boolean; retryAfterSec: number } {
  const max = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? Date.now();

  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    return { limited: false, retryAfterSec: 0 };
  }
  if (bucket.failures >= max) {
    return {
      limited: true,
      retryAfterSec: Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000)),
    };
  }
  return { limited: false, retryAfterSec: 0 };
}

/** Record a failed login attempt for this key. */
export function recordFailedLogin(key: string, opts: LoginThrottleOptions = {}): void {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? Date.now();

  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { failures: 1, windowStart: now });
  } else {
    bucket.failures += 1;
  }
}

/** Clear a key's failure count (call on a successful login). */
export function clearLoginAttempts(key: string): void {
  buckets.delete(key);
}

/** Test helper: wipe all throttle state. */
export function _resetLoginThrottle(): void {
  buckets.clear();
}
