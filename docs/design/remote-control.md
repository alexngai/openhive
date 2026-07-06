# Remote Control of OpenHive from Another Device

**Status:** A1 + A2 + A3 landed on `feat/remote-control-a1` (A3 verified live 2026-07-05); A4 (packaging + push) and the public-exposure auth hardening remain · 2026-07-05
**Owner:** (tbd)
**Related:** `src/server.ts`, `src/config.ts`, `src/api/middleware/auth.ts`, `src/network/`, `src/headscale/manager.ts`, `src/map/` (MAP hub), `src/sync/` (federation), `docs/DEPLOYMENT.md`, `docs/HEADSCALE_HOSTING_SPEC.md`
**Adjacent repos:** `multi-agent-protocol` (`@multi-agent-protocol/sdk`), `agentic-mesh` (transport layer under the SDK)

> Living design doc, not a spec. It captures **what is wired today** (with file
> citations, verified 2026-07-04) and a **design direction** for a remote-control
> surface. "Remote control" here means: from a second device — a phone, a laptop,
> a web app, or another OpenHive instance — observe and steer the agents running
> on a host OpenHive (send a chat turn to a live agent, send mail, create/cancel a
> dispatch, author a spec, watch trajectories). The canonical example is a hub on
> a home server (Mac Mini) steered from a laptop or phone, but nothing here is
> host-specific.

---

## 1. TL;DR

There are **two architecturally distinct ways** to remote-control OpenHive, and they
sit at different protocol layers:

| Approach | Client is… | Transport | Status today | Effort |
|---|---|---|---|---|
| **A. Thin client** | a human operator UI (mobile / web / desktop / laptop console) | the hub's existing **REST + WebSocket operator API** | **✅ works now** (this is what the bundled React UI already is) | build a client + close a small auth gap |
| **B. MAP protocol peer** | another agent runtime / OpenHive instance | the **MAP agent protocol** over `/ws/map` (optionally over an `agentic-mesh` tunnel) | **❌ not wired** for *control* (only read-only observe/listen exists) | new outbound control-client module + authz |

**The important realization:** for a phone/web/desktop "remote terminal" driven by a
**human**, you do **not** need MAP or any hive-to-hive plumbing. Steering is already
fully exposed over REST + WebSocket. The remaining work is a client app, network
reachability, and a cleaner self-hosted login. MAP peering (B) is only the right
tool when the *remote party is itself a machine* participating in the agent
protocol.

---

## 2. What is wired today (current state)

### 2.1 The hub already exposes a complete operator API

- **Binding:** the server binds `host: "0.0.0.0"`, `port: 7836` by default
  (`src/config.ts:76`), overridable via `OPENHIVE_HOST` / `OPENHIVE_PORT`
  (`src/config.ts:851`). So it is reachable from other hosts on the network with no
  extra config.
- **Web UI served by the server itself:** in `mode: "full"` (default) Fastify serves
  the built React SPA via `@fastify/static` with an SPA fallback
  (`src/server.ts:845`). Reaching `http://<host>:7836/` in a browser gives the full
  dashboard — this *is* a working remote-control surface.
- **Steering surfaces (all REST/WS):**

  | Capability | Endpoint(s) |
  |---|---|
  | Observe swarms & agents (presence/state) | `GET /api/v1/map/swarms`, agents |
  | Threads: chat / mail / trajectories | sessions routes, `GET /api/v1/mail/conversations` |
  | Live-steer an ACP agent | WS `/ws/swarmcraft` + `POST /api/swarmcraft/acp/streams` |
  | Send a mail turn | `POST /api/v1/mail/conversations/{id}/turns` |
  | Create / cancel a dispatch | `POST /api/v1/dispatches`, `…/{id}/cancel` |
  | Specs, tasks | specs + tasks routes |
  | Realtime updates | WS `/ws?token=<key>` subscribe channels |

- **CORS is permissive:** `cors.origin: true` (`src/config.ts:148`), so a browser or
  mobile web app on any origin can call the API.

### 2.2 Auth (REST/WS)

Request auth is credential-based and transport-agnostic
(`src/api/middleware/auth.ts`). Bearer tokens are tried in order:

1. **API key** (`ohk_…`) via `findAgentByApiKey` — tried **first**
   (`src/api/middleware/auth.ts:176`). Works regardless of auth mode. Good fit for a
   provisioned app credential.
