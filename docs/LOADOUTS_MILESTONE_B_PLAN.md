# Loadouts — Milestone B: Verification

**Goal:** End-to-end test coverage for the hub→swarm bridge that already shipped in Milestone A. Prove the dispatch flow with materialized loadouts works under realistic edits, against the real macro-agent process, and stays compatible with openteams as both libraries evolve.

**Companion docs:**
- [`LOADOUTS_DESIGN.md`](./LOADOUTS_DESIGN.md) — full architecture. The "Distribution to swarms" section is what these tests verify.
- [`LOADOUTS_MILESTONE_A_PLAN.md`](./LOADOUTS_MILESTONE_A_PLAN.md) — what shipped before this.

---

## What this milestone is and isn't

**This milestone is** verification + a tightened safety net around the hub-side flow. The product capability already exists — Milestone A landed CRUD, the resolver, materialization, dispatch integration, and UI preview endpoints. What was missing: end-to-end coverage that exercises the full author → dispatch → agent path.

**This milestone is not** a swarm-side fetch implementation. Earlier drafts proposed MAP methods (`resources/get`, then per-domain `openteams/template.*`) and a hub installer in cc-swarm. Both were rejected on review. The reasoning is captured in `LOADOUTS_DESIGN.md`'s "What this design replaces" table; the short version: dispatch already carries everything the swarm needs in the prompt body, and openteams' install path covers non-dispatch boots without OpenHive being involved.

---

## Architectural commitments

These are the principles this milestone enforces via tests. If implementation drift breaks them, the tests should fail.

1. **No swarm-side fetch from OpenHive.** Templates and loadouts are not pulled from OpenHive at runtime. The hub→swarm content path is dispatch prompts.
2. **No HTTP awareness on the agent side.** OpenHive's REST endpoints are UI-only. References from cc-swarm/macro-agent should not exist.
3. **openteams loader stays canonical.** Anything OpenHive stores must round-trip through openteams' `TemplateLoader.loadAsync` cleanly when staged to disk.
4. **Materialized loadout content travels in dispatch prompts.** Skills bundle (`skills.rendered`) and `promptAddendum` reach the agent via the dispatch payload, not via a sidechannel.

---

## Test slate

Four files, three fast and one heavy. Critical path: the fast three first; full-stack last and gated.

### 1. `src/__tests__/integrations/loadout-author-to-dispatch.test.ts` (fast)

**What it proves:** the full author→dispatch path produces the right prompt without spawning real processes.

**Shape:**
- Author a `team_template` + `loadout` via DAL.
- Construct a synthetic `DispatchTask` with `metadata.spec_metadata.team_role_ref = { teamTemplateId, role }`.
- Run `enrichWithLoadout(task)` (the actual dispatch source step).
- Run `openHivePromptBuilder(enrichedTask, ctx)` (the actual prompt builder).
- Assert the prompt contains the rendered skills (or rendered placeholder when no skill bank is bound), the `promptAddendum`, and the role line in the documented order.

**Variants:**
- `team_role_ref` path (resolves through `materializeRoleLoadout`).
- `loadout_ref` path (resolves through `materializeLoadoutById`).
- No binding (control: prompt is unchanged).
- Materialization failure mid-flight (mock the resolver to throw): dispatch proceeds with `loadout_error` marker, prompt is un-enriched, no exception bubbles up.

**Why this exists:** catches logic bugs in milliseconds. The fastest signal that the hub-side wiring is intact.

### 2. `src/__tests__/integrations/loadout-update-propagation.test.ts` (fast)

**What it proves:** edits to authored content reach the next materialize call. Catches cache-invalidation regressions.

**Shape:**
- Create team_template, materialize once → cache hit on second call (assert `===` identity).
- Update content via DAL.
- Materialize again → fresh value, no `===` identity with the previous result.
- Assert the new field (e.g., updated `prompt_addendum`) is in the materialized output.

