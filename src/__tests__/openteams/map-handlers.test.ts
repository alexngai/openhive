/**
 * Layer 2 tests for `src/openteams/map-handlers.ts`.
 *
 * Covers the composed MAP `map/resources/list`/`get` dispatcher over the
 * `x-openteams/loadout` and `x-openteams/team` kinds, plus the lifecycle
 * emit hook that bridges to the SDK event bus. The store is the openteams
 * `InMemoryBundleStore` reference impl.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  bundleLoadout,
  resolveStandaloneLoadout,
  LOADOUT_RESOURCE_TYPE,
  TEAM_RESOURCE_TYPE,
} from 'openteams';
import type { LoadoutDefinition, MAPResource, BundleEvent } from 'openteams';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
  getOpenteamsMapHandlers,
  getOpenteamsResourceKinds,
  setOpenteamsBundleEmitter,
} from '../../openteams/map-handlers.js';

const SAMPLE_LOADOUT: LoadoutDefinition = {
  name: 'l2-test',
  capabilities: ['file.read'],
  permissions: { deny: ['Bash(git push:*)'] },
  prompt_addendum: 'be careful',
};

const ctx = { callerId: null, session: {} };

function makeLoadoutBundle(name = 'l2-test'): MAPResource {
  const resolved = resolveStandaloneLoadout({ ...SAMPLE_LOADOUT, name } as LoadoutDefinition);
  return bundleLoadout(resolved, { version: '0.0.0', name }) as unknown as MAPResource;
}

describe('openteams map-handlers', () => {
  beforeEach(() => {
    _resetOpenteamsMapHandlers();
  });

  it('advertises both openteams resource kinds', () => {
    expect(getOpenteamsResourceKinds()).toEqual([
      LOADOUT_RESOURCE_TYPE,
      TEAM_RESOURCE_TYPE,
    ]);
  });

  it('store singleton survives across handler accesses', () => {
    const store1 = getOpenteamsBundleStore();
    // Compose handlers, then access store again — must be the same instance.
    getOpenteamsMapHandlers();
    const store2 = getOpenteamsBundleStore();
    expect(store1).toBe(store2);
  });

  it('map/resources/get returns a stored loadout bundle', async () => {
    const store = getOpenteamsBundleStore();
    const bundle = makeLoadoutBundle();
    await store.put(bundle);

    const { handlers } = getOpenteamsMapHandlers();
    const result = (await handlers['map/resources/get']!(
      { type: LOADOUT_RESOURCE_TYPE, id: bundle.id },
      ctx,
    )) as MAPResource;
    expect(result.id).toBe(bundle.id);
    expect(result.id).toMatch(/^sha256:/);
  });

  it('map/resources/list returns all stored bundles of a type', async () => {
    const store = getOpenteamsBundleStore();
    await store.put(makeLoadoutBundle('alpha'));
    await store.put(makeLoadoutBundle('beta'));

    const { handlers } = getOpenteamsMapHandlers();
    const result = (await handlers['map/resources/list']!(
      { type: LOADOUT_RESOURCE_TYPE },
      ctx,
    )) as { resources: MAPResource[] };
    expect(result.resources).toHaveLength(2);
    expect(result.resources.every((r) => r.type === LOADOUT_RESOURCE_TYPE)).toBe(true);
  });

  it('throws ResourceNotFoundError for missing get of a known type', async () => {
    const { handlers } = getOpenteamsMapHandlers();
    await expect(
      handlers['map/resources/get']!(
        { type: LOADOUT_RESOURCE_TYPE, id: 'sha256:does-not-exist' },
        ctx,
      ),
    ).rejects.toThrow(/Not found/);
  });

  it('throws UnknownResourceTypeError for an unregistered type (no fallback)', async () => {
    const { handlers } = getOpenteamsMapHandlers();
    await expect(
      handlers['map/resources/get']!({ type: 'x-host/repo', id: 'rid' }, ctx),
    ).rejects.toThrow(/No handler registered/);
  });

  it('hash stability: same content bundled twice yields the same id', () => {
    const a = makeLoadoutBundle();
    const b = makeLoadoutBundle();
    expect(a.id).toBe(b.id);
  });

  it('emits resource.added on first publish, resource.updated on republish', async () => {
    const events: BundleEvent[] = [];
    setOpenteamsBundleEmitter((e) => events.push(e));

    const { handlers } = getOpenteamsMapHandlers();
    const bundle = makeLoadoutBundle();

    // First publish.
    await handlers[`${LOADOUT_RESOURCE_TYPE}/publish`]!({ bundle }, ctx);
    // Republish (same hash; existed in store → updated).
    await handlers[`${LOADOUT_RESOURCE_TYPE}/publish`]!({ bundle }, ctx);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('resource.added');
    expect(events[1].type).toBe('resource.updated');
  });

  it('emits resource.removed when a stored bundle is removed', async () => {
    const events: BundleEvent[] = [];
    setOpenteamsBundleEmitter((e) => events.push(e));

    const { handlers } = getOpenteamsMapHandlers();
    const bundle = makeLoadoutBundle();
    await handlers[`${LOADOUT_RESOURCE_TYPE}/publish`]!({ bundle }, ctx);

    const result = (await handlers[`${LOADOUT_RESOURCE_TYPE}/remove`]!(
      { id: bundle.id },
      ctx,
    )) as { removed: boolean };
    expect(result.removed).toBe(true);

    const removedEvents = events.filter((e) => e.type === 'resource.removed');
    expect(removedEvents).toHaveLength(1);
    expect(removedEvents[0].resource_id).toBe(bundle.id);
  });
});
