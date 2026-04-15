/**
 * Tests for capability aggregation and per-agent capability tracking.
 *
 * Validates that when multiple agents register on the same connection,
 * their capabilities are tracked separately and aggregated correctly
 * for the swarm-level view (union / most-permissive).
 */
import { describe, it, expect } from 'vitest';

// Replicate the aggregation logic from connection-registry.ts for unit testing.

function aggregateCapabilities(sources: Array<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const existing = result[key];

      if (key === 'protocols' && Array.isArray(value)) {
        const merged = new Set([
          ...(Array.isArray(existing) ? existing as string[] : []),
          ...value as string[],
        ]);
        result[key] = [...merged];
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const existingObj = (existing && typeof existing === 'object' && !Array.isArray(existing))
          ? existing as Record<string, unknown>
          : {};
        const merged: Record<string, unknown> = { ...existingObj };
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (v === true || merged[k] === undefined) {
            merged[k] = v;
          }
        }
        result[key] = merged;
      } else if (value === true || existing === undefined) {
        result[key] = value;
      }
    }
  }

  return result;
}

function checkPath(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current === true;
}

describe('capability aggregation', () => {
  it('aggregates two agents with non-overlapping capabilities', () => {
    const result = aggregateCapabilities([
      { trajectory: { canReport: true, canServeContent: true } },
      { mail: { canCreate: true, canJoin: true } },
    ]);
    expect(result.trajectory).toEqual({ canReport: true, canServeContent: true });
    expect(result.mail).toEqual({ canCreate: true, canJoin: true });
  });

  it('aggregates overlapping object capabilities with true-wins', () => {
    const result = aggregateCapabilities([
      { messaging: { canSend: true, canReceive: false } },
      { messaging: { canReceive: true, canBroadcast: true } },
    ]);
    expect(result.messaging).toEqual({ canSend: true, canReceive: true, canBroadcast: true });
  });

  it('unions protocol arrays', () => {
    const result = aggregateCapabilities([
      { protocols: ['acp'] },
      { protocols: ['mcp', 'acp'] },
    ]);
    const protocols = result.protocols as string[];
    expect(protocols).toContain('acp');
    expect(protocols).toContain('mcp');
    expect(protocols).toHaveLength(2);
  });

  it('handles single source unchanged', () => {
    const source = { messaging: { canSend: true }, mail: { canCreate: true } };
    const result = aggregateCapabilities([source]);
    expect(result).toEqual(source);
  });

  it('handles empty sources', () => {
    const result = aggregateCapabilities([{}, {}]);
    expect(result).toEqual({});
  });
});

describe('hasCapability (path-based check)', () => {
  it('finds a nested boolean capability', () => {
    const caps = { trajectory: { canServeContent: true } };
    expect(checkPath(caps, 'trajectory.canServeContent')).toBe(true);
  });

  it('rejects false capability', () => {
    const caps = { trajectory: { canServeContent: false } };
    expect(checkPath(caps, 'trajectory.canServeContent')).toBe(false);
  });

  it('rejects missing capability', () => {
    const caps = { trajectory: { canReport: true } };
    expect(checkPath(caps, 'trajectory.canServeContent')).toBe(false);
  });

  it('rejects missing namespace', () => {
    const caps = { messaging: { canSend: true } };
    expect(checkPath(caps, 'mail.canJoin')).toBe(false);
  });

  it('handles single-level path', () => {
    // This doesn't make sense for booleans at top-level objects, but test it anyway
    const caps = { observation: true };
    expect(checkPath(caps, 'observation')).toBe(true);
  });
});

describe('per-agent capability tracking', () => {
  it('cc-swarm sidecar + sub-agent stay separate', () => {
    const sidecar = {
      messaging: { canSend: true, canReceive: true },
      mail: { canCreate: true, canJoin: true, canViewHistory: true },
      trajectory: { canReport: true, canServeContent: true },
    };
    const subagent = {
      trajectory: { canReport: true },
    };

    // Per-agent: sidecar has mail, sub-agent doesn't
    expect(checkPath(sidecar, 'mail.canJoin')).toBe(true);
    expect(checkPath(subagent, 'mail.canJoin')).toBe(false);

    // Aggregate: mail is present (from sidecar)
    const aggregate = aggregateCapabilities([sidecar, subagent]);
    expect(checkPath(aggregate, 'mail.canJoin')).toBe(true);
    // trajectory.canServeContent from sidecar survives
    expect(checkPath(aggregate, 'trajectory.canServeContent')).toBe(true);
  });

  it('macro-agent sidecar + ACP agent stay separate', () => {
    const sidecar = {
      messaging: { canSend: true, canReceive: true },
      mail: { canCreate: true, canJoin: true },
      protocols: ['acp'],
      acp: { version: '2024-10-07' },
      trajectory: { canReport: true },
    };
    const worker = {
      trajectory: { canReport: true },
      observation: { canObserve: true },
    };

    // Per-agent: only sidecar has ACP
    expect(checkPath(sidecar, 'mail.canJoin')).toBe(true);
    expect(checkPath(worker, 'mail.canJoin')).toBe(false);

    // Aggregate: both protocols and observation present
    const aggregate = aggregateCapabilities([sidecar, worker]);
    expect((aggregate.protocols as string[])).toContain('acp');
    expect(checkPath(aggregate, 'observation.canObserve')).toBe(true);
    expect(checkPath(aggregate, 'mail.canJoin')).toBe(true);
  });
});
