import { describe, it, expect } from 'vitest';
import { resolveMapTrustModel } from '../../map/trust-model.js';

describe('resolveMapTrustModel (3c migration guard)', () => {
  it('defaults a NEW hub (no agents) to verified', () => {
    expect(resolveMapTrustModel(undefined, 0)).toEqual({ trustModel: 'verified', migrated: false });
  });

  it('grandfathers an EXISTING hub (has agents) to open, flagged as migrated', () => {
    expect(resolveMapTrustModel(undefined, 1)).toEqual({ trustModel: 'open', migrated: true });
    expect(resolveMapTrustModel(undefined, 42)).toEqual({ trustModel: 'open', migrated: true });
  });

  it('an explicit config value always wins, regardless of agent count', () => {
    expect(resolveMapTrustModel('verified', 0)).toEqual({ trustModel: 'verified', migrated: false });
    expect(resolveMapTrustModel('verified', 99)).toEqual({ trustModel: 'verified', migrated: false });
    expect(resolveMapTrustModel('open', 0)).toEqual({ trustModel: 'open', migrated: false });
    expect(resolveMapTrustModel('open', 99)).toEqual({ trustModel: 'open', migrated: false });
  });
});
