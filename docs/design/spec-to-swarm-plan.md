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
- **Next**: scope out Stream 1 and Stream 2 implementation tickets in parallel. Potential first PRs: `GET /specs` + list UI skeleton (Stream 1); `dispatches` schema + `POST /specs/:id/dispatch` stub (Stream 2).