**Variants:**
- Edit team manifest (verify content hash changes).
- Edit a referenced standalone loadout (verify the team's resolution sees the change — exercises the `extends:` chain).
- Edit MCP refs (verify `mcpProviders` reflects the change).
- Edit `prompt_addendum` (verify the materialized addendum updates).

**Why this exists:** the resolver caches by `(templateId, contentHash)`. If the hash function ever silently fails to detect a change, materialization goes stale; this catches it.

### 3. `src/__tests__/integrations/openteams-roundtrip.test.ts` (fast)

**What it proves:** OpenHive's stored content shape stays compatible with openteams' `TemplateLoader.loadAsync`. If openteams ever changes its YAML expectations, this test fires before users see breakage.

**Shape:**
- Author a non-trivial team_template via DAL (multiple roles, inline + extends-chain loadouts, MCP scope, prompt addendum, skill criteria).
- Internally, the resolver writes this content to a tmpdir via the existing staging helper.
- Run openteams' actual `TemplateLoader.loadAsync` against that tmpdir directly (bypassing the resolver).
- Assert the resulting `ResolvedTemplate` matches what `resolveTeam` produces internally.

**Why this exists:** OpenHive's `stageTemplate` and openteams' file loader are coupled by the YAML format. A drift on either side breaks dispatch silently. This is the safety net.

### 4. `src/__tests__/swarm/full-stack-loadout-prompt-receipt.test.ts` (slow, gated)

**What it proves:** the materialized loadout addendum travels through the full dispatch orchestrator pipeline and arrives at the ACP runtime layer in a booted environment (real OpenHive Fastify + real OpenSwarm + real macro-agent subprocess).

**Shape:** sibling to `src/__tests__/swarm/full-stack-e2e.test.ts`. Same gate (`FULL_STACK_E2E=true`).

**Pipeline exercised:**
```
dispatch row (queued)
  → source polls + claims (DAL fence token)
  → enrichWithSpec (stub fetcher injects loadout binding)
  → enrichWithLoadout (materializeRoleLoadout against live DB)
  → prompt builder (openHivePromptBuilder embeds promptAddendum)
  → runtime.sendPrompt (recording stub captures the text)
  → captured prompt contains PROMPT_RECEIPT_MARKER
```

**What it actually exercises:**
- Hub-side: full Fastify, real DAL, real resolver, real dispatch source, real orchestrator.
- Materialization: `materializeRoleLoadout` against the live SQLite DB in the booted environment.
- Runtime boundary: recording stub `AcpStreamManager` captures the exact prompt text.
- Subprocess presence: macro-agent stays healthy throughout — confirms the booted environment is consistent with production even though ACP delivery is stubbed.

**What it does not prove:** actual prompt receipt by macro-agent's ACP handler. The stub intercepts at the runtime boundary. Adding real delivery observation would require wiring the full SwarmCraft plugin and subscribing to `acp.session.update` WS events — not done here.

**Why it's gated:** boots subprocesses; ~30s per run. Same trade-off as `full-stack-e2e.test.ts`.

**Note:** an earlier stepping-stone file (`full-stack-loadout-dispatch.test.ts`) was deleted. Its assertions (REST authoring, direct `materializeRoleLoadout` calls, swarm health checks) are all subsets of what this file plus the fast integration tests cover — the subprocess cost bought nothing the in-process tests don't already prove.

---

## Implementation order

```
Step 1: integrations/loadout-author-to-dispatch.test.ts         (fastest signal, catches obvious breakage)
Step 2: integrations/loadout-update-propagation.test.ts         (cache regressions)
Step 3: integrations/openteams-roundtrip.test.ts                (drift safety net)
Step 4: swarm/full-stack-loadout-prompt-receipt.test.ts         (dispatch pipeline + runtime receipt)
Step 5: typecheck + run new tests + verify zero regressions
```

Steps 1–3 can run in parallel (independent test files, no shared fixtures). Step 4 is sequential after the prior fast tests — if the fast ones fail, fix those before paying the full-stack cost.

---

## Cross-cutting

### Test directory layout

```
src/__tests__/integrations/
  loadout-author-to-dispatch.test.ts         # fast: author→dispatch prompt
  loadout-update-propagation.test.ts         # fast: cache invalidation
  openteams-roundtrip.test.ts               # fast: openteams compat
  dispatch-source-prompt.test.ts            # fast: source adapter integration

src/__tests__/swarm/
  full-stack-e2e.test.ts                    # gated: macro-agent boot + MAP
  full-stack-loadout-prompt-receipt.test.ts # gated: dispatch pipeline runtime receipt
```

The `integrations/` directory is new but conventional — clearer signal than dumping these into the catch-all root.

### Naming

Tests use the `loadout-*.test.ts` prefix in `integrations/` so they group together in test output and grep results.

### Helpers reuse

- `helpers/test-dirs.ts` — `testRoot`, `testDbPath`, `cleanTestRoot` for the fast tests.
- The existing `full-stack-e2e.test.ts` fixture for the gated test (extract shared boot/teardown if duplication grows; for v1, copy is fine).

---

## Definition of done

- [ ] All test files written and passing locally.
- [ ] `npx vitest run src/__tests__/integrations/` is green.
- [ ] `FULL_STACK_E2E=true npx vitest run src/__tests__/swarm/full-stack-loadout-prompt-receipt.test.ts` is green.
- [ ] Full test suite (`npm run test:run`) shows no regressions on existing tests.
- [ ] `references/claude-code-swarm/` source contains zero references to OpenHive's REST endpoints, no `hub-installer`, no MAP fetch wiring for templates. (One-liner grep check; the architectural commitment turned into an assertion.)
- [ ] `LOADOUTS_DESIGN.md` reflects the as-built shape (no MAP-fetch references, no agent-side wiring section). ✓ done in this milestone.

---

## Open questions to resolve during implementation

1. **`integrations/` directory naming.** Some existing tests under `src/__tests__/` have names like `*-e2e.test.ts` at root level (e.g., `headless-mode-e2e.test.ts`). Prefer the `integrations/` subdirectory or rename to `loadout-*-e2e.test.ts` at root? Lean `integrations/` for grouping clarity.
2. **Distinctive markers in test content.** For the full-stack test, what's the cleanest way to verify the agent received specific content? A unique string in `promptAddendum` is simplest; macro-agent's session-update events should surface the prompt verbatim. Confirm by inspecting an existing full-stack-e2e assertion before writing.
3. **Cleanup between full-stack runs.** The existing fixture wipes the test root in `afterAll`; the new sibling needs the same. Verify the fixture is reusable as-is or whether we need to extract a helper.
4. **Macro-agent prompt visibility over MAP.** The dispatch prompt reaches macro-agent via ACP `prompt`. Confirm the agent surfaces the received prompt in a way the test can observe (session update, log line, MAP event). If observability is opaque, may need to add a small "echo prompt" hook on the test path.

---

## References

- [`LOADOUTS_DESIGN.md`](./LOADOUTS_DESIGN.md) — full architecture, including the dropped-MAP-methods rationale.
- [`LOADOUTS_MILESTONE_A_PLAN.md`](./LOADOUTS_MILESTONE_A_PLAN.md) — what shipped before this.
- `src/__tests__/swarm/full-stack-e2e.test.ts` — the e2e pattern we extend in step 4.
- `src/dispatch/openhive-source.ts` — `enrichWithLoadout` step under test in step 1.
- `src/dispatch/prompt.ts` — `openHivePromptBuilder` under test in step 1.
- `src/openteams/resolver.ts` — `materializeRoleLoadout` / `materializeLoadoutById` / `stageTemplate` under test in steps 1–3.
- `src/openteams/cache.ts` — `(id, contentHash)` cache under test in step 2.
