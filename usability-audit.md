# OpenHive Usability Audit

**Date:** 2026-07-01
**Scope:** UX flow audit against the core use case — coordinate multiple agents, create specs and discussions around them, dispatch agents to implement tasks, and validate results.
**Method:** Parallel deep-dives across the work pipeline (specs → dispatches → tasks), the chat/mail/threads surface, multi-agent coordination, and frontend route wiring.

---

## Bottom line

OpenHive is **architecturally complete but has a cold-start tax**. The backend, dispatch orchestrator, and ~40 frontend pages are real and wired to `/api/v1`. The friction is that the target workflow requires assembling four things before delivering any value, and two of them live outside this repo:

1. A **connected swarm** that declares capabilities (ACP/mail) at registration.
2. An **OpenTasks daemon** running per agent (Unix-socket IPC).
3. A **spec authored into an OpenTasks graph** (writes are local-daemon-only; remote returns `503`).
4. The **agent-side sidecar** (`cc-swarm` / `macro-agent`, `pushSyncEvent`) — these live under `references/`, which is **empty in this workspace**.

Compared to opening N terminal agents directly, OpenHive asks the user to stand up a daemon + sidecar + capability declaration + spec graph first. That is the primary reason for non-adoption.

---

## What works end-to-end today

The happy path is real and tested (behind `LIVE_AGENT_E2E`):

```
/specs/new  →  spec in OpenTasks graph
   → SpecDetail → Dispatch modal → POST /specs/:rid/:id/dispatch
   → dispatches row (queued) + dispatch_linked_tasks captured from graph neighbors
   → orchestrator polls (~15s) → claims → running → linked tasks open→in_progress
   → routes: mail-first, else ACP spawn (Codex optional)
   → agent reports via map/dispatches/report → complete/failed
   → cascade merge → task-binder may auto-close the task
```

Confirmed functional:

- Spec list / detail / create (`/specs`, `/specs/new`, `/specs/:rid/:id`).
- Dispatch fan-out to N swarms; orchestrator claim / retry / stall-reconcile.
- Dispatch kill switch (admin + MAP block; in-memory).
- Schedules (cron) full CRUD + cron preview.
- Task graph board / hierarchy / sigma views; multi-graph merge.
- Changes (cascade) triage with capability-gated actions.
- Unified Threads surface: live ACP chat + async mail + hosted chat/TUI.
- Realtime WS invalidation across specs, dispatches, schedules, tasks.

---

## Enumerated issues

Priority: **P0** = blocks the target workflow · **P1** = major friction · **P2** = polish / correctness.

### P0 — Blocks the coordinate/discuss/dispatch/validate loop

| # | Issue | Impact | Evidence |
|---|-------|--------|----------|
| 1 | **No "discuss a spec" primitive** | Cannot open a discussion on a spec. Threads are only created *lazily after an agent posts* to a dispatch. No "New thread" button exists anywhere. This is the missing "create specs and discussions around them" surface. | `Sessions.tsx:339`, `dispatch-conversation.ts` (lazy create), design-only in `docs/design/spec-to-swarm.md` |
| 2 | **Cross-agent task sync requires external sidecar** | Inter-agent coordination (the core value) depends on `pushSyncEvent` in `cc-swarm`, not present in this repo. Hub is relay-only and cannot converge task graphs itself. | `coordination/CLAUDE.md:46`, `coordination/compat.ts` (no-ops), `references/` empty |
| 3 | **Cold start / external dependencies** | Target flow needs OpenTasks daemon + agent sidecar + capability declaration + local spec graph before any value. No one-command bootstrap. | `map/CLAUDE.md:109`, `task-daemon-lifecycle.ts:1`, tests at `opentasks-two-agent-coordination-e2e.test.ts:51` |

### P1 — Major friction

