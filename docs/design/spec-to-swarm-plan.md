---
status: active
owner: alexngai
created: 2026-04-15
revised: 2026-04-15
companion: spec-to-swarm.md
---

# Spec → Task → Swarm: Working Plan

Living plan for the work described in `spec-to-swarm.md`. Update as scope and priorities shift.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[?]` blocked / needs decision

---

## Decisions made

- **D1**: Primary noun is **Spec** (not Brief / Briefing / Mission).
- **D2**: Specs are **OpenTasks context nodes** — reuse the existing opentasks lifecycle (local daemon + MAP remote). No new spec DAL.
- **D3**: **Multi-swarm dispatch** is first-class from day one.
- **D4**: **`Dispatch`** is the only new hub-native entity; records one `(spec, swarm)` pair.
- **D5**: Agent autonomy designed in from day one, via MAP endpoints + topology. See D9 for current authorization stance.
- **D6**: **Versioning** via opentasks context-node history; Dispatch records the revision it was dispatched against.
- **D7**: **Spec ↔ post bridging** via shared opentasks context nodes; no schema coupling.
- **D8**: Multi-swarm dispatch is **`independent` only in v1**. No spec-level aggregate status; each dispatch is a sibling record. `all-must-complete` / `first-wins` parked.
- **D9**: **No per-agent capability gating for spec/dispatch at launch.** Any registered MAP agent can author, edit, and dispatch. `Dispatch.initiator` recorded; global kill switch present. Rate limits / budgets / capability flags are retrofit paths.
- **D10**: **Drafts are frontend-local (`localStorage`) for new-spec compose.** Edits to existing specs commit through to opentasks. Agent-initiated proposals commit directly with `metadata.review_status: 'pending'`.
- **D11**: **Dispatch is a workflow with a feedback channel** — `<dispatch id="…">` header in the seed prompt; agent reports back via `map/dispatches/report` MAP notification.
- **D12**: **`spec_ref = { resource_id, spec_id, captured_at }`** — captures `updated_at` at dispatch time for "spec edited since dispatch" affordances.
- **D13**: **Seed prompt is plain markdown** — `<dispatch>` header + spec body + `## Tasks` section + optional `## Additional instructions`.
- **D14**: **Cancel = mark cancelled + close session.** Notify-swarm path layers on later via the D11 contract.
- **D15**: **Status transitions** — hub writes `→ queued`, `queued → running`, `running → cancelled`; agent writes `running → complete` / `running → failed` via `map/dispatches/report`.

---

## Open decisions

None. All design-review questions resolved. New questions will accrue during implementation.

---

## Stream 1 — Specs surfacing (view + author)

Goal: specs are browsable, authorable, linkable from the UI. No new persistence.

### Backend
- [x] Query helper: list opentasks context nodes filtered to `kind=spec` (local + remote via existing opentasks-remote)
- [x] REST route: `GET /specs` (list across reachable daemons, paginated)
- [x] REST route: `GET /specs/:id` (detail, delegates to opentasks resource-content)
- [x] REST route: `POST /specs` (create spec context node)
- [x] REST route: `PATCH /specs/:resourceId/:specId` (update, commit-through per D10)
- [x] REST route: `POST /specs/:resourceId/:specId/links` + `DELETE` (link/unlink edges)
- [x] MAP endpoint: `map/specs/author` — agent-authored spec creation (open to any registered agent per D9)
- [x] Event emission: `spec.created`, `spec.updated`, `spec.linked` (derived from opentasks events + kind filter)
- [x] Tests: route integration (23 cases) + MAP handler (8 cases)

### Frontend
- [x] `src/web/pages/Specs.tsx` — list view
- [x] `src/web/pages/SpecDetail.tsx` — detail + edit (edits commit through to opentasks per D10)
- [x] Spec editor component (markdown body with edit/preview tabs)
- [x] New-spec compose (`SpecNew.tsx`): `localStorage` draft autosave, commit on Save/Dispatch (per D10)
- [ ] "Pending review" inbox/badge for specs with `metadata.review_status: 'pending'` — backend supports, no UI yet
- [x] Link picker: spec ↔ task, spec ↔ context (LinkedNodesPanel with "+" form + "×" unlink)
- [x] Realtime invalidation via `useSpecsRealtime` on `map:tasks` channel
- [x] React Query hooks: `useSpecs`, `useSpec`, `useCreateSpec`, `useUpdateSpec`, `useLinkSpec`, `useUnlinkSpec`
- [x] Nav entry: "Specs" as first-class in Sidebar

---

## Stream 2 — Dispatch primitive

Goal: explicit `(spec, swarm)` dispatch replaces free-text `assignee`. Bootstrap sessions on target swarms. Open to any registered agent; audit + kill switch as safety net (per D9).

