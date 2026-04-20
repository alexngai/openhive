# RFC: Capability Grants via Native MAP Delegation

**Status**: Design pinned — implementation in progress.
**Author**: Alex Ngai
**Date**: 2026-04-19
**Scope**: OpenHive headless-mode series, agent-facing capability enforcement.
**Current revision**: **v4** — MAP-native (map/agents/spawn + agent-iam delegation).
See "Revision history" at the end for the path we took to get here.

---

## TL;DR

OpenHive agent capabilities are implemented as a thin layer over two primitives
already in the codebase: agent-iam scopes (cryptographic auth) and the MAP
protocol's `map/agents/spawn` method (native delegation).

- **Operator-facing**: REST + admin key, grants capabilities via
  `POST /admin/agents/:id/capabilities`. The capability value is an
  agent-iam scope string (e.g. `map:agents:spawn`).
- **Agent-facing**: MAP WebSocket. An agent with a granted scope can invoke
  `map/agents/spawn` to create a child agent, receiving a delegated
  credential the child uses to connect. No OpenHive-specific REST routes
  or MAP methods.
- **Enforcement**: scope check at MAP method dispatch time. Session scopes
  are resolved once at `map/connect` (from the agent-iam token in verified
  mode, from the DB capabilities column in open mode, plus `map:*` for
  admins).
- **Onboarding**: preauth keys are retired. Agents and operators both mint
  onboarding credentials via agent-iam delegation. The delegated token IS
  the credential a new swarm uses on `map/connect` — there is no separate
  "join ticket" concept.

The net effect: OpenHive is a MAP hub that implements standard MAP methods,
with an agent-iam auth provider that supports delegation. Everything
agent-facing rides on protocol standards. OpenHive-specific code lives
only in the grant ledger and operator ergonomics layer.

---

## Why we landed here

### Problem

A headless OpenHive hub is a MAP sync/coordination plane for agent swarms.
Onboarding a new swarm today requires a human operator to mint a credential
and hand it to the swarm. For autonomous fleets, this bottleneck doesn't
scale — a coordinator agent should be able to onboard its own workers once
the operator has established the initial trust.

The goal: give authorized agents the ability to mint credentials for
sibling agents, with operator-revocable grants that can't escalate beyond
the granting agent's own authority.

### Non-goals

- Role-based access control with inheritance. Flat capability set only.
- Expiring grants. `true/false` on the grant ledger; expiry happens at the
  delegated-token layer via agent-iam's TTL.
- Per-capability scoped grants (e.g. "only for hive X"). Agent-iam supports
  scope constraints; we'll layer that in later if needed.
- Making preauth keys continue to exist in any form. They're retired.

### Why native MAP instead of OpenHive-specific primitives

Three earlier drafts of this RFC (v1–v3, see history at the end) designed
this as a REST-centric system with an `agents.capabilities` DB column, a
`POST /agents/me/token` exchange endpoint, an `X-Agent-Token` header, a
`grant_version` counter, and OpenHive-specific `X-Agent-Token` middleware
paths. The code worked. It also duplicated mechanisms MAP already had.

The reframe: every other agent-facing operation in OpenHive (`map/tasks/*`,
`trajectory/checkpoint`, `x-cascade/*`, `x-openhive/memory.sync`) already
rides on MAP. Onboarding was inexplicably REST. Once we asked "what's the
MAP-native version of this," the answer was right there in the spec —
`map/agents/spawn` has `requestedScopes` and `ttlMinutes` in its request,
`delegatedCredentials` in its response, and an `AuthManager.delegateForSpawn`
hook in the ts-sdk. Nothing to invent.

v4 uses what's already there.

---

## Architecture

