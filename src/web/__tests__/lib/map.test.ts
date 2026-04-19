import { describe, it, expect } from 'vitest';
import { getPeerMapId } from '../../lib/map';

describe('web/lib/map — getPeerMapId', () => {
  it('prefers peerMapId', () => {
    expect(
      getPeerMapId({
        peerMapId: 'map-ulid',
        peerAgentId: 'internal',
        localAgentId: 'legacy',
      }),
    ).toBe('map-ulid');
  });

  it('falls back to peerAgentId when peerMapId is missing', () => {
    expect(getPeerMapId({ peerAgentId: 'internal' })).toBe('internal');
  });

  it('falls back to localAgentId for pre-migration payloads', () => {
    expect(getPeerMapId({ localAgentId: 'legacy' })).toBe('legacy');
  });

  it('returns undefined for empty metadata', () => {
    expect(getPeerMapId(undefined)).toBeUndefined();
    expect(getPeerMapId({})).toBeUndefined();
  });

  it('returns undefined when no recognized field is present', () => {
    expect(getPeerMapId({ systemId: 'sys-1', type: 'swarm' })).toBeUndefined();
  });

  it('ignores non-string values and falls through', () => {
    expect(
      getPeerMapId({
        peerMapId: 42 as unknown as string,
        peerAgentId: 'internal',
      }),
    ).toBe('internal');
    expect(getPeerMapId({ peerMapId: '' })).toBeUndefined();
  });
});
