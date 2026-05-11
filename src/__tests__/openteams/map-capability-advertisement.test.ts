/**
 * Capability advertisement coverage — gap H.
 *
 * Verifies that the openteams kinds (`x-openteams/loadout`,
 * `x-openteams/team`) are exposed through both the openhive accessor
 * surface and the composed JSON-RPC method-handler map that gets
 * registered on the MAP server's `additionalHandlers`.
 *
 * A full wire-level test would stand up a connected MAP client and
 * inspect `serverCapabilities`; that requires the SDK's `TestServer`
 * harness which doesn't expose `capabilities.resources.kinds` end-to-end
 * yet. This test asserts the contract at the layer openhive controls —
 * the surface the MAP server config consumes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LOADOUT_RESOURCE_TYPE, TEAM_RESOURCE_TYPE } from 'openteams';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsMapHandlers,
  getOpenteamsResourceKinds,
} from '../../openteams/map-handlers.js';

describe('openteams capability advertisement', () => {
  beforeEach(() => {
    _resetOpenteamsMapHandlers();
  });

  it('exposes both kinds via getOpenteamsResourceKinds()', () => {
    const kinds = getOpenteamsResourceKinds();
    expect(kinds).toContain(LOADOUT_RESOURCE_TYPE);
    expect(kinds).toContain(TEAM_RESOURCE_TYPE);
  });

  it('composes the standard map/resources/{list,get} methods', () => {
    const { handlers } = getOpenteamsMapHandlers();
    expect(typeof handlers['map/resources/list']).toBe('function');
    expect(typeof handlers['map/resources/get']).toBe('function');
  });

  it('exposes per-kind publish methods', () => {
    const { handlers } = getOpenteamsMapHandlers();
    expect(typeof handlers[`${LOADOUT_RESOURCE_TYPE}/publish`]).toBe('function');
    expect(typeof handlers[`${TEAM_RESOURCE_TYPE}/publish`]).toBe('function');
  });

  it('exposes per-kind remove methods', () => {
    const { handlers } = getOpenteamsMapHandlers();
    expect(typeof handlers[`${LOADOUT_RESOURCE_TYPE}/remove`]).toBe('function');
    expect(typeof handlers[`${TEAM_RESOURCE_TYPE}/remove`]).toBe('function');
  });

  it('exposes the composed kinds list verbatim', () => {
    const { kinds } = getOpenteamsMapHandlers();
    expect(kinds).toEqual([LOADOUT_RESOURCE_TYPE, TEAM_RESOURCE_TYPE]);
  });

  it('handler map and kinds list agree on registered types', () => {
    const composed = getOpenteamsMapHandlers();
    for (const kind of composed.kinds) {
      expect(composed.handlers[`${kind}/publish`]).toBeDefined();
      expect(composed.handlers[`${kind}/remove`]).toBeDefined();
    }
  });
});