```
┌─ Operator surface ─ REST /api/v1/admin/* ───────────────────────────┐
│  Strict admin auth (X-Admin-Key or admin Bearer).                   │
│  - POST /admin/agents/:id/capabilities { capability }               │
│      Grants a scope to an agent. Operator-only.                     │
│  - DELETE /admin/agents/:id/capabilities/:capability                │
│      Revokes. Operator-only.                                        │
│  - GET /admin/agents/:id/capabilities                               │
│      Audit.                                                          │
│  - openhive admin onboard-token create --scopes ... --ttl-hours N   │
│      Operator mints a delegated token directly (no agent in loop).  │
│      Useful for bootstrap scripts.                                  │
└─────────────────────────────────────────────────────────────────────┘

┌─ Agent surface ─ MAP WebSocket ─────────────────────────────────────┐
│  Agent-iam-authenticated session with effective scopes attached.    │
│  - map/agents/spawn { parent, requestedScopes, ttlMinutes, ... }    │
│      Scope check: session must hold map:agents:spawn.               │
│      Delegation check: requestedScopes ⊆ session scopes.            │
│      Returns: { agent, delegatedCredentials: {method,credentials,env}}│
│  - map/connect with delegated token as credential                   │
│      New swarm presents its delegated credential. Hub verifies      │
│      signature, scope chain, revocation. Session opens with the     │
│      token's scopes.                                                │
└─────────────────────────────────────────────────────────────────────┘

┌─ Hub internals ─────────────────────────────────────────────────────┐
│  Agent-iam TokenService (universal, all trust modes)                │
│      createRootToken / delegate / verify / revokeToken              │
│  AgentIAMProvider.delegateForSpawn(parent, parentData, request)     │
│      Mints child token via tokenService.delegate().                 │
│      Returns DelegatedCredentials with env-var form for subprocess. │
│  Session scope resolver (new at map/connect)                        │
│      In verified mode: scopes from agent-iam token.                 │
│      In open mode: scopes from DB capabilities column + is_admin.   │
│      map:* for admins; else Object.keys(agent.capabilities).        │
│  Scope-check helper at MAP method dispatch                          │
│      requireCapability(ctx, 'map:agents:spawn')                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Data model

One new/retained column. Everything else is either existing MAP machinery
or built-in agent-iam behavior.

```sql
-- Retained from Phase 1. The grant ledger.
agents.capabilities TEXT  -- JSON object, keys are agent-iam scope strings
```

**Retired (see "What dies" below):**
- `map_preauth_keys` table
- `agents.grant_version` column
- `__ohv_grant_version__` sentinel scope

### Capability vocabulary (v4)

Capabilities are plain agent-iam scope strings. Same vocabulary for the
grant ledger and the tokens.

| Scope | Unlocks | Who grants |
|---|---|---|
| `map:agents:spawn` | `map/agents/spawn` MAP method — agent can delegate to a child | Operator (narrow) |
| `map:*` | Any MAP operation the hub scope-gates | Operator (admin flag) |

Operators grant `map:agents:spawn` via
`openhive admin agent grant <id> map:agents:spawn`.

Admins implicitly hold `map:*` by virtue of `is_admin: true`; they do not
need an explicit grant.

**Intentionally excluded from v1** (per the naming rule, these would be
valid capabilities, but we're not enabling them yet):

- `map:preauth:*` — preauth keys are retired entirely
- `map:agents:delete` — agent removal stays operator-only
- `map:config:*` — hub config changes stay operator-only
- `map:grants:*` — agents cannot grant to other agents (no delegation of
  grant authority; only of capability)

### Naming rule

`<domain>:<resource>:<verb>` — matches agent-iam's canonical
`provider:resource:action` format. `scopeMatches('map:*', 'map:agents:spawn')`
returns true; admin tokens need no explicit enumeration of individual
scopes.

---

## Onboarding flow (agent-to-agent)

The full story of a coordinator onboarding a worker, once the operator has
granted `map:agents:spawn`.

```
Operator (one-time)
  $ openhive admin agent grant coord-agent-id map:agents:spawn

Coordinator (running continuously)
  // Connected via map/connect with its agent-iam token.
  // Session scopes include map:agents:spawn.

  [new job arrives, needs capacity]

  const result = await client.callMethod('map/agents/spawn', {
    parent: coordAgentId,
    name: 'worker-job-42',
    role: 'worker',
    requestedScopes: ['map:*'],          // worker gets full map auth;
                                          // can be narrower if desired
    ttlMinutes: 60,                       // credential expires in 1h
    capabilities: { ... },                // worker's ParticipantCapabilities
  });
  //
  // result.agent                         — the worker's agent record
  // result.delegatedCredentials.method   — 'bearer'
  // result.delegatedCredentials.credentials.token — JWT-ish
  // result.delegatedCredentials.env.MAP_CREDENTIAL — same token, subprocess-form
  // result.delegatedCredentials.env.MAP_PARENT_ID — coord agent id

  // Coordinator spawns the worker subprocess, passing env through:
  spawn('./worker-binary', { env: {
    ...process.env,
    ...result.delegatedCredentials.env,
  }});

