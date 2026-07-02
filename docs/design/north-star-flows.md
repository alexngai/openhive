# North Star UX Flows

**Date:** 2026-07-01
**Status:** Proposed
**Inputs:** `usability-audit.md` (Parts 1 + 2), parity/coordination deep-dives
**Drives:** the next implementation cycle (phases at the bottom map every audit gap to a flow)

---

## Product thesis

> OpenHive is the cockpit where one person runs, discusses, dispatches, and validates a fleet of coding agents — and it beats N terminal sessions because attention flows *to* the human instead of the human scanning panes.

The audit showed the failure mode precisely: the advertised pipeline (specs → dispatch) is unreachable on a fresh instance, while the reachable path (hosted chat) is unadvertised — and even when running, the UI is single-focus where terminals are N-focus. The north star is one coherent loop where every surface hands off to the next:

```
CONNECT ──► CONVERSE ──► SPEC & DISCUSS ──► DISPATCH ──► MONITOR ──► VALIDATE ──► CLOSE
   ▲            │                                            │                      │
   └────────────┴──────────────── attention queue ◄──────────┴──────────────────────┘
```

## Design principles

1. **Every empty state points at a reachable action.** No page may tell the user to go somewhere that dead-ends on a fresh instance (today: Jobs → Specs → "no task graphs" wall).
2. **Attention comes to you.** Permission requests, idle-awaiting-input, dispatch failures, and completed work all land in one global queue. The user should be able to safely *not watch* N agents.
3. **One chat contract everywhere.** Every conversational surface (session, mail, dispatch thread, spec discussion, hosted chat) renders through `ChatMessageList`/`ChatInput`/`PermissionDialog` via `useChatChannel`. No hand-rolled bubbles.
4. **Hub-only value first.** The core loop must work with zero external sidecars: hosted swarms + hub mail + hub dispatch. Sidecar-powered features (cross-daemon task convergence, cascade diffs) are progressive enhancements, gated and labeled — never silent prerequisites.
5. **Five minutes to first conversation.** `git clone` → talking to an agent must be a guided, single-path journey.

---

## Flow 1 — First Contact

*Fresh install → talking to an agent in under 5 minutes.*

### North-star narrative

1. `npm run dev` → CLI wizard (exists today) finishes by printing "Open http://localhost:7836 — the app will walk you through connecting your first agent."
2. Web app detects zero swarms and shows a **first-run panel** (on Dashboard or as the Threads empty state) with two cards:
   - **Spawn a hosted agent** — one click, sensible default (Codex RPC), with a *preflight check* that verifies `codex`/`claude` on PATH and API keys in env *before* the form submits, showing actionable errors ("`codex` not found — install with …") instead of post-submit toasts.
   - **Connect an existing agent** — shows a copy-paste one-liner built from a freshly minted onboard token (`openhive admin onboard-token` equivalent via admin API) + the MAP WS URL, plus a link to `/skill.md`.
3. Spawn completes → the app navigates *directly into the new thread* and focuses the composer. The user types; the agent answers.
4. The first-run panel's third card, **Create your first spec**, stays visible and unlocks Flow 3.

### Today / gaps

