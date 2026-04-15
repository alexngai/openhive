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

---

## Open decisions

None. All design-review questions resolved. New questions will accrue during implementation.

---

## Stream 1 — Specs surfacing (view + author)

Goal: specs are browsable, authorable, linkable from the UI. No new persistence.

### Backend
- [ ] Query helper: list opentasks context nodes filtered to `kind=spec` (local + remote via existing opentasks-remote)
- [ ] REST route: `GET /specs` (list across reachable daemons, paginated)
- [ ] REST route: `GET /specs/:id` (detail, delegates to opentasks resource-content)
- [ ] MAP endpoint: `map/specs/author` — agent-authored spec creation (open to any registered agent per D9)
- [ ] Event emission: `spec.authored`, `spec.updated`, `spec.linked` (derived from opentasks events + kind filter)
- [ ] Tests: query helper + route integration

### Frontend
- [ ] `src/web/pages/Specs.tsx` — list view
- [ ] `src/web/pages/SpecDetail.tsx` — detail + edit (edits commit through to opentasks per D10)
- [ ] Spec editor component (markdown body + structured fields: goals, acceptance, out-of-scope)
- [ ] New-spec compose: `localStorage` draft autosave, commit on Save/Dispatch (per D10)
- [ ] "Pending review" inbox/badge for specs with `metadata.review_status: 'pending'`
- [ ] Link picker: spec ↔ task, spec ↔ context (opentasks graph edges)
- [ ] Realtime invalidation on `map:tasks` channel (reuse existing; filter by kind)
- [ ] React Query hooks in `src/web/hooks/`
- [ ] Nav entry: "Specs" as first-class

---

## Stream 2 — Dispatch primitive

Goal: explicit `(spec, swarm)` dispatch replaces free-text `assignee`. Bootstrap sessions on target swarms. Open to any registered agent; audit + kill switch as safety net (per D9).

### Backend
- [ ] Schema migration: `dispatches` table (fields: id, spec_ref, target_swarm_id, status, initiator_type, initiator_id, session_ids, outcome, created_at, updated_at)
- [ ] `src/db/dal/dispatches.ts` — CRUD, status transitions
- [ ] `src/api/routes/dispatches.ts` — list, detail, cancel
- [ ] `POST /specs/:id/dispatch { target_swarms[], prompt? }` — creates N dispatches, bootstraps sessions (per D8, `independent` semantics only)
- [ ] Session bootstrap helper: seeds ACP / mail session with goal + spec ref + linked task ids (uses existing adapters)
- [ ] MAP endpoint: `map/specs/dispatch` — agent-initiated dispatch (open to any registered agent per D9)
- [ ] Event emission: `dispatch.created`, `dispatch.status_changed`, `dispatch.completed`
- [ ] `map:dispatches` WS channel + broadcast
- [ ] Audit: `initiator` recorded on every dispatch; status transitions logged
- [ ] Global kill switch: admin setting `autonomousDispatchPaused: boolean` — when true, agent-initiated dispatches return 503; user-initiated dispatches still work
- [ ] Tests: dispatch happy path, unreachable swarm, cancel, multi-swarm, kill switch on/off

### Frontend
- [ ] Dispatch modal (`DispatchModal.tsx`): swarm picker, multi-select, confirm
- [ ] Reusable from Spec detail, Task detail, SwarmDetail, command palette
- [ ] Ack toast linking to created dispatch(es) + session(s)
- [ ] Cancel action from dispatch detail
- [ ] `Initiator` chip visible in every dispatch list item + detail view (user name or agent id)
- [ ] Admin toggle in Settings for autonomous-dispatch kill switch

---

## Stream 3 — Compose UX

Goal: authoring a spec + dispatching takes seconds. Agents can help.

- [ ] Global command palette (⌘K / cmd-K): "New spec", "New task", "Dispatch spec"
- [ ] Quick-add modal for specs (lightweight; "expand to full editor" option)
- [ ] Agent-assist panel inside compose — chat channel w/ structured output contract
  - [ ] Structured output schema (fields: title, description, goals, tasks[])
  - [ ] Apply-to-form action ("insert agent's draft into the form")
- [ ] Template gallery: feature / bug / research / triage
- [ ] `localStorage` draft autosave + reload recovery (per D10)

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
- [ ] CLAUDE.md section update once Dispatch ships
- [ ] Migration nudge: existing task `assignee` flows keep working, UI suggests dispatch

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
- **Next**: kick off Stream 2 (Dispatch primitive) when ready.