Worker (subprocess)
  // Reads MAP_CREDENTIAL from env. Connects.
  client.connect({
    auth: { method: 'bearer', credential: process.env.MAP_CREDENTIAL },
  });
  //
  // Hub verifies the delegated token: signature valid, not revoked,
  // scopes = ['map:*'], parent chain points back to coord.
  // Session opens with scopes ['map:*'].

  [worker does its job using MAP methods within its scope]
```

**What happens on coordinator revocation** (operator decides to shut it
off):

```
Operator
  $ openhive admin agent revoke-capability coord-agent-id map:agents:spawn

Coordinator's session scopes are recomputed on next map/connect cycle
(next reconnect, or immediately if the hub force-closes the WS). Its
next attempt at map/agents/spawn returns scope-check failure.

Existing workers spawned from the coordinator keep working until their
delegated tokens expire. This is by design — revoking the spawn
capability stops the faucet, doesn't invalidate already-running work.

If the operator wants to invalidate existing workers too:
  $ openhive admin agent revoke-capability <each-worker> map:*  # or
  # delete them, which cascades revocation via agent-iam's parent chain
```

**Parent revocation cascade** — agent-iam natively: if the operator
`revokeToken`s the coordinator's token, all children delegated from it
are also rejected on next verify. We get this for free.

---

## Onboarding flow (operator-bootstrap)

For operators who want to boot a swarm from a shell script without going
through a running coordinator agent, the CLI exposes delegation directly:

```bash
$ openhive admin onboard-token create --scopes map:* --ttl-hours 24
Created onboarding token for new-agent-xyz:
  MAP_CREDENTIAL=<token>
  MAP_PARENT_ID=<admin-key-sentinel>
  Expires: 2026-04-20T16:15:00Z

