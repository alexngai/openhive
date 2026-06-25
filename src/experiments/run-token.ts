/**
 * Per-run worker tokens ([D6] option C).
 *
 * The hub launches the runner worker, so it mints a one-time token at run
 * creation, stores only its SHA-256 hash on the `experiment_runs` row, and
 * checks it on the three worker-write routes. Row-scoped (one run) and
 * ephemeral by construction — no ingest-key machinery, no new table.
 */

import { nanoid } from 'nanoid';
import { createHash, timingSafeEqual } from 'node:crypto';

export function hashRunToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mint a fresh worker token. The plaintext is returned once; only the hash is stored. */
export function mintRunToken(): { token: string; hash: string } {
  const token = `ohw_${nanoid(32)}`;
  return { token, hash: hashRunToken(token) };
}

/** Constant-time check of a presented token against a stored hash. */
export function verifyRunToken(token: string, hash: string): boolean {
  const presented = Buffer.from(hashRunToken(token));
  const expected = Buffer.from(hash);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
