# North Star Flows — Wave 1 Implementation Plan (P1 Cockpit + P2 Day Zero)

**Date:** 2026-07-01
**Status:** Proposed
**Parent:** [`north-star-flows.md`](north-star-flows.md) (phases P1 + P2, which run in parallel)
**Grounding:** all file:line references verified against HEAD `5b4c8e5`

## Spike results that shape this plan

Three unknowns from the north-star doc were resolved before planning:

1. **Task-graph bootstrap (the P2 risk item) is small.** The hub already ships production code to init a `.opentasks/` dir and spawn the daemon (`ensureInitialized` / `ensureDaemon` in `src/map/task-daemon-lifecycle.ts`); `withDaemon` in `task-daemon-client.ts` even auto-starts the daemon on first write. A functioning graph is just `config.json` + empty `graph.jsonl` + a `syncable_resources` row with `metadata.opentasks: true` — the exact recipe the test suite uses. **Decision: Option A — hub-default graph on first run** (~50–100 new lines), not swarm-mediated bootstrap.
2. **Onboard tokens already have a REST API** (`POST /api/v1/admin/onboard-token`, `src/api/routes/admin.ts:317-391`) reachable from the web UI in local/trusted mode. The Connect one-liner is frontend-only work — plus fixing the skill fragment, which documents the wrong query param (`api_key`; the WS gate reads `token`, `src/map/ws-map.ts:665,741`).
3. **Permission events already reach the frontend** — `acp.permission.request` / `acp.permission.resolved` are bridged to the `global` WS channel (`src/realtime/acp-bridge.ts`), and hosted-codex permissions arrive as `hosted-chat.event` with `kind: 'permission.request'` on `hosted-chat:<id>`. The attention queue is mostly frontend wiring, with one small backend endpoint for reload correctness (pending-permission state is in-memory server-side, so a page reload would otherwise show an empty queue while an agent sits blocked).

---

## Track P1 — Cockpit

### P1.1 New-session picker on Threads — ✅ implemented

**Goal:** a "New session" button in the Threads sidebar header that gets the user into a live session in ≤3 clicks.

**Shipped as** `src/web/components/threads/NewSessionMenu.tsx` (exports `NewSessionButton` — icon variant in the Threads sidebar header next to `AttentionBell`, block variant in the `EmptySidebar` zero-thread state). Dialog with two tabs:

- **Connect** — online ACP agents, grouped per swarm via the shared `buildSwarmGroups` helper (imported from `SessionPicker`), filtered to `mode === 'acp'` (mail agents excluded — mail threads need a conversation first and the list already shows those). Row click POSTs `/sessions/acp-connect` `{ swarm_id, agent_id, peer_map_id? }` directly (same request shape as `ChatFabStore.connectAndOpen`, but navigates to `/threads/${session_resource_id}?streamId=…&sessionId=…` instead of opening the floating panel). Lifecycle-capable swarms get a "+" spawn-agent row (reuses `SpawnAgentDialog`, auto-connects on spawn).
- **Spawn** — compact hosted-spawn form: three-way choice (Codex chat = codex/rpc default, Codex terminal = codex/tui, Claude Code), `WorkingDirectoryCombobox` for cwd, optional first prompt, auto-generated name. P2.1 preflight embedded via `useSpawnPreflight` + `SpawnPreflightCallout` (submit disabled on failed preflight unless "attempt anyway"). On success navigates to `/threads/hosted-chat/:id` (rpc) or `/threads/hosted-tui/:id` (tui kinds). Footnote points at the full Swarms spawn form for repos/hives/credentials.

`useSpawnSwarm`'s payload type gained the codex-only `mode?: 'rpc' | 'tui'` field (previously smuggled through a spread in `Swarms.tsx`).

**Tests:** `src/web/__tests__/components/new-session-menu.test.tsx` — 5 tests: ACP-only listing, acp-connect + deep-link navigation, codex-rpc default spawn → hosted-chat, claude-code spawn → hosted-tui, preflight blocking + attempt-anyway.
**Done when (met):** from `/threads`, hosted-codex chat in 3 clicks (New session → Spawn tab → Spawn & open) and an ACP session in 2 (New session → agent row).

### P1.2 Attention store v2 (idle + permission kinds) — ✅ implemented

