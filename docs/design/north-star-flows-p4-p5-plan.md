# North Star Flows — P4 + P5 Implementation Plan (Dispatch a Team · Validate & Close)

**Date:** 2026-07-02
**Status:** Proposed
**Parent:** [`north-star-flows.md`](north-star-flows.md) Flow 4 (Dispatch a Team) + Flow 5 (Validate & Close)
**Predecessor:** [`north-star-flows-p3-plan.md`](north-star-flows-p3-plan.md) (P3 Spec & Discuss, shipped)

> **Flow 2 follow-up — closed.** The one remaining Flow 2 item (permission-pending events in the attention queue with inline replies) already shipped: `AttentionBell.tsx` renders inline Allow/Deny with optimistic resolution + WS reconciliation, and `useGlobalAttention.ts` handles `acp.permission.request/resolved` + `hosted-chat.event` permission kinds. No further Flow 2 work. The *dispatch-completion* → attention wiring that remains is genuinely new and lives in **P5.4**, not Flow 2.

## Goal

Close Flows 4 and 5: fan a spec out to a **coordinated team** of agents that know about each other and share one thread, surface a **spec-level rollup** as the primary progress view, make **cancel actually stop** a running agent, and turn "dispatch complete" into a **validate-and-close loop** (accept & close, launch a validator, send back) without leaving the spec page.

**Acceptance (from the north-star doc):**
- **Flow 4:** one spec dispatched to 3 swarms yields one shared thread where agents reference each other's work, a rollup that answers "is this spec done?" at a glance, and a cancel that verifiably stops a runaway agent.
- **Flow 5:** the user validates and closes a completed dispatch in ≤3 clicks, or launches a validator agent in ≤2, and the spec page shows the full lifecycle (discussed → dispatched → validated → closed).

## Ground truth that shapes this plan

Verified against HEAD before planning (subagent sweeps 2026-07-02). The three findings that most change the shape of the plan are flagged **⚠ load-bearing**.

### Dispatch creation

1. **The modal is thin; the Zod schema is fat.** `DispatchModal.tsx` sends only `{ resource_id, spec_id, target_swarms, prompt }` (`src/web/components/dispatch/DispatchModal.tsx:115-120`, mirrored by `CreateDispatchInput` in `src/web/hooks/useDispatch.ts:87-92`). `DispatchSpecSchema` already validates and persists `loadout_resource_id`, `team_template_resource_id`, `role`, `acp_lifecycle`, `mail_lifecycle`, `repo_id`, `branch`, `commit_sha`, `clone_policy`, `clone_path` (`src/api/routes/specs.ts:72-111`), and `dispatchSpecToSwarms` bundles + persists them per row (`specs.ts:1117-1185`, DAL `src/db/dal/dispatches.ts:304-338`).
2. **⚠ load-bearing: "backend accepts every field" ≠ "orchestrator honors every field."** Repo fields *and* lifecycle hints are wired end-to-end (`enrichWithRepo`, `src/dispatch/openhive-source.ts:332-378`; lifecycle in `enrichWithLoadout:211-226`). But **loadout/team/role from the dispatch row are NOT consumed at runtime** — `enrichWithLoadout` reads the *spec node's* `metadata.loadout_ref` / `team_role_ref` only (`openhive-source.ts:118-133`), never the row's `loadout_bundle_id` / `team_bundle_id` / `role`. So exposing loadout/team/role in the modal is a **no-op until we also wire the row bundles into enrichment** (the way `enrichWithRepo` reads row columns). This is hidden backend work folded into P4.1.
3. **A precedent modal exists.** The Swarms "Spawn" dialog already does team-template `<select>` + loadout `<select>` + role input, resolving bundle ids via `GET /teams/:id/bundle` and `GET /loadouts/:id/bundle` (`src/web/pages/Swarms.tsx:792-863`, `317-330`). P4.1 is largely lifting this pattern into `DispatchModal`.

### Dispatch threads + coordination