### Backend
- [x] Schema migration V32: `dispatches` table + V35: `lease_token`, `lease_expires_at`, `attempt`, `turn_count`
- [x] `src/db/dal/dispatches.ts` — CRUD, status transitions, fence-token claim/release/renew
- [x] `src/api/routes/dispatches.ts` — list, detail, cancel
- [x] `POST /specs/:id/dispatch { target_swarms[], prompt? }` — creates N dispatches (per D8, `independent` semantics only)
- [x] swarm-dispatch orchestrator integration (`src/dispatch/`) — replaces manual bootstrap with automatic poll → claim → spawn/route → retry → complete/fail
- [x] MAP endpoint: `map/specs/dispatch` — agent-initiated dispatch (open to any registered agent per D9)
- [x] Event emission: `dispatch.created`, `dispatch.status_changed`, `dispatch.completed`, `dispatch.cancelled` + orchestrator events bridged
- [x] `map:dispatches` WS channel + broadcast
- [x] Audit: `initiator` recorded on every dispatch; status transitions logged
- [x] Global kill switch: `dispatch-policy.ts` + admin GET/POST endpoints — when paused, agent-initiated dispatches return -32004; user-initiated still work
- [x] Tests: DAL (17 cases) + orchestrator helpers (12 cases) + source adapter (15 cases) + routes (10 cases) + dispatch handler (9 cases) + admin policy (5 cases)

### Frontend
- [x] Dispatch modal (`DispatchModal.tsx`): deduped swarm picker, multi-select, confirm, `last_seen_at` + `×N` variant badges
- [x] Reusable from Spec detail (wired); Task detail + SwarmDetail + command palette pending Stream 3
- [x] Ack toast on dispatch creation
- [x] Cancel action from dispatch detail
- [x] `Initiator` chip visible in every dispatch list item + detail view (user name or agent id)
- [x] Admin toggle in Settings → Server → DispatchPolicyCard
- [x] Orchestrator progress display: attempt + turn_count in DispatchDetail (shown when >0)
- [x] Dispatches dashboard (`Dispatches.tsx`) with status filter chips + deduped swarm dropdown
- [x] SpecDispatchesPanel on SpecDetail sidebar

---

## Stream 3 — Compose UX

Goal: authoring a spec + dispatching takes seconds. Agents can help via a global chat surface.

### Chat FAB Widget (primary deliverable)

A floating chat button available on every page. Expands into a chat panel for collaborating
with agents — drafting specs, decomposing tasks, discussing dispatches, or any ad-hoc work.

#### Architecture

```
src/web/components/chat-fab/
├── ChatFab.tsx              # FAB button + expanded panel container
├── ChatFabStore.ts          # Zustand store (open/session/swarm/minimized)
├── ChatFabContext.tsx        # React context for page-level context injection
├── SessionPicker.tsx         # Agent/session picker (spawn new or resume existing)
├── ChatPanel.tsx             # Message list + input (wraps useChatChannel)
├── ContextMenu.tsx           # "Add context" dropdown populated by page
└── ContextFormatter.tsx      # Formats context items into chat messages
```

Mounted in `Layout.tsx`, rendered on all protected routes. Uses existing `useChatChannel`
from swarmcraft + `useOpenHiveAdapters` for ACP/Mail transport.

#### Decisions

- **One active session at a time.** Switch sessions via the picker. No tabs.
- **Persists across page navigation.** Zustand store at Layout level; navigating doesn't close the chat.
- **Spawn target**: user picks a swarm from the deduped picker (same as DispatchModal). FAB creates an ACP session on that swarm.
- **Quick actions** (future): "Create spec from conversation", "Dispatch this spec" as action buttons in the FAB header. Not in v1.
- **Mobile**: full-screen when expanded, not a side panel.

#### State (ChatFabStore)

```ts
interface ChatFabState {
  open: boolean;               // FAB expanded or collapsed
  sessionId: string | null;    // active session (null = show picker)
  swarmId: string | null;      // swarm the session is on
  minimized: boolean;          // expanded but tucked to header bar only
}
```

#### Three modes

1. **No session** → session picker (list connected swarms + recent sessions + "Spawn new")
2. **Active session** → chat messages + input (via useChatChannel)
3. **Minimized** → header bar only (agent name + unread badge)

#### Context injection

Each page provides available context items via a React context provider:

```tsx
// SpecDetail registers spec + linked tasks
<ChatFabContext.Provider value={{
  items: [
    { label: 'Current spec', type: 'spec', data: { id, title, content } },
    { label: 'Linked tasks (N)', type: 'tasks', data: linked.tasks },
  ]
}}>
```

User clicks a context item → formatted message injected into chat:

```
📎 Shared context — Spec: "Auth Refactor" (c-29m5)
## Goals
...
## Linked Tasks
- [open] t-693a — Implement spec display
```

Agent sees the full context as a user message and can act on it.

#### Checklist