# Pass to the swarm process:
$ MAP_CREDENTIAL=... ./swarm-binary
```

Under the hood: admin-key auth is the "parent authority" for this
delegation. Signed by the same agent-iam TokenService. No special code
path — admin-key-as-parent is just another case the hub's delegation
logic handles.

---

## MAP method details

### Request — `map/agents/spawn`

Fields used by OpenHive's handler. Full spec at
`references/multi-agent-protocol/schema/schema.json`:

| Field | Required | Purpose |
|---|---|---|
| `parent` | yes | Calling agent's id; must match the session agent |
| `name` | yes | Human-readable name for the new agent |
| `role` | no | e.g. "worker", "coordinator" |
| `requestedScopes` | yes | Scopes for the child's delegated token; must be subset of parent's session scopes |
| `ttlMinutes` | no | Delegated token TTL; defaults to 60, bounded to 1..1440 |
| `capabilities` | no | Child's ParticipantCapabilities (mail, messaging, etc.) |
| `metadata` | no | Free-form hub-specific data |

### Response — `map/agents/spawn`

| Field | Purpose |
|---|---|
| `agent` | The child's agent record (id, name, etc.) |
| `delegatedCredentials.method` | `'bearer'` |
| `delegatedCredentials.credentials.token` | Serialized agent-iam token |
| `delegatedCredentials.env.MAP_CREDENTIAL` | Same token, subprocess-form |
| `delegatedCredentials.env.MAP_PARENT_ID` | Parent agent id, subprocess-form |

### Scope check

Before any work:

```ts
requireCapability(ctx, 'map:agents:spawn');
// Throws MAPError(-32403) if session scopes don't include map:agents:spawn
// (or a wildcard that matches it, like map:* for admins).
```

### Delegation check

agent-iam's `TokenService.delegate()` enforces `requestedScopes ⊆ parentScopes`.
We rely on this — no custom code. A caller asking for scopes wider than
their own session throws before a token is minted.

### TTL bounds

The handler clamps `ttlMinutes` to `[1, 1440]`. Same convention as the
Phase 2 `/agents/me/token` endpoint (now retired); kept here because
unbounded-TTL tokens are a footgun.

---

## Session scope resolution

This is the one new piece of infrastructure. Today, MAP sessions track
authentication but not a definitive scope set. v4 adds that.

**At `map/connect`:**

```ts
function resolveSessionScopes(
  session: MapInboundSession,
  config: Config,
): string[] {
  // Verified trust mode: trust the agent-iam token's scopes
  if (session.authMethod === 'agent-iam' && session.agentIamToken) {
    return session.agentIamToken.scopes;
  }

  // Open trust mode: look up from DB
  const agent = findAgentById(session.agentId);
  if (agent.is_admin) return ['map:*'];
  return Object.keys(parseCapabilities(agent.capabilities));
}
```

Called once at connect; result cached on the session. Method handlers see
it via `ctx.scopes`.

**On grant change** (operator grants or revokes): the in-memory session's
scopes are stale until reconnect. Two options:

1. **Recompute at dispatch** — read from DB on every method call. Correct
   but expensive.
2. **Invalidate on change** — force-disconnect affected sessions; let the
   client reconnect. Cheap but disruptive.

**v4 chooses option 2.** Force-disconnect is disruptive for sessions
actively processing work, but grant changes are rare (operator-initiated,
not automated) and the reconnect cycle takes <100ms. A brief interruption
beats a DB read on every method dispatch forever. We already have the
WS-disconnect machinery (it's how `revokeToken` already works for banned
agents).

If in practice grant-change-disconnect proves too disruptive for some
workload, we can switch to option 1 later without changing the external
semantics.

---

## Security analysis

### Threat: compromised coordinator mints unlimited children

**Mitigations already in place:**
- Each child gets a bounded TTL (max 24h per our clamp).
- Child scopes are attenuated: requestedScopes ⊆ parentScopes. A compromised
  coordinator with `map:agents:spawn` cannot mint a child with `map:admin:*`.
- Every delegation carries an agent-iam parent chain. Revoking the
  coordinator's token cascades — all children become invalid.

**Residual risk:** within the parent's TTL, a compromised coordinator can
spawn many short-lived workers with the parent's full scopes. Bounded by
the parent's own authority; can't escalate beyond that.

**Operator mitigation:** revoke the coordinator's grant. New spawns are
denied. Revoke the coordinator's agent-iam token (via direct `revokeToken`
or delete agent) → all descendant tokens rejected immediately.

### Threat: scope escalation via delegation chain manipulation

**Mitigation:** agent-iam enforces scope attenuation cryptographically
at `delegate()` time. A child token cannot carry scopes its parent
doesn't have, because the signature covers the `currentDepth` and the
scope set is validated against the parent before signing.

### Threat: stolen delegated token

**Mitigations:**
- TTL (default 60 min, max 24h) bounds the exposure window.
- The operator can revoke the entire subtree by revoking the parent.
- A delegated token presented to the hub is verified on every method
  dispatch (signature + expiry + revocation list).

### Threat: replay after revocation

**Mitigation:** agent-iam's revocation list is checked on every verify.
Once the operator runs `revokeToken(coordId)` (or deletes the coord),
subsequent requests by any descendant token get 403 at the MAP level.

### Threat: DB capabilities column corruption

**Mitigation:** `parseCapabilities` defaults-deny on parse errors. An
attacker who can write the column to garbage only causes denial, not
privilege escalation.

### Threat: insider with admin key bypasses everything

This is by design. The admin key is the root-of-trust; holders get `map:*`
via `createAdminAuth`. Protecting the admin key is an operator
responsibility. For deployments that want additional checks, future RFCs
can layer multi-sig admin operations.

---

## Operator ergonomics

### Grant a capability

```bash
openhive admin agent grant <agent-id> map:agents:spawn
```

### List an agent's grants

```bash
openhive admin agent capabilities <agent-id>
# Agent X grants:
#   - map:agents:spawn
# Known capabilities: map:agents:spawn
```

### Revoke

```bash
openhive admin agent revoke-capability <agent-id> map:agents:spawn
```

### Bootstrap a swarm without a coordinator in the loop

```bash
openhive admin onboard-token create \
  --scopes map:* \
  --ttl-hours 24 \
  --agent-name worker-standalone
# Created onboarding token:
#   MAP_CREDENTIAL=<token>
#   MAP_PARENT_ID=admin-key
#   Expires: ...

