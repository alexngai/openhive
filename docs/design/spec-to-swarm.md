---
status: draft
owner: alexngai
created: 2026-04-15
revised: 2026-04-15
---

# Spec → Task → Swarm: OpenHive as a Work Origination Platform

## Vision

OpenHive should let users **author specs, context, and tasks quickly — with or without agent assistance — and dispatch that work to hosted or connected swarms for coordinated execution.**

Today OpenHive is strong at the middle and end of that pipeline (task graph, session trajectories, chat surfaces, MAP coordination) but weak at the beginning (authoring) and at the handoff (explicit dispatch). This document captures the gaps and the proposed primitives after initial design review.

---

## Where OpenHive is today

### Solid foundation
- **OpenTasks integration**: full CRUD, graph view, ready/blocked queries, local + remote daemon routing (`src/api/routes/resource-content.ts`, `src/map/task-handler.ts`, `src/map/opentasks-remote.ts`).
- **Chat contract**: unified `useChatChannel` from swarmcraft with ACP + Mail adapters, used across Sessions / Conversation / Agent / SwarmDetail.
- **Sessions & trajectories**: five-tier content resolution, event stream rendering, on-demand transcript fetch, capability-gated chat.
- **Swarm hosting + MAP**: spawn local/sandboxed/remote swarms, preauth-key registration, capability aggregation, trajectory sync.
- **MAP participant capabilities**: agents declare capabilities at registration; the hub aggregates and gates operations per-agent.

### Weak seams
1. Authoring entry points (quick-create, agent-assisted drafting) don't exist in the UI.
2. **Specs are invisible to the hub.** sudocode exposes spec/issue operations via MCP but zero references in `src/`. Users can't browse, author, or link specs in OpenHive.
3. Dispatch is implicit (free-text `assignee`) rather than a first-class action with target selection and acknowledgment.
4. No entity records the handoff — spec, tasks, context, target swarm, resulting sessions, and outcome live in separate silos with no cross-reference.
5. Observability is per-resource, not per-work-unit.
6. Preauth-key onboarding and team topology are API-only.

---

## Decisions that shape the architecture