- [ ] `ChatFab.tsx` — FAB button (bottom-right), expand/collapse, minimized mode
- [ ] `ChatFabStore.ts` — Zustand store with open/session/swarm/minimized state
- [ ] `ChatFabContext.tsx` — React context provider + `useChatFabContext` hook
- [ ] `SessionPicker.tsx` — swarm picker (deduped, online filter), recent sessions list, "Spawn new" action
- [ ] `ChatPanel.tsx` — message rendering + input, wrapping `useChatChannel` / `useOpenHiveAdapters`
- [ ] `ContextMenu.tsx` — "Add context" dropdown reading from ChatFabContext
- [ ] `ContextFormatter.tsx` — formats spec/task/dispatch context into markdown messages
- [ ] Mount `ChatFab` in `Layout.tsx` inside ProtectedRoute
- [ ] Wire `ChatFabContext.Provider` on key pages:
  - [ ] `SpecDetail.tsx` — current spec + linked tasks/contexts
  - [ ] `SpecNew.tsx` — draft spec content
  - [ ] `DispatchDetail.tsx` — dispatch metadata + outcome
  - [ ] `TaskGraph.tsx` — selected task(s)
  - [ ] `SwarmDetail.tsx` — swarm info + connected agents
  - [ ] `SessionDetail.tsx` — session metadata
- [ ] Mobile: full-screen expanded mode via responsive breakpoint

### Other Stream 3 items (lower priority)

- [ ] Global command palette (⌘K / cmd-K): "New spec", "New task", "Dispatch spec"
- [ ] Quick-add modal for specs (lightweight; "expand to full editor" option)
- [ ] Template gallery: feature / bug / research / triage

---

## Stream 4 — Observability

Goal: once dispatched, state is visible without hunting.

- [ ] Dispatches dashboard page (or Dashboard refresh): work-in-flight cards
- [ ] Filters: by swarm, status, author, date
- [ ] Per-spec dispatch view: per-swarm chips, merged event stream, task progress, outcome
- [ ] Back-references: Session detail → Dispatch → Spec; Task detail → Dispatch
- [ ] Realtime via `map:dispatches` + existing `map:tasks`
- [ ] Empty states

---

## Stream 5 — Onboarding & topology

Goal: getting swarms connected + understanding their shape no longer needs CLI.

- [ ] Preauth-key UI: create, list, revoke, copy share link
- [ ] Invite flow: generate link → swarm self-registers → hub toast
- [ ] Topology view in SwarmDetail: coordinator/worker tree, role badges (read from macro-agent lifecycle bridge)
- [ ] Team template viewer (macro-agent YAML)
- [ ] Team template editor (advanced, gated) — stretch

---

## Stream 6 — Learning loop

Goal: dispatched specs benefit from historical outcomes.

- [ ] Playbook browser UI (reads cognitive-core knowledge bank)
- [ ] "Suggested swarms" on dispatch modal (ranked by past dispatch similarity + outcome)
- [ ] Inline knowledge search from spec editor
- [ ] Trajectory → playbook extraction surfacing (already backend, needs UI)

---

## Cross-cutting

- [ ] Telemetry: event taxonomy for specs + dispatches, wired into existing event pipeline
- [ ] Docs: user-facing getting-started for the spec → dispatch flow
- [x] CLAUDE.md section update — "Dispatch Orchestrator" section added with architecture, key files, lifecycle, adapters, kill switch
- [ ] Migration nudge: existing task `assignee` flows keep working, UI suggests dispatch
- [x] swarm-dispatch integration — client/server split with `swarm-dispatch/client` factories; adapters compose via static ESM imports
- [x] ESM migration — `"type": "module"`, `format: ['esm']` + `shims: true` in tsup, `require()` calls replaced, `__dirname` shim in server.ts
- [x] Swarm hygiene — Phase 1 (dedup picker 849→18), Phase 2 (archived column + sweep), Phase 3 (stable identity schema + upsert)
- [x] Dual reporting path guard — event bridge checks terminal status before writing; design doc updated to clarify `map/dispatches/report` retained as secondary path
- [x] useWSEvent render loop fix — ref-stabilized callback + Zustand selectors in useWebSocket.ts

---

## Parking lot (not committed)

- **Templates**: specs as templates ("triage this bug", "research this API", "add a route"). Composes with Stream 3.
- **Chains**: a spec can spawn follow-up specs. Needs cycle guard + depth cap.
- **Scheduled dispatch**: cron-style "dispatch this spec every Monday." Aligns with `/schedule` skill.
- **Public specs in hives**: a hive hosts a public spec queue; community swarms pick up work.
- **Slack/Discord authoring**: bridge → DM → "create spec from this thread."
- **Forking a dispatch**: branch-and-retry after a failed dispatch.
- **Spec PR review**: PR-style review before dispatch can be triggered.
- **Cost/budget**: compute budget per dispatch, abort if exceeded.
- **Fork/branch specs**: spec forks with `forked_from` edge in opentasks graph.

### Retrofit paths (from D9) — add if chaos emerges

Watch signals: runaway dispatch chains, repeated dispatches from one agent in tight succession, resource exhaustion on target swarms, specs created + immediately dispatched without review.

