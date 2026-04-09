/**
 * Tests for the stripPrefix logic in daemonGetGraph().
 *
 * The daemon client strips resource-prefixed IDs from edges
 * (e.g. "res_xxx:t-4iwf" → "t-4iwf") that may have been stored
 * by the multi-graph UI.
 */

import { describe, it, expect } from 'vitest';

/**
 * Extracted from daemonGetGraph() in src/map/task-daemon-client.ts.
 * The real function is inline inside a withDaemon() call, so we
 * replicate the exact logic here for unit testing.
 */
const stripPrefix = (id: string) => id.includes(':') ? id.split(':').pop()! : id;

describe('stripPrefix (edge ID prefix stripping)', () => {
  it('passes through IDs without a prefix unchanged', () => {
    expect(stripPrefix('t-4iwf')).toBe('t-4iwf');
  });

  it('passes through simple node IDs unchanged', () => {
    expect(stripPrefix('c-xy60')).toBe('c-xy60');
    expect(stripPrefix('abc123')).toBe('abc123');
  });

  it('strips a resource prefix from an edge ID', () => {
    expect(stripPrefix('res_abc123:t-4iwf')).toBe('t-4iwf');
  });

  it('strips a resource prefix from a context node ID', () => {
    expect(stripPrefix('res_abc:c-xy60')).toBe('c-xy60');
  });

  it('handles multiple colons by taking the last segment', () => {
    // If somehow a prefix contained a colon, split(':').pop() returns the last part
    expect(stripPrefix('res_a:res_b:t-99')).toBe('t-99');
  });

  it('handles empty string', () => {
    expect(stripPrefix('')).toBe('');
  });

  it('handles an ID that is just a colon', () => {
    expect(stripPrefix(':')).toBe('');
  });

  it('handles prefix with no trailing ID (edge case)', () => {
    expect(stripPrefix('res_abc:')).toBe('');
  });
});