2. **SwarmHub JWT** via `trySwarmHubAuth` (OAuth for humans)
   (`src/api/middleware/auth.ts:181`).
3. **agent-iam delegated token** (`src/api/middleware/auth.ts:195`).

Admin-gated routes additionally require an `X-Admin-Key` header or an admin agent's
bearer token (`src/api/middleware/auth.ts:310`).

**Auth modes** (`src/config.ts:161`): `local` | `swarmhub`.
- `local` **auto-authenticates unauthenticated requests** (`src/api/middleware/auth.ts:45`).
  Fine behind a trusted network boundary (see §3); **unsafe on the public internet**.
- `swarmhub` validates JWTs via JWKS; the only browser login route is
  `POST /auth/swarmhub/exchange` (`src/api/routes/auth.ts:53`).

**Gap:** there is **no self-hosted username/password login** that mints a session
token. A remote human today must either (a) hold an API key, or (b) run SwarmHub. See
§6.

### 2.3 Cross-instance federation (hive ↔ hive) — the sync layer

Two OpenHive instances **can** peer today, but only at the **resource/federation**
layer, not the live-control layer:

- Configured via `sync.peers` + a `/sync/v1` **JSON-RPC 2.0** handshake (`src/sync/`).
- **Pull-based, eventual-consistency.** Federates memory banks, skills, sessions,
  repos, and **coordination messages** (task-event notifications:
  `task.created/assigned/status`).
- Transport is **HTTP JSON-RPC** — *not* the MAP WebSocket.

So instance-to-instance you can **sync resources and gossip task-event
notifications**. You **cannot** create a task, orchestrate a dispatch, or steer an
agent on the remote instance through this path. It is federation, not remote control.

### 2.4 MAP transport — inbound only

- Swarms connect **into** the hub over MAP at `/ws/map` (`src/map/ws-map.ts:662`),
  using `MAPServer` from `@multi-agent-protocol/sdk/server` over Fastify
  `websocketStream`. SDK is `@multi-agent-protocol/sdk` v0.1.12
  (`package.json:78`).
- OpenHive's **only outbound MAP connections are read-only**:
  - SwarmCraft `MAPClientManager` — *observes* remote agents / ACP streams
    (`src/server.ts:424`).
  - `sync-listener` — *listens* for sync notifications (`src/map/sync-listener.ts:254`).
- OpenHive **never issues outbound MAP control methods** (`map/tasks/create`,
  `map/dispatches/*`, `map/agents/spawn`, …) to a remote hub. Those handlers exist
  **inbound-only** (swarm → hub).

---

## 3. Reachability — and the "three Tailscales"

Getting bytes from the remote device to the hub is a separate concern from the API.
There are **three different "Tailscales"** in this ecosystem; only one is relevant
to a remote terminal.

| # | "Tailscale" | What it is | Carries | Right for a remote terminal? |
|---|---|---|---|---|
| 1 | **OS-level Tailscale app** | Tailscale installed on each device | *any* IP traffic incl. HTTP/WS | ✅ **yes** — use this |
| 2 | OpenHive `network.provider: tailscale-cloud` | mints auth keys so **swarm hosts** join a tailnet (`src/network/tailscale-provider.ts`) | swarm provisioning only | ❌ irrelevant to a human terminal |
| 3 | `agentic-mesh` `TailscaleTransport` | a `TransportAdapter`: TCP-over-Tailscale + NDJSON framing | **MAP protocol frames**, not HTTP | ❌ wrong layer for a thin HTTP/WS client |

**Recommended reachability tiers for a remote terminal:**

| Tier | Setup | Off-LAN | Encrypted | Notes |
|---|---|---|---|---|
| **LAN** | none (already binds `0.0.0.0`) | ❌ | ❌ (plain HTTP) | fine on trusted WiFi; use `local` auth + set `OPENHIVE_ADMIN_KEY` |
| **OS Tailscale** | install the app on both devices, same tailnet | ✅ anywhere | ✅ (WireGuard) | **recommended**; hit `http://<host-100.x>:7836`; `local` auth acceptable behind it |
| **Public URL** | reverse proxy (Caddy/Cloudflare Tunnel) for TLS | ✅ | ✅ | the hub is HTTP-only; **requires real auth** (`swarmhub` or proxy-level), not `local` |