- **Rate limits**: N dispatches per agent per time window, enforced at `map/specs/dispatch`.
- **Compute budgets**: per-dispatch token/time cap; abort when exceeded.
- **Per-agent capability flags**: the `specs` cluster we considered and deferred — `{ canAuthor, canDispatch, requiresApproval }` under `ParticipantCapabilities`. Add when binary gating is truly warranted.
- **Approval routing**: when `requiresApproval` is set (spec-level metadata or agent-level capability), hub holds the dispatch and sends a MAP message to a designated human agent for confirmation.

### Multi-swarm outcome aggregation (from D8) — add if patterns emerge

- **`all-must-complete`**: spec-level aggregate status; one dispatch failure → spec fails.
- **`first-wins`**: first successful dispatch cancels peers; losers marked `superseded` (distinct from failed).
- **Partial-success state**: when some dispatches succeed and some fail under an aggregation policy.

---

## Status log

- **2026-04-15** — Plan drafted. Initial design review completed:
  - Resolved D1–D7 (naming, persistence, multi-swarm, Dispatch entity, autonomy model, versioning, post bridging).
  - Scope collapse: Stream 1 no longer needs a DAL buildout; Specs live in opentasks.
  - Three open questions raised (OQ1–OQ3).
- **2026-04-15** — Design-review questions resolved:
  - **D8** — `independent` aggregation only in v1.
  - **D9** — No per-agent authorization gating at launch; audit + kill switch; retrofit paths documented.
  - **D10** — Frontend-local `localStorage` drafts for new-spec compose; edits commit through; agent proposals use `metadata.review_status: 'pending'`.
  - Stream 2 simplified: no capability-cluster work.
- **2026-04-15 — PR 0 findings (Stream 1)**:
  - **Discriminator**: `node.type === 'spec'`. OpenTasks `ProviderNode.type` is one of `'spec' | 'issue' | 'task' | 'feedback' | 'external'` — first-class types, no metadata coercion needed.
  - **Sudocode emit shape**: `{ id, uri: 'sudocode://workspace/<id>', type: 'spec', title, content?, status: 'archived'|'active', priority?, rawData: <full sudocode spec incl. parent_id, tags, relationships>, fetchedAt }`. (See `references/opentasks/src/providers/sudocode.ts:294-306`.)
  - **Query mechanism**: `daemonQueryNodes(socketPath, { type: 'spec', archived: false, limit, offset })` (`src/map/task-daemon-client.ts:499`). Same call works for `type: 'feedback'`.
  - **Resource scoping**: specs live inside resources of `resource_type: 'task'` with `metadata.opentasks: true`. To list "all specs" globally, iterate accessible task resources and aggregate.
  - **Remote support**: federated resources via MAP — `remoteQueryTasks(swarmId, filter, limit)` (`src/map/opentasks-remote.ts`) for swarms whose daemon isn't local. Same pattern as `/resources/:id/content/opentasks/tasks` (try local daemon → fall through to remote).
  - **Edges/relationships**: opentasks graph captures spec relationships as typed edges (`blocks`, `implements`, `references`, `depends-on`, `related`, `discovered-from`). Read via `daemonGetGraph` or per-node link query.
  - **Feedback**: opentasks-native `type: 'feedback'` nodes are queryable via `daemonQueryNodes`. Sudocode provider declares `feedback: false` capability — sudocode's own feedback (issue_feedback) stays inside sudocode storage and does NOT surface as graph feedback nodes. PR 2 should display opentasks-native feedback nodes attached to the spec via graph edges; sudocode feedback is post-MVP (would need direct sudocode CLI/HTTP query).
  - **Write path**: `POST /resources/:id/content/opentasks/tasks` is the existing precedent — uses `daemonCreateTask` for local, falls through to MAP `opentasks/create.request` for remote. Spec writes will follow the same pattern but call `client.createNode({ type: 'spec', ... })` (or whatever the equivalent is for spec creation through the daemon — confirm in PR 3 that the daemon honors `type: 'spec'` on write or whether sudocode writes go via a different API).
