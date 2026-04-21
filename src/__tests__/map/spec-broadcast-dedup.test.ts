/**
 * Unit tests for the spec-broadcast-dedup helper.
 *
 * Covers:
 *   - First call returns true and records the timestamp
 *   - Second call within the window returns false
 *   - Distinct keys (different type / resource / spec) don't cross-suppress
 *   - Window expires so the same key broadcasts again later
 *   - Reset clears state cleanly
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  shouldBroadcastSpecEvent,
  _resetSpecBroadcastDedup,
} from '../../map/spec-broadcast-dedup.js';

beforeEach(() => {
  _resetSpecBroadcastDedup();
});

afterEach(() => {
  vi.useRealTimers();
  _resetSpecBroadcastDedup();
});

describe('shouldBroadcastSpecEvent', () => {
  it('returns true for the first call', () => {
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
  });

  it('suppresses a matching second call within the dedup window', () => {
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(false);
  });

  it('suppresses several matching calls in the window', () => {
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(false);
    }
  });

  it('does not suppress different event types for the same spec', () => {
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
    expect(shouldBroadcastSpecEvent('spec.updated', 'res_1', 'spec_1')).toBe(true);
  });

  it('does not suppress different resource ids', () => {
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
    expect(shouldBroadcastSpecEvent('spec.created', 'res_2', 'spec_1')).toBe(true);
  });

  it('does not suppress different spec ids', () => {
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_2')).toBe(true);
  });

  it('allows rebroadcast after the window elapses', () => {
    vi.useFakeTimers();
    const start = new Date('2026-04-21T12:00:00Z');
    vi.setSystemTime(start);

    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(false);

    // advance past the 2s window
    vi.setSystemTime(new Date(start.getTime() + 2500));

    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
  });

  it('reset clears state mid-window', () => {
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(false);
    _resetSpecBroadcastDedup();
    expect(shouldBroadcastSpecEvent('spec.created', 'res_1', 'spec_1')).toBe(true);
  });
});