**Goal:** the existing attention store tracks *why* attention is needed, including permissions, fed by global WS listeners.

> **Status:** landed. Store rewritten (`session-attention.ts`, thread-keyed items with `idle`/`permission` kinds), `useGlobalAttention` mounted in Layout (global + per-hosted-swarm channel listeners), `useSessionsRealtime` reduced to invalidation-only, consumers (Threads rows, SessionDetail pill) migrated — permission indicators survive row clicks and render red vs amber for idle. `SessionListItem` gained `acp_stream_id` (DAL + API type) for streamId→session mapping. Tests: store unit + hook WS-emit tests + updated invalidation tests. See `src/web/CLAUDE.md` "Session attention (cockpit)".

**Frontend only.** Changes to `src/web/stores/session-attention.ts`:

```typescript
interface AttentionItem {
  threadKey: string;        // 'session:<id>' | 'hosted-chat:<id>' — matches Sessions.tsx selection keys
  kind: 'idle' | 'permission';
  swarmId: string;
  timestamp: number;
  // permission-only:
  requestId?: string;
  streamId?: string;        // ACP reply route
  hostedSwarmId?: string;   // hosted reply route
  description?: string;
}
// keyed map allows one idle + N permission items per thread
```

New hook `useGlobalAttention()` mounted once in `Layout.tsx` (alongside existing `useSessionsRealtime`):

- `acp.permission.request` → resolve `data.streamId` → session id via the `sessions-overview` query cache (`metadata.acpStreamId` is set by `acp-connect`); add permission item. `acp.permission.resolved` → remove by `requestId` (this also handles multi-tab: answered elsewhere clears everywhere).
- Subscribe `hosted-chat:<id>` for each running rpc swarm (list already in cache via `useHostedSwarms`); `permission.request` / `permission.resolved` kinds → add/remove items keyed `hosted-chat:<id>`.
- Existing idle logic (`trajectory:sync`, `node_state_changed`) migrates from `useSessionsRealtime` into the same store shape.

**Known limitation (accepted):** streamId→session cache lookup fails if the sessions list hasn't loaded; P1.3's hydrate endpoint covers cold start.
**Tests:** store unit tests (add/resolve/clear semantics); hook test with mocked WS emits.
**Done when:** a permission request on an *unfocused* session appears in the store within one WS round-trip and disappears when answered from any tab.
**Estimate:** 2 days. **Depends on:** nothing (P1.4 consumes it).

### P1.3 Backend: `GET /sessions/pending-attention` — ✅ implemented

**Goal:** reload-correct hydration for the attention queue.

> **Status:** landed. Route in `sessions.ts` (auth: `authMiddleware`) aggregates both in-memory stores: SwarmCraft's ACP `pendingPermissions` map (no public accessor in the package — duck-typed read-only, degrades to `[]` on shape change) joined to sessions via new DAL `findSessionByAcpStreamId`, plus a new `SwarmManager.listPendingCodexPermissions()` (map entries now also record `summary` + `requestedAt`). `useGlobalAttention` fetches once on mount and seeds the store. Tests: route test with stubbed stores (both populated, absent, malformed) + hook hydration test.

**New route** in `src/api/routes/sessions.ts` (auth: `authMiddleware`), aggregating the two in-memory pending-permission stores:

- ACP: enumerate SwarmCraft `acpStreamManager` streams with pending permission requests; join to session resources via `metadata.acpStreamId` → return `{ kind: 'permission', session_resource_id, stream_id, request_id, description, requested_at }`.
- Hosted codex: `SwarmManager.codexPendingPermissions` map (`src/swarm/manager.ts:~88,213`) → `{ kind: 'permission', hosted_swarm_id, request_id, ... }`.

Response: `{ items: AttentionItemDto[] }`. `useGlobalAttention` fetches once on mount and seeds the store. Expose whatever accessor the SwarmCraft stream manager needs (may require a small getter added where the ACP proxy is set up; keep it read-only).

**Tests:** route test with a stubbed pending permission in each store.
**Done when:** hard-refresh with a pending permission shows it in the queue immediately.
**Estimate:** 1–2 days (the SwarmCraft accessor is the only unknown).

### P1.4 Nav badge + attention queue panel — ✅ implemented

**Goal:** one place that answers "who needs me?" with inline Allow/Deny.