- **2026-04-15 — Stream 1 MVP shipped (PRs 1–4)**:
  - **PR 1 (specs list)**: `GET /specs` aggregates `type: 'spec'` nodes across accessible task resources (local daemon → remote MAP fallback). Sudocode `SpecList` / `SpecCard` / `MarkdownLine` copied + adapted (Workflow concept and shadcn UI primitives stripped; openhive CSS variables substituted). `Specs.tsx` page + nav entry + route.
  - **PR 2 (spec detail)**: `GET /specs/:resourceId/:specId` returns spec + 1-hop neighbors grouped by kind (tasks / contexts / feedback / specs / issues). New helper `daemonGetNodeWithNeighbors` does node + edge filter + parallel `getNode` for linked ids. Remote fallback uses existing `remoteGetGraph`. `SpecDetail.tsx` page renders markdown body via new `SpecMarkdown` component + sidebar `LinkedNodesPanel` for each kind. **OpenTasks-native feedback nodes display read-only in their own panel** (sudocode-source feedback stays in sudocode storage per the provider's `feedback: false` capability — that bridge is post-MVP).
  - **PR 3 (spec create/edit)**: `POST /specs` and `PATCH /specs/:resourceId/:specId` (local daemon only — remote-write deferred). New helpers `daemonCreateSpec` / `daemonUpdateSpec`. `SpecEditor` component with edit/preview tabs (textarea-based — Tiptap deferred per "skip custom extensions" guidance; same data shape lets us swap later). `SpecNew` page at `/specs/new` with resource picker + `localStorage` autosave per D10 (key: `openhive:spec-draft`). `SpecDetail` gains in-page edit toggle (commits straight through per D10) and archive/restore button. "New spec" button added to `Specs.tsx`.
  - **PR 4 (MAP author + realtime)**: New `src/map/spec-handler.ts` exports `MAP_SPEC_METHODS = { AUTHOR: 'map/specs/author' }`, registered in `map-server-setup.ts` alongside MAP task methods. Open to any registered agent per D9; records initiator on broadcast. WS broadcasts (`spec.created`, `spec.updated`) on the existing `map:tasks` channel from REST endpoints + the MAP handler. New `useSpecsRealtime` hook subscribes and invalidates; wired into `Specs` and `SpecDetail` pages. `WSEventType` extended with `spec.*` variants.
  - Verified: `npm run typecheck` clean across all PRs; `npm run build:web` succeeds.
  - Not verified end-to-end yet: needs a live opentasks daemon + a sudocode-enabled swarm to validate the read path against real provider data, plus an interactive spot-check of compose → save → realtime invalidation.
- **Open follow-ups for Stream 1**:
  - Remote-write for spec create/edit (mirrors `remoteCreateTask` / `remoteUpdateTaskFields` patterns; awaiting demand).
  - Sudocode's own anchored feedback bridge (sudocode provider declares `feedback: false`; would need a dedicated read path through the sudocode CLI/HTTP API).
  - Tiptap-based editor for richer markdown (drop-in replacement for `SpecEditor` body — same API shape).
  - Link-picker UI for spec ↔ task / spec ↔ context relationships (currently read-only via the LinkedNodesPanel).
  - Pending-review affordance for specs created with `metadata.review_status: 'pending'` (D10 agent-proposal flow) — backend supports it, no UI yet.
- **2026-04-15 — Stream 1 test coverage**:
  - **Backend route tests** (`src/__tests__/routes/specs.test.ts`, 23 cases): GET /specs (cross-resource aggregation, archive filter, narrow by resource_id, pagination, auth, outsider isolation, partial-fetch error tolerance), GET /specs/:resourceId/:specId (linked nodes grouping, 404, 403, non-opentasks rejection), POST /specs (create + broadcast assertion, validation, auth), PATCH /specs/:resourceId/:specId (update + broadcast, archive toggle, validation).
  - **MAP handler tests** (`src/__tests__/map/spec-handler.test.ts`, 8 cases): map/specs/author happy path + initiator broadcast, every validation branch, unknown method, unknown resource, no-access agent, non-opentasks resource.
  - **Frontend hook tests** (`src/web/__tests__/hooks/useSpecs.test.ts`, 8 cases): URL param construction for useSpecs filters, useSpec id-conditional firing, useCreateSpec POST + invalidation, useUpdateSpec PATCH + dual invalidation.
  - **Frontend component tests** (`src/web/__tests__/components/specs/SpecCard.test.tsx` + Specs page + SpecNew page, 20 cases): card rendering (priority chip, swarm chip, archived opacity, copy-id-without-propagation), Specs page (loading/empty/error/list/archive-toggle/partial-error states), SpecNew (resource picker, draft autosave to localStorage, restore on mount, discard, save flow, save-failure handling).
  - **Bug found and fixed during testing**: parallel `await import()` of the same module via Promise.allSettled was bypassing vitest's mock for the second invocation — the route's per-resource fetches saw the real daemon module past the first call. Hoisted dynamic imports in `src/api/routes/specs.ts` to top-level static imports.
  - **Bug found and fixed during testing**: `?offset=0` was returned in the response body as the string `'0'` because `request.query.offset || 0` short-circuited only on falsy. Replaced with `Math.max(Number(...) || 0, 0)`.
  - **Suite verified**: full server suite (`npm run test:run`) — 2412 passed; 4 pre-existing failures unrelated to specs (in `admin-config`, `config-meta`, `opentasks/discovery`, `opentasks/e2e` — confirmed by stashing and re-running, all four still fail without my changes). Full web suite (`npm run test:web`) — 503 passed, no regressions.
- **2026-04-15 — Stream 1 live e2e validation** (HTTP-level against a real opentasks daemon):
  - **Bug found and fixed (architectural)**: native opentasks `NodeType` is `'context' | 'task' | 'feedback' | 'external'` — there is **no native `'spec'` type**. The CLI rejected `--type spec`, and the daemon's `createNode` would reject it too. `'spec'` only appears as a `ProviderNodeType` (sudocode emits it via the provider). Per D2 ("specs are opentasks **context** nodes"), changed `daemonCreateSpec` to write `type: 'context'` with `metadata: { kind: 'spec' }` (new exported `SPEC_METADATA_KIND` constant). Reads now match either `type === 'spec'` (provider-sourced) or `type === 'context' && metadata.kind === 'spec'` (user-authored). Both surface uniformly through `/specs`.
  - **Bug found and fixed (read path)**: `daemonQueryNodes` strips `metadata` from results even with `verbose: true` — the daemon's query response is a reduced view. Switched `fetchSpecsForResource` to use `daemonGetGraph` instead, which returns full Node objects including metadata. Added `includeArchived` option to `daemonGetGraph` so the spec route's archive filter is honored without changing existing callers.
  - **Manual verification against a live daemon** (built `dist/cli.js`, ran on port 3137 against a fresh `.opentasks/` graph dir):
    - `GET /specs` returned the seeded `c-3odm` (context+kind=spec) with all expected annotations.
    - `GET /specs/:resourceId/:specId` returned spec + linked task in `linked.tasks` + `edges` array.
    - `POST /specs` created `c-2dsh`; `opentasks get c-2dsh` confirmed it persisted as `type: context, metadata: { kind: 'spec' }`.
    - `PATCH` updated title + priority; `PATCH { archived: true }` archived the node.
    - Default list excluded the archived node; `?include_archived=true` included it.
  - **Tests updated**: added `daemonGetGraph` + `SPEC_METADATA_KIND` to the route test mock; added a regression test for the dual-mode read path (provider `type: 'spec'` + native `type: 'context'` with kind marker). 24 specs route + 8 spec-handler tests all pass.
- **2026-04-15 — Stream 2 PRs 1a/1b/1c shipped (dispatch primitive, REST + UI)**:
  - **PR 1a (schema + DAL + read endpoints)**: bumped `SCHEMA_VERSION` to 32, added `dispatches` table with one row per `(spec, swarm)` pair (no FKs to spec/swarm — keep history even when those are deleted). New `src/db/dal/dispatches.ts` with `createDispatch`, `findDispatchById`, `listDispatches` (filters on status/swarm/spec/initiator), `updateDispatchStatus`, `setDispatchSessionIds`, `cancelDispatch`. New `src/api/routes/dispatches.ts` with `GET /dispatches` and `GET /dispatches/:id`. 17 DAL tests + 10 route tests, all passing. Visibility (v1): any authenticated agent can list/inspect any dispatch — per-row ACL is a future layer.
  - **PR 1b (POST /specs/:rid/:specId/dispatch)**: implements the core dispatch endpoint with the `target_swarms[]` + `prompt?` body. Builds the seed prompt per D13 — hidden `<dispatch id="…" spec="…" captured_at="…">` header, spec body, `## Tasks` section (linked tasks 1-hop from the spec), optional `## Additional instructions`. Captures spec.updated_at as `spec_captured_at` per D12. Dedupes target swarms, validates each exists. Per swarm: insert dispatch row (`status: queued`, `initiator: { type: 'user', id: agent.id }`), broadcast `dispatch.created` on `map:dispatches` channel. Returns `{ dispatches: Array<Dispatch & { seed_prompt, target_swarm_name }> }`. New `WSEventType` entries for `dispatch.created`/`dispatch.status_changed`/`dispatch.completed`/`dispatch.cancelled`. 18 new tests (route + buildDispatchSeedPrompt unit), all passing.
  - **PR 1c (frontend dispatch modal + hooks)**: new `src/web/hooks/useDispatches.ts` with `useDispatches`/`useDispatch`/`useCreateDispatch`. New `src/web/components/dispatch/DispatchModal.tsx` — multi-select swarm picker (filters to online + ACP/mail-capable; toggle to show offline/incompatible), optional prompt textarea, success toast linking to created dispatches. Wired into `SpecDetail` page via a "Dispatch" button (disabled on archived specs). 14 new tests (7 hook + 7 component), all passing.
  - **Verified**: `npm run test:web` (517 passed), `npm run test:run` (2458 passed; same 3 pre-existing failures as before, no new regressions). Build clean. End-to-end against a real daemon not yet exercised — that lands after PR 2 (so dispatches actually transition out of queued).
- **2026-04-15 — Stream 2 PR 2 shipped (agent feedback channel + cancel)**:
  - **Backend**: new `src/map/dispatch-handler.ts` exporting `MAP_DISPATCH_METHODS = { REPORT }`, registered in `map-server-setup.ts`. `map/dispatches/report` accepts `{ dispatch_id, status: 'running' | 'complete' | 'failed', outcome? }` (D11 / D15 — agent-reportable transitions only; cancelled and queued are hub-side). Rejects reports on cancelled/terminal dispatches. Records reporter id + swarm in the broadcast event so the audit trail shows who reported.
  - **REST**: `POST /dispatches/:id/cancel` (D14 — mark cancelled + close session in v1; the proactive-notify-the-swarm path layers on once the D11 contract has receivers). Idempotent on already-cancelled, 409 on terminal states.
  - **WS broadcasts**: `dispatch.status_changed` (running), `dispatch.completed` (complete/failed), `dispatch.cancelled` — all on `map:dispatches`.
  - **Frontend**: new `useCancelDispatch` hook.
  - 24 backend tests (9 dispatch-handler + 5 cancel-route + existing 10) and 8 hook tests, all passing.
- **2026-04-15 — Stream 2 PR 3 shipped (dispatches dashboard + realtime)**:
  - **Frontend**: new `useDispatchesRealtime` hook subscribing to `map:dispatches` and invalidating list/detail caches. New `Dispatches` page (`/dispatches`) with status-chip filter row, swarm dropdown, dispatch cards (id, spec link, swarm chip, initiator chip, status chip, time-ago). New `DispatchDetail` page (`/dispatches/:id`) with metadata grid (spec/swarm/initiator/captured-at), prompt-override panel, sessions panel, outcome panel (summary/error/artifacts), cancel button (only when queued/running), "no completion signal yet" hint when running with no sessions. New `DispatchStatusChip` component (5 statuses with icons; running animates).
  - Nav entry added to Sidebar between Specs and Tasks.
  - 23 frontend tests (3 chip + 5 page + existing dispatch tests), all passing.
- **2026-04-15 — Stream 2 PR 4 shipped (MAP-initiated dispatch + kill switch)**:
  - **Backend**: new `src/map/dispatch-policy.ts` with the in-memory `autonomousDispatchPaused` toggle (D9 retrofit path — global kill switch; restarts default to off). Refactored the dispatch-creation logic in `src/api/routes/specs.ts` into an exported helper `dispatchSpecToSwarms({ resourceId, specId, agentId, initiatorType, targetSwarms, prompt })` so REST and MAP entry points share one path. New `MAP_SPEC_METHODS.DISPATCH = 'map/specs/dispatch'` in spec-handler — checks the kill switch (returns -32004 if paused), creates dispatches with `initiator_type='agent'`, broadcasts. Two admin REST endpoints — `GET /admin/dispatch-policy` and `POST /admin/dispatch-policy { paused }` — to toggle the switch.
  - 9 new tests (4 spec-handler dispatch cases + 5 admin policy route tests), all passing.
- **Stream 2 totals**: 76 new backend tests + 23 new frontend tests = 99 net-new tests, all passing. Suite verified — `npm run test:run` 2488 passed (4 pre-existing failures unrelated, same ones that fail without my changes); `npm run test:web` 526 passed.
- **Open follow-ups for Stream 2**: ~~Hub-side bootstrap~~, ~~Settings UI toggle~~, ~~per-spec dispatch list~~, ~~live e2e~~ — all addressed below.

- **2026-04-15 — Stream 2 live e2e** (HTTP-level against a real opentasks daemon + registered swarms):
  - Built `dist/cli.js`, ran on port 3138 against a fresh `.opentasks/` graph dir with one spec (`c-27j0` context+kind=spec) and one linked task.
  - Registered two MAP swarms via REST (`e2e-swarm-alpha`, `e2e-swarm-beta`) with ACP capabilities.
  - Verified: POST /specs/:rid/:specId/dispatch (single + multi-swarm), seed prompt contains all D13 elements (`<dispatch>` header with id/spec/captured_at + `# title` + body + `## Tasks` + `## Additional instructions`), spec_captured_at correctly captured.
  - Verified: GET /dispatches with all filters (`status`, `spec_id`, combined), GET /dispatches/:id, POST /dispatches/:id/cancel (status flips, idempotent on already-cancelled).
  - Verified: GET/POST /admin/dispatch-policy toggles the in-memory kill switch; rejects non-boolean payloads with 422.
  - Verified: validation 422 on empty target_swarms, 404 on unknown swarm/spec.
  - **No bugs caught.** Local-mode-without-X-Admin-Key returning 200 on admin endpoints is by-design (auto-authed local user is admin).
- **2026-04-15 — Stream 2 follow-up: hub-side session bootstrap**:
  - New `POST /dispatches/:id/bootstrap` opens an ACP stream to the target swarm, initializes, creates a session, sends the rebuilt seed prompt as the first user message, creates a session resource (so it appears in `/sessions`), records `session_ids` on the dispatch and flips status to `running`. Best effort — returns 503 cleanly when SwarmCraft's `acpStreamManager` isn't loaded or the target swarm has no ACP-capable agent. Rejects with 409 if dispatch is already past `queued`. `fetchSpecForDispatch` and `buildDispatchSeedPrompt` exported from `specs.ts` for reuse.
  - Frontend: `useBootstrapDispatch` hook. `DispatchModal` now calls bootstrap for each created dispatch via `Promise.allSettled` after the create returns; toast detail shows `bootstrapped/total` count. Bootstrap failures are non-fatal — the dispatch row still exists at `queued`, modal still closes, user can navigate to detail and retry/cancel.
  - 4 backend route tests (404, 409, 503-no-swarmcraft, auth) + 1 modal test ("bootstrap fails, modal still closes") + the existing modal test extended to assert bootstrap is called. Mail bootstrap intentionally deferred (no clean "seed-with-prompt" mail entry yet).
- **2026-04-15 — Stream 2 follow-up: Settings UI toggle for kill switch**:
  - New `DispatchPolicyCard` component shown at the top of the Server tab in `Settings.tsx`. Reads/writes via new `useDispatchPolicy` and `useUpdateDispatchPolicy` hooks (`/admin/dispatch-policy` GET/POST). Live state shows green shield + "Pause" button; paused state shows red ban icon, red-tinted card, and "Resume" button. Hidden for non-admins. Notes that state is in-memory and resets on hub restart.
  - 5 component tests + 2 hook tests, all passing.
- **2026-04-15 — Stream 2 follow-up: per-spec dispatch list on SpecDetail**:
  - New `SpecDispatchesPanel` sidebar component on `SpecDetail` (above the Tasks/Feedback/Contexts panels). Lists dispatches scoped to the (resource_id, spec_id) pair via `useDispatches({ spec_resource_id, spec_id })`. Each row shows id, swarm name, time-ago, status chip; clicking navigates to `/dispatches/:id`. Subscribes to `useDispatchesRealtime` so a dispatch from elsewhere appears here without refresh.
  - 4 component tests, all passing.
- **Stream 2 totals (post follow-ups)**: 82 net-new backend tests + 35 net-new frontend tests = 117 total. Final suite run: server `2494 passed` (4 pre-existing failures unchanged), web `538 passed`.
- **2026-04-15 — Interactive e2e validation (Stream 1 + Stream 2)**:
  - Fixed **critical bug**: `useWSEvent` infinite render loop on `/specs` — callback in effect deps + whole-store Zustand subscription. Fixed with ref-stabilization + selectors in `src/web/hooks/useWebSocket.ts`.
  - Verified: spec list, compose (localStorage drafts per D10), create → commit, detail, edit-commits-through, LinkedNodesPanel display.
  - Verified: dispatch creation via API, DispatchModal, DispatchDetail, cancel flow, SpecDispatchesPanel, kill switch in Settings.
  - **Bug found**: swarm list polluted with 849 duplicate-looking rows → implemented 3-phase swarm hygiene fix (Phase 1: dedup picker 849→18; Phase 2: archived column + sweep; Phase 3: stable identity schema + upsert). See `src/db/dal/map.ts` `listSwarmsForPicker`, `archiveStaleSwarms`, `upsertSwarmByCanonicalKey`.
- **2026-04-15 — swarm-dispatch integration**:
  - Added `swarm-dispatch` as local dependency (`file:references/swarm-dispatch`).
  - New `src/dispatch/` directory: `openhive-source.ts` (DispatchTaskSource), `openhive-runtime.ts` (DispatchAgentRuntime), `openhive-roster.ts` (AgentRoster), `openhive-mail-port.ts` (MessagePort), `prompt.ts` (data-driven PromptBuilder), `setup.ts` (orchestrator wiring + event bridge).
  - Schema V35: `lease_token`, `lease_expires_at`, `attempt`, `turn_count` on dispatches table.
  - DAL: `claimDispatch`, `releaseDispatch`, `transitionDispatch`, `renewDispatchClaim`, `updateDispatchAttemptTurn`, `listQueuedDispatches`, `listInProgressDispatches`.
  - Wired orchestrator in `server.ts` — starts on boot, stops on shutdown, bridges events to `map:dispatches` WS channel.
  - **Deprecated**: `POST /dispatches/:id/bootstrap` endpoint removed, `useBootstrapDispatch` hook removed, bootstrap call removed from DispatchModal.
  - **Bugs found and fixed**: (1) dispatch stays `running` after spawn failure — fixed event bridge to handle `dead` → `failed` with real error; (2) premature outcome written during retry — fixed source adapter to only write outcome on terminal transitions.
  - Verified e2e: orchestrator claims queued dispatches within 15s, retries 3× with exponential backoff, transitions to `failed` with real error and attempt count on exhaustion, cancel still works.
- **2026-04-15 — Stream 1 link creation**:
  - New `POST /specs/:resourceId/:specId/links` + `DELETE /specs/:resourceId/:specId/links` endpoints using `daemonCreateLink`/`daemonRemoveLink`.
  - Frontend: `useLinkSpec`/`useUnlinkSpec` hooks. `LinkedNodesPanel` gains "+" button (inline form: node ID + edge type + direction) and per-node "×" unlink button (hover-reveal).
  - Wired into SpecDetail for Tasks, Feedback, and Contexts panels.
- **2026-04-15 — Dead code cleanup + stale copy fix**:
  - DispatchDetail: replaced stale `map/dispatches/report` copy with orchestrator-managed message.
  - Added "Orchestrator progress" section showing attempt + turn_count.
  - Removed `useBootstrapDispatch` hook definition + `notifyAgentStopped` stub.
- **Next**: Stream 3 (compose UX), Stream 4 (observability), Stream 5 (onboarding), Stream 6 (learning). Sidecar stable_identity adoption for cc-swarm + macro-agent. Test coverage for `src/dispatch/` adapters.
