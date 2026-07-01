# Loadouts — Milestone B: Verification

**Status:** Verified end-to-end with a real Claude API worker (2026-05-03). 5/5 live tests pass in ~25s with four hard-asserted capability proofs (delivery, skill consumption, MCP invocation, permission enforcement).
**Goal:** End-to-end test coverage for the hub→swarm bridge that already shipped in Milestone A. Prove the dispatch flow with materialized loadouts works under realistic edits, against the real macro-agent process, and stays compatible with openteams as both libraries evolve.

**Companion docs:**
- [`LOADOUTS_DESIGN.md`](./LOADOUTS_DESIGN.md) — full architecture. The "Distribution to swarms" section is what these tests verify.
- [`LOADOUTS_MILESTONE_A_PLAN.md`](./LOADOUTS_MILESTONE_A_PLAN.md) — what shipped before this.

---

## Verification status — 2026-05-03

The full chain `loadout author → enrichWithLoadout → openHivePromptBuilder → mail port → swarm sidecar → mail-bridge → mail-inbound-consumer → agentManager.spawn → promptUntilDone (real Claude) → done() → handlers-v2 → mapSidecar.postMailTurn → hub mail.turn.added → capturedTurns` is live-tested end-to-end. The verification surfaced and closed nine downstream defects across openhive, macro-agent, openteams, and the MAP SDK. See "Defects closed during verification" below.

### Live tests — green

| Test | Cadence | Result |
|---|---|---|
| `live-loadout-dispatch-e2e.test.ts` (5 tests) | `LIVE_AGENT_E2E=true` | 5/5 pass in ~25s. Four hard-asserted capability proofs in the agent's reply: SENTINEL (addendum read), SKILL_MARKER_WIDGET_99 (skill catalog consumed), AGENT_COUNT=N with N>0 (loadout-declared MCP `agent-inbox.list_agents` invoked), PERM_DENIED=true (loadout's deny rule blocked a tool call). Each layer is a regression target — see "Defects closed" 10–12 below for the wiring fixes that made them flip green. |
| `full-stack-loadout-prompt-receipt.test.ts` (7 tests) | `FULL_STACK_E2E=true` | 7/7 pass. Asserts dispatch with materialized loadout reaches the macro-agent process boundary. |
| `mail/forward-retry.test.ts` (6 tests) | default | 6/6 pass. Hub-side retry-queue happy path, dedup, drain on `node_registered`, fallback timer, mismatched-swarm filter, skip-self. |

### Defects closed during verification

Each was found while tightening Milestone B coverage and patched in the same session:

1. **macro-agent had no inbound mail consumer** — added `mail-bridge` (translates `mail/turn.received` notifications) + `mail-inbound-consumer` (classifies `x-dispatch/work`, spawns + drives the worker, posts the reply).
2. **Schema buried under `data`** — `inboxAdapter.send` calls `agent-inbox`'s `normalizeContent`, which wraps any payload without a `type` field as `{type:"data", data: original}`. Bridge now sets `type: "data"` explicitly so `schema` stays at the top level.
3. **Reply path missing** — `mapSidecar.postMailTurn` + `_lastSummary` storage in `handlers-v2.ts` for parentless workers, with `agentStore` plumbed into `HandlerDepsV2`.
4. **Outbound `dispatch.enabled` gate covered the inbound path too** — Option 3: extracted the inbound mail-consumer into its own module wired unconditionally, leaving the outbound orchestrator opt-in.
5. **`agentMeta.settingSources` not stripped for dispatch workers** — host-level claude-code-swarm / oh-my-claudecode plugins were auto-mounting and hanging session/new MCP-init. Added `SpawnAgentOptions.isolatedSettings` (consumer sets it; persisted to agent metadata so `resume` honors it).
6. **`agentManager.spawn` only creates the session** — the consumer now also calls `agentManager.promptUntilDone(spawnedId, prompt)` so the model actually receives the user message and runs to `done()`.
7. **openteams 0.2.2 had no loadout support** — published 0.3.0 with `ResolvedRole.loadout`, `resolved.loadouts`, snake_case → camelCase mapping for `prompt_addendum`. Resolver code path was already correct; the dependency wasn't.
8. **MAP SDK stale-stream race** — `BaseConnection.#startReceiving()` could close a freshly reconnected stream when an old loop unblocked. Added `#streamGeneration` counter so close happens only when the loop's generation matches the current.
9. **Hub-side mail forward had no retry** — `forwardTurnToSwarms` now always-queues alongside the live send, dedupes by `turn_id`, drains on `node_registered` (with 2s fallback). Recovers mid-turn WS disconnects.

