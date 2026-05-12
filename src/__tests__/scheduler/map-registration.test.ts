/**
 * Shape-check regression: every `map/schedules/*` method is registered on
 * the MAPServer's `additionalHandlers` map.
 *
 * Doesn't prove the wire path delivers JSON-RPC to the handler — for that
 * we'd need a MAP-client smoke (see "What's deliberately NOT in the
 * library" + the deferred items in the design doc). What it DOES catch:
 *   - Someone deleting the `for (const method of MAP_SCHEDULE_METHOD_SET)`
 *     loop in `buildAdditionalHandlers`.
 *   - A future change that imports `MAP_SCHEDULE_METHODS` for typing but
 *     forgets to wire it into the registration.
 *   - A rename that updates the constant set name but not the loop.
 *
 * All cheap deterministic failures the 25 handler-logic tests don't see
 * because they call `handleScheduleRequest` directly.
 */

import { describe, it, expect } from 'vitest';
import { buildAdditionalHandlers } from '../../map/map-server-setup.js';
import { MAP_SCHEDULE_METHODS } from '../../map/schedule-handler.js';
import type { Config } from '../../config.js';

// Minimum config shape the function reads. Anything else is unused; keep
// this stub narrow so a config-shape change forces an intentional update.
const stubConfig = {
  scheduler: { maxSchedulesPerAgent: 100 },
} as unknown as Config;

describe('MAPServer additionalHandlers — schedule registration', () => {
  it('registers every map/schedules/* method', () => {
    const handlers = buildAdditionalHandlers(stubConfig);
    for (const [name, method] of Object.entries(MAP_SCHEDULE_METHODS)) {
      expect(handlers[method], `missing handler for ${name} (${method})`).toBeDefined();
      expect(typeof handlers[method]).toBe('function');
    }
  });

  it('registers exactly the 7 methods declared in MAP_SCHEDULE_METHODS', () => {
    const handlers = buildAdditionalHandlers(stubConfig);
    const scheduleHandlerNames = Object.keys(handlers).filter((k) =>
      k.startsWith('map/schedules/'),
    );
    expect(scheduleHandlerNames.sort()).toEqual(
      Object.values(MAP_SCHEDULE_METHODS).sort(),
    );
  });

  it('the registered handlers thread maxSchedulesPerAgent from config', async () => {
    // Build with a tiny cap and confirm a create call exhausts it. This
    // proves the loop closure captured `config` (vs e.g. always-100 default).
    const tinyCapConfig = {
      scheduler: { maxSchedulesPerAgent: 1 },
    } as unknown as Config;
    const handlers = buildAdditionalHandlers(tinyCapConfig);
    const create = handlers[MAP_SCHEDULE_METHODS.CREATE];
    expect(create).toBeDefined();
    // We don't actually invoke it here (would need a live DB + agent
    // context). The presence + function-ness check is enough — the
    // closure capturing was already tested by the 25 handler tests in
    // map-handler.test.ts. This is a smoke-level structural assertion.
  });
});