Resolved during design review:

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **"Spec" is the primary noun** | Generic enough for planning, design, feature, bug. Matches sudocode terminology. No new "Brief" concept. |
| D2 | **Specs are OpenTasks context nodes, not a new entity** | Reuses OpenHive's existing opentasks lifecycle (local daemon + MAP remote). No new spec DAL, no new persistence layer. Versioning, linking, file-backing fall out for free. |
| D3 | **Multi-swarm dispatch is first-class** | A spec can target N swarms. Each `(spec, swarm)` pair is a `Dispatch` with its own state, sessions, outcome. |
| D4 | **`Dispatch` is the only new hub-native entity** | Everything else (specs, tasks, contexts) lives in opentasks; dispatch state is inherently hub-level cross-swarm coordination. |
| D5 | **Autonomy designed in from day one, via capabilities + topology** | No policy table. Agent authorization flows through the existing MAP `ParticipantCapabilities` mechanism. Topology (coordinator/worker roles from macro-agent) governs who can do what. |
| D6 | **Versioning via opentasks context node history** | No snapshotting at the Brief/Dispatch layer; the Dispatch records which context-node revision it was dispatched against. |
| D7 | **Spec ↔ hive post bridges via shared context nodes** | Posts and specs can reference the same opentasks context node; no schema coupling needed. |
| D8 | **Multi-swarm dispatch aggregation is `independent` only in v1** | No spec-level aggregate status; each dispatch is a sibling record with its own lifecycle. Agents coordinate via MAP if they need to. `all-must-complete` / `first-wins` parked for later. |
| D9 | **No per-agent capability gating for spec/dispatch at launch** | Any registered MAP agent can author, edit, and dispatch specs. Trust boundary is "who's on the MAP network," not per-agent flags. `Dispatch.initiator` is recorded for audit/visibility; rate limits, budgets, or capability flags can be retrofitted when observed behavior requires it. |
| D10 | **Drafts are frontend-local for new-spec compose; edits commit through** | New spec compose uses React state + `localStorage` until explicit Save. Editing an existing spec commits each change straight to opentasks, matching how task edits already work. Agent-initiated proposals commit directly as opentasks context nodes with `metadata.review_status: 'pending'`. |
| D11 | **Dispatch is a workflow with a feedback channel** | Hub injects a `<dispatch id="…">` header into the seed prompt; the agent reports completion/failure via a new `map/dispatches/report` MAP notification. Without this signal, dispatches never flip from `running` to `complete` automatically — the dashboard would have nothing real to show. |
| D12 | **`spec_ref = { resource_id, spec_id, captured_at }`** | Record the spec's `updated_at` at dispatch time. Cheap to capture, unlocks "spec edited since dispatch" affordances later without committing to full content snapshots. |
| D13 | **Seed prompt is plain markdown with structured sections** | Hidden `<dispatch>` header (id + spec_ref) + spec body + `## Tasks` (linked tasks: title + status + ref) + optional `## Additional instructions` (the request's `prompt?` field). Agents read markdown well; JSON would force an unnecessary parser contract. |
| D14 | **Cancel = mark cancelled + close session** | v1 doesn't proactively notify the swarm to stop work. Once the agent contract from D11 is in place, a `map/dispatches/cancel` extension can layer on without schema change. |
| D15 | **Hub-driven status transitions; agent-driven completion** | `→ queued` (insert), `queued → running` (hub on session bootstrap success), `running → cancelled` (hub on user cancel), `running → complete` / `running → failed` (agent via `map/dispatches/report`). `running` is otherwise sticky — UI surfaces a "no completion signal yet" hint. |

---

## The model

### Nouns

```
Spec                     — opentasks context node (the "what and why")
  ├─ linked Tasks        — opentasks task nodes (executable atoms)
  └─ linked Contexts     — opentasks context nodes (files, memory, prior work)

Dispatch                 — NEW, hub-native
  ├─ spec_ref            — { daemon_url, node_id, revision }
  ├─ target_swarm_id     — one swarm per dispatch; N dispatches per spec for multi-swarm
  ├─ status              — queued | running | complete | failed | cancelled
  ├─ initiator           — { type: 'user' | 'agent', id }
  ├─ session_ids[]       — sessions bootstrapped on the target swarm
  ├─ outcome             — summary + artifacts when complete
  └─ policy              — { approval_required, outcome_aggregation, ... }
```

### Flow

```
1. Author spec           user types (or agent drafts)         → opentasks context node
2. Decompose tasks       user or agent decomposes             → opentasks task nodes, linked
3. Attach context        files, memory, prior sessions        → opentasks context nodes, linked
4. Dispatch              pick target swarm(s), confirm        → N Dispatch rows created
5. Bootstrap sessions    hub uses existing ACP / mail         → sessions spawned on swarms
6. Execute               swarm works against spec + tasks     → events flow, task status updates
7. Observe               dispatch view aggregates state       → per-swarm chips, merged stream
8. Complete              outcome recorded per-dispatch        → linked artifacts, summary
```

### Autonomy via topology + audit, not authorization

Agents author and dispatch specs through MAP. The v1 stance is **permissive**: any registered MAP agent can call `map/specs/*`. The trust boundary is admission to the network (preauth-keys, who you invite) plus the shape of the topology that produced the agents (coordinator vs. worker, team template) — not a per-agent capability table.

**Audit as the safety net.** Every spec creation and every dispatch records an `initiator: { type: 'user' | 'agent', id }`. Every state change emits an event. The UI surfaces this prominently — who dispatched, when, against which spec revision — so a human can always trace what happened and why.

**Kill switch.** A global "pause autonomous dispatch" toggle is the emergency brake. Cheap to add, parked until needed.

**When this approach breaks.** If behavior gets chaotic — runaway chains, repeated dispatches, resource exhaustion — the retrofit path is (in order of likelihood): rate limits per agent, compute budgets per dispatch, and finally a capability cluster if binary gating is warranted. We design the data model so each retrofit is additive, not a schema rewrite.

### Why this collapses nicely

| Before | After |
|---|---|
| Build spec DAL + routes + schema + MAP handler | Reuse opentasks; add spec-kind view queries |
| Build Brief entity + schema + lifecycle | Specs are opentasks nodes; only Dispatch is new |
| Build policy/authorization table | Open at launch; audit + kill switch; retrofit if needed |
| Build separate versioning | Inherit from opentasks |
| Build approval inbox | Reuse chat; per-spec `metadata.review_status` flag |
| Build drafts DAL | Frontend `localStorage` for compose; edits commit through |

The hub's role stays what it already is: relay, coordinator, observer.

---

## Work streams (post-decisions)

### Stream 1 — Specs surfacing (view + author)

Goal: specs are browsable, authorable, linkable from the UI. No new persistence; queries go to existing opentasks plumbing.

- Query helpers in `src/api/routes/resource-content.ts` for "context nodes of kind=spec" (filter + list).
- `src/web/pages/Specs.tsx` + `SpecDetail.tsx`, leveraging existing opentasks hooks.
- Spec editor (markdown body + structured fields like goals / acceptance / out-of-scope). New-spec compose uses frontend-local drafts; edits commit through.
- Link picker UI (spec ↔ task, spec ↔ context) on top of opentasks graph edges.
- MAP endpoint for agent-authored specs. Open to any registered agent.
- "Pending review" affordance for specs authored with `metadata.review_status: 'pending'`.

### Stream 2 — Dispatch primitive

Goal: explicit dispatch replaces free-text `assignee`. One new entity, clean contract.

- Schema migration: `dispatches`.
- `src/db/dal/dispatches.ts`, `src/api/routes/dispatches.ts`.
- `POST /specs/:id/dispatch { target_swarms[], prompt? }` — creates N dispatches, bootstraps sessions via existing ACP/mail adapters, returns ack.
- MAP endpoint for agent-initiated dispatch. Open to any registered agent.
- `initiator: { type, id }` recorded on every dispatch; state-change events emitted.
- `map:dispatches` WS channel.
- Global "pause autonomous dispatch" admin toggle (cheap kill switch).
- Dispatch modal in UI (swarm picker, multi-select, confirm). Surfaces `initiator` prominently in detail views.

### Stream 3 — Compose UX

Goal: authoring a spec + dispatching takes seconds, and agents can help.

- Global command palette (⌘K): "New spec", "New task", "Dispatch existing spec".
- Agent-assist panel inside spec compose — chat channel, structured output → fills spec fields.
- Template gallery (feature, bug, research, triage).
- Quick-add modals reusable from Dashboard and Swarms pages.

### Stream 4 — Observability

Goal: once dispatched, state is visible without hunting.

- Dispatches dashboard: "work in flight" cards across all swarms.
- Per-spec dispatch view: per-swarm chips, merged event stream, task progress, outcome when done.
- Back-references from Session → Dispatch → Spec.
- Realtime via `map:dispatches`.

### Stream 5 — Onboarding & topology

Goal: getting swarms connected and understanding their shape no longer requires the CLI.

- Preauth-key UI: create, share link, revoke.
- Topology view in SwarmDetail: coordinator/worker tree, role badges (read from macro-agent lifecycle).
- Team template editor (macro-agent YAML) — advanced, gated.

### Stream 6 — Learning loop

Goal: dispatched specs benefit from historical outcomes.

- Playbook browser (reads cognitive-core knowledge bank).
- "Suggested swarms" on dispatch modal (ranked by past dispatch similarity + outcome).
- Inline knowledge search from spec editor.

---

## Sequencing

```
Stream 1 ──┐
           ├──→ Stream 3 ──┐
Stream 2 ──┘               ├──→ Stream 4 (observability needs both)
                           │
Stream 5 (parallel anytime)│
Stream 6 (parallel anytime)│
```

Streams 1 and 2 are the unblockers. They can run concurrently — Stream 1 is UI-heavy with light backend, Stream 2 is backend-heavy with a narrow UI slice.

---

## Dispatch orchestration (swarm-dispatch integration)

The dispatch lifecycle is now managed by the [swarm-dispatch](../../references/swarm-dispatch/) library, integrated via adapters in `src/dispatch/`.

### Architecture

```
User clicks Dispatch in UI
  → POST /specs/:id/dispatch → Dispatch row: status=queued (hub DB)

swarm-dispatch orchestrator (in-process, polls every 15s)
  → createOpenHiveDispatchSource polls queued rows
  → claims dispatch (fence token, status → running)
  → builds prompt (turn-aware, spec content as input)
  → tries roster first (prefer-route), falls back to ACP spawn
  → on success: transition → complete, outcome written
  → on failure: retry with exponential backoff (3 attempts)
  → on exhaustion: transition → failed, outcome with error
  → on user cancel: isStillActive() → false → terminates agent

OpenHive hub
  → event bridge writes status changes to dispatch rows
  → broadcasts via map:dispatches WS channel
  → UI updates live
```

### Adapter files

| File | swarm-dispatch interface | What it wraps |
|---|---|---|
| `src/dispatch/openhive-source.ts` | `DispatchTaskSource` | Dispatches table (claim/release/transition with fence tokens) + spec content from opentasks |
| `src/dispatch/openhive-runtime.ts` | `DispatchAgentRuntime` | SwarmCraft ACP stream manager (spawn/terminate/lifecycle) |
| `src/dispatch/openhive-roster.ts` | `AgentRoster` | MAP connection registry (available agents by role) |
| `src/dispatch/openhive-mail-port.ts` | `MessagePort` | `x-dispatch/work` messages via agent-inbox/mail |
| `src/dispatch/prompt.ts` | `PromptBuilder` | Data-driven, turn-aware (first-run/retry/continuation) |
| `src/dispatch/setup.ts` | — | Wires everything, starts orchestrator, bridges events to WS |

### What the hub owns vs. what swarm-dispatch owns

| Concern | Owner |
|---|---|
| Dispatch table (persistent ledger) | Hub |
| Spec → dispatch binding, initiator tracking | Hub |
| UI surfaces, kill switch | Hub |
| Poll → claim → spawn/route → retry → continue | swarm-dispatch |
| Prompt building (turn-aware) | swarm-dispatch (via custom builder) |
| Fence tokens, heartbeat, stale-claim detection | swarm-dispatch |
| Agent roster, dispatch modes, affinity | swarm-dispatch |

### Deprecated in this integration

- `POST /dispatches/:id/bootstrap` — removed; orchestrator handles spawn
- `map/dispatches/report` MAP method — removed; orchestrator reports outcomes
- `useBootstrapDispatch` frontend hook — removed

---

## Open questions

All design-review questions resolved (D1–D10). New questions will accrue here as implementation surfaces them.

---

## Non-goals

- Replacing opentasks or sudocode — we integrate, not supplant.
- Code-graph visualization (swarmcraft territory).
- Auth/access control rework — current model holds.
- Mobile / responsive overhaul.
- Per-agent authorization gating (deferred — see D9). Rate limits, budgets, capability flags are retrofit paths, not v1 scope.
- Multi-swarm outcome aggregation (deferred — see D8). Only `independent` semantics in v1.

---

## Next

See `docs/design/spec-to-swarm-plan.md` for the working plan and status tracker.