# Hand MAP_CREDENTIAL to the swarm process.
```

The `admin onboard-token` command replaces `admin preauth create` from v2.
Operators already know the mental model; only the naming changes.

---

## What dies in v4

Everything shipped in v1, v2, v3 that's no longer needed under v4. Since
nothing is in production, deletion is clean.

| Component | Notes |
|---|---|
| `map_preauth_keys` table | V44 migration drops it |
| `POST /api/v1/map/preauth-keys` (all methods) | REST routes removed entirely |
| `preauth_key` field on `POST /map/swarms` request | Schema cleaned |
| `createPreauthKey` / `listPreauthKeys` / `deletePreauthKey` / `consumePreauthKey` DAL | All gone |
| `openhive admin preauth create|list|revoke` CLI | Replaced by `admin onboard-token create` |
| `POST /agents/me/token` endpoint | Retired; delegation replaces it |
| `X-Agent-Token` header | Not used anywhere |
| `createAdminOrCapability` middleware factory | All callers revert to `createAdminAuth` |
| `agents.grant_version` column | V45 migration drops it |
| `bumpAgentGrantVersion`, `getAgentGrantState`, `getAgentGrantVersion` DAL | All gone |
| `__ohv_grant_version__` sentinel scope | Gone |
| `createAgentToken` for regular agents | Gone (token exchange happens via spawn delegation now) |
| `tokenHasScope` grant_version callback parameter | Simplified to just scope check |
| `path4_hits` metric | No path 4 exists anymore |
| Capability vocabulary `map:preauth:create`, `map:preauth:list` | Renamed to `map:agents:spawn` (single entry) |

### What survives

| Component | Role |
|---|---|
| `agents.capabilities` JSON column | Grant ledger (unchanged shape, scope-string values) |
| `grantAgentCapability` / `revokeAgentCapability` / `agentHasCapability` | Used by session scope resolver |
| `POST /admin/agents/:id/capabilities` REST routes | Operator grant UX (unchanged) |
| `openhive admin agent grant/revoke/capabilities` CLI | Unchanged |
| Agent-iam `TokenService` + `createSwarmToken` + `revokeToken` | Still used for MAP WS auth |
| `createAdminAuth` middleware | Strict admin auth on all REST admin routes |
| Admin key path | Break-glass, unchanged |
| `trustLocalMode` escape hatch | Orthogonal to capabilities; unchanged |

---

## Rollout

Nothing in production. No back-compat pressure. PRs are sequenced by
dependency only.

**PR 1 — Session scope resolution at `map/connect`**
- New helper `resolveSessionScopes(session, config)`.
- Called at connect; result attached to session.
- Method handlers read `ctx.scopes`.
- Force-disconnect on grant change (call existing `revokeToken` on
  affected agent).
- Tests: scope resolution for verified/open/admin combinations;
  disconnect-on-grant-change behavior.

**PR 2 — `AgentIAMProvider.delegateForSpawn`**
- Implement the `delegateForSpawn(parent, parentData, request)` hook.
- Validates `requestedScopes ⊆ parentScopes` (agent-iam enforces).
- Mints via `tokenService.delegate()`.
- Returns `DelegatedCredentials` with `method`, `credentials.token`,
  `env.MAP_CREDENTIAL`, `env.MAP_PARENT_ID`.
- Tests: scope attenuation, TTL clamping, parent chain integrity, bad
  scope rejected.

**PR 3 — `map/agents/spawn` handler**
- OpenHive handler wired into MAP server setup.
- Scope check: `requireCapability(ctx, 'map:agents:spawn')`.
- Calls `authManager.delegateForSpawn(...)`.
- Creates DB row for the new agent.
- Broadcasts `node_registered` lifecycle event.
- Tests: E2E with real MAP WS — coord with grant spawns child, child
  connects with returned token, operator revokes coord, child's next
  request rejected after its own TTL expires (or operator revokes
  subtree).

**PR 4 — `admin onboard-token create` CLI**
- Replaces `admin preauth create`.
- Uses `tokenService.delegate()` directly with admin key as parent
  authority.
- Output: env-var form ready for subprocess use.
- Tests: CLI smoke test with live hub fixture.

**PR 5 — `POST /map/swarms` accepts delegated tokens**
- Swarm Bearer that's a valid agent-iam token → register accepted.
- Remove `preauth_key` field from request schema.
- Tests: register with delegated token succeeds; register with old-style
  preauth key returns deprecation error.

**PR 6 — Deletions**
- Migration V44 (drop `map_preauth_keys`) + V45 (drop
  `agents.grant_version`).
- Strip preauth REST routes, DAL, CLI.
- Remove `/agents/me/token`, X-Agent-Token middleware, grant_version
  machinery.
- Rename capability vocabulary.

**PR 7 — Documentation**
- README headless section updated.
- Skill fragment (`src/api/skill-fragments/map.ts`) documents
  `map/agents/spawn` as the onboarding mechanism.
- CLI help text updated.

PR 1 and PR 2 are independent. PR 3 depends on both. PR 4 is independent.
PR 5 depends on PR 2. PR 6 lands after 3+5 stabilize. PR 7 last.

Estimated total effort: ~1 week focused.

---

## Open questions (for follow-up RFCs, not this one)

1. **Scope-gating on other MAP methods.** `map/tasks/*`, `trajectory/*`,
   `x-cascade/*` are today ungated — any connected agent can invoke them.
   v4 introduces the scope-check primitive; a separate RFC decides where
   else to apply it. Not in scope now.

2. **Cross-system delegation (federation).** agent-iam supports federation
   via `FederationMetadata` with hop counting. If an agent on hub A
   delegates to an agent connecting to hub B, we'd need cross-hub token
   verification. Deferred.

3. **Per-capability scoped grants.** e.g. `map:agents:spawn[hive=X]` —
   agent can spawn children only into hive X. agent-iam's `ScopeConstraint`
   supports `resources` patterns for exactly this. Deferred.

4. **Rate limiting on `map/agents/spawn`.** A compromised coordinator with
   `map:agents:spawn` could spawn children as fast as it can RPC. Within
   its own scope budget, but still worth a per-agent rate cap. Deferred;
   not a security issue, a resource-abuse one.

5. **Agent-to-agent grant delegation.** Today only the operator grants.
   For deeply hierarchical fleets, "coordinator A grants to coordinator
   B" would be useful. Requires design work beyond this RFC.

---

## Revision history

### v4 — MAP-native via `map/agents/spawn` (2026-04-19, this revision)

Reframed the entire system around agent-iam delegation exposed via
`map/agents/spawn`. Discovered (via the reviewer's push: "can we use
native MAP auth structure?") that the MAP spec already defines exactly
the primitive we need — a spawn method with `requestedScopes`,
`ttlMinutes`, and `delegatedCredentials` in the response, plus a
ts-sdk-provided `AuthManager.delegateForSpawn` hook.

Retired all OpenHive-specific machinery built in v2/v3: the REST token
exchange endpoint, `X-Agent-Token` header, `grant_version` column, the
`__ohv_grant_version__` sentinel scope, and the `map_preauth_keys`
table. Kept the DB `agents.capabilities` column as the grant ledger
(unchanged), and operator-facing CLI / REST admin endpoints (unchanged).

Capability vocabulary shrunk to `map:agents:spawn` — the single scope
that gates delegation. Admin agents implicitly hold `map:*`.

The win: zero OpenHive-specific agent-facing methods. Onboarding flows
through standard MAP. Any MAP-compliant hub implementing the spec
correctly can adopt the same onboarding pattern.

### v3 — `grant_version` counter (2026-04-19, superseded)

Replaced v2's revocation-list hack (which collided with legitimate
permanent bans via `POST /map/swarms/:id/revoke`) with a monotonic
`agents.grant_version` counter. Tokens embedded the version at mint
time; verification rejected stale tokens. Fixed the ban-defeat bug and
the deleted-agent-token bug from the second review.

This was a correct v3 given the v2 design constraints, but the entire
grant-version mechanism disappears in v4 — tokens are session-bound,
and grant changes force session reconnect. Simpler.

### v2 — agent-iam integration with dual-path REST enforcement (2026-04-19, superseded)

Added `POST /agents/me/token`, `X-Agent-Token` header, and a 4-path
`createAdminOrCapability` middleware (admin key → X-Agent-Token → admin
Bearer → Bearer-with-DB-grant). Introduced agent-iam scopes as the
runtime credential alongside the DB grant ledger.

Shipped working code. The second review (same day) caught the ban-defeat
bug that triggered v3. v4 then reframed away from REST enforcement
entirely, which obsoletes most of the v2 code even though it was
functionally correct.

### v1 — DB-backed capabilities (2026-04-19, superseded)

Added `agents.capabilities` JSON column, grant/revoke DAL, admin REST
endpoints, CLI commands, and `createAdminOrCapability` middleware
enforcing the grant at REST route preHandlers. Route gate on
`POST /map/preauth-keys` (the REST admin-ish route of the time).

Worked, but enforcement was REST-centric and didn't compose with
agent-iam's existing scope machinery. First review noted the
duplication.

---

## Decision

Implement v4 as specified. PR sequence above. Retire v1-v3 code paths
in PR 6. Ship nothing to production until the full sequence lands.