> **Status:** landed. Threads nav item in `Sidebar` shows a reactive attention count (red tone when any permission pending, amber otherwise; both collapsed and expanded render sites). New `AttentionBell` (`src/web/components/attention/AttentionBell.tsx`) in the Threads sidebar header: popover queue listing items newest-first with thread name, description, and age; permission rows have inline Allow/Deny posting to the right endpoint per source (ACP via exported `replyAcpPermission`, hosted via `hostedChatService.replyPermission`) with optimistic store removal; idle rows deep-link to the thread and clear on click. Tests: `attention-bell.test.tsx` (badge, per-source reply routing, idle clear).

**Frontend only.** Two pieces:

- **Badge:** `Sidebar.tsx` `NavItem.badge` already exists (used for Swarms online count, ~79). Wire the Threads item to a reactive attention count (subscribe to the store's map, don't call `attentionCount()` non-reactively).
- **Queue panel:** clicking the badge (or a bell in the Threads header) opens a popover listing items grouped by thread: description, age, and for permissions **Allow / Deny** buttons posting directly to the existing reply endpoints — ACP: `POST /api/swarmcraft/acp/streams/:streamId/permission` `{ requestId, reply: { outcome } }`; hosted: `POST /map/hosted/:id/chat/permission/:requestId` `{ decision }`. No chat channel needed. Idle items deep-link to the thread.

**Tests:** panel component test — items render, Allow fires the right endpoint per kind, resolved items disappear (store event).
**Done when:** 3 agents blocked on permissions are all answerable from the queue without opening any of their threads.
**Estimate:** 2 days. **Depends on:** P1.2 (store), P1.3 (hydration, soft).

### P1.5 Thread-row state chips — ✅ implemented

**Goal:** sidebar rows distinguish working / needs-permission / awaiting-input / idle at a glance.

> **Status:** landed. `ThreadRow` computes an effective state chip with priority `approval` (red, pulsing, permission attention) > `input` (amber, pulsing, idle attention) > working statuses (`live`/`running`/`active` via the existing `STATUS_CHIP` map). Quiet states (recent/idle/closed) intentionally render no chip — the avatar border color still carries that signal, avoiding gray-chip noise on stale rows. The avatar pulse dot was replaced by the chip next to the title. Row click still clears idle only; permission chips survive clicks. Tests: 5 new cases in `Sessions.test.tsx` (live chip, input overlay, permission precedence, click survival, stale = no chip).

**Frontend only.** In `Sessions.tsx`: extend the `Thread` status computation to overlay attention-store state — `permission` (highest priority, distinct color) > `awaiting-input` (idle attention) > existing `live/recent/idle/hosted-running` chips. Replace the single amber pulse dot in `ThreadRow` (~275) with a small `StatusChip`-based indicator; keep row-click clearing for idle but **not** for permission items (those clear only on resolution).

**Tests:** thread-list rendering test with seeded store states.
**Done when:** the four states are visually distinct in the sidebar and permission indicators survive row clicks.
**Estimate:** 1 day. **Depends on:** P1.2.

### P1.6 Session affordance unification (cancel) — ✅ implemented

**Goal:** cancel/stop is available wherever a session streams.

> **Status:** landed. Verification found a split: **ACP sessions already have a working stop** — swarmcraft's `ChatInput` swaps Send for a red Square button when `channel.cancel` is defined and `status === 'streaming'`, the ACP adapter implements `cancel` → `POST /acp/streams/:id/cancel`, and the openhive ACP service flips status to `streaming` on prompt. So `SessionDetail` needed nothing. **Hosted chats had no stop at all**: the swarmcraft hosted-chat adapter implements neither `cancel` nor a `streaming` status (turns report `ready`), so ChatInput's built-in control can never engage. Fix: `HostedChat` now tracks the active turn id via a second ref-counted `hostedChatService.subscribe` (`turn.started`/`turn.completed`), renders a "Stop" strip above the composer while a turn is live, and posts to the existing `POST /map/hosted/:id/chat/interrupt` through a new `interruptHostedTurn` helper. Sibling-tab turns are also stoppable (subscription is swarm-scoped, and completion events clear the strip everywhere). Tests: 2 new HostedChat cases (stop appears + interrupts; disappears on turn completion).

### P1.7 Thread grid view (stretch — may slip to Wave 2)

