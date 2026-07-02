# North Star Flows — P3 Implementation Plan (Spec & Discuss)

**Date:** 2026-07-01
**Status:** ✅ Implemented (2026-07-02)
**Parent:** [`north-star-flows.md`](north-star-flows.md) Flow 3 (Spec & Discuss)
**Predecessor:** [`north-star-flows-wave1-plan.md`](north-star-flows-wave1-plan.md) (P1 + P2, all shipped)

## Implementation status

All P3.1–P3.6 tickets landed. Where the shipped shape differs from the plan below, the plan text is kept as the design record and the deltas are noted here.

| Ticket | Status | Key files |
|---|---|---|
| P3.1 spec thread create/resolve | ✅ | `src/specs/spec-conversation.ts` (`ensureSpecConversation`, deterministic `spec-thread:<rid>:<sid>` id, create-or-get), `GET`/`POST /specs/:rid/:sid/thread` in `src/api/routes/specs.ts`; tests in `src/__tests__/routes/specs.test.ts` |
| P3.2 REST invite | ✅ | `POST /mail/conversations/:id/participants` in `src/api/routes/mail.ts` (generic, idempotent); `mail.participant.joined` now also fans out to `mail:conversation:<id>` (`src/mail/index.ts`); tests in `src/__tests__/mail/mail-routes.test.ts` |
| P3.3 Discussion tab | ✅ | Document/Discussion tab strip + `?tab=discussion` deep link in `src/web/pages/SpecDetail.tsx`; `SpecDiscussionPanel` + `useSpecThread`/`useCreateSpecThread`; `spec-thread` case in `Sessions.tsx` `mailToThread`; test `spec-discussion-panel.test.tsx` |
| P3.4 agent invite picker | ✅ | `InviteAgentButton` (mail-capable agents) wired via new `MailThreadView` `headerAction` prop; `useInviteMailParticipant`; test `invite-agent-button.test.tsx` |
| P3.5 dispatch outcomes → system turns | ✅ | `postSpecThreadOutcome` (`src/specs/spec-conversation.ts`) called from `src/dispatch/setup.ts` (completed/dead) + `src/map/dispatch-handler.ts` (agent report); `system:*` turns relabeled "Orchestrator" in `MailThreadView`; test `spec-thread-outcome.test.ts` |
| P3.6 docs + skill hygiene | ✅ | `src/api/skill-fragments/mail.ts` + `dispatch.ts`, `src/web/CLAUDE.md`, this doc + `north-star-flows.md` |

**Delta from plan:** no `POST /mail/conversations` create route was added — spec threads rely on the deterministic id + create-or-get, so `POST /specs/:rid/:sid/thread` is the only create path. Turn `metadata` (`{ system: true }`) is passed to `mail/turn` but agent-inbox does not persist it; system-turn rendering keys off the `system:` author prefix instead.

## Goal

Author a spec and hold a discussion around it — with agents and humans — *before* any dispatch. Concretely: SpecDetail grows a **Discussion** tab backed by a spec-scoped mail conversation, agents can be invited into it, and dispatch outcomes post into it as system turns so the spec page becomes the single narrative of the work.

**Acceptance (from the north-star doc):** on a fresh instance, the user creates a spec, opens a discussion, gets a substantive reply from an invited agent in that thread, and the whole exchange is visible on the spec page.

## Ground truth that shapes this plan

Verified against HEAD before planning:

1. **Mail lives in agent-inbox, not the OpenHive DAL.** Conversations/turns are stored in `mail_*` SQLite tables via the embedded agent-inbox module (`src/mail/index.ts:54-72`). There is **no `POST /mail/conversations` REST route** — humans can only join/post to existing conversations (`src/api/routes/mail.ts`). Threads are created today by agents over MAP (`mail/create` JSON-RPC), or lazily by the hub: session chat (`src/api/routes/session-chat.ts:60-95`) and dispatch threads (`src/dispatch/dispatch-conversation.ts:86-114`).
2. **`ensureDispatchConversation` is the factory template.** It calls `mail/create` with a deterministic id, a dedicated `scope`, and back-reference metadata (`dispatch_id`, `spec_id`, `spec_resource_id`), then `mail/invite`s participants. The spec thread is the same shape with a `spec-thread` scope.
3. **Specs are OpenTasks graph nodes, not hub rows.** Identity is `resourceId` (task-graph syncable resource) + `specId` (node id) — `src/api/routes/specs.ts:499-610`. There is nowhere hub-side to hang a `conversation_id` column, and writing it into node metadata would require a daemon round-trip on every read. → use a **deterministic conversation id** derived from `(resourceId, specId)` so create is idempotent and lookup needs no persistence.
4. **The Discussion UI already exists.** `MailThreadView` (`src/web/components/sessions/MailThreadView.tsx`) mounts a conversation on the unified chat contract: `conversationTarget(conversationId)` + `useOpenHiveAdapters()` + `useChatChannel`, with realtime invalidation on `mail:conversation:<id>`. The tab is composition, not new chat plumbing.
5. **System turns are representable today.** Authorship is just `participant_id`; the orchestrator already posts `system:dispatch-orchestrator` turns on retry (`src/dispatch/setup.ts:323-340`) and the UI styles `system:*` authors distinctly (`DispatchThreadSection.tsx:60-61`). Terminal outcomes (`completed` / `dead` / agent `map/dispatches/report`) post nothing today.
6. **`mail/invite` has no REST proxy.** It's hub-internal only (`dispatch-conversation.ts:102-110`). The web UI has no way to add an agent to any conversation.
7. **Push is broadcast, participant-gated locally.** The mail push bridge notifies *every* connected swarm with `mail.canJoin` (minus the sender's swarm) — `src/mail/index.ts:310-330`; sidecars filter locally. So an invited agent's swarm already receives turn pushes; the invite's job is to make the conversation appear in the agent's participant-filtered view and to address it explicitly.

---

## Tickets

### P3.1 Backend: spec thread create/resolve

**Goal:** `POST /specs/:resourceId/:specId/thread` returns a mail conversation bound to the spec — creating it on first call, idempotently.

New module `src/api/routes/spec-thread.ts` (or a section in `specs.ts`) + `src/specs/spec-conversation.ts` factory mirroring `ensureDispatchConversation`:

- Deterministic id: `spec-thread:<resourceId>:<specId>` — verified OK: `mail/create` accepts an arbitrary `id` string (`references/agent-inbox/src/jsonrpc/mail-server.ts:63`) and storage is parameterized SQL, so charset is unconstrained.
- `mail/create` params: `scope: 'spec-thread'`, `subject: 'Spec: <title>'`, `metadata: { source: 'spec-thread', spec_id, spec_resource_id, spec_title }`.
- **Idempotency — verified hazard: `mail/create` is a destructive upsert, not create-or-conflict.** `putConversation` does `INSERT OR REPLACE` + participant re-sync (DELETE + reinsert from the passed object, which create builds with `participants: []`) — `mail-server.ts:60-75`, `storage/sqlite.ts:438-467`. A second `mail/create` with the same id silently **wipes all participants and overwrites metadata**. The factory MUST check `mail/get` first and return the existing conversation, and hold an in-flight promise per key to serialize concurrent creates (copy the `inFlightCreations` map pattern from `src/dispatch/mail-transport.ts:86-118`).
- Auth: `authMiddleware`; validate the spec exists via the same daemon lookup `GET /specs/:rid/:id` uses (404 on missing spec).
- Also `GET /specs/:resourceId/:specId/thread` → `{ conversation_id } | 404` for read-only resolution (frontend uses this to decide whether the Discussion tab shows a thread or a "Start discussion" CTA without side effects).

**Tests:** route test — create → same id on second call; 404 on unknown spec; conversation metadata carries the spec back-references.
**Estimate:** 1 day.

### P3.2 Backend: REST invite (generic mail route)

**Goal:** the web UI (and supervisors generally) can add an agent to a conversation.

`POST /mail/conversations/:id/participants` `{ agent_id, role? }` in `src/api/routes/mail.ts` → proxies `mail/invite` with default `role: 'participant'`. Generic on purpose — the same route serves dispatch threads and future surfaces, not just spec threads.

- 404 on missing conversation. Verified: `mail/invite` is a silent no-op when the agent is already a participant (`mail-server.ts:159-180`) — the route can return `{ ok: true }` unconditionally, no 409 needed.
- Emits the existing `mail.participant.joined` broadcast (already wired in `src/mail/index.ts:185-189`), so open Discussion tabs refresh their roster live.
- Update the mail skill fragment (`src/api/skill-fragments/mail.ts`) which currently documents MAP methods only.

**Tests:** invite adds participant + is idempotent; unauthenticated 401; unknown conversation 404.
**Estimate:** 0.5 day.

### P3.3 Frontend: Discussion tab on SpecDetail

**Goal:** the spec page hosts the discussion.

`SpecDetail.tsx` has no tab system (sticky header + Tiptap editor + right sidebar). Add a lightweight two-tab strip under the header: **Document** (current body) and **Discussion**.

- Discussion tab: resolve via `GET .../thread`. If absent → empty state with a "Start discussion" button (`POST .../thread`). If present → mount `MailThreadView conversationId={...}` (reused as-is; it already handles realtime, participants row, closed-state gating).
- Badge the tab with the turn count (cheap: `GET /mail/conversations/:id` turn count on resolve; live via the `mail:conversation:<id>` subscription MailThreadView already opens).
- Keep the dispatch panel visible on both tabs (right sidebar is orthogonal).
- Deep link: `/specs/:rid/:sid?tab=discussion` so system turns and toasts can link straight into the conversation.

**Tests:** component test — tab renders MailThreadView when thread resolves; "Start discussion" POSTs and swaps in the thread (mocked hooks; pattern: `new-session-menu.test.tsx`).
**Estimate:** 1.5–2 days.

### P3.4 Frontend: agent invite picker

**Goal:** "@codex-1, review this spec" — pull an agent into the discussion from the spec page.

Add an **Invite agent** control to the Discussion tab (next to MailThreadView's participant stack). Popover lists online agents grouped per swarm — reuse `buildSwarmGroups` (`chat-fab/SessionPicker.tsx`) but keep **mail-mode** agents this time (any agent on a `mail.canJoin` swarm is addressable; that's the relevant capability here, not ACP).

- Selecting an agent → `POST /mail/conversations/:id/participants` (P3.2). Optimistically add to the roster; `mail.participant.joined` confirms.
- After invite, prefill the composer with `@<agent-name> ` so the user's next turn addresses them (the mail adapter already supports an `addressee` on `conversationTarget` — wire the mention through if trivial, otherwise plain-text mention is fine for v1).

**Tests:** picker lists mail-capable agents; invite calls the route and updates roster on the WS event (mocked).
**Estimate:** 1 day.

### P3.5 Backend: dispatch outcomes → spec-thread system turns

**Goal:** the spec discussion accumulates the work narrative automatically.

Hook points (all already touch the dispatch row, which carries `spec_resource_id` + `spec_id` — `src/db/schema.ts:651-653`):

- Orchestrator bridge terminal events: `completed` / `dead` in `src/dispatch/setup.ts` (~250 / ~279) — alongside `finalizeDispatch`.
- Agent self-reports: terminal `map/dispatches/report` in `src/map/dispatch-handler.ts:109-146`.

On terminal state, if the dispatch has spec refs, resolve the deterministic spec-thread id (P3.1 — no DB lookup needed) and, **only if that conversation exists**, post a `system:dispatch-orchestrator` turn: outcome (`complete`/`failed`/`dead`), swarm name, one-line summary/error, and a `/dispatch/<id>` link. Reuse the retry-turn shape (`setup.ts:323-340`) including `metadata: { system: true, dispatch_id }`.

Deliberate scope limits:

- No thread is *created* by outcome hooks — silence stays silent unless the user opened a discussion (this respects the existing "no hub-authored narrative" stance in dispatch threads, `setup.ts:247-249`).
- Dispatch *threads* keep their current behavior; this posts to the **spec** thread only.

**Tests:** unit — terminal event with spec refs + existing thread posts exactly one turn; no thread → no create, no turn; non-spec dispatch → no-op.
**Estimate:** 1 day.

### P3.6 Docs + skill hygiene

- `src/web/CLAUDE.md`: Discussion tab + invite picker section.
- `docs/design/north-star-flows.md`: mark Flow 3 items as they land.
- Skill fragments: `src/api/skill-fragments/mail.ts` (new participants route), specs fragment (thread routes) — so connected agents discover they can be invited into and post to spec threads.

**Estimate:** 0.5 day.

---

## Sequencing & dependencies

```
P3.1 (thread create) ──► P3.3 (Discussion tab) ──► P3.4 (invite picker)
        │                                              ▲
        └──────────► P3.5 (system turns)               │
P3.2 (REST invite) ────────────────────────────────────┘
```

P3.1 + P3.2 are independent backend tickets and can land in parallel. P3.5 depends only on P3.1's deterministic-id convention. Total: ~5–6 days.

## Mail delivery model — why invited agents may not reply promptly

Traced end to end (2026-07-01). OpenHive mail is deliberately **store-and-pull with best-effort push**, because agent runtimes split into two tiers:

| | macro-agent (push-capable) | cc-swarm / Claude Code (pull-only) |
|---|---|---|
| `mail/turn.received` push | Handled by `setupMailBridge` (`references/macro-agent/src/map/mail-bridge.ts`) → local inbox → TriggerSystemV2 wake (inject / queue / interrupt by `importance`) | **No handler** — pushes are dropped at the sidecar (harmless by design; Claude Code has no "start a turn" API) |
| How mail is read | Live, event-driven | On reactivation only: `UserPromptSubmit` hook drains local inbox + nudge flags (`map-hook.mjs:76-132`); dispatch continuation prompt reports unread counts |
| Wake authority | Local WakeManager | **The dispatch orchestrator** — `continuationPolicy` checks `checkThreadPending` against the hub store and grants up to `maxThreadTurns` extra turns (`src/dispatch/setup.ts:117-140`); `x-dispatch/nudge` is a latency hint only (D8, `docs/design/dispatch-inbox-threads.md`) |

The hub push bridge (`src/mail/index.ts:304-380`) broadcasts to *all* `mail.canJoin` swarms (not participants) with an always-queue + 5-min-TTL redelivery shim — precision doesn't matter because the store is the source of truth and delivery is only a latency optimization. Thread identity binds to stable inbox IDs so a dormant agent's membership survives; a reactivated/re-dispatched agent reads the history it slept through.

**Consequence for P3.4:** all existing wake machinery is *dispatch-scoped* (keyed by `dispatch_id`). A spec thread has no dispatch, hence no wake authority — an invite to a Claude Code agent sits unread until that agent gets a turn for unrelated reasons. Options, in preference order:

1. **Dispatch-as-wake (recommended, aligns with Flow 5):** for pull-only agents, "invite to discuss" materializes as a small review *dispatch* whose prompt points at the spec thread; the orchestrator's continuation policy then guarantees pickup and reply turns. Can ship as a P3.4 follow-up or fold into P4.
2. **Generic conversation nudge:** extend `x-dispatch/nudge` to an `x-mail/nudge` for arbitrary conversations — helps only agents with an *active* session (next `UserPromptSubmit`), still no wake for dormant ones.
3. **Presence-aware invite UX (cheap, do regardless):** `mail/presence` is implemented in agent-inbox and already used by dispatch routes (`src/api/routes/dispatches.ts`, `dispatch-presence.test.ts`) — the invite picker should show participant presence ("dormant — will see this on reactivation") so async semantics are explicit rather than surprising.

## Pre-implementation derisk findings (verified 2026-07-01)

Checked against agent-inbox source (`references/agent-inbox/src/`) and both sidecar implementations before writing code:

**Resolved — safe to build on:**

1. **Deterministic conversation ids** — `mail/create` accepts any `id` string; storage is parameterized SQL, charset unconstrained (`mail-server.ts:63`).
2. **`mail/invite` is idempotent** — silent no-op on duplicate participant, emits `mail.participant.joined` only on actual add (`mail-server.ts:159-180`). P3.2 needs no 409 handling.
3. **System turns need no membership** — `mail/turn` does not check that `participantId` is a participant (`mail-server.ts:183-208`), confirming the hub can post `system:dispatch-orchestrator` outcome turns (P3.5) without inviting the synthetic author.
4. **Human turn authorship** — in local auth mode `request.agent` is the auto-authenticated local agent (`src/api/middleware/auth.ts:45-131`), so human posts get a stable participant id; the REST turn route already auto-joins the poster.

**Hazards found — plan adjusted:**

5. **`mail/create` is a destructive upsert** (folded into P3.1): a repeat create with the same deterministic id wipes participants and overwrites metadata via `INSERT OR REPLACE` + participant re-sync. Get-before-create + in-flight-promise serialization is mandatory, not defensive.
6. **macro-agent's mail bridge drops plain-text turns.** `parseTurnContent` returns null for non-JSON content and the handler logs "Dropping non-JSON turn" (`references/macro-agent/src/map/mail-bridge.ts:138-147`) — the bridge exists to feed `x-dispatch/work` envelopes to the dispatcher, not to relay conversation. **Consequence: today *neither* tier surfaces a natural-language spec-thread turn to a live agent** — Tier 1 drops it at the bridge, Tier 2 never handles the push at all. This upgrades "dispatch-as-wake" from recommended to **the only working reply mechanism at P3 launch**:
   - P3.4 v1 ships invite + presence display, with honest UX ("will see this when next activated / dispatched").
   - A "Request review" action that creates a small review dispatch pointing at the spec thread (Flow 5 shape) is the reliable reply path — consider pulling it forward from P4/P5 into P3.4 scope.
   - Making macro-agent's bridge forward text turns (with importance-driven wake) is a macro-agent-repo change, tracked separately; it upgrades Tier 1 to live replies without any OpenHive change.

**Upstream fix options (all three repos are ours; agent-inbox + macro-agent are checked out in `references/`):**

| Fix | Repo | Change | Effect | Status |
|---|---|---|---|---|
| `mail/create` → create-or-get | agent-inbox (`jsonrpc/mail-server.ts`) | Return existing conversation when `params.id` already exists; skip `mail.created` emit | Removes the participant-wipe footgun for all consumers (hazard #5 stops being load-bearing in P3.1) | ✅ done (0.2.5) |
| `mail/join`/`invite`/`leave` → atomic storage helpers | agent-inbox (`mail-server.ts`) | Replace read-modify-write `putConversation` with `addParticipant` (`INSERT OR IGNORE`) + new `removeParticipant`; `touchConversation` for updated_at | Fixes concurrent-invite/leave lost-update race | ✅ done (0.2.5) |
| Push payload + conversation context | agent-inbox (`jsonrpc/mail-push-types.ts` + `mail-push.ts`) | Optional `conversation` block (`scope`/`subject`/`metadata`/participant ids) on `MailTurnReceivedParams`; new optional `resolveConversation` resolver on `MailPushBridgeConfig` (additive) | Lets sidecars filter/route pushes without a hub round-trip; prerequisite for the macro-agent relay fix | ✅ done (0.2.5) |
| Relay text turns to local inbox | macro-agent (`src/map/mail-bridge.ts`) | Deliver non-JSON turns to local participant agents as `{ type: "text", text, _conversationId }` with wire `importance` instead of dropping (empty turns skipped) | Tier 1 gets live conversational replies (wake via TriggerSystemV2) — no OpenHive change needed | ✅ done (0.2.5, committed; publish pending — npm 0.2.4 was published without the fix) |
| Handle `mail/turn.received` | claude-code-swarm (sidecar) | Store pushed turns into the local inbox for the main agent | Tier 2 improves from "on reactivation" to "on next turn" for active sessions (`UserPromptSubmit` drain + `check_inbox` already exist) | ☐ pending |

Dormant Claude Code agents remain dispatch-as-wake territory regardless — that's a runtime limitation, not a library gap.

**agent-inbox 0.2.5 — published + consumed 2026-07-02.** Committed in `references/agent-inbox` (build + full 425-test suite green) and published to npm as `0.2.5`. Note: an earlier `0.2.4` was published that did *not* contain any of these changes (a plain bump off `0.2.3`), so `0.2.4` is unusable and the work landed in `0.2.5`. The bump carries a `Storage` interface change (`removeParticipant`, breaking for external implementors) plus new public API (`resolveConversation`, the `conversation` push block). **Consumed by OpenHive:** `package.json` dep bumped to `agent-inbox@^0.2.5`, and `src/mail/index.ts`'s `startMailPushBridge` now passes `resolveConversation: (turn) => getMailStorage().getConversation(turn.conversation_id)` to `createMailPushBridge`. Typecheck clean (only pre-existing unrelated error: `autonomation/experiment-config` subpath in `src/experiments/worker`). The get-before-create + in-flight-promise pattern in P3.1's factory stays as defense-in-depth even though create-or-get now makes it non-load-bearing.
Other dep ranges for the pending fixes: `macro-agent@^0.2.4`, `claude-code-swarm@^0.3.21`.

> **Env note (2026-07-02, resolved):** a clean `npm install` briefly failed because `@swarmkit-ai/swarm-runner@0.1.18` had been removed from the registry; after republishing as `0.1.19` (and a short propagation delay) the full tree reconciles cleanly. OpenHive's dep is now `@swarmkit-ai/swarm-runner@^0.1.19`. `agent-inbox@0.2.5` + `swarm-runner@0.1.19` install via `npm install`; typecheck is clean for the mail wiring and all 56 OpenHive mail tests pass. (Two unrelated pre-existing `tsc` errors remain in `src/experiments/worker/*` from missing `autonomation/experiment*` subpath exports.)

**Remaining open questions:**

7. **Threads-list mapping** — spec-thread conversations will surface on `/threads` as generic `mail` flavor linking to `/threads/mail/:id` (`Sessions.tsx:106-124` special-cases only `dispatch-thread`). P3.3 should add a `spec-thread` case linking to `/specs/:rid/:sid?tab=discussion` so the two surfaces don't compete.
8. **`system:*` turn rendering in `MailThreadView`** — confirmed gap: `DispatchThreadSection` styles system authors distinctly, but `MailThreadView` has no `system:` handling at all. Small frontend item — add it to P3.5 scope so outcome turns don't render as an "agent" named `system:dispatch-orchestrator`.
9. **Turn-count badge cost** — if `GET /mail/conversations/:id` is heavy for long threads, drop the count and badge presence only.