| # | Issue | Impact | Evidence |
|---|-------|--------|----------|
| 4 | **Dispatch modal is a thin subset of the backend** | UI sends only `target_swarms` + `prompt`. Backend already supports loadout, team template, repo/branch/commit, and ACP-vs-mail lifecycle — none surfaced. Blocks the "dispatch a configured team to a repo" story. | `DispatchModal.tsx:115` vs `specs.ts:67` |
| 5 | **Cancel does not stop the agent** | REST cancel marks the DB row only; there is no `map/dispatches/cancel` sent to the agent. Runaway agents keep running, so autonomous dispatch can't be trusted. | `dispatches.ts:155` |
| 6 | **No spec-level aggregate status** | Dispatching a spec to N swarms creates N independent rows with no rollup of "is this spec done." No single progress view to replace tracking N terminals. | `dispatch/CLAUDE.md:114` |
| 7 | **Remote spec/task writes return 503** | Spec authoring (create/update/links) only works against a *local* daemon; federated/remote resources are read-only for writes. | `specs.ts:617`, `map/task-handler.ts:462` |
| 8 | **Advance-on-start only works on local linked tasks** | Linked tasks on remote graphs are not advanced to `in_progress` when a dispatch claims them. | `map/task-handler.ts:462`, `dispatch/start.ts:22` |
| 9 | **Dispatch thread UI not on the unified chat contract** | `DispatchThreadSection` is hand-rolled bubbles + direct POST, not `ChatMessageList`/`ChatInput`. Loses permission dialogs, streaming, mode badges. | `DispatchThreadSection.tsx` vs `MailThreadView.tsx` |
| 10 | **User cannot start a dispatch thread from the UI** | Backend lazy-creates the conversation on first message, but the UI hides the section until `conversation_id` exists (`if (!conversationId) return null`). Chicken-and-egg. | `DispatchThreadSection.tsx:190`, `dispatches.ts:213` |

### P2 — Correctness / polish

| # | Issue | Impact | Evidence |
|---|-------|--------|----------|
| 11 | **Inject transport declared but omitted** | Capability may appear in UI, but no route backs it; inject-only agents show unavailable. | `openhive-adapters.ts:56`, `web/CLAUDE.md:62` |
| 12 | **Kill switch not durable** | `autonomousDispatchPaused` is in-memory; resets on hub restart. | `map/dispatch-policy.ts:10` |
| 13 | **Broken Sign Up link** | Sidebar links `/register`; no route exists → catch-all redirect to `/`. | `Sidebar.tsx:295` vs `App.tsx` |
| 14 | **No REST create for standalone mail thread** | Humans can't create a standalone mail conversation via API; only MAP `mail/create` (agents) or lazy paths. | `mail.ts` (no POST create) |
| 15 | **No `fire-now` on schedules / no `fire_id` correlation** | Schedule fires are linked only via `initiator_id`; no immediate-fire and no per-fire correlation id. | `schedules.ts:13`, `scheduler/CLAUDE.md:33` |
| 16 | **Experiments: no create UI** | List is monitor-only; experiments created via agents/API. | `Experiments.tsx` |
| 17 | **Learning is config-gated** | Empty state unless `learning.enabled` in server config. | `Learning.tsx:40` |
| 18 | **Task auto-close is not automatic** | Task closure only via cascade merge + opt-in `close_policy` (default `manual`), not on dispatch complete. | `cascade/CLAUDE.md:94` |
| 19 | **Platform bridge inbound is a no-op** | Slack/Discord inbound neutralized after social-layer removal. | `bridge/inbound.ts:1` |
| 20 | **`message.sent` task-event may pass wrong swarm id** | Interceptor passes `resolvedAgentId` instead of `resolvedSwarmId`; `getDefaultTaskGraph` may fail on this path. | `ws-map.ts:656` vs `ws-map.ts:392` |
| 21 | **About page unreachable from nav** | Routed at `/about` but no in-app link. | `App.tsx:89` |
| 22 | **Multi-repo spawn UI / pinned auto-bind not surfaced** | Spawn auto-bind is validation-only; multi-repo workspace UI not shown. | `Swarms.tsx:213`, `Swarms.tsx:1137` |

---

## Recommendations (by leverage)

