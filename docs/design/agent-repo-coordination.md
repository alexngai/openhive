---
status: design
owner: alexngai
created: 2026-05-07
revised: 2026-05-07 (protocol layering, environment metadata, MAP Resource Protocol)
---

# Agent ↔ Repo Coordination Flows

## Vision

Agents should treat repos / environments as first-class **discoverable, addressable, mountable** resources. Today the federation contract is **declare-only**: agents tell the hub what they have; the hub never tells the agent what *anyone else* has. This doc captures the design for the read side — discovery, dispatch on a repo, and mount — across this hub and federated peer hubs.

The federation pipeline (slice 5) and the typed `repo` resource (slice 1) already exist. The protocol surfaces below ride on top of that: pure read paths into already-persisted state, plus a small write path for "mount a repo I just discovered".

Cross-cutting hub-side architecture lives in [`src/map/CLAUDE.md`](../../src/map/CLAUDE.md) "Repos and Workspaces". Protocol shapes are owned by [`agent-workspace`](../../references/agent-workspace/docs/design/repo-kind.md). This doc is openhive-side consumer + agent-side surfaces.

---

## Status quo (asymmetric)

```
agent → hub:  declare, changed, retract       ✅ writes
agent → hub:  list, get, conflict-check       ❌ no reads — agents are blind
hub → agent:  list                            ✅ inverse poll (agent answers)
hub → peer hub: federation events             ✅ via mesh sync (slice 5)
```

Concretely: an agent today has zero protocol-level visibility into:
- What repos this hub knows about (its own + federated from peers)
- Who else is bound to repo X with `dirty=true` on `feature/x`
- Whether a peer hub has agents actively working in this repo right now
- What repo a `task_ref` belongs to (without the linking we just stamped)

The hub already has all this data. What's missing is the agent-facing protocol surface.

---

## Protocol layering

Three layers with distinct owners. The full protocol spec lives at [`docs/protocol/map-resource-protocol-v1.md`](../protocol/map-resource-protocol-v1.md).

### Layer 0 — MAP Resource Protocol (MAP SDK — upstream candidate)

A standard wire format for typed resource discovery on any MAP-protocol hub. Defines the `MAPResource` envelope, two read methods, a kind handler dispatch convention, and capabilities advertisement. **Not OpenHive-specific** — any MAP hub can implement this to make its resources discoverable.

```jsonrpc
map/resources/list { type, filter?, cursor?, limit? }
map/resources/get  { id, type? }
```

The SDK provides:
- `MAPResource` envelope: `{ id, type, name, status, owner_id, origin_hub_id, created_at, updated_at, metadata }`.
- `ResourceKindHandler` interface: per-type `list` + `get` implementations registered by the hub.
- Capabilities advertisement: `capabilities.resources.kinds[]` during the MAP handshake tells agents which types this hub supports.
- Type namespacing convention: `map/*` reserved for standard types, `x-<package>/*` for extensions.

The SDK does not define storage, access control, federation, write operations, or metadata shapes — those are hub and kind concerns.

**Upstreaming path.** OpenHive is the reference implementation. The protocol spec is designed to be extractable into the MAP SDK once it has run. See the [full spec](../protocol/map-resource-protocol-v1.md) for conformance requirements.

### Layer 1 — Hub implementation (OpenHive-owned)

OpenHive implements the MAP Resource Protocol with its own storage (`syncable_resources` table), access control (dual visibility model), and federation (mesh sync). It registers kind handlers for every resource type it supports.

The key implementation detail is **per-type dispatch** (RD9): `type='x-workspace/repo'` routes to `repos.listRepos()` for metadata-visibility scoping; other types route to `listAccessibleResources()` for column-level scoping. Generic on the wire, type-aware in the handler.

OpenHive also provides a REST enrichment layer (`SyncableResourceWithMeta`) with owner profiles, tags, subscriber counts, and permissions — a superset of `MAPResource` for UI consumption.

### Layer 2 — Kind-specific extension methods (package-owned)

Each kind package owns its metadata shape and may define kind-specific methods beyond the generic `list` / `get` surface. The package already owns the four `x-workspace/repo.*` methods; this layer adds more for the read direction.

```jsonrpc
x-workspace/repo.declare    // agent → hub, write bindings (existing)
x-workspace/repo.changed    // agent → hub, diff bindings (existing)
x-workspace/repo.retract    // agent → hub, narrow visibility (existing)
x-workspace/repo.list       // hub → agent, ask agent for its bindings (existing, inbound)
x-workspace/repo.bindings   // NEW — agent → hub, read binding state for a repo
```

`x-workspace/repo.bindings` is the symmetric outbound version of the existing inbound `x-workspace/repo.list`. Same package, same protocol contract, opposite direction.

Environment-kind methods (`x-workspace/environment.instances`, etc.) are deferred until environments ship and usage patterns emerge.

### Type namespace map

Each resource kind is owned by the package that defines its metadata shape and protocol semantics:

| Package | Type namespace | Resource types |
|---|---|---|
| agent-workspace | `x-workspace/*` | `x-workspace/repo`, `x-workspace/environment` |
| minimem | `x-minimem/*` | `x-minimem/memory-bank` |
| opentasks | `x-opentasks/*` | `x-opentasks/task-board` |
| skill-tree | `x-skill-tree/*` | `x-skill-tree/skill` |
| sessionlog | `x-sessionlog/*` | `x-sessionlog/session` |

OpenHive internally uses short `resource_type` values in the database (`repo`, `memory_bank`, `session`, etc.) and maps to/from namespaced types at the protocol boundary.

### How the layers compose

| Operation | Method | Layer |
|---|---|---|
| "What resource types does this hub support?" | `capabilities.resources.kinds[]` | 0 — MAP SDK |
| "What repos / environments / sessions exist?" | `map/resources/list { type }` | 0 — MAP SDK (dispatched to hub handler) |
| "Tell me about resource X" | `map/resources/get { id }` | 0 — MAP SDK (dispatched to hub handler) |
| "Who's bound to repo X right now?" | `x-workspace/repo.bindings { canonical_url }` | 2 — workspace-kind |
| "I have a workspace at /local/path" | `x-workspace/repo.declare` | 2 — workspace-kind |
| "Who has environment Y activated?" | `x-workspace/environment.instances { name }` | 2 — workspace-kind (future) |

Generic stays a pure projection. Kind-specific data sits in the package's namespace. Two round trips for the discovery + conflict-check flow (RD3 says ship that and observe before adding higher-level helpers).

---

## Three flows

### Flow 1 — Discovery: "what repos / environments are available?"

**Goal:** an agent can browse the federated repo set its hub knows about, and ask targeted questions about a specific repo's binding state.