4. **Threads are strictly one-per-dispatch and lazy.** `ensureDispatchConversation` keys the id on `dispatchId` (`dispatch-conv-${dispatchId}`), invites exactly two participants (initiator + one `executorAgentId`), and only runs on the first thread message (`src/dispatch/dispatch-conversation.ts:56-125`). Fan-out inserts N rows and creates **zero** threads (`src/api/routes/specs.ts:1166-1227`).
5. **⚠ load-bearing: shared threads were deliberately rejected once, and the `conversation_id` column is contended.** `docs/design/dispatch-inbox-threads.md:329-331` rejected shared threads over *permission scoping* (mixed loadouts in one thread). Separately, `mail-transport.ts`'s per-`(swarm,agent)` `swarm-dispatch` delivery channel **also** writes `setDispatchConversationId` first-writer-wins on the same column (`src/dispatch/mail-transport.ts:91-108,183-187`), racing the coordination thread. A team thread cannot reuse that single column naively.
6. **Roster is executor *selection*, not peer *awareness*.** `createOpenHiveRoster().findAvailable` returns candidates for the orchestrator to pick one executor per attempt (`src/dispatch/openhive-roster.ts:53-118`); nothing tells an agent who its peers are.
7. **The prompt has a Coordination section but no peer roster.** `openHivePromptBuilder` emits `## Coordination` with thread tag + initiator + linked tasks (`src/dispatch/prompt.ts:114-130`); task metadata carries only `initiator`, `linkedTasks`, `conversation_id` (`openhive-source.ts:49-61`). Note the tag mismatch: the prompt advertises `dispatch-${task.id}` while the factory id is `dispatch-conv-${dispatchId}` (`prompt.ts:120` vs `dispatch-conversation.ts:82`).
8. **The dispatch thread UI hides itself pre-conversation (#10).** `DispatchThreadSection` does `return null` when `!conversationId` (`src/web/components/dispatch/DispatchThreadSection.tsx:190-193`), even though `POST /dispatches/:id/thread/turns` lazily creates the conversation on first user post (`src/api/routes/dispatches.ts:213-307`). It's a hand-rolled bubble list, not the unified `ChatMessageList`/`ChatInput`.

### Cancel

9. **⚠ load-bearing: REST cancel is DB-only and reconcile probably never fires on it.** `POST /dispatches/:id/cancel` just flips the row to `cancelled` + broadcasts `dispatch.cancelled` (`src/api/routes/dispatches.ts:152-207`); the handler comment says v1 does not notify the swarm. Reconcile *is* enabled at 5 s (`src/dispatch/setup.ts:147-155`) and swarm-dispatch's `cancelExecutor` can send `x-dispatch/cancel` (mail) or `runtime.terminate`→`closeStream` (ACP), but OpenHive **does not pass `reconcile.shouldStop`**, and the library default only stops on `task.status` `closed`/`blocked` — OpenHive maps cancel to `'cancelled'` (`openhive-source.ts:47`), so the predicate never trips. Reconcile also **skips mail-origin records** (`dispatcher.js:812-814`). No `map/dispatches/cancel` MAP method exists (`src/map/dispatch-handler.ts:20-22`). The `cancel_not_acked` ribbon already exists in the UI (`DispatchDetail.tsx:216-235`) but is never emitted by OpenHive today.

### Validate & close

10. **Outcome view is read-only.** `DispatchDetail.tsx:523-578` renders `d.outcome` (summary/error/artifacts); `DispatchOutcome` merges agent artifacts + cascade streams at terminal via `finalizeDispatch` (`src/dispatch/finalize.ts:24-44`). Cancel is the only action, gated to `queued|running`.
11. **Task close is a buried graph-sidebar edit — but the API is clean.** `TaskGraphSidebar` has the Close button (`src/web/components/task-graph/TaskGraphSidebar.tsx:106-130`); the underlying call is `PATCH /resources/:rid/content/opentasks/tasks/:nodeId { status: 'closed' }` via `useUpdateOpenTaskStatus` (`src/web/hooks/useApi.ts:1137-1160`). Linked tasks are already on the dispatch (`dispatch_linked_tasks`, shown at `DispatchDetail.tsx:474-521`). "Accept & close" is a one-click wrapper over these.
12. **⚠ diff deep-link id mismatch.** The Changes page deep-links on the **hub row id** (`?stream=<cascade_streams.id>`, `src/web/pages/Changes.tsx:163-177`), but the outcome artifact ref is `{swarm_id}/{runtime_stream_id}` (`finalize.ts` / `computeCascadeArtifacts`). The "Changes opened" heuristic section already deep-links correctly (`DispatchDetail.tsx:446-448`) but the **outcome artifact** links only to `/changes` (list). P5.2 must map artifact ref → row id (or store the row id in the artifact).
13. **No reviewer/validation dispatch concept exists.** `reviewer` exists only as a loadout/team *role* string fed to `prompt.ts`; there is no validation dispatch type, no acceptance-criteria capture, no verdict flow. The `postSpecThreadOutcome` hook (P3) is live from both terminal paths (`src/dispatch/setup.ts:270-306`, `src/map/dispatch-handler.ts:149-174`) and is the reuse target for validator verdicts.
14. **Completion does not reach attention.** `useDispatchRealtime.ts:44-51` consumes `dispatch.completed`/`dead` as **query invalidations only** — no toast, no attention item. The attention store handles `idle` + `permission` kinds only (`src/web/stores/session-attention.ts:6-11`); `AttentionBell` deep-links `session:`/`hosted-chat:`/`stream:` keys, not dispatch. P5.4 adds a `dispatch`/`review` kind and a listener, reusing the shipped Flow 2 store + bell.

---

## P4 — Dispatch a Team

### P4.1 Dispatch modal expansion (+ runtime wiring for row loadout/team/role) — ✅ Implemented

**Goal:** the modal exposes what the backend accepts — target swarms, loadout, team template + role, repo/branch, transport lifecycle — with defaults so the simple case stays ~2 clicks.

**Implemented (deviation from plan):** the runtime wiring uses a new pair of *resource-ref* columns rather than the pinned bundle ids. Discovery during build: the row's `loadout_bundle_id` / `team_bundle_id` resolve through the *lighter* bundle materializer (`src/openteams/loadout-materializer.ts`, ACP-focused `mcpServers` shape, no skill compilation) which feeds only the sidecar-facing `GET /dispatches/:id/loadout`. The hub-side rich enrichment pipeline (`enrichWithLoadout` → loadout side-channel → mail envelope) needs the resolver shape (`src/openteams/types.ts`: skills, mcpScope, mcpProviders) and materializes **live from resource ids** (docs/LOADOUTS_DESIGN.md: "pinning: not implemented" for that path). So instead of wiring the bundle ids in (shape-incompatible), migration **V64** adds `dispatches.loadout_resource_id` / `team_template_resource_id`; `dispatchSpecToSwarms` persists them alongside the pinned bundles; `enrichWithLoadout` reads a row binding (`readRowLoadoutBinding`, row-precedence over spec default) and also surfaces a bare row `role` onto `task.metadata.role` so `chooseExecutor` filters the roster even without a loadout. Files: `src/db/schema.ts` (V64 + repair), `src/db/index.ts`, `src/db/dal/dispatches.ts`, `src/api/routes/specs.ts`, `src/dispatch/openhive-source.ts`, `src/web/components/dispatch/DispatchModal.tsx`, `src/web/hooks/useDispatch.ts`. Tests: `dispatches-loadout-refs.test.ts` (persistence), `openhive-source.test.ts` (row-role → executor selection).

**Frontend** (`DispatchModal.tsx`, `useDispatch.ts`): add a collapsible **Advanced** section below the swarm picker.
- Team template + loadout `<select>`s + role input, lifted from `Swarms.tsx:792-863`; role options derived from the selected template's `metadata.content.roles` keys. Data via `useResourcesByType('team_template' | 'loadout')` (`useApi.ts:464-478`).
- Repo/branch + lifecycle (`acp_lifecycle`/`mail_lifecycle` `fresh|reuse`) selects; all optional, defaulted so a plain dispatch is unchanged.
- Extend `CreateDispatchInput` + the `useCreateDispatch` POST body to forward the new fields (they already exist on the Zod schema).

**Backend — the hidden half (ground truth #2):** make the orchestrator honor row-level loadout/team/role. In `enrichWithLoadout` (`openhive-source.ts`), fall back to the dispatch row's `loadout_bundle_id` / `team_bundle_id` / `role` when the spec node carries no `loadout_ref` / `team_role_ref` — mirroring how `enrichWithRepo` reads row columns. Row-level (explicit dispatch choice) should take precedence over spec-default.

**Tests:** route test for extended POST fields → correct bundle ids + role persisted (none exist today, `specs.test.ts:660-899`); orchestrator-source unit test that row bundle drives materialized loadout when spec metadata is absent; component test that Advanced fields serialize into the POST.
**Estimate:** 2–2.5 days (1 UI, 1–1.5 runtime wiring + tests).

### P4.2 Coordinated-team mode (shared thread + peer roster) — ✅ Implemented

**Goal:** when N>1 targets are dispatched in "Coordinated team" mode, all executors + initiator share **one** mail thread and each agent's prompt names its peers.

**As-built (deviations from plan noted):**
- **Opt-in toggle**: `DispatchModal` shows a "Coordinate as a team" checkbox only when >1 target is selected (default off). `coordinated` flows through `useDispatch` → `DispatchSpecSchema` → `dispatchSpecToSwarms`.
- **Separate column**: V65 adds `dispatches.team_conversation_id` (nullable), distinct from the transport-contended `conversation_id`. Setter `setDispatchTeamConversationId` is first-writer-wins; `listDispatchesByTeamConversation` builds the roster.
- **Eager shared thread**: `ensureTeamConversation` (`dispatch-conversation.ts`, scope `dispatch-team-thread`) is created once per fan-out batch with a `team-conv-<nanoid>` id, after the row loop in `dispatchSpecToSwarms`. **Deviation:** only the *initiator* is invited at creation — executor agent ids aren't known until claim/delivery time, so executors auto-join by posting (agent-inbox auto-adds the sender), guided by the roster in their prompt. Thread creation is best-effort: a mail failure logs a warning and lets the per-dispatch threads carry on.
- **Peer roster in prompt**: `dispatchToTask` surfaces `team_conversation_id`; `enrichWithTeam` (new step in the enrich chain) attaches `peers: Array<{ swarmName, role? }>` from the sibling rows (minus self, swarm name resolved via `findSwarmById` with id fallback). `prompt.ts` renders a roster block inside `## Coordination` and — **fixing the tag mismatch** — advertises the *real* `team_conversation_id` as the shared `thread_tag`.

**Tests:** DAL (`dispatches-loadout-refs.test.ts`) — default null + batch link + first-writer-wins; source (`openhive-source.test.ts`) — peer roster surfaced / omitted; prompt (`loadout-prompt.test.ts`) — roster + shared tag rendered / omitted when no peers. Typecheck clean.

**Files:** `src/db/schema.ts` (V65), `src/db/index.ts` (repairSchema), `src/db/dal/dispatches.ts`, `src/dispatch/dispatch-conversation.ts`, `src/dispatch/openhive-source.ts`, `src/dispatch/prompt.ts`, `src/api/routes/specs.ts`, `src/web/hooks/useDispatch.ts`, `src/web/components/dispatch/DispatchModal.tsx`.

**⚠ Resolve the shared-thread objections first (ground truth #5):**
- Make coordinated mode an **explicit opt-in toggle** in the modal (default off = today's N independent threads), so the permission-scoping concern from `dispatch-inbox-threads.md:329` only applies when the user deliberately opts in.
- Do **not** overload the `dispatches.conversation_id` column for the shared thread (it's contended by the transport channel). Add a separate `team_conversation_id` (nullable) column, or store the shared id in each row's `metadata` and resolve by a deterministic id keyed on the **fan-out batch** (e.g. `spec-team:<resourceId>:<specId>:<batchTs>`). The transport channel keeps `conversation_id`; the coordination thread is separate.

**Build:**
- **Eager shared-thread factory** — a `ensureTeamConversation` variant (sibling to `ensureDispatchConversation`) created **at dispatch time** in the fan-out loop (`specs.ts:1166-1227`) when coordinated mode is on: one `mail/create` (`scope: 'dispatch-team-thread'`, metadata linking all dispatch ids + spec refs), then `mail/invite` for the initiator + **every** executor agent. Reuse the get-before-create + in-flight-mutex pattern (create-or-get from agent-inbox 0.2.5 makes this safe).
- **Peer roster in the prompt** — thread through a `peers: Array<{ agentId, swarmName, role? }>` on task metadata (`openhive-source.ts:49-61`) and render a roster block inside `## Coordination` in `prompt.ts:114-130` ("You're on a team: codex-2 (backend), claude-1 (tests). Shared thread tag: <id>."). **Fix the tag mismatch** so the advertised tag equals the real shared conversation id.
- Coordinated executors are still selected via the existing roster/eligibility path per row; this ticket adds *awareness*, not a new selection algorithm.

**Tests:** fan-out in coordinated mode creates exactly one thread with initiator + N executors invited; independent mode unchanged (still 0 eager threads); prompt builder emits the peer roster + correct shared tag; concurrent fan-out doesn't double-create the thread.
**Estimate:** 2.5–3 days.

### P4.3 Spec-level rollup — ✅ Implemented

**Goal:** SpecDetail shows "2/3 running, 1 complete" aggregated over the spec's dispatch rows + linked-task statuses; the rollup is the primary progress surface.

**As-built:**
- New `DispatchRollup` component + pure `rollupDispatchStatuses()` aggregator (`src/web/components/dispatch/DispatchRollup.tsx`): status tally chips (running/queued/complete/failed/cancelled, only non-zero) reusing the shared `StatusChip` tone vocabulary, plus an optional `N/M done` summary and `settled` / `allComplete` signals.
- Rendered as a header row in `SpecDispatchPanel` (above the per-dispatch drill-down list, which is retained). Live via the existing `map:dispatches` WS invalidation in `useDispatchRealtime`.
- Rendered in the SpecDetail sub-header meta row so "is this spec done?" is answerable without opening the panel. Fed by a `useDispatchList` with the *same* query options as the panel, so react-query dedupes — no extra fetch.
- **Deviation:** linked-task status aggregation deferred — the rollup covers dispatch rows only (the primary "is this spec done?" signal). Linked-task rollup can layer on later without changing the component API.

**Tests:** `DispatchRollup.test.tsx` — aggregator counts/settled/allComplete + component renders one chip per non-zero status + summary + hides empty. Existing `SpecDispatchPanel.test.tsx` still green. Typecheck clean.

**Build:** rollup is pure aggregation over data that already exists — no schema change.
- Query all dispatches for the spec (`GET /dispatches?spec_resource_id=&spec_id=`, already filterable, DAL `dispatches.ts:391-397`) + their linked-task statuses.
- Add a rollup header to `SpecDispatchPanel` (`src/web/components/dispatch/SpecDispatchPanel.tsx`, currently a flat count-only list): status tally chips (queued/running/complete/failed/cancelled) with per-dispatch drill-down retained below. Live via the `map:dispatches` WS invalidation already wired in `useDispatchRealtime`.
- Surface the rollup on the SpecDetail Document tab header so "is this spec done?" is answerable without opening the panel.

**Tests:** component test — given mixed-status dispatch fixtures, the tally renders correct counts and updates on a `dispatch.completed` WS event (mocked).
**Estimate:** 1.5 days.

### P4.4 Unified dispatch thread UI + pre-conversation composer — ✅ Implemented

**Goal:** the dispatch thread renders on the unified chat contract, and the composer is visible **before** the first agent message so the user can nudge a silent agent (#10).

**As-built (deviations noted):**
- **Pre-conversation composer (the core #10 fix):** `DispatchThreadSection` no longer `return null`s when there's no conversation. It now returns null only when the dispatch is *terminal AND* never had a thread. For an active dispatch with no conversation, it renders an empty-state prompt ("No coordination thread yet…") + the composer. The first send posts to `POST /dispatches/:id/thread/turns` (lazy-creates the conversation) and invalidates `['dispatch', id]` so `conversation_id` swaps in and the live thread appears.
- **Shared team-thread pointer (P4.2 tie-in):** new optional `teamConversationId` prop renders a link to the shared coordinated-team thread (`/threads/<id>`) above the per-dispatch thread. Wired from `DispatchDetail` via `d.team_conversation_id`.
- **Deviation — MailThreadView swap deferred:** the plan called for replacing the hand-rolled bubbles with the unified `MailThreadView`. Held off because `MailThreadView` is a full-height chat surface (its own header/participant stack + `usePageContext`, and its `ChatInput` sends via the swarmcraft channel adapter — a *plain* mail send that bypasses the dispatch turns route's lazy-create + dispatch side effects). Embedding it in the scrolling `DispatchDetail` page (which already declares its own page context) risks layout + duplicate-context + send-path regressions. The existing bubble renderer already handles system-turn relabeling + importance badges + 5s polling, so the unified swap is a lower-value follow-up tracked below.

**Tests:** `DispatchThreadSection.test.tsx` — terminal+no-conversation renders nothing; active+no-conversation shows the composer; first send hits the turns route; team pointer renders; existing-conversation renders the message list + normal composer. Typecheck clean.

**Follow-up (not blocking):** migrate the thread body to `MailThreadView` for realtime WS (vs polling) + unified avatars, keeping the dispatch turns route as the send path (needs a `send` override or a turns-route-backed adapter).

**Build:** mostly frontend — the lazy-create backend already exists (`POST /dispatches/:id/thread/turns`, `dispatches.ts:213-307`).
- Replace `DispatchThreadSection`'s hand-rolled bubbles with `MailThreadView` (the P3-hardened unified component) when a `conversation_id` exists — inheriting realtime, system-turn "Orchestrator" relabeling, participant roster.
- **Kill the chicken-and-egg:** when `!conversation_id` and the dispatch is non-terminal, render an *empty-state composer* instead of `return null` (`DispatchThreadSection.tsx:190-193`); the first user send hits `POST .../thread/turns`, which creates the conversation and returns the id (invalidate `['dispatch', id]`).
- For coordinated dispatches (P4.2), the thread section points at the shared `team_conversation_id`.

**Tests:** component test — no-conversation non-terminal dispatch shows composer; sending posts to the turns route and swaps in the thread; terminal dispatch shows the closed-state footer (existing behavior preserved).
**Estimate:** 1.5–2 days.

### P4.5 Real cancel (`map/dispatches/cancel` + reconcile fix + ack UI) — ◑ Layer 1 shipped

**Goal:** cancel verifiably stops a running agent; the UI shows acknowledged vs not.

**As-built — Layer 1 (reconcile fix, fully in-repo):**
- Root cause: `dispatchToTask` maps a `cancelled` row to `task.status === 'cancelled'`, but swarm-dispatch's `defaultShouldStop` only stops on `closed`/`blocked` (+ claim theft). So `POST /dispatches/:id/cancel` flipped the DB row (and broadcast `dispatch.cancelled`) but the running ACP agent kept churning until the 5-min stall timeout.
- Fix: exported `reconcileShouldStop(task, record)` (`dispatch/openhive-source.ts`) — stops on any terminal dispatch status (`cancelled`/`complete`/`failed`) plus the preserved library defaults (`closed`/`blocked` + claim theft). Wired as `reconcile.shouldStop` in `dispatch/setup.ts`. Now the 5s reconcile tick calls `cancelExecutor` → `runtime.terminate` (ACP `closeStream`) within ~5s of a cancel. Cancel-route doc comment updated to reflect this.
- Tests: `openhive-source.test.ts` — `reconcileShouldStop` stops on cancelled/terminal, keeps active running, honors claim theft. All 264 dispatch/DAL tests green; typecheck clean.

**Deferred — Layers 2 & 3 (cross-repo, need sidecar consumer):**
- **Layer 2 (`map/dispatches/cancel` proactive push):** mail-routed agents are skipped by the library reconcile loop (`record.origin === 'mail'`), so reconcile can't stop them. A hub→agent MAP push is needed for immediate/mail cancel, but the *consumer* (cooperative stop + ack) is a macro-agent / claude-code-swarm sidecar change — same shape as the P3 relay fix. Left for a cross-repo pass.
- **Layer 3 (ack UI success path):** the `cancel_not_acked` failure ribbon already renders; the `dispatch.cancel_acknowledged` success state depends on an agent actually acking (Layer 2). Deferred with Layer 2.

**Build — three layers (ground truth #9):**
1. **Fix the reconcile fallback (cheapest, highest value first):** pass `reconcile.shouldStop` in `setup.ts:147-155` derived from the source's `isStillActive` (`openhive-source.ts:460-461`) so a DB `cancelled` reliably triggers swarm-dispatch's `cancelExecutor` (`x-dispatch/cancel` for mail, `runtime.terminate`→`closeStream` for ACP). Address the mail-origin reconcile skip (`dispatcher.js:812-814`) — either don't skip on cancel, or send the cancel envelope directly.
2. **Add `map/dispatches/cancel` MAP method** (`src/map/dispatch-handler.ts`, registered in `map-server-setup.ts:172-186`): hub → agent push over the existing MAP WS to a connected executor, so cancel is proactive rather than waiting on the 5 s reconcile tick. Wire `POST /dispatches/:id/cancel` to fire it alongside the DB update.
3. **Ack plumbing + UI:** emit `dispatch.cancel_acknowledged` when the agent acks (or reports terminal post-cancel) and keep the existing `dispatch.cancel_not_acked` for timeout. The ack ribbon UI already exists (`DispatchDetail.tsx:216-235`); wire the success state (only the failure path is currently reachable).

**Cross-repo note:** the *agent-side* consumer of `map/dispatches/cancel` (cooperative stop + ack) is a sidecar/runtime change (macro-agent / claude-code-swarm), tracked like the P3 macro-agent relay fix. Layer 1 (reconcile fix) delivers a working stop for ACP-spawned agents **without** any sidecar change and should ship first.

**Tests:** unit — REST cancel with a connected executor invokes the MAP cancel push; reconcile `shouldStop` returns true for a `cancelled` row; ack event flips the UI ribbon. Integration — cancel a running ACP dispatch → `closeStream` called (extend `loadout-dispatch-runtime-broader.test.ts:231-235`).
**Estimate:** 2.5–3 days (Layer 1 ~0.5 day standalone).

---

## P5 — Validate & Close

> **Status — all four shipped.** P5.1–P5.4 landed in-repo. Deviations noted per item; the only deferrals are the *inline* StackDiffView on the outcome view (P5.2 — deep link + labeled fallback shipped instead) and cross-repo agent cooperation (none required for P5). Typecheck clean; web 734 green, server dispatch/spec/map suites green.

### P5.1 Outcome-view action bar (Accept & close · Dispatch validation · Send back) — ✅ Implemented

**As-built:** new `OutcomeActionBar` (`src/web/components/dispatch/OutcomeActionBar.tsx`) rendered on terminal `complete` in `DispatchDetail` above the Outcome panel.
- **Accept & close** — confirm-then-fire; closes every linked opentask via `useUpdateOpenTaskStatus(spec_resource_id).mutateAsync({ nodeId, status: 'closed' })`, shows an "Accepted" state + toast.
- **Dispatch validation** — opens the P5.3 `DispatchModal` validation preset (state lifted into `DispatchDetail`).
- **Send back** — navigates to the spec discussion thread (`/specs/:rid/:sid?tab=discussion`); the dispatch coordination thread is closed at terminal, so replies land in the spec thread (P3) as designed.
- Tests: `OutcomeActionBar.test.tsx` — three actions render, Accept&close confirms→closes all linked tasks→shows Accepted, validation fires the callback, Send back navigates to the discussion tab.

### P5.1 (original plan)

**Goal:** a completed dispatch's outcome view offers the three Flow 5 actions inline.

**Build:** add an action bar to the Outcome panel (`DispatchDetail.tsx:523-578`), shown on terminal `complete`.
- **Accept & close** — one click over `data.linked_tasks` (already on the GET dispatch response, `DispatchDetail.tsx:474-521`) calling `useUpdateOpenTaskStatus(...).mutate({ status: 'closed' })` per task (`useApi.ts:1137-1160`). Confirm-then-fire; optimistic status chips.
- **Dispatch validation** → P5.3 preset.
- **Send back** — opens the spec discussion thread reply (dispatch coordination thread is closed at terminal, `DispatchThreadSection.tsx:292-302`); reply lands in the spec thread (P3), with an optional "re-dispatch" that reopens `DispatchModal` prefilled.

**Tests:** component — Accept & close closes all linked tasks and reflects closed chips; buttons only render on terminal complete.
**Estimate:** 1.5 days.

### P5.2 Deep-link outcome → cascade stream diff (with labeled fallback) — ✅ Implemented (inline diff deferred)

**As-built:** pure helper `resolveCascadeStreamRow` / `cascadeStreamDeepLink` (`src/web/components/dispatch/cascade-link.ts`) maps a `cascade_stream` artifact ref (`${swarm_id}/${runtime_stream_id}`) to the Changes-hub row via the DAG nodes already fetched by `DispatchDetail` (`useCascadeDAG`), producing `/changes?stream=<row_id>` (matches `Changes.tsx`'s `n.id === streamParam` selector). Outcome artifacts now render a rich "View diff →" deep link (status dot + commit count) when resolvable, and a clearly labeled "(diff not indexed · browse Changes →)" fallback otherwise (principle 4). Both dispatch→Changes link styles are unified on the row-id deep link.
- **Deviation:** resolved UI-side from the DAG cache rather than embedding the row id at `finalizeDispatch` time. This needs no schema change and works for already-finalized dispatches; the artifact shape stays `{kind, ref}`. The **inline `StackDiffView`** on the outcome view is deferred — the deep link + labeled fallback deliver the core "one hop to the diff" goal.
- Tests: `cascade-link.test.ts` — ref resolves to the correct row id; deep link built when resolvable; null (→ fallback) when not indexed.

### P5.2 (original plan)

**Goal:** the outcome view links straight to the diff, not the Changes list.

**Build (ground truth #12):**
- Map the outcome artifact's `cascade_stream` ref (`{swarm_id}/{runtime_stream_id}`) to the Changes hub row id so the link becomes `/changes?stream=<row_id>` (matching `Changes.tsx:163-177`). Cleanest: store the row id in the artifact at `finalizeDispatch` time (`finalize.ts`, which already joins `findCascadeStreamsByTaskRefs`) rather than resolving in the UI.
- Prefer an **inline diff** on the outcome view via the existing `StackDiffView` when a stream is resolvable; **files-touched fallback**, clearly labeled per principle 4, when no diff capability is present.
- Unify the two dispatch→Changes link styles (outcome artifact vs "Changes opened" heuristic) onto the row-id deep link.

**Tests:** unit — artifact ref resolves to the correct row id; UI test — outcome renders a deep link (not `/changes`) when a stream row exists, fallback label otherwise.
**Estimate:** 1.5–2 days.

### P5.3 Dispatch-validation preset — ✅ Implemented

**As-built:** `DispatchModal` gained an optional `validationPreset` prop (`{ summary, executorSwarmId, streamRef }`). When present, an effect (once per open) prefills a reviewer prompt template (`buildValidationPrompt` — spec title + outcome summary + stream ref + "post APPROVED / CHANGES REQUESTED"), sets `role: 'reviewer'`, expands Advanced, and defaults the target to a swarm *other* than the executor. `DispatchDetail`'s "Dispatch validation" button opens it with the completed dispatch's `outcome.summary`, `target_swarm_id`, and the `cascade_stream` ref.
- The role input now also renders when a `role` is set (not just team/loadout), so the reviewer role is visible/editable.
- The verdict → spec thread posting is the P5.4 wiring (role-driven, no new posting primitive).
- Tests: `DispatchModal.test.tsx` — preset prefills reviewer role, prompt template (summary + streamRef), and a non-executor swarm.

### P5.3 (original plan)

**Goal:** one click opens `DispatchModal` prefilled with a reviewer-role prompt (outcome summary + stream link + spec acceptance criteria), targeting a different swarm.

**Build:** reuses P4.1's expanded modal — this is a *preset*, not new dispatch machinery.
- "Dispatch validation" (P5.1) opens `DispatchModal` with: prompt template pre-filled from the completed dispatch's `outcome.summary` + the P5.2 stream deep link + the spec's acceptance criteria (already available to `prompt.ts:81-86`); `role` defaulted to `reviewer`; target swarm defaulted to one *other* than the executor.
- On completion, the validator's verdict posts to the spec thread via **P5.4/P3.5's `postSpecThreadOutcome`** — no new posting primitive.

**Tests:** component — validation preset opens the modal with template + reviewer role + spec ≠ executor swarm prefilled.
**Estimate:** 1 day (assuming P4.1 modal landed).

### P5.4 Completion → attention queue (+ validator verdict → spec thread) — ✅ Implemented

**As-built:**
- **Attention queue:** added a `'dispatch'` `AttentionKind` + `dispatchThreadKey` + `markDispatch` to `session-attention.ts`. `useGlobalAttention` now also subscribes to `map:dispatches` and listens for `dispatch.completed` / `dispatch.dead`, pushing a dispatch attention item (+ deduped toast). `AttentionBell` deep-links `dispatch:<id>` → `/dispatch/:id`, renders a Sparkles icon + status label, and clears the item on click; `DispatchDetail` also clears it on view.
- **Validator verdict → spec thread:** `postSpecThreadOutcome` gained an optional `kind: 'dispatch' | 'validation'`; both terminal callers (`map/dispatch-handler.ts`, `dispatch/setup.ts`) pass `kind: role === 'reviewer' ? 'validation' : 'dispatch'`. A reviewer-role dispatch now narrates "Validation by <swarm> completed. <verdict> …" (metadata `kind: 'validation'`) instead of a generic dispatch outcome. Pure wiring of the existing P3 primitive + the persisted `role` (V-P4.1) — no new posting path.
- Tests: `session-attention.test.ts` (dispatch item upsert/clear), `useGlobalAttention.test.ts` (`dispatch.completed` complete/failed + `dispatch.dead` → attention item with deep-link key), `spec-thread-outcome.test.ts` (validation verdict narrative). Also updated the subscribe assertion to `['global', 'map:dispatches']`.

### P5.4 (original plan)

**Goal:** a dispatch completion becomes an attention item ("codex-1 finished *Add rate limiting* — review"); validator verdicts narrate into the spec thread.

**Build — reuses shipped Flow 2 infra (ground truth #13, #14):**
- Add a `dispatch` (or `review`) `AttentionKind` to `src/web/stores/session-attention.ts:6-11`; listen for `dispatch.completed` / `dispatch.dead` in `useGlobalAttention.ts` (today only `useDispatchRealtime` invalidates), pushing an attention item + toast.
- Teach `AttentionBell` to deep-link a `dispatch:<id>` key to `/dispatch/:id` (currently `session:`/`hosted-chat:`/`stream:` only).
- **Validator verdict → spec thread:** the validation dispatch (P5.3) already flows through the terminal paths that call `postSpecThreadOutcome` (`setup.ts:270-306`, `dispatch-handler.ts:149-174`); give validator dispatches a distinct narrative/metadata so the verdict reads as a review outcome, not a generic dispatch outcome. Pure wiring of an existing primitive.

**Tests:** unit — `dispatch.completed` WS event adds an attention item with the right deep link; validation dispatch terminal posts a verdict turn when the spec thread exists (extend `spec-thread-outcome.test.ts`).
**Estimate:** 1.5 days.

---

## Sequencing & dependencies

```
P4.1 (modal + runtime wiring) ─┬─► P4.2 (coordinated team) ─► P4.4 (unified thread UI)
                               └─► P5.3 (validation preset) ──► P5.4 (attention + verdict)
P4.3 (spec rollup) ── independent, reads existing rows
P4.5 (real cancel) ── independent backend/runtime track (Layer 1 first)
P5.1 (outcome actions) ─► P5.2 (diff deep link) ─► P5.3
```

- **P4.1 is the linchpin** — its modal is reused by P5.3, and its runtime-wiring half (row loadout/team/role) is the biggest hidden work item; do it first.
- **P4.5 Layer 1** (reconcile `shouldStop` fix) is a ~0.5-day standalone win that makes cancel work for ACP agents immediately; land it early even before the full MAP-method work.
- **P5.1 → P5.2 → P5.3 → P5.4** is a clean chain; P5.4 and the validator-verdict piece are mostly wiring the already-shipped Flow 2 store and P3 `postSpecThreadOutcome`.
- **Total:** P4 ≈ 10–12 days, P5 ≈ 7 days. Cross-repo agent-side cancel consumer (P4.5) tracked separately.

## Derisk findings — hazards to resolve before/while building

1. **Loadout/team/role runtime gap (P4.1) — must-fix, not optional.** Exposing these in the modal without wiring `enrichWithLoadout` to read row bundles ships a lie: the fields persist but do nothing. Repo + lifecycle are safe (already end-to-end).
2. **Shared-thread permission scoping + column contention (P4.2).** Coordinated mode must be opt-in (respects the documented objection) and must use a *separate* conversation id (not the transport-contended `dispatches.conversation_id`). Homogeneous-loadout assumption should be surfaced in the modal copy.
3. **Reconcile predicate + mail-origin skip (P4.5).** OpenHive doesn't pass `reconcile.shouldStop`, and the library default ignores `cancelled`; reconcile also skips mail-origin records. Without fixing both, "cancel" remains DB-only regardless of the new MAP method for mail-routed agents.
4. **Diff deep-link id space (P5.2).** Artifact ref uses the runtime `stream_id`; the Changes route wants the hub row id. Resolve at `finalizeDispatch` time to avoid a fragile UI-side lookup.
5. **Agent-side cancel consumer is cross-repo (P4.5).** Like the P3 macro-agent relay, cooperative stop + ack needs a sidecar change; ship the reconcile-fallback (ACP) path first so the OpenHive-only change is independently useful.
6. **`thread_tag` vs `conversation_id` mismatch (P4.2).** The prompt currently advertises a tag that isn't the real conversation id; the peer-roster work must advertise the actual shared id or agents post into the wrong (auto-created) thread.

## Live e2e validation (2026-07-03)

Ran a live browser pass against a Docker Compose build (`docker compose up -d --build`)
with a seeded completed dispatch (`disp_e2e_1`) linked to spec `c-154g` and a
`cascade_streams` row (`cs_e2e_1`). Local auth mode auto-authenticates, so no login.

- **P5.1 — ✅ verified live.** Outcome action bar renders all three actions.
  *Accept & close* → confirm → actually closed the linked opentask (`t-35j7`
  flipped to `closed` in the opentasks graph) and the bar switched to
  *Accepted*. *Send back* navigated to `…/c-154g?tab=discussion`.
- **P5.2 — ✅ verified live.** *View diff →* navigated to
  `/changes?stream=cs_e2e_1` (hub **row id**, not the runtime `stream_id`) and
  the Changes hub opened with the stream's detail panel selected.
- **P5.3 — ✅ verified live after a fix.** **Bug found:** the reviewer
  prompt/role/Advanced prefill was gated behind `dispatchable.length > 0`, so a
  hub with **no online swarms** opened a blank modal. Fixed by splitting the
  text prefill (immediate) from swarm auto-select (best-effort once loaded);
  added a zero-swarm regression test. Re-verified live: modal now prefills the
  reviewer template, expands Advanced, and sets role=`reviewer` even with zero
  swarms. (commit `04f2c51`)
- **P5.4 — covered by unit tests, not live.** `dispatch.completed`/`dispatch.dead`
  only originate from a MAP-connected agent report (no HTTP shim), so a live
  trigger needs a registered executor swarm — out of scope for this UI change.
  WS→store→bell is covered by `useGlobalAttention.test.ts` +
  `session-attention.test.ts`.

**Env defects found + fixed (not P4/P5, but Docker-deployment bugs) — commit `a80d857`:**

1. **Daemon auto-start always failed in the production image.** `opentasks` ships
   an ESM-only `exports` map (no `./package.json` subpath), so
   `require.resolve('opentasks/package.json')` threw `ERR_PACKAGE_PATH_NOT_EXPORTED`
   under the bundled server's CJS `createRequire`; the code silently fell back to
   spawning a bare `opentasks` (not on `$PATH` in the image) → ENOENT →
   `POST /specs` 500 until the daemon was started by hand. Fixed with
   `resolveOpentasksCliPath()` (walks `node_modules` off disk, reads the package's
   own `bin`).
2. **EACCES crash-loop on first start.** The image never set `OPENHIVE_HOME`, so
   `resolveDataDir()` fell back to `os.homedir()/.openhive`
   (`/home/openhive/.openhive`), unwritable by the `useradd -r` system user. Fixed
   by pinning `OPENHIVE_HOME=/app/data` in the Dockerfile (compose also sets it).

Both require an image rebuild to take effect.

## Open questions

- **Rollup scope:** does "is this spec done?" aggregate over dispatch rows only, or also fold in linked-task statuses (a dispatch can complete while its task stays open)? Plan assumes both, dispatch-status-primary.
- **Coordinated-team executor divergence:** if two coordinated executors resolve *different* loadouts, do we warn in the modal or block? (Non-goal this cycle is hub-side work splitting; agents divide via the shared thread.)
- **Validator target default (P5.3):** auto-pick any other online swarm, or require explicit selection? Plan defaults to "prefer a different swarm, user-overridable."
