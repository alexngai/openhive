# Hosting the OpenSwarm Harness in OpenHive

**Status:** draft · Phase 0 spike complete + openswarm-side fix landed · 2026-07-05
**Owner:** (tbd)
**Related (openhive):** `src/swarm/types.ts`, `src/swarm/manager.ts`, `src/swarm/providers/local.ts`, `src/map/ws-map.ts`, `src/map/connection-registry.ts`, `src/dispatch/routing.ts`, `src/dispatch/CLAUDE.md`
**Adjacent repo (openswarm):** `references/openswarm` (npm `openswarm`) — `src/cli/host.ts`, `src/host/bootstrap.ts`, `src/host/boot.ts`, `src/host/map-sidecar.ts`, `docs/44-macro-agent-parity-implementation-plan.md`

> Living design doc. Captures **what is wired today** (file-cited, verified
> 2026-07-05 via a gated integration spike), the **one-wire gap** that blocked
> hosting openswarm, the **fix that landed on the openswarm side**, and the
> remaining path to a first-class harness.

---

## 1. TL;DR

**We can host our own OpenSwarm harness, and after a small openswarm-side change
it now works through the existing `swarm-runner` path with zero OpenHive
changes.** openswarm was built for this: its `openswarm host` subcommand is an
"OpenHive-compatible host" that binds OpenHive's 3-port stride, reads the same
bootstrap env, and speaks the macro-agent `_macro/*` + cascade method surface.

The Phase 0 spike found exactly **one** missing wire: OpenHive delivers the hub
URL / onboard token / swarm id **inside** the bootstrap token, but openswarm only
opened its outbound MAP sidecar from an explicit `--map-server` flag. Bridging
that (plus advertising the `acp` protocol) makes a plain
`swarm_runner_command: 'openswarm host'` register itself and become routable for
chat + dispatch.

| Concern | Before spike | After openswarm fix |
|---|---|---|
| Boots as `swarm-runner`, passes health | ✅ | ✅ |
| Registers as a MAP agent (chat/dispatch reachable) | ❌ (booted but invisible) | ✅ |
| Routable via ACP (`findAcpAgentInfo`) | ❌ | ✅ |
| Routable via mail (`messaging.canReceive`) | ✅ | ✅ |
| Registers under OpenHive's pre-registered swarm id | ❌ | ✅ |

---

## 2. Why openswarm is a special case (not a new harness from scratch)

OpenHive's hosted-swarm kinds are enumerated at `src/swarm/types.ts:418`:

```ts
export type HostedSwarmKind = 'swarm-runner' | 'claude-code' | 'codex';
export type LegacyHostedSwarmKind = 'openswarm';                 // :423
// normalizeHostedSwarmKind: 'openswarm' | null → 'swarm-runner'  // :428
```

`'openswarm'` is already a **legacy alias** for `swarm-runner` — the generic
gateway is openswarm-lineage. The spawn env still uses `OPENSWARM_*` names
(`src/swarm/providers/local.ts:194`), the legacy `openswarm_command` config maps
to `swarm_runner_command` (`src/config.ts:270`), and the default gateway command
is `npx @swarmkit-ai/swarm-runner serve` (`src/config.ts:282`).