**Three layers, decreasing reach:**

| Layer | Reach | Mechanism | Lift |
|---|---|---|---|
| Same-hub | Repos visible to this caller on this hub (private = owner, hub_local + federated = anyone) | `map/resources/list { type: 'repo' }` wrapping `repos.listRepos()` + viewer scoping | Small |
| Cross-hub via existing federation | Same query also returns repos hub A learned from hub B via mesh sync (`origin_instance_id` ≠ local) | Same method — federated rows are already in `syncable_resources` | Free |
| True cross-mesh ("which hubs even exist?") | Hub C that A doesn't sync with | Hub registry / well-known directory | Out of scope for v1 |

**Method shapes:**

Two methods do the work. Browse is generic over `resource_type`; conflict-check is workspace-kind-specific. See [Protocol layering](#protocol-layering) for the rationale.

```jsonrpc
// Generic browse — Layer 1, OpenHive-owned, works for any resource_type
{
  "method": "map/resources/list",
  "params": {
    "type": "repo",
    "filter": {
      "origin": "user_defined" | "agent_declared" | "trajectory_inferred",
      "visibility": "hub_local" | "federated",
      "status": "active" | "archived" | "merged_into" | "redacted_remote"
    }
  },
  "result": {
    "resources": [
      {
        "id": "repo_xxx",
        "resource_type": "repo",
        "git_remote_url": "https://github.com/foo/bar",  // canonical for repos
        "name": "bar",
        "status": "active",
        "origin_instance_id": "inst_local" | "inst_peer_hub",
        "metadata": {
          "default_branch": "main",
          "visibility": "federated",
          "origin": "user_defined",
          // ...kind-specific metadata; shape per resource_type
        }
      }
    ]
  }
}

// Generic single-resource fetch — Layer 1, OpenHive-owned
{
  "method": "map/resources/get",
  "params": { "id": "repo_xxx" },
  "result": {
    "resource": { /* same shape as list item */ }
  }
}

// Workspace-kind binding lookup — Layer 2, agent-workspace package-owned
// (the pre-flight conflict check)
{
  "method": "x-workspace/repo.bindings",
  "params": { "canonical_url": "https://github.com/foo/bar" },
  "result": {
    "bindings": [
      {
        "agent_id": "agent_a",
        "swarm_id": "swarm_x",
        "local_path": "/Users/alex/work/bar",  // visible per visibility rules
        "current_branch": "feature/x",
        "head_sha": "abc123",
        "dirty": true,
        "last_seen_at": "2026-05-07T..."
      }
    ],
    // Federated peers that have learned about this repo. Bindings stay
    // local to each hub by design (RD1) — this field tells the agent
    // WHICH hubs to ask for cross-hub conflict-check, not the binding
    // state itself.
    "federated_peers": [
      { "hub_id": "inst_peer_b", "last_seen_at": "2026-05-07T..." }
    ]
  }
}
```

**Visibility scoping** mirrors `OpenHiveRepoHandler.onList` (already hardened): private bindings → owner only; hub_local bindings → same swarm only (per-machine path is sensitive); federated → all on hub. Cross-hub federation never exposes another hub's bindings — bindings are local-only state by design (see RD1).

**Same-hub conflict check guarantee.** `bindings` reflects only this hub's `workspaces` table. Agents on peer hubs working on the same repo are NOT in this list; the `federated_peers` field tells the caller which hubs *might* have additional binding state. True cross-hub binding visibility is a Phase 6+ feature (RD1).

**Why split into two methods.** Generic browse stays a pure projection of `syncable_resources` and works for any `resource_type` (repo, environment, session, task, memory_bank, skill). Workspace-binding state is kind-specific and lives in the agent-workspace package's namespace. Two round trips for the conflict-check flow; cleaner ownership (RD3 — observe before optimizing the round-trip).

**Agent SDK shape (proposed in `agent-workspace/kinds/repo`):**

```typescript
class RepoClient {
  // Existing
  declare(workspaces): Promise<void>
  changed(diff): Promise<void>
  retract(canonicalUrl, localPath?): Promise<void>
  handleList(params): Promise<RepoListResult>  // inbound, agent answers

  // New — outbound discovery
  bindings(canonicalUrl): Promise<RepoBindingsResult>  // delegates to x-workspace/repo.bindings
  // Generic discovery (`map/resources/list`) doesn't need a package wrapper —
  // the sidecar calls it directly via `connection.callExtension(...)`.
}
```

Macro-agent / cc-swarm sidecars expose these as MCP tools so agents can call them inline (`list_repos`, `find_repo_bindings`).

---

### Flow 2 — Dispatch on a repo: "do work scoped to repo X"

Today's dispatch primitive (`POST /specs/:id/dispatch`) is operator-driven and spec-shaped. It picks an executor via the orchestrator's `chooseExecutor` (role match → roster). It does NOT know about repos.

**Four sub-flows, increasing autonomy:**

| Sub-flow | Who triggers | What's needed | Status |
|---|---|---|---|
| **A. "Spawn fresh swarm clone'd to this repo"** | Operator (UI/REST) | `POST /swarms { repo_id }` injects WORKSPACE_* env | ✅ slice 6 |
| **B. "Route a dispatch to a swarm already bound to this repo"** | Operator (UI/REST) | Dispatch picker prefers swarms with active bindings on the spec's repo. Reduces clone overhead. | Not built |
| **C. "Broadcast to all swarms bound to this repo"** | Operator or agent | Coordination message ("anyone dirty on feature/x?") fans out to the binding set | Not built |
| **D. "Agent triggers its own dispatch on a repo"** | Agent | Agent calls `map/dispatches/create { repo_id, intent }` — orchestrator picks executor | Not built |

**Sub-flow B (smart routing)** is the smallest lift and the highest-leverage:

- Add `task.metadata.repo_id` (or `spec.metadata.repo_id`) lookup in `src/dispatch/openhive-roster.ts` or `routing.ts`.
- When the spec/dispatch carries a `repo_id`, prefer swarms whose `workspaces` rows include that `repo_id` and `is_active=1`.
- Falls through to the existing role-based selection if no bound swarm matches.
- The slice 8 `metadata.repo_id` linking we just shipped on tasks/sessions makes this a one-join query.

**Sub-flow D (agent-self-dispatch)** is bigger — it's the autonomous-agent path. Needs a write surface, eligibility checks, idempotency, and a kill switch (the dispatch orchestrator already has `autonomousDispatchPaused` for related agent-initiated dispatches; this would extend that gate). Defer until B is real.

**Cross-hub dispatch** ("agent on hub A says 'spawn a worker on hub B'") is a separate primitive — would need `map/cross-hub/dispatch` with credential brokering. Out of scope for v1; record as open question.

---

### Flow 3 — Mount: "agent wants to start working in repo X"

Mount = "I discovered this repo, now put it on my filesystem and bind to it." Three layers:

| Layer | Owned by | What happens |
|---|---|---|
| **a. Discover the repo** | Hub (Flow 1) | Agent learns `canonical_url` exists |
| **b. Resolve to a local path** | Agent (or hub-suggested) | Agent decides where to clone — `/tmp/work/<name>` or its workspace root |
| **c. Clone + bind** | Agent | `git clone <canonical_url> <local_path>` + `RepoClient.declare([{remoteUrl, localPath}])` |

The mechanics already work today: cc-swarm and macro-agent both use `WORKSPACE_REPO_URL` + `WORKSPACE_LOCAL_PATH` at startup to clone-and-declare. To make it **interactive at runtime** (agent decides mid-session "I want repo X now"):

**Agent SDK shape (proposed in package):**

```typescript
class RepoClient {
  // ... existing methods

  // New — mount semantics
  mount(params: {
    canonicalUrl: string;
    localPath?: string;       // if omitted, agent's workspace strategy decides
    branch?: string;
    visibility?: RepoVisibility;
  }): Promise<RepoConfig>;     // returns the bound config; throws on clone failure

  unmount(canonicalUrl: string, localPath?: string): Promise<void>;
}
```

The package's `RepoManager.attach({ remoteUrl, localPath, inspectGitOnAttach: true })` is the in-process mechanic — `mount()` wraps it with a clone (if path doesn't exist yet) plus `client.declare()`. Sidecar exposes as MCP tool: `mount_repo(canonical_url)`.