Follow-on work (post-Milestone B verification, same-day):

10. **Skill catalog reached prompt but skill consumption was never proven.** Live test had no `skills` block in the loadout, so the entire `compileSkillsForLoadout → skill-tree → prompt prepend` path was unexercised. Added `src/__tests__/helpers/skill-bank-fixture.ts` (reusable test bank with `MARKER_SKILL` carrying `SKILL_MARKER_WIDGET_99`), `src/__tests__/openteams/skill-bank-ref.test.ts` (4-test fast lock-in for the `loadout.openhive.skillBankRef` resolution path), and extended the live e2e to assert the marker reaches the agent's reply (proving the agent both received AND consumed the catalog).
11. **MCP "trinity" not actually mounted on mail-inbound workers.** Architecture docs claimed agent-inbox and opentasks were available to spawned workers, but `agentManager.spawn` only mounted macro-agent's own MCP server. With `isolatedSettings: true` stripping host-user plugins, mail-inbound workers had zero non-macro-agent MCP tools. Fixed in macro-agent: `spawn` now writes per-spawn entries for `agent-inbox` (via new `dist/cli/inbox-mcp-proxy.js` → `InboxMcpProxy`) and `opentasks` (via `opentasks mcp` CLI subcommand), independent of `isolatedSettings`. Bumped `agent-inbox` 0.1.8 → 0.1.9 to get the `InboxMcpProxy` export.
12. **Loadout permissions never reached the worker's Claude SDK.** `MaterializedLoadout.permissions` was populated but went nowhere — workers ran with `permissionMode: "auto-approve"` and no rule enforcement. Built three new pieces:
    - `src/dispatch/loadout-side-channel.ts` — bridges enrichment-time → deliver-time, since swarm-dispatch's `MessagePort.deliver` payload is fixed.
    - `openhive-mail-port.injectLoadoutMetadata` — wraps `transport.sendToAgent` to add `body.metadata.permissions`.
    - macro-agent's `agentManager.spawn` — writes permissions to `agentMeta.claudeCode.options.settings.permissions` (inline SDK pass-through; no `.claude/settings.json` file → no concurrent-spawn collision). New `fullAutonomous` flag controls `ask` rule resolution.

Plus three observability + safety fixes (stripped `_lastSummary` after post; bounded `seenTaskIds` with 1h TTL; surfaced malformed-envelope counter via `consumer.stats()`).

### What's NOT covered by Milestone B (carried into the limitations table in `LOADOUTS_DESIGN.md`)

Status updated 2026-05-03 after follow-on work:

- ~~Loadout-provided MCP servers reaching the spawned worker.~~ **Closed.** macro-agent's `agentManager.spawn` now mounts the `agent-inbox` + `opentasks` trinity per-spawn (independent of `isolatedSettings`). Live test asserts `agent-inbox.list_agents` returns real data via `AGENT_COUNT > 0`. Loadout-declared MCPs beyond the trinity remain advisory (Phase 0); scope filter (Phase 1) and install-spec delivery (Phase 2) deferred.
- ~~`permissions.{allow,deny,ask}` enforced as Claude permission-mode config.~~ **Closed.** Loadout permissions ride hub-side via the loadout side-channel → envelope `body.metadata.permissions` → mail-inbound-consumer → `agentManager.spawn({ permissions, fullAutonomous })` → `agentMeta.claudeCode.options.settings.permissions`. Live test asserts `PERM_DENIED=true` after the agent attempts a denied bash call. New `fullAutonomous` flag controls `ask` resolution (true → allow, false → deny).
- Cross-owner `extends` chains. (Open — needs sharing/visibility model.)
- Cross-instance federation of loadouts under live dispatch. (Open — depends on cross-owner.)
- Loadout version pinning on dispatches. (Open — wait for use case.)
- UI / Playwright coverage. (Open — wait until UI stops moving.)
- Loadout audit log persistence. (Open — quick win available; ~half day.)

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

**What it proves:** the materialized loadout addendum travels through the full dispatch orchestrator pipeline and arrives at the ACP runtime layer in a booted environment (real OpenHive Fastify + real SwarmRunner + real macro-agent subprocess).

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