**Why not route the terminal through `agentic-mesh` (#3)?** Because `agentic-mesh`'s
Tailscale transport carries **MAP NDJSON frames over a framed TCP tunnel** — it does
not speak HTTP. A mobile/web app is an HTTP + WebSocket client; there is no HTTP
server on the far end of that tunnel. Two further reasons: OpenHive's own MAP server
does not even use `agentic-mesh` (it runs over Fastify WS), and under the hood the
transport is *also* just riding the OS tailnet — so for an HTTP hub the plain OS app
(#1) gives you the exact network path with none of the framing you'd have to strip
back off. `agentic-mesh` earns its place only in Approach B (§5).

### 3.1 What OpenHive does / does not manage re: Tailscale

For completeness (a common question): **OpenHive does not install the Tailscale
client, ever.**

| | Install binary | Run / configure | Orchestrate (keys/ACLs) |
|---|---|---|---|
| **Tailscale client** (`tailscale-cloud`) | ❌ never | ❌ you run `tailscale up` yourself | ✅ mints pre-auth keys, syncs ACL policy, queries device IPs via Tailscale's API |
| **Headscale server** (`headscale-sidecar`) | ❌ never | ✅ spawns & manages `headscale serve` + config (`src/headscale/manager.ts:84`) | ✅ same key/ACL orchestration |

- `TailscaleCloudProvider` is a pure API client — *"No local binary, no port
  forwarding, no TLS certs"* (`src/network/tailscale-provider.ts:5`) — and tells you
  to install the client yourself (`:124`).
- The headscale sidecar *does* spawn `headscale serve` but requires the binary to
  pre-exist, erroring with *"Install headscale or set headscale.binaryPath"*
  (`src/headscale/manager.ts:119`).
- `openhive network setup` only **detects** presence (`tailscale version`,
  `headscale version`) and writes config (`src/cli/network.ts:104`); it installs
  nothing.

For a remote terminal this is moot: install the OS Tailscale app once per device
(`brew install --cask tailscale` or the App Store app, then sign in). Automating a
privileged system-VPN install through the hub is out of scope and better left to
Tailscale's own installer.

---

## 4. Approach A — Thin-client remote terminal (recommended)

A phone app, a web app, a desktop app, or a laptop "operator console" that is a
**client of the hub's existing REST + WebSocket API**. This is the shortest path and
requires no change to the hub's protocol layer.

### 4.1 Requirements

**Connection / config**
- A client-side **connection store**: a list of `{ label, baseUrl, token, adminKey? }`.
  This *is* the multi-hive switcher — the hub never sees it.
- Reachability per §3 (OS Tailscale recommended).

**Auth**
- Today: `Authorization: Bearer <ohk_… key>` for REST; `wss://…/ws?token=<key>` for
  realtime. Admin ops need `X-Admin-Key` or an admin agent's token.
- Recommended addition (see §6): a **self-hosted login endpoint** issuing a JWT, so a
  mobile app can "log in" instead of pasting a raw key.

**Functional surface** — all already available (§2.1): observe swarms/agents; open
threads (chat/mail/trajectories); live-steer an ACP agent; send mail; create/cancel
dispatches; author specs; create tasks; subscribe to realtime events.

**Nice-to-haves for a real product**
- Mobile push (APNs/FCM) for "agent needs input" / "dispatch complete". The outbound
  bridge infra exists for Slack/Discord; native push is net-new.
- A credential **scope tier** (read-only / operator / admin) so a phone can hold a
  limited key.

### 4.2 What must be built (hub side)

Minimal — most of it is client-side app work. Hub-side:
1. **Self-hosted login** (§6) — optional but strongly recommended for mobile UX.
2. Optionally, a documented, stable **"operator API" subset** + a scope model for
   keys.

---

## 5. Approach B — MAP protocol peer / control client

For when the remote party is a **machine** speaking the agent protocol — e.g. a
second OpenHive instance whose swarms should be orchestrated by, or should
orchestrate, the host hive at the agent level. This is the plumbing that is **not
wired today**.

### 5.1 What already exists

- The MAP SDK ships the outbound primitives: `ClientConnection.connect(url)`,
  `ClientConnection.connectMesh({ transport, peer })`, `PeerConnection.connect()`,
  and `MapServer({ federation: { enabled } })` (in `multi-agent-protocol/ts-sdk`).
- `agentic-mesh` is the transport under the SDK (dependency direction **MAP →
  agentic-mesh**, one-way): encrypted P2P tunnels over Nebula (primary), Tailscale,
  or Headscale, carrying MAP NDJSON frames via `TunnelStream`.
- The hub's `/ws/map` **handler dispatch is generic** (`src/map/map-server-setup.ts:129`)
  — it authenticates by credential and routes by JSON-RPC method + session scopes; it
  does not care whether the peer is a work-doing swarm or a command-issuing
  controller. In protocol terms, **a control client is just an agent that calls
  control methods.**

### 5.2 What is missing

1. An **outbound control-client module** in OpenHive (extend the sync-only
   `MapSyncClient` at `src/map/client-entry.ts` to a general `callMethod` with
   request/response correlation + reconnect).
2. A **control-client session** on connect (register as a scoped agent; reuses the
   existing auth + scope path — no new handler code).
3. An **authorization policy**: who may call which method on which remote hive. This
   is the real design question, not the transport.
4. An **operator surface** to drive it (CLI/REST, e.g. `POST /api/v1/remote-hives/{url}/dispatches`).
5. If routing over an `agentic-mesh` tunnel (rather than plain WS): wire
   `agentic-mesh`'s `TransportAdapter` into OpenHive on both ends — net-new, since
   OpenHive currently runs MAP over Fastify WS only.

Rough estimate: a WS-based control client (skipping #5) is a few days for an MVP; the
transport machinery and remote handlers already exist, so the work is plumbing +
authz, not protocol.

---

## 6. The auth gap (blocks a clean mobile/web login) — ✅ resolved by A3 (2026-07-05)

Historically the only token-minting login was SwarmHub OAuth
(`POST /auth/swarmhub/exchange`, `src/api/routes/auth.ts:53`); self-hosted operators
without SwarmHub had to paste an API key. **A3 closed this gap** — see §10.2. The
implementation diverged from (and improved on) the original sketch below:

- `POST /api/v1/auth/login` `{ username, password }` → `{ token, agent, expires_in }`.
- It **mints a scoped `ohk_` ingest key**, *not* a JWT. Reusing the existing ingest-key
  validation + per-route scope gate meant **no new middleware** — a smaller, more
  consistent change than a fresh JWT verify path, and the credential is revocable +
  expiring for free.
- Gated behind `auth.mode` (a no-op / 400 in `swarmhub` mode).
- Admin authority stays enforced by `requireAdmin` (agent `is_admin`), so key scope did
  not need a read-only/operator/admin split for v1 (deferred).

Original sketch (superseded), kept for context: *"issue a JWT the existing middleware
accepts; pair with a read-only/operator/admin credential scope model."* The ingest-key
route reached the same goal with less surface.

---

## 7. Decision guidance

- **Human steering from a phone / web / laptop console → Approach A.** Do *not* reach
  for MAP or `agentic-mesh`. Use OS Tailscale for reachability, the existing REST/WS
  API, a Bearer credential, and (recommended) the §6 login.
- **Machine peer / hive-to-hive agent-protocol control → Approach B.** This is where
  the MAP control client and `agentic-mesh` transport belong.
- **Resource federation between instances → already available** via `/sync/v1`
  (§2.3); no new work.

---

## 8. Open questions

- **[Q1] Auth model for remote humans.** Add the self-hosted login (§6), or standardize
  on provisioned API keys, or require SwarmHub? Recommendation: add the login +
  scoped keys.
- **[Q2] Public exposure posture.** If a public URL is wanted, decide proxy-level auth
  (Cloudflare Access / basic auth) vs. requiring `swarmhub` mode. `local` mode must
  never face the public internet.
- **[Q3] Authorization for Approach B.** Which remote MAP methods may an external
  operator invoke, and how is that policy expressed/stored?
- **[Q4] Push notifications.** Reuse the bridge outbound infra, or add native
  APNs/FCM?
- **[Q5] Client form factor first.** PWA (fastest, one codebase, works on desktop +
  mobile) vs. native app vs. an Electron desktop console (note `docs/ELECTRON_PACKAGING.md`
  already exists).

---

## 9. Suggested phasing

**Priority (set 2026-07-04):** Approach A is the near-term priority. Approach B is
planned but deferred. The user-facing operator guide is a **low-priority TODO,
deferred until after the Approach A implementation lands** — see [TODO-1].

1. **P1 — self-hosted login + scoped keys** (§6). Unblocks clean mobile/web auth.
2. **P2 — thin-client terminal** (Approach A), against the documented operator API
   subset. Optional push. **← current focus; see §10 for the implementation plan.**
3. **P3 — MAP control peer** (Approach B) *if/when* machine-to-machine hive control is
   needed, starting with a WS control client + an authz policy.

### Deferred TODOs

- **[TODO-1] User-facing "access your hub from another device" guide** (operator-facing,
  `docs/` proper — not `design/`). OS Tailscale + credential walkthrough. **Low
  priority; write after the Approach A client ships** so the instructions match the
  real login/credential flow rather than the pre-implementation state. *(Still open —
  A3's login/credential flow is now stable, so this can be written when prioritized.)*
- **[TODO-2] Public-exposure auth hardening (turns A3 login into a real gate).** Today
  `local` auth mode auto-authenticates unauthenticated requests, so A3's password login
  is a scoped-identity convenience over a trusted network (Tailscale), not a barrier for
  a publicly-reachable hub. Add a "reject-unauthenticated" posture — finish the vestigial
  `token` auth mode (referenced in `src/config.ts`, never wired) or a `requireCredential`
  flag — so an exposed hub demands the API-key/password/OAuth credential. Pair with a
  boot-time warning when `local` mode is bound to a non-loopback host. Ties to §8 [Q2].

---

## 10. Approach A — implementation plan

### 10.0 Decisions (2026-07-04)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **[DA1]** | Client strategy | **Extend the existing web UI** (make it hub-configurable + multi-hub) | Reuses all steering UI + ~150 API hooks; the same-origin assumptions are centralized (1 API client, 1 WS hook, 2 adapters, 1 auth store), so this is a contained refactor, not a rewrite. |
| **[DA2]** | Form factor | **PWA + Electron desktop** | PWA covers web + installable mobile + web push from one codebase; Electron folds into the in-flight `docs/ELECTRON_PACKAGING.md` effort. Native mobile deferred. |
| **[DA3]** | v1 auth | **API-key paste now; self-hosted password login as fast-follow** | Token/API-key login already works (`src/web/pages/Login.tsx`), so the client is remotely usable immediately; the password login (§6) lands in parallel without blocking. |

**MVP cut line:** **A1 + A2 with API-key auth** = a usable multi-hub remote terminal, served as the normal web UI and reached over Tailscale. Everything after is enhancement.

### 10.1 Enabling facts (verified 2026-07-04)

- **Centralized I/O seams** to refactor: `src/web/lib/api.ts` (singleton `ApiClient('/api/v1')`, constructor already accepts a `baseUrl`; has `setToken`), `src/web/hooks/useWebSocket.ts` (WS URL from `window.location`), `src/web/adapters/openhive-acp-service.ts` + `coordination-chat-adapter.ts` (hardcoded base + direct `localStorage` token reads), `src/web/components/terminal/TerminalPanel.tsx` (WS from `window.location`), `src/web/stores/auth.ts` (single token, persisted to `openhive-auth`).
- **Cross-origin is fine:** CORS is `origin: true`; the only WS gate is a **Host**-header guard (`src/api/middleware/hostname-guard.ts`), not an Origin check. ⚠️ That guard validates `request.hostname` against `config.instance.url` — **remote hubs must set `instance.url` to a reachable value (or the guard must allow the LAN/tailscale host), or requests are rejected.** This is an A1 server-side task.
- **Key login already exists:** `login(token)` → `GET /agents/me` (`src/web/stores/auth.ts`). v1 reuses it per-connection.

### 10.2 Stages

**A1 — Hub-agnostic refactor** — ✅ **landed 2026-07-04** on branch `feat/remote-control-a1` *(enabling)*
- Introduce a `HubConnection` shape `{ id, label, baseUrl, token, agent? }` and an **active-connection** source of truth. `wsUrl` derives from `baseUrl` (`http→ws`, `https→wss`).
- Drive the existing `api` singleton from the active connection (`setBaseUrl` + `setToken`) so the ~150 call sites are untouched.
- Parameterize `useWebSocket`, the ACP + coordination adapters, and `TerminalPanel` to use the active connection's `wsUrl`/`baseUrl`/token instead of `window.location` / direct `localStorage`.
- **On active-connection change: `queryClient.clear()` + WS reconnect** (prevents cross-hub cache bleed).
- **Server task:** verify/relax the Host-header guard for remote hosts (set `instance.url`, or allow LAN/tailscale hosts, or an allowlist).
- *Default connection = same-origin*, so local usage is unchanged.
- **Accept:** a build served from origin X can point at a *different* hub URL + key and fully work (data, WS live updates, ACP chat, terminal).
- **Shipped:** `src/web/lib/hub.ts` (active-connection source of truth: origin + token + URL/header builders) + `src/web/hooks/useActiveHub.ts` (React binding via `useSyncExternalStore`). Seam swaps: `lib/api.ts`, `adapters/openhive-acp-service.ts`, `adapters/coordination-chat-adapter.ts`, `adapters/openhive-adapters.ts`, `hooks/useWebSocket.ts` (incl. a real reconnect-on-hub-switch — the old `connect()` early-returned so a credential change never reconnected), `components/terminal/TerminalPanel.tsx`, `pages/Dashboard.tsx`, `main.tsx` (`queryClient.clear()` on origin change). Default connection is same-origin, so local usage is unchanged. Tests: `src/web/__tests__/lib/hub.test.ts`.
- **Server task done:** added `instance.allowedHosts` (config + `OPENHIVE_INSTANCE_ALLOWED_HOSTS`) and taught `registerHostnameGuard` to accept it — so a swarmhub-mode hub whose `url` is its public domain can still be reached over LAN/Tailscale. The guard now compares host identity **port-agnostically**, which also fixed a latent bug: a non-default-port `instance.url` (e.g. `https://mini:7836`) previously 421'd even correct requests, because `request.hostname` is port-stripped but `expectedHost` was not. Tests extended in `src/__tests__/middleware/hostname-guard.test.ts`.
- **Not yet wired (A2's job):** there is no UI to *set* a remote origin — `setActiveOrigin(...)` persists to `localStorage.openhive_hub_origin`, so A1 is exercised by setting that key + reload. A2 adds the connection store + switcher that drives it.

**A2 — Connection store + switcher** — ✅ **landed 2026-07-05** on branch `feat/remote-control-a1` *(depends on A1)*
- `src/web/stores/hubs.ts`: persisted list of connections + `activeHubId`; migrate the existing single `openhive-auth` token into a seeded same-origin connection.
- Switcher UI (top-nav/sidebar dropdown): list, active indicator, add (label + URL + key, validated via `/agents/me`), edit/remove. Keep per-connection `authMode` by fetching that hub's `/auth/mode` (so SwarmHub-mode hubs still OAuth).
- **Prominent "connected to <hub>" indicator** — guard against acting on the wrong hub, especially for destructive ops.
- Deep-linking stays hub-global for v1 (active hub is app state, not in the URL); hub-in-URL deep-linking is deferred (see §8 [Q5]/router refactor).
- **Accept:** add 2+ hubs, switch, steer each; creds persist across reloads; switching cleanly swaps data + live connections.
- **Shipped:** `src/web/stores/hubs.ts` (saved connections + `activeHubId`; `switchTo` re-points `lib/hub.ts` **and** drives the single-session auth store as a *view* of the active hub — no auth-store rewrite; `ensureSeed` guarantees a same-origin "This hub" connection and reconciles `activeHubId` to whatever `hub.ts` is pointed at on boot; `syncActiveFromAuth` mirrors live login/logout into only the *active* connection so switching never clobbers the same-origin credential; `addConnection` validates a credential against the remote via `/agents/me`, decorates from `/auth/mode` + `/.well-known/openhive.json`). `src/web/components/layout/HubSwitcher.tsx` (sidebar dropdown: list/switch/remove + add-connection form), wired into `Sidebar.tsx` (below the logo, collapsed-aware) and `App.tsx` (seed + auth-sync effect). Tests: `src/web/__tests__/stores/hubs.test.ts` (10).
- **Deferred to later:** adding a **SwarmHub-OAuth** remote hub through the switcher (v1 add-form is API-key / local-mode only, per [DA3]); a dedicated Settings → **Connections** management panel (the sidebar dropdown covers add/switch/remove for now); live **visual** verification of the switcher against a running backend.

**A3 — Self-hosted login + scoped keys** — ✅ **landed 2026-07-05** on branch `feat/remote-control-a1` *(backend + client; verified live)*
- **`POST /api/v1/auth/login { username, password } → { token, agent, expires_in }`** (`src/api/routes/auth.ts`). Verifies a human account's password (bcrypt, existing DAL) and **mints a short-lived (24h) scoped `ohk_` ingest key — *not* a JWT.** This reuses the existing `validateIngestKey` + scope-gate middleware, so **no new token type and no new middleware** were needed (a cleaner result than the JWT plan; see §6). Gated off in `swarmhub` mode, mirroring how `/auth/swarmhub/exchange` is gated off in local mode.
- **Scope model:** the login key is issued with `['*']` scope. This does **not** grant admin routes — those are gated by `requireAdmin` on the resolved agent's `is_admin` flag (`src/api/middleware/auth.ts`), independent of key scope. So a non-admin operator gets full console access but cannot hit `/admin/*`, and an admin operator's identity flows through unchanged. (A finer read-only/operator key split is deferred: the scope taxonomy makes `/agents`, `/hives`, … require `*`, so a "console-capable but non-admin" *key* scope is awkward, and `requireAdmin` already provides the real admin boundary.)
- **Provisioning — both paths (per [DA3] follow-up decision):** `POST /api/v1/admin/operators` (admin-gated; create/update a human operator) **and** `openhive admin set-password` (DB-direct bootstrap with a no-echo password prompt). Both create/update `account_type='human'` accounts; no schema migration (the columns already existed).
- **Client:** the Login page gains a username/password form (shown outside swarmhub mode); the A2 add-connection form gains an **API-key / Password toggle** — the password path exchanges credentials for a scoped token via the *remote* hub's `/auth/login`, then stores it like any bearer credential (so you can attach a remote hub by username+password, not just a key).
- **Verified live (2026-07-05):** curl E2E against a running hub (login → token → `/agents/me` **with that token** → 200; wrong-pw → 401; `/admin/operators` → 201); the CLI provisioned + migrated a fresh DB; the web UI rendered the switcher + the API-key/Password toggle. Tests: 11 backend (`src/__tests__/auth-login.test.ts`) + 3 client (`hubs.test.ts`); full web suite green (773).
- **⚠️ Caveat (not yet a hard gate):** in `local` auth mode the hub still **auto-authenticates** unauthenticated requests, so this login provides a *real scoped identity + nicer UX over a trusted network* (Tailscale), but is **not** a barrier on a publicly-exposed hub. Making it a true gate needs a "reject-unauthenticated" posture (the vestigial `token` auth mode) — see [Q2] and Deferred TODOs.

**A4 — Packaging + push** *(after A2; PWA and Electron are parallel sub-tracks)*
- **PWA:** web app manifest + service worker (Vite PWA plugin); installable on desktop/iOS/Android; cache the app shell. The PWA is "the OpenHive app" served by any hub and targets others via the connection store.
- **Web push:** service worker + Push API + a backend push-subscription store + an event→notification sender (agent-needs-input, dispatch-complete); reuse the outbound event/bridge infra where possible. Note: iOS web push requires an installed PWA (iOS 16.4+).
- **Electron:** fold multi-hub support into `docs/ELECTRON_PACKAGING.md`; support a **client-only mode** (no local backend, points at a remote hub) alongside the local-backend mode; native notifications; auto-update already scaffolded (`UpdateBanner`, `version.ts`). Coordinate with that doc's owner.
- Token-at-rest: localStorage plaintext is acceptable for v1 (matches today); upgrade to Electron `safeStorage` / mobile keychain later.

### 10.3 Sequencing & risks

- **Order:** A1 → A2; A3 parallel (integrates into A2's login UI when ready); A4 after A2 (PWA ∥ Electron; push trails).
- **Rough total:** ~6–9 wk; **MVP (A1+A2, key auth) ~3–3.5 wk.**
- **Risks:** cross-hub React Query cache bleed (mitigated by clear-on-switch); Host-guard rejecting remote hosts (A1 server task); JWT expiry/refresh (A3); robust WS reconnect on mobile network changes (verify existing hook); shipping a remote-capable app raises the stakes of `local` auth auto-auth on exposed hubs — surface a warning + tie to §8 [Q2].