**Credentials.** If the repo requires auth (private GitHub, GitHub Enterprise, etc.), credentials come from one of:
- Local environment (e.g., `GIT_ASKPASS`, SSH keys) — agent's responsibility
- Hub-brokered via `agent-iam`'s credential broker — hub returns a short-lived token; agent uses it for the clone
- Pre-cloned by the operator (slice 6 spawn flow already injects `WORKSPACE_REPO_URL` and the host has credentials)

For v1 of `mount()`, lean: use local environment. Hub-brokered is a meaningful step up but couples this work to agent-iam's credential surface; treat as Phase 5b.

**Mount safety / claim semantics.** Today multiple agents can independently clone the same repo and declare independent bindings. There's no protocol-level "claim" preventing concurrent dirty work. Mount is **opportunistic** for v1 (just clone + declare). Coordination via Flow 1's pre-flight check + Flow 2C broadcast.

**Visibility is reach, not ACL (RD7).** `mount` does NOT check the repo's federation tier. The `'private' | 'hub_local' | 'federated'` model controls **discovery reach** — who sees the repo via `list` / `get` — not who can clone or bind. If the agent already has the canonical URL, mount succeeds. Git-server-side auth (GitHub private repos, etc.) is what actually gates clone success. This matches how git works in real life and avoids confusing "OpenHive thinks I can't see this repo" with "git won't let me clone it."

**Mount idempotency (RD4).** `mount(url, /a)` twice = same binding (no-op refresh). `mount(url, /a)` then `mount(url, /b)` = two bindings (multi-clone is intentional — main worktree + experiment worktree). The package's `RepoManager.attach` already keys on `(agent_id, repo_id, local_path)`; `mount` inherits those upsert semantics. No special logic.

---

## Cross-cutting questions