- Wizard exists (`src/cli.ts:105-308`) but ends without next-step guidance; no web onboarding at all.
- Fastest real path is ~13 unguided steps; spawn prerequisites fail as post-submit toasts (audit #26).
- Connect dialog expects the user to already run a MAP server; README documents retired preauth keys (#23); no one-liner anywhere.

### Build

- First-run panel component (zero-swarm detection is trivial — swarms query already exists).
- Spawn preflight endpoint (`GET /swarms/preflight?kind=codex` → binary/creds checks server-side).
- Onboard-token generator surfaced in the Connect dialog + Settings → Connectivity.
- Post-spawn auto-navigate into the thread.
- Doc fixes: README preauth section, mail skill fragment (#24).

### Done when

A new user on a machine with `codex` installed goes clone → conversation in ≤5 minutes without reading docs, and a user *without* `codex` gets told exactly that before submitting anything.

---

## Flow 2 — The Cockpit

*Run and steer N sessions in parallel; attention comes to you.*

### North-star narrative

1. Threads is home. A **"New session"** button in the sidebar opens a two-tab picker: *hosted* (kind + cwd + optional initial prompt — the compact version of the spawn form) and *connect* (online ACP agents). One click later you're in the session.
2. The user repeats this to get 3–5 concurrent sessions. The sidebar shows each thread's live state: **working** (streaming), **needs permission**, **awaiting input**, **idle/done** — as distinct visual states, not one pulse.
3. A **global attention badge** in the nav aggregates needs-permission + awaiting-input across *all* threads. Clicking it opens a queue; each item deep-links to the thread — or, for permissions, offers **Allow/Deny inline** from the queue itself.
4. A **grid toggle** on Threads switches from master-detail to an N-up grid (2×2 default) of live thread panes — the "tmux view". Each pane is the same chat surface (composer, permission dialog, cancel) at reduced density.
5. Every session surface has the same affordances: send, **cancel** (missing on SessionDetail today, #28), mode badge, permission dialog, and — for hosted claude-code — the embedded terminal tab.
6. After a hub restart, Threads shows a "resume available" banner per recoverable session and a one-click **Resume all** (backend exists).

### Today / gaps

- No New-session button; entry paths cost 8–12 steps or require pre-registered ACP agents.
- Single detail pane; permission requests invisible unless focused; `attentionCount()` exists but unwired.
- Cancel only in ChatFab; multi-tab ACP sharing already works (`sessions.ts:1552-1567`) so the grid is frontend-only.

### Build

- New-session picker (composes existing spawn + acp-connect APIs).
- Attention store upgrade: add permission-pending events to `session-attention`, wire `attentionCount` to a nav badge + queue panel with inline permission replies (permission reply endpoints exist for ACP and hosted chat).
- Thread-row state chips (working/permission/awaiting/idle) driven by existing WS events (`trajectory:sync`, ACP stream state, permission events).
- Grid view over existing thread detail components.
- Affordance unification on SessionDetail (cancel, terminal tab consistency).

### Done when

The user runs 4 sessions, minimizes the window, and misses nothing: every permission and idle event lands in the queue, and any of them is answerable in ≤2 clicks without hunting.

---

## Flow 3 — Spec & Discuss

*Author a spec and hold a discussion around it — with agents and humans — before any dispatch.*

### North-star narrative

1. From Threads (first-run card) or Specs, the user clicks **New spec**. On a fresh instance the form offers **"Create a task graph"** inline (hub-local or hosted-daemon-backed) instead of dead-ending — day zero is fixed.
2. The user writes the spec. SpecDetail now has a **Discussion** tab: a spec-scoped mail thread created on demand (`POST /specs/:rid/:id/thread` → mail conversation with `spec_id` metadata), rendered on the unified chat contract.
3. The user invites agents into the discussion ("@codex-1, review this spec for feasibility"). Invited agents receive the thread via the existing mail push bridge; replies stream into the tab. Humans and agents interleave.
4. The discussion thread persists through the spec's life: dispatch outcomes, validation results (Flow 5), and cascade links post into it as system turns, making the spec page the single narrative of the work.

### Today / gaps

- P0 #1: no spec discussion primitive; threads only exist lazily after an agent posts to a dispatch.
- `/specs/new` requires a pre-existing OpenTasks graph with no UI to create one; remote writes 503 (#7).
- Mail layer is verified functional hub-side (create/invite/turn/push/retry) — the missing piece is one route + one panel + a human-facing create path (#14).

### Build

- Task-graph bootstrap: minimal "create graph" action (the largest unknown in this cycle — needs a hub-local OpenTasks daemon or embedded graph store decision).
- `POST /specs/:rid/:id/thread` + `POST /mail/conversations` (fixes #14 and the stale skill fragment #24).
- SpecDetail Discussion tab on `useChatChannel` + agent invite picker.
- System-turn posting hooks from dispatch/cascade events into the spec thread.

### Done when

On a fresh instance, the user creates a spec, opens a discussion, gets a substantive reply from an invited agent in that thread, and the whole exchange is visible on the spec page.

---

## Flow 4 — Dispatch a Team

*Fan a spec out to multiple agents that know about each other.*

### North-star narrative

1. From SpecDetail (or straight from its Discussion), the user clicks **Dispatch**. The modal now exposes what the backend already accepts: target swarms, **loadout**, **team template + role**, **repo/branch**, transport lifecycle — with sane defaults so the simple case stays two clicks.
2. When N > 1 targets are selected, the modal offers **"Coordinated team"** mode: all executors + the initiator are auto-invited into **one shared mail thread**, and each agent's prompt includes a **peer roster** ("you are working with codex-2 on backend, claude-1 on tests…") plus the shared thread tag.
3. Dispatch creates N rows *and* a **spec-level rollup**: SpecDetail shows "2/3 running, 1 complete" with per-dispatch drill-down. The rollup, not the individual row, is the primary progress surface.
4. Dispatch threads render on the unified chat contract, and the composer exists *before* the first agent message (kills the chicken-and-egg, #10) so the user can nudge a silent agent.
5. **Cancel means stop**: cancel sends `map/dispatches/cancel` to the agent, with the existing reconcile-terminate as fallback; the UI shows acknowledged vs not.

### Today / gaps

- #4 thin modal (backend schema already has every field); #6 no rollup; #9/#10 hand-rolled hidden thread UI; #5 cancel partially mitigated only.
- Roster (`openhive-roster.ts`) is executor *selection*, not peer awareness; fan-out produces N mutually-unaware workers.

### Build

- Dispatch modal expansion (frontend against existing `DispatchSpecSchema`).
- Coordinated-team mode: shared-thread creation at dispatch time (eager `ensureDispatchConversation` variant spanning the fan-out) + roster injection into `prompt.ts`.
- Spec rollup panel (aggregate over existing dispatch rows + linked-task statuses).
- `DispatchThreadSection` → `ChatMessageList`/`ChatInput`, rendered pre-conversation.
- `map/dispatches/cancel` MAP method + agent ack plumbing.

### Done when

One spec dispatched to 3 swarms yields one shared thread where the agents reference each other's work, a rollup that answers "is this spec done?" at a glance, and a cancel that verifiably stops a runaway agent.

---

## Flow 5 — Validate & Close

*From "dispatch complete" to "verified and closed" without leaving the flow.*

### North-star narrative

1. A dispatch completes → attention queue item: "codex-1 finished *Add rate limiting* — review". Clicking it lands on the outcome view: summary, artifacts, and an inline **diff** (deep-linked cascade stream when available; files-touched fallback when the diff capability is absent, clearly labeled per principle 4).
2. The user picks one of three actions:
   - **Accept & close** — marks linked tasks closed (one click, replacing today's buried graph-sidebar edit).
   - **Dispatch validation** — one click opens the dispatch modal pre-filled with a reviewer-role prompt template (outcome summary + stream link + acceptance criteria from the spec), targeting a different swarm. The validator's verdict posts back into the spec discussion thread.
   - **Send back** — reply into the dispatch/spec thread with feedback; optionally re-dispatch.
3. The spec rollup and discussion thread reflect the terminal state, so the spec page reads as a complete story: discussed → dispatched → validated → closed.

### Today / gaps

- Validation is observe-only: DispatchDetail → Changes diff → *manual* close via graph sidebar; no reviewer dispatch concept; no acceptance capture; outcome→Changes links are list-level not deep links (partially improved by ui-consistency pass).
- Cascade auto-close exists but is opt-in (`close_policy: on_merge`) and disconnected from human review.

### Build

- Outcome view actions: Accept & close (wraps existing task status update), Dispatch-validation preset (template + prefilled modal), Send back (thread reply).
- Deep-link outcome → cascade stream diff.
- Validator verdict → system turn in spec thread (reuses Flow 3 hooks).
- Completion events → attention queue (reuses Flow 2 infrastructure).

### Done when

The user validates and closes a completed dispatch in ≤3 clicks, or launches a validator agent in ≤2, and the spec page shows the full lifecycle.

---

## Implementation sequence

Dependencies: Flow 2's attention queue feeds Flows 4/5; Flow 3's thread + graph bootstrap feeds Flows 4/5; Flow 1 is independent.

| Phase | Delivers | Flows | Closes audit issues |
|-------|----------|-------|---------------------|
| **P1 — Cockpit core** | New-session picker, attention queue + badge, thread state chips, cancel/affordance unification | 2 | #28; parity gaps 1–3 |
| **P2 — Day zero** | First-run panel, spawn preflight, onboard one-liner, task-graph bootstrap, doc fixes | 1, 3 (partial) | #3, #23, #24, #26; SpecNew dead end |
| **P3 — Spec threads** | `POST /mail/conversations`, spec discussion tab, agent invites, system-turn hooks | 3 | #1, #14 |
| **P4 — Team dispatch** | Modal expansion, coordinated-team mode (shared thread + roster), spec rollup, unified dispatch thread UI, real cancel | 4 | #4, #5, #6, #9, #10 |
| **P5 — Validate loop** | Outcome actions, validator preset, diff deep links, completion → attention | 5 | #18 + validation gaps |
| Later | Grid view polish, remote spec writes (#7/#8), durable kill switch (#12), coordination-message delivery (#27), mail-as-request handler (#25) | — | remainder |

P1 and P2 can proceed in parallel (frontend-heavy vs. bootstrap/backend-heavy). The task-graph bootstrap spike is complete — the hub-default graph option (Option A) was validated and chosen; see the wave-1 plan.

**→ Ticket-level plan for P1 + P2: [`north-star-flows-wave1-plan.md`](north-star-flows-wave1-plan.md).**

## Non-goals this cycle

- Cross-daemon task-graph convergence without the sidecar (stays sidecar-powered; hub remains relay).
- Hub-side work *splitting* across a fan-out (agents divide work via the shared thread, not the hub).
- Cross-instance mail federation.
- Platform bridge (Slack/Discord) inbound revival.
