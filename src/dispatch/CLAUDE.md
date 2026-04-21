# src/dispatch — swarm-dispatch integration layer

OpenHive-specific adapters + wiring for the `swarm-dispatch` library. The library ships a generic orchestrator (poll → claim → route → retry → complete/fail); this directory plugs OpenHive's data, transport, and registry into its adapter ports. The orchestrator itself is hub-native but scoped — it's a **named subsystem with explicit policy surfaces**, not a hidden opinion baked into handler code.

## File roles

- **`setup.ts`** — composes an `Orchestrator` from the factories below + the event bridge that writes terminal state to `dispatches` and broadcasts to the `map:dispatches` WS channel. Entry point: `setupOrchestrator({ specFetcher, runtimeDeps, messagePort, dispatchConfig })`.
- **`openhive-source.ts`** — `DispatchTaskSource` adapter. Polls the `dispatches` table for `queued` rows, applies fence-token claim semantics, enriches with spec content via the injected fetcher.
- **`openhive-runtime.ts`** — `DispatchAgentRuntime` adapter. Drives ACP stream lifecycle (create → init → session → prompt) via `AcpStreamManager` from the SwarmCraft plugin.
- **`openhive-roster.ts`** — `AgentRoster` adapter. Surfaces connected MAP agents to the orchestrator's eligibility scorer, filtered by role/tag/busy state.
- **`openhive-mail-port.ts`** — `MessagePort` adapter. Wraps envelopes for agent-inbox mail delivery, classifies incoming, dedups.
- **`mail-transport.ts`** — low-level transport used by the mail port; wires `mail/*` JSON-RPC and sync-listener fanout.
- **`mail-ingress.ts`** — inbound reply normalization for dispatch conversations.
- **`routing.ts`** — `prefer-route` vs `spawn` decision: prefers a connected agent matching the spec's role/tags, falls back to ACP spawn when none match.
- **`prompt.ts`** — turn-aware builder. Produces first-run / retry / continuation prompts so an agent picking up a dispatch on turn N knows the prior context.

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

## Non-goals

- No spec-level aggregate status. Each dispatch row is independent, even when one spec is dispatched to N swarms (D8 — parked `all-must-complete` / `first-wins`).
- No persisted outbound mail log inside this directory. Mail transport delegates to `agent-inbox` for persistence.
- No cascade integration inside dispatch. Dispatch does not care whether the agent it routes to uses `git-cascade`. The cascade-task binder in `src/cascade/` operates separately on the agent's post-work merge events.

## Relationship to other subsystems

- **Cascade task-binder** (`src/cascade/task-binder.ts`) — same architectural pattern (named orchestrator + opt-in policy + kill-switch). Dispatch drives pre-work; cascade-binder observes post-work.
- **Specs + resources** — `fetchSpecForDispatch` in `src/api/routes/specs.ts` is the injection point for spec content; dispatch doesn't read specs directly.
- **ACP streams** — dispatch owns prompt delivery via `AcpStreamManager`, shared with the chat surface (Sessions, Messages, SwarmDetail) from the SwarmCraft plugin. One stream pool; dispatch and chat both subscribe.
- **Mail** — dispatch replies travel over the agent-inbox mail fabric so agents can respond asynchronously without holding an ACP stream open.

## Tests

- Adapter unit tests: `src/__tests__/dispatch/*` and `src/__tests__/dal/dispatches-*`
- Event bridge: `src/__tests__/dispatch/event-bridge.test.ts`
- Orchestrator end-to-end: mixed in with the `dispatches` REST route tests