These shape the design space at a higher level than the per-method [Resolved decisions](#resolved-decisions) below. The leans here are accepted as design unless explicitly revisited.

### CQ1 — Same surface for `repo` and `environment`?

The agent-workspace package distinguishes `repo` (just-a-git-pointer) from `environment` (composer over repo + sandbox + secrets). The repo work shipped is repo-only. Two options:

| Option | Pros | Cons |
|---|---|---|
| Same `syncable_resources` row, different `resource_type='environment'` | Single federation pipeline; minimal new schema | Conflates two concepts that have different lifecycle semantics (envs are derived; repos are atomic) |
| Parallel `environments` table (or own `resource_type` with own DAL) | Clean separation; environments can have richer composition shape | Two federation pipelines to maintain |

**Resolved: same table, different `resource_type`.** Federation pipeline is single-purpose; environment-specific lifecycle (compose-time secrets resolution) lives in metadata + a thin DAL. Aligns with how `repo` extends `syncable_resources` today.

The template-vs-instance split (see [CQ6](#cq6--environment-templates-vs-instances)) keeps the two lifecycle models clean: the `syncable_resources` row is the static **template** (a recipe); resolved runtime state lives on the instance surface and never in the resource row.

### CQ2 — Authority on cross-hub federated repos

When hub A federates a repo to hub B, hub B has a row marked `origin_instance_id=hub_a`. If an agent on hub B wants to mutate the row (visibility change, archive, merge), who decides?

Today's enforcement: the row's `owner_agent_id` is hub B's local agent (the materializer assigns it during `materializeResourcePublished`). So hub B's local owner can edit the local row, but those edits don't propagate back to hub A — the federation is pull-only on hub A's side.

**Open:** do we want bidirectional sync where hub B's edit pushes back to hub A as a `resource_updated` event? Lean **no for v1** — it complicates the federation contract significantly. Cross-hub mutations stay reads only; if hub B wants to "fork" the repo, it creates its own local row. Revisit if real coordination demands appear.

### CQ3 — Read-time vs subscribe-time discovery

Two models for "what repos can I work in?":

| Model | Shape | Cost |
|---|---|---|
| **Pull** | Agent calls `map/resources/list { type: 'repo' }` whenever it needs to know | Per-call latency; stale between calls |
| **Push (subscribe)** | Hub broadcasts `repo_added` / `repo_changed` events on a MAP scope channel; agents subscribe and maintain a local cache | Better latency; per-agent state to keep |

We already broadcast on the WS layer (`broadcastWorkspaceLifecycleEvent` to `map:repos` + `map:repo:${id}`) for the hub UI. Extending those to a MAP scope channel agents can subscribe to is small. **Lean: ship pull first, layer push on top later if polling becomes a problem.**

### CQ4 — Mount vs clone-and-attach

Two flavors:

| Flavor | Hub role | Use case |
|---|---|---|
| **Hub-mediated mount** | Hub gates mount, may broker credentials, may track who-has-mount | Production-grade workflows where the hub owns secrets |
| **Pure agent-local mount** | Hub is informed, not consulted | Dev workflows where credentials are environmental |

**Lean: pure agent-local for v1.** Hub gets the binding via `declare`; credential layer can attach later via the existing agent-iam broker without changing the protocol. This matches today's slice 7 wire-up.

### CQ5 — Discovery for environments specifically

If we ship environments alongside repos, agent discovery returns both. Options:

- Agents see "available environments to spin up" (operator-curated bundles) — closer to `dispatch` semantics
- Each agent composes its own environment from primitives (repo + secret refs + sandbox params)

**Lean: both.** Operator-curated environments are first-class resources (federate via the same path). Agents can also compose ad-hoc and `declare` the result. Defer until repo discovery is solid.

### CQ6 — Environment templates vs instances

Environments have a fundamentally different lifecycle from repos. Repos are **atomic** — one canonical URL, one identity. Environments are **derived** — they compose repos, secrets, tools, and sandbox config. This creates a split between the static description (what the environment needs) and the runtime state (what an agent has activated).

**Resolved: template / instance split, mirroring the repo pattern.**

| | Template (discoverable, federable) | Instance (bound, ephemeral) |
|---|---|---|
| **Repo** | `syncable_resources` row — canonical URL, metadata.visibility, origin | `workspaces` row — agent_id, local_path, branch, dirty, is_active |
| **Environment** | `syncable_resources` row — manifest shape, repo refs, secret names | *(new surface)* — agent_id, resolved paths, activation state, health |

- `map/resources/list { type: 'x-workspace/environment' }` returns **templates** — what environments are available to activate.
- `x-workspace/environment.instances { name }` (future) returns **instances** — who has this environment activated, with what resolution state.
- Mount mode decisions (clone into fresh dir vs bind to existing `/project-A`) are instantiation-time, not template-time. The template says `repos: [{ canonical_url: "..." }]`; the instance says `resolved_repos: [{ canonical_url: "...", local_path: "/project-A", mount_mode: "existing" }]`.

Templates federate across hubs via the same mesh-sync pipeline as repos. Instances are local-only state (same as workspace bindings — RD1 applies).

### CQ7 — Environment template metadata shape

The environment template metadata is the **federation-safe projection** of the manifest. Not the full manifest, but enough for discovery, dispatch routing, and "can I activate this on my hub?"

**Design principle: references, not values.** Secret names, not payloads. Canonical URLs, not local paths. Provider names, not resolved handles. Each hub resolves values locally at activation time (RD8).

```typescript
/**
 * Per-environment metadata stored in `syncable_resources.metadata`
 * for `resource_type='environment'`. This is the TEMPLATE shape — the
 * discoverable, federable description. Instance state (resolved paths,
 * running processes, health) lives on a separate instance surface.
 */
interface EnvironmentMetadata {
  // ── Identity & provenance ──────────────────────────────────────

  /** Display name (may differ from the syncable_resources.name column). */
  name: string;

  /** Human-readable description of what this environment is for. */
  description?: string;

  /** How this resource came into being. */
  origin: 'operator_curated' | 'agent_declared' | 'derived';

  /**
   * Federation tier — same model as repos.
   * - private: only the creator sees it
   * - hub_local: visible to all agents on this hub
   * - federated: propagated to peer hubs via mesh sync
   */
  visibility: 'private' | 'hub_local' | 'federated';

  /** Freeform labels for filtering/grouping. */
  labels?: Record<string, string>;

  // ── Manifest shape (the recipe) ────────────────────────────────

  /** Schema version of the source manifest. */
  api_version: 'agent-environment/v1';

  /** Whether the manifest requires strict resolution (no implicit defaults). */
  strict?: boolean;

  /**
   * Layer summary — which providers are declared, at what version ranges.
   * NOT the full config (may contain sensitive references). Enough for
   * "can my hub resolve this?" and "what does this env need?"
   */
  layers: {
    identity?:    { provider: string; version?: string };
    secrets?:     { provider: string; version?: string };
    inbox?:       { provider: string; version?: string };
    compute?:     { provider: string; version?: string };
    workspace?:   { provider: string; version?: string };
    repos?:       { provider: string; version?: string };
    tools?:       { provider: string; version?: string };
    permissions?: { provider: string; version?: string };
    sandbox?:     { provider: string; version?: string };
  };

  // ── Composition references (the dependencies) ──────────────────

  /**
   * Repos this environment includes. Canonical URLs only — no local
   * paths, no credentials, no branch state. Serves dispatch routing
   * ("does this env touch repo X?") and federation ("peer hub, do you
   * have these repos?").
   */
  repos: Array<{
    canonical_url: string;
    role?: string;  // 'primary' | 'reference' | 'dependency' | free string
  }>;

  /**
   * Secret names this environment requires (never values). At activation
   * time, each hub resolves these via its local agent-iam / vault.
   * A receiving hub can pre-flight check "do I have these configured?"
   */
  secret_refs?: string[];

  /**
   * Tool server names declared in the tools layer. Not endpoints or
   * commands — just names for discoverability and compatibility checking.
   */
  tool_servers?: string[];

  /**
   * Named sandbox profile, if the sandbox layer uses one. Informational
   * — the actual policy is in the manifest config, not here.
   */
  sandbox_profile?: string;

  // ── Lifecycle ──────────────────────────────────────────────────

  /**
   * Where the source manifest lives, if file-backed. Not meaningful on
   * receiving hubs — they'd resolve their own copy.
   */
  source_manifest_path?: string;

  /**
   * If this template was derived from another environment (e.g., forked
   * with local overrides), points to the parent template's resource ID.
   */
  derived_from?: string;

  /**
   * Timestamp of the last lockfile generation. Tells consumers whether
   * the template has been validated recently.
   */
  locked_at?: string;
}
```

**Key differences from `RepoMetadata`:**

| Field | RepoMetadata | EnvironmentMetadata | Notes |
|---|---|---|---|
| `origin` values | `user_defined \| agent_declared \| trajectory_inferred` | `operator_curated \| agent_declared \| derived` | Different provenance paths — envs can't be trajectory-inferred |
| `labels` | no | yes | Environments need richer filtering for dispatch |
| `api_version` | no | yes | Schema versioning for the manifest format |
| `layers` | no | yes (provider summary) | Env-specific: composition shape |
| `repos` | no | yes (canonical URLs) | Env-specific: which repos are composed in |
| `secret_refs` | no | yes (names only) | Env-specific: credential needs |
| `branches` | yes | no | Repo-specific: git state |
| `binding_policy` | yes | no | Repo-specific: claim semantics |

**What the `syncable_resources` row looks like:**

```
id:              env_abc123
resource_type:   environment
name:            platform-dev
description:     Platform team development environment
git_remote_url:  map://environment/platform-dev    ← synthetic URI as identity
visibility:      private                           ← column-level, vestigial for envs
owner_agent_id:  agent_xyz
sync_strategy:   metadata                          ← no git content to sync
metadata:        { ... EnvironmentMetadata ... }
status:          active
```

The `git_remote_url` column is reused as a synthetic identity URI, same pattern as sessions (`map://session/{id}`). No actual git operations happen on it.

### CQ8 — What environments-as-resources enable for multi-agent flows

Environments as first-class resources unlock four capabilities:

**A. Portable agent setup.** An operator defines an environment template with repos + secrets + sandbox + tools. When dispatching to a swarm, the dispatch carries `env_id` instead of individual `WORKSPACE_REPO_URL` / `WORKSPACE_BRANCH` / etc. env vars. The agent mounts the environment atomically — all repos, all tools, correct sandbox policy. Today's spawn integration injects one repo; environments inject the full working context.

**B. Federated environment discovery.** Environment templates with `visibility: 'federated'` sync across hubs. An agent on hub B can discover "hub A has a `platform-dev` environment with repos X, Y, Z." The agent can't resolve hub A's secrets, but it sees the shape and can mount a local equivalent (or report "I'm missing secret `GITHUB_TOKEN`" before attempting activation).

**C. Dispatch routing by environment.** Extending Phase 2's "smart dispatch by repo" to "smart dispatch by environment." If a dispatch targets `env_id`, prefer swarms that already have that environment activated (all repos mounted, tools running). Strictly stronger than repo-only routing — fewer cold starts.

**D. Environment-as-intent.** Instead of "do work on repo X", the dispatch says "do work in environment Y," which implies repos, sandbox constraints, tool availability, and identity. The environment becomes the **unit of work context** — what the agent needs, not just where the code lives.

---

## Existing OpenHive surface (what we extend)

A read of the current code (`src/map/map-server-setup.ts`, `src/db/dal/syncable-resources.ts`, `src/api/routes/{resources,repos,memory-banks,skill-management}.ts`) confirms the shape Phase 1a slots into.

**MAP method registry** — `buildAdditionalHandlers()` registers handlers in per-domain families:

| Family | Direction | Notes |
|---|---|---|
| `map/tasks/*` | bidirectional | opentasks daemon proxy |
| `map/specs/*` | agent→hub | spec content |
| `map/dispatches/*` | agent→hub | dispatch lifecycle reports |
| `trajectory/*` | bidirectional | session checkpoints + on-demand content |
| `x-cascade/*` | agent→hub | cascade events |
| `x-workspace/repo.*` | both | declare/changed/retract (out), list (in) — package-owned |
| `x-openhive/{memory,skill}.sync` | agent→hub | resource-update notifications |

**There is no generic `map/resources/*` family today.** Discovery happens only over REST. Phase 1a adds the missing family.

**DAL surface** already exposes the right primitives:
- `listAccessibleResources({ agentId, resourceType, owned, visibility, scope, limit, offset })` — column-level scoping (`owner OR subscribed OR visibility='public'`). Returns `SyncableResourceWithMeta[]` (full row + owner + tags + subscriber_count + my_permission).
- `discoverPublicResources(...)` — pure-public browse with text + tag filters.
- `getResourceWithMeta(id, viewerAgentId)` — single-resource read with the same enrichment.
- `canAccessResource(agentId, resource)` — column-level only; does NOT understand `metadata.visibility` (the federation tier on repos).

**REST is already split two ways and Phase 1a should mirror that split:**
- `GET /api/v1/resources` (generic) → `listAccessibleResources`. Whitelist in `resources.ts:25` is `['memory_bank', 'task', 'skill', 'session']` — **repos are excluded today.**
- `GET /api/v1/{memory-banks,skills}` (per-type wrappers) → `listAccessibleResources` with the type pre-filtered.
- `GET /api/v1/repos` → `repos.listRepos()` directly + metadata-visibility scoping in the route.

The asymmetry exists because repo visibility lives in `metadata.visibility` (federation tier), not the column. Reconciling the two visibility models is a separate (Phase 6+) refactor — not a blocker for Phase 1a.

---

## Phasing

Smallest-first, each shippable independently.

### Phase 1a — MAP Resource Protocol implementation (~half day)

**Scope:** implement the [MAP Resource Protocol v1](../protocol/map-resource-protocol-v1.md) on OpenHive. Two generic MAP read methods as the reference implementation, plus capabilities advertisement.

**Deliverable:**
- New methods registered as `additionalHandlers` in `src/map/map-server-setup.ts`:
  - `map/resources/list { type, filter?, cursor?, limit? }`
  - `map/resources/get { id, type? }`
- Responses conform to the `MAPResource` envelope on the MAP wire. Hub enriches to `SyncableResourceWithMeta` for REST.
- **Capabilities advertisement**: include `resources.kinds[]` in the hub's capabilities response, listing all registered resource types.
- **Type namespace mapping**: MAP wire uses namespaced types (`x-workspace/repo`, `x-sessionlog/session`, etc.); OpenHive maps to/from internal `resource_type` values at the protocol boundary.
- **Per-type dispatch in the handler** (RD9): `type='x-workspace/repo'` routes to `repos.listRepos()` for metadata-visibility scoping; other types route to `listAccessibleResources()` for column-level scoping. Generic on the wire, type-aware in the handler.
- Add `'repo'` to the `RESOURCE_TYPES` whitelist at `resources.ts:25` so REST `/api/v1/resources` also lists repos through the per-type-dispatch handler.
- Protocol spec doc: [`docs/protocol/map-resource-protocol-v1.md`](../protocol/map-resource-protocol-v1.md) — the upstream-candidate wire format, method shapes, kind handler interface, type namespacing, and capabilities advertisement. OpenHive-specific implementation details in a separate section of the spec.
- Tests covering same-hub, cross-hub-federated rows, visibility scoping (column-level for non-repo, metadata-level for repo), type-filtering, per-type-dispatch fork, and `get` with and without `type` hint.

**Unblocks:** generic browse for any resource type. Agents can ask "what repos / environments / sessions exist?" via one method. Capabilities advertisement tells agents what's available without a round-trip.

### Phase 1b — `x-workspace/repo.bindings` (~half day)

**Scope:** workspace-kind extension method for the pre-flight conflict-check, agent-workspace package-side, with hub-side handler in OpenHive.

**Deliverable:**
- New method on the `agent-workspace/protocol/repo` namespace: `x-workspace/repo.bindings { canonical_url } → { bindings, federated_peers }`.
- Symmetric outbound version of the existing inbound `x-workspace/repo.list`.
- Hub-side handler in `OpenHiveRepoHandler` with binding-visibility scoping (private → owner; hub_local → same swarm; federated → all on hub).
- `federated_peers` field surfaces which peer hubs have learned about the repo (RD1 — cross-hub bindings are deferred but agents see *where* to ask).
- Tests covering visibility scoping, federated-peer enumeration, missing-repo (returns empty bindings).

**Unblocks:** pre-flight conflict-check ("anyone dirty on `feature/x`?") on this hub. Same-hub guarantee only — cross-hub conflict-check stays Phase 6+ (RD1).

### Phase 2 — Smart dispatch routing by repo (~half day)

**Scope:** dispatch picker prefers bound swarms when the spec/dispatch carries a `repo_id`. Falls through to role-based selection.

**Deliverable:**
- Extend `src/dispatch/openhive-roster.ts` with a `repo_id` filter.
- `enrichWithLoadout` already surfaces `task.metadata.role`; add `task.metadata.repo_id` to the enrichment if present on the spec/task resource.
- Tests covering: bound-swarm preferred over fresh-spawn; falls through when no swarm is bound; works with the `prefer-route` and `prefer-spawn` modes.

**Unblocks:** less clone-on-spawn churn; dispatches reuse existing working trees when possible.

### Phase 3 — `RepoClient.bindings()` + `.mount()` + sidecar MCP tools (~half day per method)

**Scope:** the package gains workspace-kind-specific outbound methods. Generic discovery (`map/resources/*`) doesn't need a package wrapper — sidecars call it directly via `connection.callExtension('map/resources/list', { type: 'repo' })`.

**Deliverable:**
- New `RepoClient.bindings(canonicalUrl)` on `agent-workspace/kinds/repo/client.ts` — wraps the Phase 1b method.
- New `RepoClient.mount({ canonicalUrl, localPath?, branch?, visibility? })` — package-side mechanic that combines clone (if path doesn't exist) + `RepoManager.attach` + `client.declare` (RD4 — package's existing upsert semantics).
- Macro-agent sidecar exposes MCP tools:
  - `list_repos` — direct MAP call to `map/resources/list { type: 'repo' }`, no package wrapper.
  - `repo_bindings` — wraps `RepoClient.bindings`.
  - `mount_repo` — wraps `RepoClient.mount`.
- v1 of `mount()` is opportunistic + agent-local credentials. `mount` does not check repo visibility (RD7 — federation tier is reach, not ACL).
- Tests: unit (transport-mocked) + sidecar integration (against a real hub).

**Unblocks:** agents self-discover and self-mount via tool calls during a session. The discovery + conflict-check + mount loop becomes a single agent-driven narrative.

### Phase 4 — MAP Resource Protocol event contract (~half day)

**Scope:** implement the optional event layer from the [MAP Resource Protocol](../protocol/map-resource-protocol-v1.md). Hub broadcasts `resource.added` / `resource.updated` / `resource.removed` on MAP scope channels for all resource types, not just repos. Eliminates polling.

**Deliverable:**
- Implement the protocol's event contract: `resource.added`, `resource.updated`, `resource.removed` events with standard shape (`resource_type`, `resource_id`, `resource_name`, `origin_hub_id`, `timestamp`).
- Extend `broadcastWorkspaceLifecycleEvent` to emit protocol-standard events in addition to the existing WS broadcast (bridge period — eventually the WS broadcast migrates to the standard shape).
- Scope channels follow the protocol convention: `resources:x-workspace/repo`, `resources:x-workspace/*`, `resources:*`.
- Sidecars opt in via subscribing to the appropriate scope channel.
- Tests: agent receives broadcast within N ms of the hub-side event; events fire for all resource types (repos, environments, memory banks, etc.).

**Unblocks:** real-time agent awareness of fleet resource state. Groundwork for environment instance notifications.

### Phase 5 — Environment kind on OpenHive (~few days)

**Scope:** promote `environment` as a first-class resource type. Template metadata shape per [CQ7](#cq7--environment-template-metadata-shape). Template/instance split per [CQ6](#cq6--environment-templates-vs-instances).

**Phase 5a — Environment templates (~1 day)**

- Schema migration: extend `resource_type` CHECK with `'environment'`.
- DAL: `src/db/dal/environments.ts` — thin layer over `syncable_resources` with `EnvironmentMetadata` typing (same pattern as `repos.ts`).
- Register `x-workspace/environment` kind handler in `map-server-setup.ts` for the MAP Resource Protocol surface (`map/resources/list { type: 'x-workspace/environment' }`, `map/resources/get`).
- Advertise `x-workspace/environment` in `capabilities.resources.kinds[]`.
- REST: `POST /environments` (create template), `GET /environments` (list), `GET /environments/:id`, `PATCH /environments/:id`.
- REST: `GET /repos/:id/environments` (browse environments that reference a repo — query `metadata.repos[*].canonical_url`).
- Federation: environment templates with `metadata.visibility: 'federated'` ride the existing `resource_published` / `_updated` mesh-sync pipeline. Wire `visibility` field carries column-level `'shared'` (same pattern as repos).
- UI: nav entry + environment list page + detail page showing layer summary, repo refs, secret refs.
- `git_remote_url` column stores synthetic `map://environment/{name}` URI (same pattern as sessions).
- Tests: CRUD, federation round-trip, visibility scoping, repo-reference filtering.

**Phase 5b — Environment instances + mount (~1-2 days)**

- Instance surface: `x-workspace/environment.instances { name }` → returns which agents have this environment activated, with resolution state (healthy/degraded, which repos mounted, activation timestamp).
- Instance storage: new `environment_instances` table or extend `workspaces` with an `env_id` FK — design TBD based on whether instances are per-agent or per-swarm.
- Package-side: `EnvironmentClient.activate({ templateId, mountOptions? })` — resolves the template, clones/binds repos, resolves secrets via local `agent-iam`, starts tool servers.
- Sidecar MCP tools: `list_environments` (calls `map/resources/list`), `activate_environment` (wraps `EnvironmentClient.activate`), `environment_status` (calls `x-workspace/environment.instances`).
- Hub-brokered credentials via `agent-iam` for environments that declare secret dependencies.
- Tests: activate/deactivate lifecycle, secret resolution failure modes, multi-repo mount.

**Phase 5c — Dispatch routing by environment (~half day)**

- Extend Phase 2's repo-based routing: if a dispatch carries `env_id`, prefer swarms that have that environment activated (all constituent repos mounted, tools running).
- Falls through to repo-based routing if `env_id` is absent, then to role-based.
- Tests: env-bound swarm preferred; falls through when no match; works alongside repo routing.

**Unblocks:** the full agent-workspace `environment` kind story end-to-end. Environments become the unit of work context for multi-agent dispatch.

---

## Resolved decisions

The eight open questions from the initial draft were walked through and resolved (2026-05-07). Decisions are referenced as `RD<n>` from the flow descriptions above.

### RD1 — Discovery scope is hub-local for bindings; cross-hub awareness via `federated_peers`

When hub A receives `map/resources/list { type: 'repo' }`, it returns its locally-originated repos AND federated rows learned from peer hubs (with `origin_instance_id` distinguishing source). For `x-workspace/repo.bindings`, the `bindings` array reflects only **this hub's** `workspaces` table — bindings stay local by design and don't federate.

To compensate, `x-workspace/repo.bindings` includes a `federated_peers: [{ hub_id, last_seen_at }]` field listing which peer hubs have learned about this repo. Cross-hub conflict-check is genuinely impossible in v1 — agents on hub B working on the same repo are invisible to hub A's response.

**Scope of the limitation.** Pre-flight conflict check is a same-hub guarantee. Document it; don't pretend it's fleet-wide.

**Reconsider.** A live cross-hub bindings query (hub A asks hub B "what bindings do you have for this canonical URL?" at query time) is a Phase 6+ feature. Adds a new mesh RPC, latency on `get`, and offline-peer handling. Worth doing if real cross-hub coordination demands appear; not worth pre-baking.

### RD2 — Cross-hub dispatch deferred

Out of scope. Recorded as a known gap. If we need it, it deserves its own design doc covering:
- Credential brokering across hubs (whose `agent-iam` resolves the dispatch's secrets?)
- Authority semantics (which hub's policy applies?)
- Failure modes (target hub goes offline mid-dispatch)

### RD3 — Ship raw `get` first; observe; layer `canStartWork` later if patterns emerge

Phase 1b ships `x-workspace/repo.bindings` returning raw binding data. Agents implement their own "should I start work?" logic. Once usage patterns are visible (logs show what conflict-check signatures agents implement), consider adding a higher-level `x-workspace/repo.canStartWork { canonical_url, branch } → { ok, reason }` helper.

**Why not higher-level first.** Pre-baking the policy risks shipping the wrong heuristic. Higher-level helpers are advisory anyway — agents can ignore them — so the cost of waiting is just discoverability of a sensible default, not coordination breakage.

### RD4 — Mount inherits package's existing upsert semantics

`RepoManager.attach` already keys on `(agent_id, repo_id, local_path)`. `mount` is a thin wrapper:
- `mount(url, /a)` then `mount(url, /a)` → idempotent refresh
- `mount(url, /a)` then `mount(url, /b)` → two bindings (multi-clone is intentional)
- `mount(url)` (no path) twice → idempotent if agent's path-strategy is deterministic

No special logic required. Documented behavior matches the package's binding key.

### RD5 — No MAP-method rate limiting in v1; revisit if abuse emerges

Real concern is misbehaving sidecars (bug → tight loop) more than malicious agents. Phase 4's push broadcasts should eliminate the polling temptation entirely. Plan:
- v1 (Phase 1): no rate limit. Document expectation that polling should be sparse.
- Phase 4 (push): agents subscribe to `repos:*` scope, rarely call `list`.
- Between v1 and Phase 4: if hub logs show one connection spamming `map/resources/list`, add per-connection token-bucket at the MAP layer (existing `mapHub` config has hooks).

### RD6 — Forward-only `task.metadata.repo_id` stamping; no backfill

Slice 8 paths A + B stamp `repo_id` opportunistically — tasks created before the linking shipped, or via paths that don't carry repo info, don't get the FK. Phase 2 routing falls through to role-based selection when `repo_id` is missing — same as today's behavior, no regression.

**Why not backfill.** Eager (scan all tasks on repo upsert) adds cost that grows with task count and matches speculatively (parent-dir match is unreliable when one parent contains many repos). Lazy-on-dispatch (resolve at dispatch time) adds latency on every dispatch. Neither is justified by current pain.

If routing coverage turns out poor in practice, revisit with lazy-on-dispatch. The path is small to add later.

### RD7 — `mount` does NOT check repo visibility — federation tier is reach, not ACL

The package's `'private' | 'hub_local' | 'federated'` model controls **discovery reach** (who sees the repo via `list` / `get`), not access control. If the agent already has the canonical URL, `mount` succeeds; git-server-side auth (e.g., GitHub private repos, GitHub Enterprise) gates the actual clone.

**Why this matters beyond mount.** This decision retroactively documents existing `declare` behavior. Today `declare` doesn't check visibility either — an agent that knows a private repo's canonical URL can `declare` a binding to it without being the owner. That's not a bug; it's by design. Visibility tier is about what you can DISCOVER through OpenHive's protocol, not what you can bind to with a URL you already have.

**Documentation impact.** Update `src/map/CLAUDE.md` "Repos and Workspaces" to make the reach-not-ACL semantics explicit, so future work doesn't accidentally treat the visibility tier as an authorization gate.

### RD9 — Per-type dispatch in `map/resources/list` handler (generic wire, typed handler)

The current REST surface has two scoping models:
- Column-level visibility (`'private' | 'shared' | 'public'`) for memory_bank / skill / task / session — handled by `listAccessibleResources`.
- Metadata-level visibility (`'private' | 'hub_local' | 'federated'`) for repo — handled by `repos.listRepos()` with route-level scoping.

`canAccessResource` is column-level only and does not understand `metadata.visibility`. Unifying these is a real refactor (every list path + every materializer) and not justified by Phase 1a's goal.

**Decision.** The generic MAP method dispatches by type inside the handler:
```ts
if (type === 'repo') return repos.listRepos(...) + metadataVisibilityScope(viewer)
else                 return listAccessibleResources({ agentId: viewer, resourceType: type, ... })
```
Same approach for `map/resources/get`. The wire stays generic; the per-type asymmetry in scoping is an implementation detail the agent never sees.

**Why not unify first.** The unified path would need `listAccessibleResources` to grow `OR (resource_type='repo' AND json_extract(metadata, '$.visibility') IN ('hub_local','federated'))` plus per-call JSON evaluation cost on a hot path. Not worth it for two scoping models. Revisit if a third type ships with metadata-level visibility.

### RD10 — Dual response shapes: MAPResource on MAP wire, SyncableResourceWithMeta on REST

The MAP wire returns the standard `MAPResource` envelope (per the [MAP Resource Protocol](../protocol/map-resource-protocol-v1.md)): `{ id, type, name, status, owner_id, origin_hub_id, created_at, updated_at, metadata }`. The REST API returns the richer `SyncableResourceWithMeta` with owner profile, tags, subscriber count, and permissions — a superset for UI consumption.

**Why dual shapes.** The MAP wire needs to be lightweight and standard (upstream-candidate). The REST API serves the UI, which needs owner avatars, tag chips, and permission badges. Same underlying data, different projections for different consumers. Sidecar tools consume the MAP shape; the React frontend consumes the REST shape.

**`get` stays a separate method** rather than `list { filter: { id: ... } }`: distinct DAL helper (`getResourceWithMeta`), distinct `not-found` error code (-32004), and matches the REST split (`GET /resources` vs `GET /resources/:id`).

### RD8 — Environments federate identically to repos; secrets resolved per-hub at mount time

Environments compose repo + secret refs + sandbox config. Splitting **schema** (the composition) from **values** (the actual secret payload) makes federation tractable:

- Environment schema federates via the same `syncable_resources` pipeline. Peers see `{ repo: <canonical_url>, secrets: ['GITHUB_TOKEN', 'SENTRY_DSN'], sandbox: {...} }` — names, not values.
- Secret values resolved per-hub at mount time via each hub's local `agent-iam` broker.

**Default visibility.** `hub_local` (matches repos), explicit upgrade to `federated`. Conservative-by-default; aligns with the existing repo conventions.

**Failure mode.** Environments with secret refs not configured on the receiver hub fail at mount time with a clear error: `"hub <name> doesn't have secret 'GITHUB_TOKEN' configured"`. Runtime concern, not a federation one.

### RD11 — MAP Resource Protocol as upstream-candidate SDK primitive

The `map/resources/list` and `map/resources/get` surface is designed as a MAP SDK-level primitive, not an OpenHive-specific extension. The protocol defines: `MAPResource` envelope, `ResourceKindHandler` dispatch interface, type namespacing (`map/*` reserved, `x-<package>/*` for extensions), and capabilities advertisement (`capabilities.resources.kinds[]`).

OpenHive is the reference implementation. The protocol spec ([`docs/protocol/map-resource-protocol-v1.md`](../protocol/map-resource-protocol-v1.md)) is written to be extractable into the MAP SDK once it has run. Storage, access control, federation, and write operations are explicitly out of scope for the protocol — those are hub concerns.

**Why upstream.** Every MAP hub needs resource discovery — it's not OpenHive-specific. Standardizing the wire format and dispatch convention means agents speak one protocol regardless of which hub they connect to. Kind packages (agent-workspace, minimem, opentasks, etc.) export handler factories that any conforming hub can register.

### RD12 — Type namespacing: open strings with `map/*` reserved

Resource types are namespaced strings following the same convention as MAP method families. `map/*` is reserved for future MAP SDK-standardized types. Extensions use `x-<package>/*` (e.g., `x-workspace/repo`, `x-minimem/memory-bank`). Open type strings are supported on the wire — any string is valid. Namespacing is a convention enforced by documentation, not the protocol.

Each resource kind is owned by the package that defines its metadata shape: `x-workspace/*` by agent-workspace, `x-minimem/*` by minimem, `x-opentasks/*` by opentasks, `x-skill-tree/*` by skill-tree, `x-sessionlog/*` by sessionlog. OpenHive maps between internal short names (`repo`, `memory_bank`) and namespaced types at the protocol boundary.

### RD13 — Environment template metadata carries references, not values

Environment templates (CQ7) store composition references in metadata: repo canonical URLs, secret *names*, tool server names, provider names + version ranges. Never secret values, local paths, resolved handles, or runtime state.

This makes templates safe to federate (no credential leakage), useful for pre-flight checks ("do I have these secrets configured?"), and sufficient for dispatch routing ("does this env touch repo X?"). Each hub resolves values locally at activation time via its own agent-iam / vault / provider registry.

### RD14 — Environment template / instance split mirrors repo / workspace split

Environments follow the same two-tier model as repos (CQ6):

- **Template** (`syncable_resources` row, `resource_type='environment'`): static, discoverable, federable. The recipe.
- **Instance** (separate surface, local-only): bound to an agent, resolved paths, running processes, health state. The activation.

`map/resources/list` returns templates. Instance state lives on `x-workspace/environment.instances` (future Phase 5b). Templates federate; instances don't (RD1 applies — bindings/instances are local-only state).

---

## Still open (after RD pass)

These deliberately remain open for now — answering them isn't load-bearing for Phase 1 / 2 / 5.

1. **Live cross-hub bindings query** — RD1 deferred. Reconsider when real cross-hub coordination demands appear.
2. **`canStartWork` helper signature** — RD3 deferred. Wait for agent-usage patterns.
3. **Cross-hub dispatch protocol** — RD2 deferred. Needs its own design doc.
4. **Agent self-dispatch (Flow 2D)** — bigger lift than Phase 2's smart routing; orthogonal. Wait until Phase 2 is shipped + observed.
5. **Hub-brokered mount credentials** — Phase 5b territory; couples to `agent-iam`'s credential surface. Not blocking for repo-only mount.
6. **Environment instance storage model** — Phase 5b: new `environment_instances` table vs extending `workspaces` with `env_id` FK. Depends on whether instances are per-agent or per-swarm.
7. **Environment-kind extension methods** — `x-workspace/environment.instances`, `x-workspace/environment.activate` (if hub-mediated activation is needed beyond agent-local). Defer until Phase 5b usage patterns emerge.
8. **MAP SDK upstreaming timeline** — RD11 says "design to be extractable." Actual extraction depends on a second implementation appearing or the MAP SDK team accepting the proposal. No action until Phase 1a has run in production.
9. **Cross-kind dispatch routing** — Phase 5c layers `env_id` routing on top of `repo_id` routing. Open: should they compose (env preferred → repo fallback → role fallback) or should env routing subsume repo routing entirely? Lean: compose, since most dispatches won't carry `env_id` for a long time.

---

## Cross-references

- [`docs/protocol/map-resource-protocol-v1.md`](../protocol/map-resource-protocol-v1.md) — MAP Resource Protocol v1 spec (upstream candidate).
- [`src/map/CLAUDE.md`](../../src/map/CLAUDE.md) — "Repos and Workspaces" — hub-side architecture, four enforcement layers, federation flow, wiring foot-guns.
- [`references/agent-workspace/docs/design/repo-kind.md`](../../references/agent-workspace/docs/design/repo-kind.md) — package-side protocol contract.
- [`references/agent-workspace/docs/design/agent-integration.md`](../../references/agent-workspace/docs/design/agent-integration.md) — sidecar wire-up recipe.
- [`references/agent-workspace/docs/design/environment-kind.md`](../../references/agent-workspace/docs/design/environment-kind.md) — environment kind protocol design (manifest format, layers, provider interface).
