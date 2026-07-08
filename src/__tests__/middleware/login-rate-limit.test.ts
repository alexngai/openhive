import { describe, it, expect, beforeEach } from 'vitest';
import {
  isLoginRateLimited,
  recordFailedLogin,
  clearLoginAttempts,
  _resetLoginThrottle,
} from '../../api/middleware/login-rate-limit.js';

describe('login rate limit', () => {
  beforeEach(() => _resetLoginThrottle());

  it('allows attempts under the failure threshold', () => {
    const opts = { maxFailures: 3, windowMs: 60_000, now: 0 };
    expect(isLoginRateLimited('ip', opts).limited).toBe(false);
    recordFailedLogin('ip', opts);
    recordFailedLogin('ip', opts);
    expect(isLoginRateLimited('ip', opts).limited).toBe(false);
  });

  it('blocks once failures reach the threshold, with a Retry-After', () => {
    const opts = { maxFailures: 3, windowMs: 60_000, now: 1_000 };
    recordFailedLogin('ip', opts);
    recordFailedLogin('ip', opts);
    recordFailedLogin('ip', opts);
    const r = isLoginRateLimited('ip', opts);
    expect(r.limited).toBe(true);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it('resets after the window elapses', () => {
    const win = { maxFailures: 1, windowMs: 1_000, now: 0 };
    recordFailedLogin('ip', win);
    recordFailedLogin('ip', win);
    expect(isLoginRateLimited('ip', { ...win, now: 500 }).limited).toBe(true);
    expect(isLoginRateLimited('ip', { ...win, now: 1_500 }).limited).toBe(false);
  });

  it('a successful login (clearLoginAttempts) unblocks the key', () => {
    const opts = { maxFailures: 1, windowMs: 60_000, now: 0 };
    recordFailedLogin('ip', opts);
    recordFailedLogin('ip', opts);
    expect(isLoginRateLimited('ip', opts).limited).toBe(true);
    clearLoginAttempts('ip');
    expect(isLoginRateLimited('ip', opts).limited).toBe(false);
  });

  it('tracks keys (IPs) independently', () => {
    const opts = { maxFailures: 1, windowMs: 60_000, now: 0 };
    recordFailedLogin('a', opts);
    recordFailedLogin('a', opts);
    expect(isLoginRateLimited('a', opts).limited).toBe(true);
    expect(isLoginRateLimited('b', opts).limited).toBe(false);
  });
});