On the other side, openswarm's `docs/44-macro-agent-parity-implementation-plan.md`
is an explicit plan to be **hosted by OpenHive** ("D3 — OpenHive hosting via
Path B + adopt `@multi-agent-protocol/sdk`"). It ships:

- `openswarm host --port N` (`src/cli/host.ts`) — binds the **3-port stride**
  `acp=N /acp`, `health=N+1 /health`, `map=N+2 /map` (`src/host/boot.ts`,
  "matches OpenHive's macro-agent-style adapter stride of 3").
- `readBootstrapConfig` (`src/host/bootstrap.ts`) — reads `OPENSWARM_BOOTSTRAP_TOKEN` / `OPENSWARM_DATA_DIR`.
- an inbound MAP server **and** an outbound MAP sidecar (`src/host/map-server.ts`, `src/host/map-sidecar.ts`).
- the macro-agent `_macro/*` method surface + cascade actions (`src/host/macro-methods.ts`).
- native ACP (`openswarm acp`) + ACP-over-MAP.

## 3. OpenHive's hosting contract (what the spike pinned down)

For a `kind:'swarm-runner'` spawn, OpenHive's `LocalProvider` runs
`<swarm_runner_command> --port N --host 127.0.0.1 --adapter <a>` and sets env
`OPENSWARM_BOOTSTRAP_TOKEN` + `OPENSWARM_DATA_DIR` (`src/swarm/providers/local.ts:184`).
The **bootstrap token is base64 JSON** carrying the hub coordinates
(`src/swarm/manager.ts:1959`):

```ts
const bootstrapToken = { version:1, openhive_url: this.instanceUrl,
  onboard_token, swarm_name, swarm_id: preRegisteredSwarmId, adapter, ... };
```

So OpenHive's model is **inbound dial-back**: the spawned runner reads the token,
dials the hub's `/ws/map`, and registers under the pre-registered `swarm_id`.
Key facts verified:

- **Health is polled on `port+1`** (`manager.ts:2522` "SwarmRunner gateway HTTP is
  port+1"). openswarm serves `/health` on `N+1` → aligns.
- **Inbound identity keys on the URL query** (`src/map/ws-map.ts:10-12`): open
  mode binds the connection to a pre-registered swarm via `?swarm_id=`
  (`resolveSwarmOpen`, `:292`); both trust models authenticate via `?token=`.
- **Chat/dispatch routing** (`src/dispatch/routing.ts:46`) picks ACP when an agent
  advertises `capabilities.protocols` ⊇ `['acp']` (`connection-registry.ts:258`
  `findAcpAgentInfo`), else mail when `messaging.canReceive`.
- The 3-port-vs-2-port stride difference is a **non-issue**: control is inbound
  dial-back, not OpenHive dialing the swarm's `/map`.

## 4. The gap and the fix (landed on openswarm)

**Gap:** OpenHive puts the hub URL in the token and never sets `OPENSWARM_MAP_SERVER`
/ `--map-server`. openswarm only opened its sidecar from that flag
(`src/cli/argv.ts:1416`) and never read the token fields. Result (spike, pre-fix):
the swarm **booted + reached `running` but never registered** — visible-but-unsteerable.

**Fix (3 small changes in `references/openswarm`, all unit-tested):**

1. `src/host/bootstrap.ts` — `readBootstrapConfig` now surfaces `hubUrl`,
   `onboardToken`, `swarmId`, `swarmName` from the token, and accepts OpenHive's
   `MACRO_BOOTSTRAP_*` coordinator aliases + `SWARM_RUNNER_*` token/data-dir
   aliases (parity with what the provider actually sets).
2. `src/cli/host.ts` — new pure helpers `buildHubMapUrl` +
   `resolveHostMapTarget`: when no `--map-server` is given, derive the sidecar
   target from the token as `ws[s]://<host>/ws/map?swarm_id=<id>&token=<onboard>`
   (OpenHive's exact `/ws/map` contract) and register under `swarm_id`.
3. `src/host/map-sidecar.ts` — advertise `protocols: ['acp']` on the sidecar
   (ACP-over-MAP is already wired on the outbound connection), so OpenHive's
   `findAcpAgentInfo` routes chat/dispatch over it instead of mail-only.

## 5. Verification (gated integration spike, 2026-07-05)

Ran OpenHive's real `SwarmManager` + `LocalProvider` + `/ws/map` against the
edited openswarm source (via `bun src/cli.ts host`), `swarm_runner_command`
pointed at it, **no `--map-server`**:

```
[openswarm] dialing hub from bootstrap token: ws://127.0.0.1:20530/ws/map?swarm_id=swarm_Ek9…&token=***
[map-sidecar] connected … as swarm_Ek9…-sidecar (scope swarm:swarm_Ek9…)
[acp-map] ACP-over-MAP adapter wired
[ws-map] Swarm swarm_Ek9… connected inbound   ← registered under the PRE-REGISTERED id
RESULT state=running registered=true inboundCount=1
ROUTING findAcpAgentInfo={targetId:…} messaging.canReceive=true
```

Plus a standalone real model turn (`openswarm --headless … "reply SPIKE-PONG"`)
returned `text_delta:"SPIKE-PONG"` / `stopReason:"end_turn"` — the coordinator +
model round-trip in this environment (Claude Max auth).

**Proven:** register → ACP-routable → mail-routable → services real turns.
**Not yet exercised end-to-end:** a live chat turn driven from OpenHive over
SwarmCraft's ACP-over-MAP stream manager (all routing prerequisites now hold; it
needs the SwarmCraft `MAPClientManager` + `AcpStreamManager` harness — see §7).

## 6. Decision guidance

- **Just want it hosted now →** set `swarmHosting.swarm_runner_command:
  'openswarm host'` (or the legacy `openswarm_command`). With the openswarm fix,
  it registers + is chat/dispatch-routable. Zero OpenHive changes.
- **Want it as a distinct, selectable harness in the UI/API →** Phase 1 below.

## 7. Remaining work / phasing

**P0 — DONE.** openswarm-side token→sidecar wiring + `acp` capability; verified.

**P1 — First-class identity — DONE (2026-07-05).** Added a `runner`
sub-discriminator on `kind:'swarm-runner'` instead of reclaiming the legacy
`'openswarm'` kind string (which is a live migration target — `db/index.ts:485`,
`schema.ts:1252`; coercions `swarm-hosting.ts:90`, `schedules.ts:26`). The
process contract is identical across runners; only the spawn command + identity
differ, so the whole spawn/register/dispatch path is reused. Changes:
- **Config** (`config.ts`): `swarmHosting.runners: Record<name,command>`, seeded
  `{ openswarm: 'npx openswarm host' }`. The implicit `'swarmkit'` runner maps to
  `swarm_runner_command`.
- **Manager** (`manager.ts`): `resolveRunner()` (throws `UNKNOWN_RUNNER`);
  `spawnSwarmRunner` passes the chosen command to the provider as
  `swarm_runner_command_override` and records `runner` on the provision config +
  `map_swarms.metadata.runner`.
- **Providers** (`local.ts`, `sandboxed-local.ts`): use the override (still
  append `--port/--host/--adapter`).
- **REST** (`swarm-hosting.ts`): `runner` field on `SpawnSwarmSchema`, rejected
  for TUI kinds; surfaced on the hosted-swarm API responses.
- **Web**: `SpawnFormDialog` Runner selector (Default / OpenSwarm), `KindBadge`
  renders an "OpenSwarm" pill, `useSpawnSwarm` + `HostedSwarm` type carry `runner`.
- **Tests**: `runner-selection.test.ts` (manager), schema + `KindBadge` cases;
  verified end-to-end via a real-provider spike (runner=openswarm → registers +
  ACP-routable + `metadata.runner`).

Deferred: surface openswarm's extras (six team topologies, `--git-cascade`
worktrees, multi-provider teams) via capability declaration + a richer UI.

**P2 — Live chat-turn e2e — RUN 2026-07-05; found a blocking gap.** Verified in
a real running hub (headless server + web UI over Tailscale-style localhost):
spawning `runner:'openswarm'` from the **web spawn form** works end-to-end —
`Running · Online · OpenSwarm badge · acp`, 1 agent, `metadata.runner=openswarm`.
But a live **chat turn fails**: `POST /sessions/acp-connect` → ACP `initialize`
**times out after 90s**.

Root cause (evidence-backed): there are two MAP channels between hub and swarm —
(1) openswarm's **outbound sidecar** → hub `/ws/map` (registration lives here),
and (2) the hub's SwarmCraft `MAPClientManager` **dialing openswarm's own inbound
MAP server** (`:base+2/map`, log: `MAP client connected to … ws://…:9202/map`).
OpenHive opens the ACP stream over channel (2), but openswarm wires
`ACPAgentAdapter` (`wireAcpOverMap`) **only on channel (1)** — its inbound MAP
server (`boot.ts createMapServer`) has no ACP handler. So `initialize` on the
inbound path never gets answered. macro-agent serves ACP on its inbound MAP
server (the one the hub dials); openswarm must do the same.

- **Fix A — openhive crash guard — DONE (2026-07-05).** The ACP-timeout
  rejection propagated unhandled and **crashed the whole hub** (all swarms +
  dispatch die). The existing `installAcpRaceSafetyNet` only caught the
  `'ACP stream closed'` close-race; broadened it to also suppress
  `'ACP request timed out after Nms: …'` from the SDK's acp/stream module (both
  are orphaned internal rejections already surfaced to the caller). Extracted to
  `src/acp-safety-net.ts` + unit-tested (`__tests__/acp-safety-net.test.ts`,
  6 cases, incl. no-over-suppression guards). Now a failed chat turn **fails
  gracefully** (500 to the caller) instead of taking down the hub.
