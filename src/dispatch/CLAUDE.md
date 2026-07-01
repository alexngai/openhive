# src/dispatch — swarm-dispatch integration layer

OpenHive-specific adapters + wiring for the `swarm-dispatch` library. The library ships a generic orchestrator (poll → claim → route → retry → complete/fail); this directory plugs OpenHive's data, transport, and registry into its adapter ports. The orchestrator itself is hub-native but scoped — it's a **named subsystem with explicit policy surfaces**, not a hidden opinion baked into handler code.

## File roles

- **`setup.ts`** — composes an `Orchestrator` from the factories below + the event bridge that writes terminal state to `dispatches` and broadcasts to the `map:dispatches` WS channel. Entry point: `setupOrchestrator({ specFetcher, runtimeDeps, messagePort, dispatchConfig })`. The event bridge also pairs the orchestrator's `dispatched` event (carrying `agentId`, `attempt`, `via`) with the OpenHive transport hint stashed by the adapter that performed delivery, then persists the merged row via `recordAttemptDelivery`.
- **`openhive-source.ts`** — `DispatchTaskSource` adapter. Polls the `dispatches` table for `queued` rows, applies fence-token claim semantics, enriches with spec content via the injected fetcher. `enrichWithLoadout` materializes `team_role_ref`/`loadout_ref` bindings, surfaces the role onto `task.metadata.role` (so the orchestrator's `chooseExecutor` can route to role-matched agents), and writes the resolution outcome to the dispatch row's V49 columns (`loadout_ref`, `loadout_status`, `loadout_error`).
- **`openhive-runtime.ts`** — `DispatchAgentRuntime` adapter. Drives ACP stream lifecycle (create → init → session → prompt) via `AcpStreamManager` from the SwarmCraft plugin. Calls `markDelivery({transport: 'acp', agent_id})` on both fresh-spawn and reuse paths so the event bridge can stamp the per-attempt transport.
- **`swarm-codex-runtime.ts`** — optional local Codex executor branch. Uses `swarm-codex`'s `createCodexDispatchRuntime` directly, not a nested `runDispatchedSwarm`, so OpenHive keeps one authoritative orchestrator/retry loop. Intended for `swarm-codex` executor targets only; hosted `kind='codex'` RPC remains an interactive chat/session surface, not a dispatch sidecar.
- **`openhive-roster.ts`** — `AgentRoster` adapter. Walks `getAllInbound()` and surfaces eligible agents to the orchestrator's executor chooser. Implements the `AgentRoster` contract directly (not via `createRegistryRoster`) because **sidecars are universal fallbacks**: when the requested role doesn't match any agent on a swarm, any sidecar registered there is returned as a last-resort target. Real workers/coordinators with an exact role match always win when present. This keeps mail routing alive on sidecar-only swarms after `enrichWithLoadout` started surfacing user-defined team roles like `'executor'`.
- **`openhive-mail-port.ts`** — `MessagePort` adapter. Wraps envelopes for agent-inbox mail delivery, classifies incoming, dedups. Calls `markDelivery({transport: 'mail', agent_id})` after `transport.sendToAgent` returns `delivered: true` so the event bridge picks up the transport on the `dispatched` event.
- **`delivery-tracker.ts`** — tiny in-memory side-channel keyed by `taskId`. Adapters call `markDelivery(taskId, {transport, agent_id})` at the moment of delivery; `setup.ts` calls `claimDelivery(taskId)` on the `dispatched` event and merges with the orchestrator's authoritative attempt+via fields. Avoids cyclic imports between setup ↔ runtime ↔ mail-port.
- **`loadout-side-channel.ts`** — separate side-channel for materialized `MaterializedLoadout` payloads + lifecycle hints. `enrichWithLoadout` registers; runtime/mail-port consume to inject loadout-derived fields (permissions, MCP metadata) into the wire envelope.
- **`mail-transport.ts`** — low-level transport used by the mail port; wires `mail/*` JSON-RPC and sync-listener fanout.
- **`mail-ingress.ts`** — inbound reply normalization for dispatch conversations.
- **`routing.ts`** — `prefer-route` vs `spawn` decision: prefers a connected agent matching the spec's role/tags, falls back to ACP spawn when none match.
- **`prompt.ts`** — turn-aware builder. Produces first-run / retry / continuation prompts so an agent picking up a dispatch on turn N knows the prior context.
- **`wire-loadout.ts`** — shared wire shape for `MaterializedLoadout` → `{permissions, mcpProviders, mcpScope, capabilities}`. Used by both the ACP `dispatch/spawn-agent` request and the mail port's envelope-body injection so the two transports can't drift.
- **`finalize.ts`** — terminal-state outcome enrichment (cascade artifact joining, etc.) called from the event bridge on `completed` / `dead`.

## End-to-end flow

```
user or agent → POST /specs/:resourceId/:specId/dispatch
  → dispatches DAL: insert row with status='queued'
  ↓
Orchestrator poll (every 15s, configurable via config.dispatch.pollIntervalMs)
  ↓
openhive-source claims row with fence token → status='running'
  ↓
routing.ts picks a target:
   – prefer-route: connected agent via openhive-roster (role/tag match, not busy)
   – else: ACP spawn via openhive-runtime.AcpStreamManager
  ↓
prompt.ts builds first-run prompt (or retry/continuation if attempt > 1)
  ↓
openhive-runtime creates ACP stream → prompt → streaming responses
  ↓
   terminal:  ─────────────────────────────────────────────────
   ┌─────────────────────┐     ┌─────────────────────┐   ┌────────────────┐
   │ agent calls         │     │ orchestrator runs   │   │ retries        │
   │ map/dispatches/     │     │ out of attempts     │   │ exhausted      │
   │ report complete|    │     │ (see config.retry)  │   │                │
   │ failed              │     │                     │   │                │
   └──────────┬──────────┘     └──────────┬──────────┘   └────────┬───────┘
              │                            │                      │
              ▼                            ▼                      ▼
    map/dispatches/report handler   setup.ts event bridge       dead event
    (src/map/dispatch-handler.ts)   writes dispatches row        writes failed
              │                            │
              ├───────────────┬────────────┘
                              ▼
              broadcastToChannel('map:dispatches', event)
```

## Status lifecycle (D15)

```
→ queued    (hub writes on insert)
queued → running    (orchestrator claims)
running → cancelled (hub writes on user cancel)
running → complete  (agent reports via map/dispatches/report)
running → failed    (agent reports OR orchestrator exhausts retries)
```

Split write authority:
- **Hub writes**: `→ queued`, `queued → running`, `running → cancelled`
- **Agent writes**: `running → complete | failed` via `map/dispatches/report`
- **Orchestrator writes** (via setup.ts event bridge): `running → complete` on `completed` event, `running → failed` on `dead` event, idempotently guarded against double-write with the agent path.

## Kill switch (D9)

`Settings → Server → Autonomous dispatch` toggles `autonomousDispatchPaused`. When paused:
- Agent-initiated dispatches via `map/specs/dispatch` return `-32004`.
- User-initiated REST dispatches still flow (operator override).

State is in-memory; hub restart resets to live. This is the **explicit operator kill-switch** for the subsystem — the model the cascade task-binder mirrors with `cascade.defaultClosePolicy`.

## Reconciliation

The orchestrator runs a reconcile cycle every 5s (configurable) that:
- Detects external cancels (user clicked Cancel after the row transitioned to `running`) and tells the runtime to terminate.
- Catches stalled attempts (`stallTimeoutMs: 300_000`) and marks them `dead` so retries fire.

## Config surface

`config.dispatch`:
- `globalConcurrency` (5) — max running at once across all swarms
- `pollIntervalMs` (15000) — source poll cadence
- `reconcileIntervalMs` (5000) — external-cancel / stall detection
- `retry.maxRetries` (3), `retry.baseDelayMs` (10000), `retry.maxDelayMs` (300000)
- `scorer` (`heuristic` | `noop`) — ready-dispatch eligibility ordering
- `codex_executor.enabled` (`false`) — enables the local `swarm-codex` dispatch executor branch
- `codex_executor.target_kind` (`swarm-codex`) — metadata/capability marker a MAP swarm row must carry to be treated as a local Codex executor target
- `codex_executor.map_server` (`ws://127.0.0.1:<port>/ws/map` at server setup) — MAP WebSocket URL for the executor sidecar; the runtime appends `swarm_id`
- `codex_executor.command` (`codex`) and `codex_executor.driver` (`mcp`) — Codex worker launch controls
- `codex_executor.sandbox` (`danger-full-access`) — Codex sandbox for dispatch workers. Git-cascade is commit-based, and Codex `workspace-write` blocks `.git/index.lock`, so repo-writing dispatches need full git metadata access unless the operator supplies an equivalent external sandbox.
- `codex_executor.timeoutMs` (`300000`) and `codex_executor.attributionRefreshMs` (`2000`) — worker timeout and cascade-attribution refresh cadence
- `codex_executor.concurrency_per_repo` (`1`) — recommended repo-level ceiling while cascade attribution is a single active hint per watcher

## swarm-codex executor design decisions

- **Separate executor target**: do not overload hosted `kind='codex'` RPC rows. Those rows represent OpenHive-managed interactive Codex sessions. Dispatchable Codex work uses a dedicated executor target marked as `swarm-codex` in the MAP row metadata/capabilities.
- **Repo source of truth**: repo-scoped dispatches must resolve `cwd` from the dispatch repo binding (`repo_id`, `clone_path`, or repo `local_path`). Dispatch without a concrete local repo path fails before spawning Codex.
- **Task ref binding**: cascade gets one `metadata.task_ref`. For v1 the runtime uses the first linked task from `dispatch_linked_tasks`. Multi-task metadata is deferred.
- **Completion semantics**: dispatch completes when the Codex worker exits normally. The continuation policy releases after a Codex-delivered attempt instead of granting normal follow-up turns, because local repo dispatches are one-shot and a second pass can fall through to mail/ACP routing after the commit already exists. Linked task closure remains cascade merge-driven via `src/cascade/task-binder.ts`; a commit-only dispatch can produce artifacts without closing the task.
- **Attribution mechanism**: use programmatic attribution through `CoordinationPlane.recordCascadeAttribution()`. Do not rely on Codex `PostToolUse` hooks inside nested `codex mcp-server` role threads; live probes showed file writes occur without hook events.
- **Sandbox default**: default Codex dispatch workers to `danger-full-access`. Live verification showed `workspace-write` can edit worktree files but cannot create `.git/index.lock`, so `git add` / `git commit` fails and no cascade commit can be projected. This branch is local/dev-oriented and should be paired with explicit executor targeting plus operator-owned repo selection.
- **Concurrency**: default to one active Codex worker per repo. Parallel workers in the same repo can misattribute cascade events until attribution is keyed by branch/worktree or each dispatch gets an isolated worktree.

## Non-goals

- No spec-level aggregate status. Each dispatch row is independent, even when one spec is dispatched to N swarms (D8 — parked `all-must-complete` / `first-wins`).
- No persisted outbound mail log inside this directory. Mail transport delegates to `agent-inbox` for persistence.
- No hub-authored merge. Dispatch may run a cascade-reporting worker, but the cascade-task binder in `src/cascade/` remains the post-work merge observer.

## Relationship to other subsystems

- **Cascade task-binder** (`src/cascade/task-binder.ts`) — same architectural pattern (named orchestrator + opt-in policy + kill-switch). Dispatch drives pre-work; cascade-binder observes post-work.
- **Specs + resources** — `fetchSpecForDispatch` in `src/api/routes/specs.ts` is the injection point for spec content; dispatch doesn't read specs directly.
- **ACP streams** — dispatch owns prompt delivery via `AcpStreamManager`, shared with the chat surface (Sessions, Messages, SwarmDetail) from the SwarmCraft plugin. One stream pool; dispatch and chat both subscribe.
- **Mail** — dispatch replies travel over the agent-inbox mail fabric so agents can respond asynchronously without holding an ACP stream open.

## Persisted dispatch state (V47–V49)

The `dispatches` row carries hub-, orchestrator-, and adapter-written fields:

| Column | Layer | Purpose |
|---|---|---|
| `acp_lifecycle` (V47) | hub on insert | Per-dispatch transport hint: `'fresh'` spawns a new ACP coordinator with loadout permissions enforced at spawn; `'reuse'` attaches to an existing ACP-capable agent (advisory). NULL → `config.dispatch.acp_lifecycle_default` → `'reuse'`. |
| `mail_lifecycle` (V48) | hub on insert | Same shape for the mail transport: `'fresh'` forces routing to the connection's sidecar (which spawns an ephemeral worker per envelope); `'reuse'` lets the roster pick. NULL → config default → `'reuse'`. |
| `loadout_ref` (V49) | source enricher | The original binding string captured at enrichment time — `loadout_xxx` for direct refs, or the synthetic `team:<template>/role:<role>` for team_role_ref bindings. NULL when the spec has no binding. |
| `loadout_status` (V49) | source enricher | `'materialized'` on success; `'failed'` on resolution error (loadout not found, ACL forbidden, etc.); NULL when no binding. Drives the sticky failure banner on `DispatchDetail`. |
| `loadout_error` (V49) | source enricher | Short reason when `loadout_status='failed'`. Suitable for UI display. |
| `attempts_history[].transport` | mail-port / runtime | `'acp'` when the runtime adapter delivered, `'mail'` when the mail port did. Written via the delivery-tracker → event-bridge handoff. |
| `attempts_history[].agent_id` | mail-port / runtime | Resolved target agent id at delivery time (spawned coordinator id for ACP fresh; picked agent for ACP reuse; recipient for mail — the sidecar id when `mail_lifecycle='fresh'`). |
| `attempts_history[].via` | event bridge | `'spawn'` or `'route'` from swarm-dispatch's `dispatched` event. Diagnostic — derived from the orchestrator decision, not the OpenHive transport. |

DAL helpers: `recordLoadoutResolution(id, {ref, status, error?})`, `recordAttemptDelivery(taskId, attempt, {transport?, agent_id?, via?})`. Both idempotent; both safely no-op when the row doesn't exist (best-effort via try/catch in callers).

## Role surfacing contract

`enrichWithLoadout` surfaces `team_role_ref.role` onto `task.metadata.role`. Two downstream consumers each behave differently:

1. **Orchestrator `chooseExecutor`** — passes the role to `roster.findAvailable({role})`. Roster filters exact-match. The sidecar-fallback layer in `openhive-roster.ts` ensures the dispatch still routes on sidecar-only swarms when the requested role doesn't match any registered agent.

2. **Wire envelope** — `body.role` reaches the receiving sidecar's `mail-inbound-consumer`. The consumer should validate the role against its local role registry before passing to `agentManager.spawn`; unknown roles must fall back to `'worker'` (which has the proper ephemeral lifecycle + `done()` system prompt). macro-agent's `mail-inbound-consumer.ts` does this validation; without it, unknown roles silently fall through to `GenericRole` (persistent lifecycle, no done()) and the worker stops without writing `_lastSummary`, breaking the reply path.

If you add a new dispatch transport that spawns workers from the wire envelope, mirror this validation — never trust the surfaced role string blindly.

## Tests

- Adapter unit tests: `src/__tests__/dispatch/*` and `src/__tests__/dal/dispatches-*`
- Event bridge: `src/__tests__/dispatch/event-bridge.test.ts`
- V49 persistence (real dispatch rows + DAL writes): `src/__tests__/integrations/dispatch-loadout-persistence.test.ts`
- Roster sidecar fallback: `src/__tests__/dispatch/openhive-roster.test.ts` (`sidecar acts as fallback for arbitrary roles`, `exact-role agents win over sidecar fallback`)
- Live e2e (gated by `LIVE_AGENT_E2E=true`): `src/__tests__/swarm/live-{acp-fresh,acp-reuse,mail-reuse,loadout}-dispatch*.test.ts` — spin up real macro-agent subprocesses