**Goal:** the "tmux view": N-up grid of live thread panes.

**Frontend only.** Grid toggle on Threads header → route `/threads/grid` rendering 2×2 (configurable) panes, each hosting the same detail components (`SessionDetail` chat surface / `HostedChat` / `TerminalPanel`) at reduced density with independent `useChatChannel` instances. Multi-tab ACP sharing (`sessions.ts:1552-1567` idempotent connect) means concurrent channels to the same session are already safe; the risk is render cost of N terminal panes — cap TUI panes at 2 initially.

**Estimate:** 3–4 days. **Depends on:** P1.5 (chips reused in pane headers). Explicitly cuttable without blocking anything else.

---

## Track P2 — Day Zero

### P2.1 Spawn preflight endpoint + form integration — ✅ implemented

**Goal:** spawn failures become pre-submit guidance instead of post-submit toasts.

> **Status:** landed. `SwarmManager.preflight(kind, mode)` runs side-effect-free checks (binary resolution per kind, PtyManager / CodexAppServerManager presence, provider, capacity, credential-keys summary — never values) and `GET /map/hosted/spawn/preflight?kind&mode` exposes it (422 on unknown kind/mode). `SpawnFormDialog` fetches per (kind, codexMode) via `useSpawnPreflight`, renders failed checks in `SpawnPreflightCallout` (amber, `role=alert`), and disables Spawn unless the "attempt anyway" checkbox is ticked (resets on kind/mode change). Tests: `src/__tests__/swarm/preflight.test.ts` (mocked resolvers).

**Backend:** new route in `src/api/routes/swarm-hosting.ts`:

```
GET /map/hosted/spawn/preflight?kind=<kind>&mode=<rpc|tui>
→ { kind, ready: boolean, checks: [{ id, ok, message? }] }
```

Checks (all reuse existing code, no side effects): `resolveClaudeBinary()` / `resolveCodexBinary()` (`src/swarm/claude-binary.ts:33`, `codex-binary.ts:19`); `resolveSwarmRunnerCommand()` resolvability; `PtyManager` present (TUI kinds); `CodexAppServerManager` present (codex rpc, `manager.ts:797-802`); provider registered; `countActiveHostedSwarms() < max_swarms`; credentials summary (`inherit_env` flag + resolved credential-set *keys*, never values). Implement as a `SwarmManager.preflight(kind, mode)` method so route stays thin.