- **Fix B — openswarm inbound ACP — DONE + live-verified (2026-07-05).** Ported
  macro-agent's server-side `ACPBridge` pattern to openswarm's inbound MAP server
  (the SDK's `ACPAgentAdapter` only binds to an outbound `AgentConnection`, so the
  inbound server needs a custom bridge). New/changed in `references/openswarm`:
  - `src/host/inbound-acp-bridge.ts` (new) — per-ACP-stream in-memory `Stream` +
    `AgentSideConnection` wired to an on-demand coordinator team
    (`createTeamConnection`, injectable for tests); inbound ACP messages pushed
    in, JSON-RPC responses + `session/update` notifications wrapped in
    `agent-to-client` envelopes and delivered back to the client.
  - `src/host/map-server.ts` — hooks `MAPServer.eventBus` `message.sent`/
    `message.queued` to feed the bridge; tracks each client's WebSocket +
    subscription ids + per-sub monotonic sequence by parsing outgoing responses,
    and pushes ACP responses as `map/event` notifications (what the client's
    `ACPStreamConnection` listens on); patches `matchesFilter` for filter-less
    subscriptions. Enabled via a new `acp: { acpOpts }` option.
  - `src/host/boot.ts` — passes `acp: { acpOpts }` to `createMapServer` when
    hosted-team opts are present.

  **Tests:** `inbound-acp-bridge.test.ts` (8 cases incl. a full
  `ClientSideConnection ↔ bridge` round-trip — initialize + session/new + prompt
  + streamed update — over a MAP-loopback transport with a fake team, no model).
  **Live e2e (real hub):** `POST /sessions/acp-connect` now returns in **~0.03s**
  (was a 90s timeout); a real prompt streamed back the exact model reply
  (`"OPENSWARM-P2-OK"`) via `acp.prompt.started`→`acp.session.update`→
  `acp.prompt.completed`, and the hub stayed up. openswarm log confirmed
  `[inbound-acp] stream … → new coordinator team`.

**P3 — Coordinator eager-spawn (openswarm).** `bootSwarmHost`'s
`bootstrap.coordinator` path is currently a stub that only logs
(`src/host/boot.ts:240`); chat-readiness comes from ACP-over-MAP spawning a
coordinator team per client. If a boot-time default coordinator is wanted, wire
it there (the `MACRO_BOOTSTRAP_*` env is now honored).

## 8. Open questions

- **[Q1]** Verified-trust hubs: the fix passes the onboard token as `?token=`
  (OpenHive's documented gate). Confirm no MAP-handshake auth is additionally
  required for `trustModel:'verified'`.
- **[Q2]** MAP SDK skew (OpenHive `@multi-agent-protocol/sdk` 0.1.13 ↔ openswarm
  0.1.15) — handshake worked in the spike; pin/track before shipping.
- **[Q3]** P1 discriminator name + whether to also expose openswarm's inbound MAP
  server (base+2) or standardize on the outbound sidecar (what OpenHive uses).