1. **Make specs the discussion hub** *(fixes #1)* — add a spec-scoped thread that exists before dispatch (`POST /specs/:rid/:id/thread` → mail conversation with `spec_id` metadata), rendered on `SpecDetail` via the existing `useChatChannel` contract.
2. **Expand the Dispatch modal** *(fixes #4)* — surface loadout / team-template / repo selection already supported server-side. Near-zero backend work; turns "dispatch a prompt" into "dispatch a configured team to a repo."
3. **Wire real cancel** *(fixes #5)* — `map/dispatches/cancel` → agent, so autonomous dispatch is trustworthy.
4. **Add a spec rollup view** *(fixes #6)* — aggregate N dispatch rows + linked-task statuses into one "spec progress" panel on `SpecDetail`.
5. **Solve cold start** *(fixes #2, #3)* — vendor the `cc-swarm`/`macro-agent` sidecars (or a one-command bootstrap), or make **hosted swarms** (`SwarmManager` spawn) the default onboarding path so a new user gets a capable agent without external setup.
6. **Unify the dispatch thread onto the chat contract** *(fixes #9, #10)* — replace `DispatchThreadSection` with `ChatMessageList`/`ChatInput`.

**Suggested first slice:** #1 + #2 together convert "I'd rather use terminals" into "I can spec, discuss, and dispatch a team from one page."

---

# Part 2 — Flow redesign analysis (second pass)

**Date:** 2026-07-01 (same day, second pass)
**Method:** Four parallel deep-dives — first-run journey, terminal-parity cockpit analysis, spec→dispatch→validate verification, hub-only coordination inventory — layered on top of Part 1. Re-verified Part 1 claims against HEAD (`5b4c8e5`, post-experiments/swarm-codex/ui-consistency merges).

## Root-cause diagnosis: why terminals still win

Part 1 framed the problem as cold-start tax. The second pass sharpens it into five root causes. The first two are the real adoption killers because they hit *before* any coordination value is visible:

1. **The advertised pipeline is unreachable on day zero.** The Jobs empty state points to Specs; `/specs/new` requires an OpenTasks task graph that a fresh instance has no UI to create (`SpecNew.tsx:71-73,122-131` shows "No OpenTasks task graphs are accessible" — a dead end). Meanwhile the path that *does* work in ~13 steps — spawn hosted Codex (RPC) → Threads → chat — is advertised nowhere: not in the Threads empty state, not in Specs, not in the wizard.
2. **OpenHive is a single-focus cockpit; terminals are N-focus.** Threads is master-detail with one visible pane (`Sessions.tsx:818-843`). A permission request from an agent you're *not* viewing is invisible — no list indicator, no global queue (the `attentionCount()` helper exists in `session-attention.ts` but is never wired to the sidebar). With N terminals, every pane's state (working / blocked-on-permission / idle / done) is ambiently visible. This is the daily-driver gap.
3. **Session start friction.** Terminal: 1 command. OpenHive: no "New session" button on Threads at all; the paths that exist run through the Spawn dialog (8–12 steps) or require a pre-registered ACP-capable agent (ChatFab picker). `acp-connect` is deliberately two-step server-side (`sessions.ts:1453-1462`).
4. **Coordination value is locked behind the sidecar.** Confirmed and sharpened from Part 1 #2: the hub-only layer *does* fully support agent↔agent mail with human participation (`src/mail/index.ts:281-379`, push bridge + retry queue), dispatch fan-out with lazy per-dispatch threads, task *observability* relay, and presence. What requires `cc-swarm`/`pushSyncEvent` is specifically **task-graph convergence across daemons**. Notably, dispatched agents are *not* mutually aware — `openhive-roster.ts` is executor selection for the orchestrator, not peer-roster injection; fan-out to 3 swarms creates 3 independent rows whose agents don't know about each other (`prompt.ts:106-126` mentions only initiator + linked tasks).
5. **Validation is observe-only.** After a dispatch completes: DispatchDetail outcome → Changes diff (good, capability-gated on `cascade.canServeDiff`) → then *manual* task close via the graph sidebar, or opt-in `close_policy: on_merge`. There is no reviewer/validator dispatch concept, no "validate this" one-click, no acceptance capture tied to the outcome.

## Part 1 claim verification (against HEAD)

| # | Claim | Verdict |
|---|-------|---------|
| 1 | No pre-dispatch spec discussion | **Still true** — no spec thread route; feedback nodes are graph nodes, not threads |
| 4 | Thin dispatch modal | **Still true** — backend `DispatchSpecSchema` has loadout/team/repo/lifecycle (`specs.ts:67-105`); UI sends `target_swarms` + `prompt` only. New: swarm-codex executor targets + sandbox warning added to modal |
| 5 | Cancel doesn't stop agent | **Partially mitigated** — still no `map/dispatches/cancel`, but orchestrator reconcile (5s, `dispatch/setup.ts:147-155`) attempts `runtime.terminate` on external cancel, and DispatchDetail shows a `cancel_not_acked` warning ribbon. Unreliable for mail/offline swarms |
| 6 | No spec rollup | **Still true** — `LineageRail` (ui-consistency pass) adds pipeline navigation, not aggregate progress |
| 7 | Remote spec writes 503 | **Still true** (`specs.ts:642-647`, PATCH and link/unlink same) |
| 10 | Thread hidden until `conversation_id` | **Still true** — and worse than the file comment claims: it's `return null`, not a muted placeholder (`DispatchThreadSection.tsx:190-193`) |
| 16 | Experiments monitor-only | **Upgrade** — `ExperimentDetail` can now launch/pause/resume/archive runs; create-experiment UI still absent. The experiment control plane (autonomation harness optimization) is orthogonal to the coordinate/dispatch/validate loop |

New issues found in the second pass:

| # | Issue | Evidence |
|---|-------|----------|
| 23 | README documents retired preauth keys; real flow is `openhive admin onboard-token` | `README.md:258-296` vs `src/api/skill-fragments/map.ts:44-59`, `src/cli/admin/onboard-token.ts:23` |
| 24 | Mail skill fragment advertises `POST /mail/conversations` which doesn't exist | `src/api/skill-fragments/mail.ts:25` vs `src/api/routes/mail.ts` (no create route) |
| 25 | `mail/*` sent with a JSON-RPC `id` (request, not notification) falls through to MAPServer with no handler and fails | `src/map/ws-map.ts:385-386`, `map-server-setup.ts:267-270` |
| 26 | Hosted-swarm spawn prerequisites (binaries on PATH, API keys, cc-swarm plugin, node-pty) are invisible until a post-submit toast error | `src/swarm/manager.ts:818-823,1192-1197`, `src/server.ts:329-336` |
| 27 | Coordination REST messages persist + broadcast to UI but are never delivered to connected agents (`sendToSwarm` absent) | `src/messaging/service.ts:7-33` |
| 28 | No cancel button on SessionDetail chat — ACP cancel exists server-side but the UI lives only in ChatFab's ChipsComposer | `openhive-acp-service.ts:608-610`, `ChipsComposer.tsx:124-126,179` vs `SessionDetail.tsx:457` |

## What already exists but is buried

The parity analysis found that much of the "cockpit" is built and merely unsurfaced:

- **Hosted Claude/Codex TUI in Threads** (`/threads/hosted-tui/:id`) — a real embedded PTY, the closest thing to terminal parity, reachable only via a quick-open icon on the Swarms page.
- **ChatFab docked mode** — persistent side chat while browsing Work pages.
- **Multi-tab ACP session sharing** — `acp-connect` is idempotent per (swarm, agent) pair (`sessions.ts:1552-1567`), so N browser tabs already work.
- **Durable resume** — per-session Resume + SwarmDetail "Resume all" (`POST /map/swarms/:id/resume-all`) via `provider_session_id`.
- **Attention pulses + idle toasts** — `trajectory:sync` idle detection marks rows and toasts (`useRealtimeInvalidation.ts:168-191`); only per-row, never aggregated.
- **Spawn with cwd + initial prompt** (`ccInitialPrompt`) — pre-seed a session like typing the first message.
- **Agent↔agent mail with human join** — fully functional hub-side including offline retry queues; no UI to *start* such a thread.

## Revised recommendations — two slices

### Slice A: win the daily-driver comparison (cockpit parity)

This is what changes whether you open OpenHive instead of iTerm tomorrow. All items are frontend-heavy with existing backend support:

1. **"New session" as a first-class action on Threads.** One button → picker: (a) spawn hosted Codex RPC / Claude TUI with cwd + initial prompt, (b) connect to an online ACP agent. Collapses the 8–12-step spawn journey into the flow where you already are. Fix the Threads/Specs/Jobs empty states to point at this instead of the unreachable spec path.
2. **Global attention queue.** Aggregate permission-pending + idle-awaiting-input across all sessions into a sidebar badge + dropdown (wire the existing `attentionCount`; add permission state to thread rows). This is the single biggest terminal-parity gap: with it, you can safely *not watch* N agents.
3. **Multi-pane thread grid.** A 2×2 (or N-up) grid view over the existing thread detail panes — the "tmux view". Multi-tab ACP sharing means the session plumbing already tolerates this.
4. **Unify session chat affordances.** Add cancel (exists in ChipsComposer) and the terminal tab to SessionDetail consistently; replace `DispatchThreadSection` with `ChatMessageList`/`ChatInput` (Part 1 rec #6) so dispatch threads get permissions/streaming for free.

### Slice B: make the coordination pipeline reachable and trustworthy

5. **Fix day zero.** Either a "Create task graph" action (hosted daemon or hub-local graph) so `/specs/new` works on a fresh instance, or make spec creation bootstrap a graph implicitly. Without this, the entire Work pipeline is demo-only.
6. **Spec discussion thread + rollup** (Part 1 recs #1, #4). Now strengthened: the mail layer is verified functional end-to-end hub-side, so `POST /specs/:rid/:id/thread` is genuinely a thin route + SpecDetail panel on the existing `useChatChannel` contract.
7. **Expand the dispatch modal** (Part 1 rec #2) — loadout / team template / repo/branch fields already validated server-side.
8. **Peer-aware dispatch.** When fanning one spec to N swarms, inject a peer roster into the prompt and auto-invite all executors + initiator into *one* shared mail thread (instead of N lazy per-dispatch threads). This converts fan-out from "N independent workers" into actual multi-agent coordination using only existing hub primitives — no sidecar required.
9. **Validator dispatch preset.** On a completed dispatch: "Dispatch validation" button → re-dispatch to a chosen swarm with a reviewer-role prompt template containing the outcome summary + cascade stream link. Cheap (reuses the existing dispatch path) and closes the validate loop.
10. **Finish real cancel** — `map/dispatches/cancel` MAP method so the reconcile-terminate mitigation isn't the only line of defense.
11. **Doc hygiene** — fix README preauth section (#23) and the mail skill fragment (#24); surface the onboard-token one-liner in the web Connect dialog.

**Sequencing argument:** Part 1 suggested spec-thread + dispatch-modal as the first slice. The second pass reorders this: without Slice A you won't *be in the app* long enough for Slice B to matter, and without item 5 the spec pipeline can't even start on a real fresh instance. Recommended order: **1 → 2 → 5 → 6 → 8**, then the rest.

**→ These recommendations are consolidated into five north-star UX flows with a phased implementation sequence in [`docs/design/north-star-flows.md`](docs/design/north-star-flows.md).**

---

## Key file index

| Concern | Path |
|---------|------|
| Specs routes | `src/api/routes/specs.ts` |
| Dispatch routes | `src/api/routes/dispatches.ts` |
| Dispatch orchestrator | `src/dispatch/setup.ts`, `src/dispatch/routing.ts`, `src/dispatch/openhive-roster.ts` |
| Dispatch conversation factory | `src/dispatch/dispatch-conversation.ts` |
| Mail routes | `src/api/routes/mail.ts` |
| Session chat bridge | `src/api/routes/session-chat.ts` |
| Coordination relay | `src/coordination/listener.ts`, `src/coordination/compat.ts` |
| MAP hub + registration | `src/map/ws-map.ts`, `src/map/connection-registry.ts` |
| Task proxy | `src/map/task-handler.ts`, `src/map/opentasks-remote.ts` |
| Swarm hosting | `src/swarm/manager.ts` |
| Threads UI | `src/web/pages/Sessions.tsx`, `src/web/pages/SessionDetail.tsx` |
| Dispatch UI | `src/web/pages/DispatchDetail.tsx`, `src/web/components/dispatch/DispatchModal.tsx`, `src/web/components/dispatch/DispatchThreadSection.tsx` |
| Spec UI | `src/web/pages/SpecDetail.tsx` |
| Chat contract | `src/web/CLAUDE.md`, `src/web/lib/chat/resolvers.ts`, `src/web/adapters/openhive-adapters.ts` |