**Frontend:** on kind/mode selection in `SpawnFormDialog` (and P1.1's compact form), fetch preflight; render failed checks as an inline callout with the check's message; disable submit when `ready === false` (with an "attempt anyway" escape hatch, since PATH can differ).

**Tests:** unit-test `preflight()` with stubbed resolvers; route test.
**Done when:** on a machine without `codex`, selecting Codex shows "codex binary not found on PATH. Install Codex and retry." before submit.
**Estimate:** 2 days.

### P2.2 First-run panel — ✅ implemented

**Goal:** a fresh instance greets the user with the two working paths plus the spec path, instead of empty stats.

> **Status:** landed. `src/web/components/onboarding/FirstRunPanel.tsx` renders three cards (spawn / connect / first spec with a "task graph included" badge) and self-gates via `useIsFirstRun()` — both swarm queries must settle at zero, so it never flashes on populated instances. Mounted on the Dashboard default branch (between header and stats), the SwarmCraft-embed branch (strip above the graph), and the Threads `EmptyDetail`. Cards call the spawn/connect dialog callbacks when provided, else link to `/swarms`; the spec card links `/specs/new`. CLI wizard final output now points at the web UI. Tests: `src/web/__tests__/components/first-run-panel.test.tsx`. Note: P1.1's compact spawn form hasn't landed, so the spawn card opens the full `SpawnFormDialog` (with P2.1 preflight inline).

**Frontend only.** New `src/web/components/onboarding/FirstRunPanel.tsx`, shown when `(mapSwarms?.length ?? 0) + (hostedSwarms?.length ?? 0) === 0` **after both queries settle** (pattern from `SwarmStatusSummary`). Three cards:

1. **Spawn a hosted agent** — opens the compact spawn form (P1.1) with preflight (P2.1) inline.
2. **Connect an existing agent** — opens the Connect dialog on the new one-liner tab (P2.3).
3. **Create your first spec** — links `/specs/new`; badge "sets up a task graph automatically" once P2.4 lands.

Placement: Dashboard between `PageHeader` and `StatsDashboard` (`Dashboard.tsx` ~397–417 header / ~352 body — also handle the SwarmCraft-embed branch by showing the panel above the embed); Threads `EmptyDetail` (`Sessions.tsx:328-336`) when zero swarms. CLI polish: append "Open http://localhost:7836 — the app will walk you through connecting your first agent." to the wizard's final output (`src/cli.ts` ~277–291).

**Tests:** render test for the zero/nonzero branch.
**Done when:** fresh instance → Dashboard and Threads both lead directly into spawn/connect/spec.
**Estimate:** 1–2 days. **Depends on:** P1.1 + P2.1 for full effect (cards can link to existing dialogs before those land).

### P2.3 Onboard one-liner in Connect dialog + Connectivity card — ✅ implemented

**Goal:** "run this in your agent's environment" copy-paste, no CLI required.

> **Status:** landed. `src/web/components/onboarding/OnboardTokenPanel.tsx` mints via `POST /admin/onboard-token` `{ scopes: ['map:agents:spawn'], ttl_hours: 24, agent_name? }` and renders copyable blocks: `export MAP_CREDENTIAL=…` (from `response.env`, token fallback) + the `ws(s)://<host>/ws/map?swarm_id=…&token=$MAP_CREDENTIAL` recipe + `/skill.md` link. Non-admin mint failures surface the CLI alternative. `ConnectFormDialog` is now two tabs — "Onboard an agent" (default) and "Register a remote MAP endpoint" (the old form). `ConnectivityCard` embeds the same panel (name field hidden); its stale pre-auth copy was already fixed in P2.5. Tests: `src/web/__tests__/components/onboard-token-panel.test.tsx`.

**Frontend only** (REST exists). Add a tab/section to `ConnectFormDialog` (`Swarms.tsx` ~1260): "Onboard an agent" — button mints a token via `POST /admin/onboard-token` `{ scopes: ['map:agents:spawn'], ttl_hours: 24, agent_name? }` (works with the existing Bearer client in local/trusted-admin mode — surface a clear error otherwise, since remote non-admin agents can't mint) and renders copyable blocks:

```bash
export MAP_CREDENTIAL="<token>"   # from response.env
# connect: ws(s)://<host>/ws/map?swarm_id=<your-swarm-id>&token=$MAP_CREDENTIAL
```

plus a link to `/skill.md`. Add the same block to `ConnectivityCard` and fix its stale "pre-auth keys" copy (line 115). Keep the existing manual-endpoint form as the second tab ("Register a remote MAP endpoint").

**Tests:** dialog test with mocked mint response.
**Done when:** a Claude Code session on the same machine can be connected using only what the dialog shows.
**Estimate:** 1 day.

### P2.4 Hub-default task graph bootstrap (Option A) — ✅ implemented

**Goal:** `/specs/new` works on a fresh instance.

> **Status:** landed. `src/map/hub-task-graph.ts:ensureHubDefaultTaskGraph(dataDir)` initializes `<dataDir>/task-graph/.opentasks` via `ensureInitialized` and upserts the `hub/default` task resource (`visibility: 'public'`, owner = oldest admin agent via `agentsDAL.findDefaultOwnerAgent()`, metadata `{ opentasks, hub_default, location_hash }`). Called at server startup behind `taskGraph.bootstrapDefault` (config default `true`); returns null pre-init (zero agents) instead of creating an unowned row. Thin `POST /map/hub-task-graph` route re-runs it on demand; SpecNew's dead-end is now a "Create default task graph" button that hits the route, invalidates the resources query, and auto-selects the graph. Daemon is not eagerly spawned (`withDaemon` auto-starts on first write). Tests: `src/__tests__/map/hub-task-graph.test.ts` (idempotency, non-owner access, zero-agent guard).

**Backend.** New module `src/map/hub-task-graph.ts` with `ensureHubDefaultTaskGraph()`:

1. `const dir = path.join(<dataDir>, 'task-graph', '.opentasks')` — under the configured data dir.
2. `ensureInitialized(dir)` (writes `config.json` + empty `graph.jsonl`; existing code).
3. `upsertDiscoveredResource({ resource_type: 'task', name: 'hub/default', git_remote_url: dir, local_path: dir, sync_strategy: 'local', owner_agent_id: <local admin agent>, scope: 'global', visibility: 'public', metadata: { opentasks: true, location_hash: <from config.json>, hub_default: true } })` — `visibility: 'public'` sidesteps the owner/subscription access-control trap the spike identified (private resources owned by another agent are invisible to `listAccessibleResources`).
4. Do **not** eagerly spawn the daemon — `withDaemon` auto-starts it on first write (`task-daemon-client.ts:48-69`).

Call it from server startup behind config `taskGraph.bootstrapDefault` (default `true`; idempotent via upsert + `location_hash`). **Frontend:** replace the SpecNew dead-end (`SpecNew.tsx:122-131`) with "Create default task graph" (POSTs a new thin `POST /map/hub-task-graph` route that calls the same function) for instances where bootstrap was disabled or predates the feature; auto-select the created graph.

**Tests:** unit test for idempotency; integration test — fresh DB → bootstrap → `POST /specs` against `hub/default` succeeds (recipe from `src/__tests__/map/opentasks-daemon-integration.test.ts`); guard test that a second boot doesn't duplicate rows.
**Risks:** daemon spawn under Docker/Electron (already handled via `process.execPath` in `ensureDaemon`); Unix-socket path length on macOS if data dir is deep — keep the relative layout short.
**Done when:** fresh instance → `/specs/new` shows `hub/default` and spec creation round-trips.
**Estimate:** 1–2 days.

### P2.5 Doc hygiene — ✅ implemented

**Goal:** no doc contradicts the running code. All verified stale spots:

> **Status:** landed. README (both operator flows, Mermaid diagram, API table), `map.ts`/`mail.ts` skill fragments, ConnectivityCard, About page, and root `CLAUDE.md` route list all corrected to the onboard-token flow and the real mail routes. Remaining `preauth` references in code are intentional: Tailscale/Headscale mesh keys (a different concept), retirement-documenting comments, migration-history DDL, and tests that verify the routes are gone.

- `README.md` 250–267, 269–299, 379, 582, 607–609 — replace preauth flows/routes with `openhive admin onboard-token create` + `POST /api/v1/admin/onboard-token`.
- `src/api/skill-fragments/map.ts` — WS param `api_key` → `token`; CLI command missing `create` subcommand.
- `src/api/skill-fragments/mail.ts` — remove `POST /mail/conversations` (until P3 adds it); add `GET .../threads`, `POST .../join`.
- `src/web/pages/settings/ConnectivityCard.tsx:115` — pre-auth wording.

**Estimate:** 0.5 day. No dependencies — can go first.

---

## Sequencing

```
Week 1:  P2.5 docs ──┐
         P1.2 store ─┼─► P1.4 badge+queue ─► P1.5 chips ─► P1.6 cancel
         P1.3 endpoint ┘
         P2.1 preflight ─► P1.1 new-session ─► P2.2 first-run panel
Week 2:  P2.4 graph bootstrap ─► P2.3 one-liner
         (stretch) P1.7 grid view
```

Two people (or two agent dispatches) can run the P1 chain and the P2 chain independently; the only cross-track edge is P2.1 → P1.1 (soft — P1.1 renders without preflight) and P1.1 → P2.2.

**Total estimate:** ~12–15 dev-days excluding the grid stretch.

## Wave-1 exit criteria (from the north-star "done when"s)

1. Fresh instance, machine with `codex`: clone → conversation in ≤5 min, no docs (P2.1, P2.2, P1.1).
2. Machine without `codex`: told exactly that, before submitting anything (P2.1).
3. 4 concurrent sessions: every permission and idle event lands in the queue; any is answerable in ≤2 clicks without hunting (P1.2–P1.5).
4. Fresh instance: `/specs/new` works end-to-end against `hub/default` (P2.4).
5. A local Claude Code session connects using only what the Connect dialog shows (P2.3).

## Deferred to Wave 2 (P3–P5)

Spec discussion threads (`POST /mail/conversations` + spec thread route + Discussion tab), dispatch modal expansion + coordinated-team mode + spec rollup, `map/dispatches/cancel`, validate-loop actions. P3 planning should reuse the mail-layer findings already in `usability-audit.md` Part 2.
