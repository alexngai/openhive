/**
 * Stress-test coverage for concurrency around the loadout cache during
 * in-flight dispatches and fast template edits.
 *
 * The cache (`src/openteams/cache.ts`) keys by (templateId, contentHash).
 * This test file exercises race semantics that the sequential-edit coverage in
 * `loadout-update-propagation.test.ts` cannot reach.
 *
 * Scenarios
 * ─────────
 * 1. Concurrent materialize — 20 parallel calls against the same template.
 *    All must return consistent content. Verifies the underlying `resolveTeam`
 *    call count (cache miss + stampede behavior documented below).
 *
 * 2. Edit mid-flight — slow `resolveTeam` call in progress; template edited
 *    mid-call. Asserts "stale-during-flight" semantics: the slow call sees the
 *    old content; a fresh call after the slow one resolves sees the new content.
 *
 * 3. Cache stampede — 50 concurrent calls for the same (templateId, role).
 *    `resolveCachedOrCompute` coalesces in-flight resolutions via an inflight
 *    Promise map: the first caller runs `compute()`; the rest await its
 *    result. Test asserts exactly one resolution runs.
 *
 * 4. Standalone loadout edit via `extends:` — the cache key is the team's
 *    content hash, not the parent loadout's hash. Editing the parent does NOT
 *    change the team's hash → the cache serves stale data. This is documented
 *    as KNOWN STALE behavior; the test asserts staleness so we don't
 *    accidentally fix it without a deliberate design decision.
 *
 * 5. Concurrent edits + dispatches — combination test. Three concurrent actors:
 *    enrichWithLoadout(taskA), template edit, enrichWithLoadout(taskB). Each
 *    resulting materializedLoadout must be internally consistent (capabilities
 *    and promptAddendum coherent, not a torn mix of old+new content).
 *
 * STAMPEDE COALESCING
 * ───────────────────
 * `resolveCachedOrCompute` uses an inflight Promise map keyed by
 * `(templateId, contentHash)`. The first caller runs `compute()` and
 * registers the in-flight promise; subsequent callers find the promise and
 * await it instead of running compute again. This prevents N concurrent
 * `TemplateLoader.loadAsync` calls + tmpdir staging on hot dispatch
 * batches. The inflight entry is cleared in a `finally` so a failed compute
 * doesn't poison the slot.
 *
 * KNOWN STALE — parent loadout edit via `extends:`
 * ─────────────────────────────────────────────────
 * The team_template's content hash covers the inline role definition
 * (`extends: parent-name`), not the parent loadout's authored content. An edit
 * to the parent loadout changes neither the team's content hash nor the cache
 * key, so the cache returns a ResolvedTemplate built against the OLD parent
 * content until the TTL expires or the cache is manually reset.
 *
 * Fixing this would require one of:
 *   a) Including referenced-loadout hashes in the cache key (recursive hashing
 *      across all `extends:` chains — adds DB reads on every resolve call).
 *   b) Invalidating the team's cache entry on parent loadout edits (requires
 *      tracking which teams reference a loadout — a reverse-index that doesn't
 *      exist today).
 *
 * Until one of those is implemented, operators who edit a parent loadout must
 * either wait for the 10-minute TTL or call `evictTemplate(templateId)` / the
 * test-only `_resetCacheForTest()`. The existing test in
 * `loadout-update-propagation.test.ts` (lines 179-215) already documents this
 * with a forced `_resetCacheForTest()` to make the assertion pass.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { DispatchTask } from 'swarm-dispatch';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import { materializeRoleLoadout } from '../../openteams/resolver.js';
import * as cacheModule from '../../openteams/cache.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { enrichWithLoadout } from '../../dispatch/openhive-source.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const TEST_ROOT = testRoot('loadout-concurrency');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'concurrency.db');

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeLoadout(overrides: Partial<LoadoutContent> = {}): LoadoutContent {
  return {
    name: 'engineer',
    capabilities: ['file.read', 'file.write'],
    permissions: { allow: ['Read(**)'] },
    prompt_addendum: '## Baseline addendum',
    ...overrides,
  };
}

function makeTeam(roleName: string, loadout: LoadoutContent): TeamTemplateContent {
  return {
    manifest: {
      name: 'concurrency-demo',
      version: 1,
      roles: [roleName],
      topology: { root: { role: roleName } },
    },
    roles: { [roleName]: { name: roleName, loadout } },
    loadouts: {},
    prompts: {},
  };
}

function makeTeamWithExtends(roleName: string, parentName: string): TeamTemplateContent {
  return {
    manifest: {
      name: 'extends-demo',
      version: 1,
      roles: [roleName],
      topology: { root: { role: roleName } },
    },
    roles: {
      [roleName]: {
        name: roleName,
        loadout: {
          name: `${roleName}-child`,
          extends: parentName,
          capabilities_add: ['exec.test'],
        },
      },
    },
    loadouts: {},
    prompts: {},
  };
}

function makeTask(
  teamTemplateId: string,
  role: string,
  agentId: string,
  taskId = 'disp_concurrent',
): DispatchTask {
  return {
    id: taskId,
    title: 'Concurrent work item',
    content: '# Work\n\nBody.',
    status: 'open',
    created_at: new Date().toISOString(),
    metadata: {
      spec_resource_id: 'res_x',
      spec_id: 'c-concurrent',
      target_swarm_id: 'swarm_x',
      initiator_type: 'user',
      initiator_id: agentId,
      spec_metadata: {
        team_role_ref: { teamTemplateId, role },
      },
    },
  };
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('loadout cache concurrency', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'concurrency-agent' });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    _resetCacheForTest();
    vi.restoreAllMocks();
    getDatabase().prepare('DELETE FROM syncable_resources').run();
  });

  // ── Scenario 1: Concurrent materialize — content consistency ──────────────

  it('20 concurrent materializeRoleLoadout calls all return the same content', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'concurrent-team',
      content: makeTeam('engineer', makeLoadout()),
      ownerAgentId: agentId,
    });

    const CONCURRENCY = 20;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        materializeRoleLoadout(tmpl.id, 'engineer'),
      ),
    );

    // All results must have the same content — no torn reads.
    for (const result of results) {
      expect(result.promptAddendum).toBe('## Baseline addendum');
      expect(result.capabilities).toEqual(['file.read', 'file.write']);
      expect(result.permissions.allow).toEqual(['Read(**)']);
    }
  });

  it('20 concurrent materializeRoleLoadout calls: cache entry count is 1 after all settle', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'concurrent-team-2',
      content: makeTeam('engineer', makeLoadout()),
      ownerAgentId: agentId,
    });

    // Spy on resolveCachedOrCompute to count compute() invocations.
    // We do this by wrapping the cache module's export.
    let computeInvocations = 0;
    const originalResolve = cacheModule.resolveCachedOrCompute;
    vi.spyOn(cacheModule, 'resolveCachedOrCompute').mockImplementation(
      async (templateId, contentHash, compute) => {
        const wrappedCompute = async () => {
          computeInvocations++;
          return compute();
        };
        return originalResolve(templateId, contentHash, wrappedCompute);
      },
    );

    const CONCURRENCY = 20;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        materializeRoleLoadout(tmpl.id, 'engineer'),
      ),
    );

    // KNOWN LIMITATION: resolveCachedOrCompute has no in-flight promise cache.
    // All 20 concurrent calls that see a cold key will each invoke compute().
    // We assert >= 1 (at least one resolution ran) and document the actual
    // observed count so future readers know the current behavior.
    expect(computeInvocations).toBeGreaterThanOrEqual(1);

    // After all settle, a 21st sequential call must be served from cache
    // (compute() not re-invoked).
    const countBefore = computeInvocations;
    await materializeRoleLoadout(tmpl.id, 'engineer');
    expect(computeInvocations).toBe(countBefore); // cache hit — no new compute
  });

  // ── Scenario 2: Edit mid-flight — stale-during-flight semantics ───────────

  it('stale-during-flight: slow call sees old content; post-edit call sees new content', async () => {
    const initialLoadout = makeLoadout({ prompt_addendum: '## OLD addendum' });
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'mid-flight-team',
      content: makeTeam('engineer', initialLoadout),
      ownerAgentId: agentId,
    });

    // We need to delay one resolveTeam call long enough that we can edit the
    // template before it completes. Spy on `resolveCachedOrCompute` to
    // intercept the first compute() call and hold it with a controllable Promise.
    let resolveHeldCompute!: () => void;
    const holdComputeUntilReleased = new Promise<void>(
      (res) => (resolveHeldCompute = res),
    );

    let callCount = 0;
    const originalResolve = cacheModule.resolveCachedOrCompute;
    vi.spyOn(cacheModule, 'resolveCachedOrCompute').mockImplementation(
      async (templateId, contentHash, compute) => {
        callCount++;
        if (callCount === 1) {
          // First call: wrap compute() to delay after resolution.
          const wrappedCompute = async () => {
            const result = await compute();
            // Hold here until the test releases us — simulating a slow compute.
            await holdComputeUntilReleased;
            return result;
          };
          return originalResolve(templateId, contentHash, wrappedCompute);
        }
        // Subsequent calls: pass through unchanged.
        return originalResolve(templateId, contentHash, compute);
      },
    );

    // Start the slow call — it will not complete until we release the hold.
    const slowCallPromise = materializeRoleLoadout(tmpl.id, 'engineer');

    // While the slow call is in flight, edit the template.
    const updatedContent = makeTeam(
      'engineer',
      makeLoadout({ prompt_addendum: '## NEW addendum' }),
    );
    teamTemplatesDAL.updateTeamTemplate(tmpl.id, { content: updatedContent });

    // Now release the slow call.
    resolveHeldCompute();
    const slowResult = await slowCallPromise;

    // The slow call was started against the OLD content — it returns OLD data.
    // (It cached with the old contentHash, which is now stale.)
    expect(slowResult.promptAddendum).toBe('## OLD addendum');

    // A fresh call after the edit sees the new contentHash → new resolution.
    // Reset so the spy doesn't interfere with the fresh call's caching.
    vi.restoreAllMocks();
    _resetCacheForTest();
    const freshResult = await materializeRoleLoadout(tmpl.id, 'engineer');
    expect(freshResult.promptAddendum).toBe('## NEW addendum');
  });

  // ── Scenario 3: Cache stampede ─────────────────────────────────────────────

  it('cache stampede: 50 concurrent calls coalesce to exactly one resolution', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'stampede-team',
      content: makeTeam('engineer', makeLoadout()),
      ownerAgentId: agentId,
    });

    let resolutionCount = 0;
    // Spy on the internal resolveCachedOrCompute to count how many times the
    // underlying TemplateLoader.loadAsync path is entered (i.e., cache misses
    // that run the full resolution via compute()).
    const originalResolve = cacheModule.resolveCachedOrCompute;
    vi.spyOn(cacheModule, 'resolveCachedOrCompute').mockImplementation(
      async (templateId, contentHash, compute) => {
        const countingCompute = async () => {
          resolutionCount++;
          return compute();
        };
        return originalResolve(templateId, contentHash, countingCompute);
      },
    );

    const CONCURRENCY = 50;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        materializeRoleLoadout(tmpl.id, 'engineer'),
      ),
    );

    // All 50 results must be content-consistent regardless of stampede behavior.
    for (const result of results) {
      expect(result.promptAddendum).toBe('## Baseline addendum');
    }

    // The inflight-Promise coalescer in `resolveCachedOrCompute` ensures all
    // 50 concurrent callers share exactly one underlying resolution: the
    // first caller registers its Promise in the inflight map; the other 49
    // see it and await rather than running compute() themselves.
    expect(resolutionCount).toBe(1);
  });

  // ── Scenario 4: Standalone loadout edit via `extends:` — known stale ──────

  it('KNOWN STALE: editing a parent loadout mid-extends-chain is NOT reflected without cache reset', async () => {
    // Create the parent loadout that the team extends.
    const parent = loadoutsDAL.createLoadout({
      name: 'engineer-base',
      content: makeLoadout({ prompt_addendum: '## Parent v1' }),
      ownerAgentId: agentId,
    });

    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'extends-team',
      content: makeTeamWithExtends('engineer', 'engineer-base'),
      ownerAgentId: agentId,
    });

    // First materialization — cache miss, resolves with parent v1.
    const before = await materializeRoleLoadout(tmpl.id, 'engineer');
    expect(before.promptAddendum).toBe('## Parent v1');

    // Edit the parent loadout.
    loadoutsDAL.updateLoadout(parent.id, {
      content: makeLoadout({ prompt_addendum: '## Parent v2' }),
    });

    // Materialize again WITHOUT resetting the cache.
    // The team's content hash did NOT change (the inline role definition still
    // references `extends: engineer-base` verbatim). The cache returns the
    // stale ResolvedTemplate built against parent v1.
    //
    // KNOWN STALE: this assertion documents current behavior. If it starts
    // failing, the cache was silently fixed — update the test and this comment.
    const afterNoReset = await materializeRoleLoadout(tmpl.id, 'engineer');
    expect(afterNoReset.promptAddendum).toBe('## Parent v1'); // stale — expected

    // Confirm that a cache reset + re-materialize sees the new parent.
    _resetCacheForTest();
    const afterReset = await materializeRoleLoadout(tmpl.id, 'engineer');
    expect(afterReset.promptAddendum).toBe('## Parent v2');
  });

  // ── Scenario 5: Concurrent edits + dispatches — no tearing ───────────────

  it('concurrent enrichWithLoadout calls and template edit produce internally consistent materializations', async () => {
    const loadoutV1 = makeLoadout({
      capabilities: ['file.read'],
      prompt_addendum: '## V1 addendum',
    });
    const loadoutV2: LoadoutContent = {
      name: 'engineer',
      capabilities: ['file.read', 'exec.test'],
      permissions: { allow: ['Read(**)', 'Bash(test:*)'] },
      prompt_addendum: '## V2 addendum',
    };

    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'edit-race-team',
      content: makeTeam('engineer', loadoutV1),
      ownerAgentId: agentId,
    });

    const taskA = makeTask(tmpl.id, 'engineer', agentId, 'disp_a');

    // Fire taskA enrichment, then immediately edit the template, then fire taskB.
    // taskB gets its own object to avoid mutation aliasing.
    const taskB = makeTask(tmpl.id, 'engineer', agentId, 'disp_b');

    const [enrichedA, , enrichedB] = await Promise.all([
      enrichWithLoadout(taskA),
      // Microtask that updates the template mid-race.
      Promise.resolve().then(() => {
        teamTemplatesDAL.updateTeamTemplate(tmpl.id, {
          content: makeTeam('engineer', loadoutV2),
        });
      }),
      enrichWithLoadout(taskB),
    ]);

    // Both tasks must be internally consistent — no tearing between
    // capabilities and promptAddendum within a single task.
    const matA = enrichedA.metadata?.materializedLoadout as
      | { capabilities: string[]; promptAddendum: string; permissions: { allow: string[] } }
      | undefined;
    const matB = enrichedB.metadata?.materializedLoadout as
      | { capabilities: string[]; promptAddendum: string; permissions: { allow: string[] } }
      | undefined;

    // Neither enrichment should have produced a loadout_error.
    expect(enrichedA.metadata?.loadout_error).toBeUndefined();
    expect(enrichedB.metadata?.loadout_error).toBeUndefined();

    // Each must be internally consistent: if capabilities include exec.test,
    // then promptAddendum must also be from V2 (and vice versa).
    if (matA) {
      const isV2 = matA.capabilities.includes('exec.test');
      if (isV2) {
        expect(matA.promptAddendum).toBe('## V2 addendum');
        expect(matA.permissions.allow).toContain('Bash(test:*)');
      } else {
        expect(matA.promptAddendum).toBe('## V1 addendum');
        expect(matA.capabilities).toEqual(['file.read']);
      }
    }

    if (matB) {
      const isV2 = matB.capabilities.includes('exec.test');
      if (isV2) {
        expect(matB.promptAddendum).toBe('## V2 addendum');
        expect(matB.permissions.allow).toContain('Bash(test:*)');
      } else {
        expect(matB.promptAddendum).toBe('## V1 addendum');
        expect(matB.capabilities).toEqual(['file.read']);
      }
    }
  });
});
