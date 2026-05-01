# Loadouts: Design

**Status:** Proposed — design locked, implementation pending.
**Date:** 2026-05-01
**Scope:** OpenHive's role as the source-of-truth and resolution layer for openteams team templates and loadouts. Agent-side wiring in claude-code-swarm to consume them via MAP. Compatibility with the existing skill-tree loadout flow.

---

## TL;DR

Today, OpenHive's loadout flow only covers **skill-tree loadouts** — curated bundles of skill-bank content. That's one piece of a larger primitive. **openteams loadouts** are role bundles that include skills *plus* MCP scope, capabilities, permissions, and prompt material — and openteams is already the consumed format on the swarm side.

The design **layers the two systems**:

- skill-tree continues to be the *skill compilation engine*.
- openteams is the *role-bundle declaration layer* — the unit of saving, sharing, and binding.
- OpenHive becomes the storage and resolution backend openteams was designed for.
- Agents (claude-code-swarm) consume hub-resolved templates over MAP — no HTTP awareness.

Hub-side HTTP endpoints exist only for the OpenHive UI. Agents fetch via MAP `resources/get` + `resources/list` and materialize locally using their existing openteams + skill-tree clients.

---

## Why now

The current LoadoutPanel is functional but MVP-shaped:

- Loadouts are ephemeral — compiled, never saved.
- Nothing downstream consumes them. Compile in UI, nothing reads it.
- Only covers skills; no MCP scope, capabilities, permissions, or prompt material.
- No multi-agent serving story.

Meanwhile, claude-code-swarm already runs openteams locally and consumes loadouts to produce `.claude/agents/*.md` files. That consumer exists; what's missing is OpenHive as the publishing/distribution backend openteams was designed to be slotted into (`LoadOptions.resolveExternalLoadout`, etc.).

This design closes the loop.

---

## The two layers

```
┌──────────────────────────────────────────────────────────────┐
│  openteams loadout (the role bundle)                         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ skills:        ← skill-tree compilation recipe         │  │
│  │ capabilities:  ← role capabilities                     │  │
│  │ mcp_servers:   ← per-role MCP scope                    │  │
│  │ permissions:   ← allow/deny/ask                        │  │
│  │ prompt_addendum: ← prompt material                     │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
              │
              │ skills field is a LoadoutCriteria
              ▼
┌──────────────────────────────────────────────────────────────┐
│  skill-tree compilation                                      │
│    profile / include / exclude / max_tokens / tagsAll        │
│      → SkillGraphServer.compile(criteria)                    │
│      → rendered system-prompt fragment + token estimate      │
└──────────────────────────────────────────────────────────────┘
```

**openteams loadout ⊃ skill-tree loadout.** A "named skill bundle" is just an openteams loadout with only a `skills:` field. Same primitive at every scale — no separate "saved skill loadout" concept needed.

The bridge between layers — `mergeOpenteamsSkillsIntoCriteria` in claude-code-swarm's `skilltree-client.mjs` — is already shipped, with a frozen `OPENTEAMS_BRIDGED_FIELDS` list and a schema-bridge test that locks the contract in.

---

## Resource model

Two new syncable resource types under OpenHive's existing resource framework.

### `team_template`

Authored team configuration. Direct mapping of openteams' `team.yaml` + sidecar files (`roles/*`, `loadouts/*`, `prompts/*`).

```ts
{
  resource_type: 'team_template',
  name: 'gsd',
  content: {
    manifest: TeamManifest,                       // openteams team.schema.json
    roles: Record<string, RoleDefinition>,        // unresolved
    loadouts: Record<string, LoadoutDefinition>,  // unresolved
    prompts: Record<string, string>               // role → markdown
  },
  metadata: {
    schemaVersion: 1,
    upstreamRef?: 'github:owner/repo#sha',        // when imported from git
    defaultSkillBankRef?: string                  // team-level fallback skill bank
  }
}
```

### `loadout`

A standalone openteams loadout, shareable across teams (matches `loadouts/<name>.yaml`).

```ts
{
  resource_type: 'loadout',
  name: 'security-auditor',
  content: LoadoutDefinition  // raw openteams shape, with `extends:` allowed
}
```

### Storage shape: authored, not pre-resolved

Templates and loadouts are stored as authored. `extends:` chains stay visible; a parent-loadout edit propagates to children on next read. The resolved form is computed on demand and cached by `(resourceId, contentHash)` — same eviction pattern as `getServingLayer()`.

### Why two types

A loadout is a reusable bundle. A team `extends:` loadouts the way roles `extends:` loadouts. Same as openteams' on-disk shape: `team.yaml` references files in `loadouts/`. Mirroring the file layout in the resource model keeps authoring intuitive and lets standalone loadouts be shared independently of any team.

---

## Resolution and materialization

Two operations, both stateless, hub-side:

### `resolveTeam(templateId) → ResolvedTemplate`

Loads the authored `team_template`, runs openteams' `TemplateLoader.loadAsync()` with hub-backed resolvers for `extends:` chains. Does **not** compile skills or resolve MCP refs — that's the materialization step.

### `materializeRoleLoadout(templateId, role) → MaterializedLoadout`

Builds on `resolveTeam`, then:

1. Compiles the role's `loadout.skills` config against its bound skill bank (via skill-tree).
2. Resolves MCP refs against the hub registry (graceful: unknown refs surface, never throw).
3. Returns a fully-baked artifact ready for prompt assembly or sub-agent generation.

```ts
interface MaterializedLoadout {
  capabilities: string[];
  mcpScope: NormalizedMcpScope[];
  mcpProviders: McpProviderSpec[];          // install specs (advisory)
  permissions: { allow: string[]; deny: string[]; ask: string[] };
  promptAddendum: string;
  skills: {
    rendered: string;                       // system-prompt fragment
    estimatedTokens: number;
    skillBankResourceId: string | null;
    skillBankVersion?: string;              // for drift detection
    items: Array<{ id: string; name: string; version: string }>;
  } | null;
  unresolvedRefs: Array<{ ref: string; reason: string }>;
  materializedAt: string;
}
```

### Where resolution happens

| Consumer | Resolves where |
|---|---|
| OpenHive UI | hub-side (UI has no skill-tree client) |
| Dispatch orchestrator (hub-internal) | hub-side (hub is the consumer) |
| claude-code-swarm at boot | **agent-side**, using its local openteams + skill-tree clients |
| Federated peer hub | publishing hive — materialized form crosses the wire |

For cross-hub `extends:` chains, the publishing hive resolves before federation. The receiving hive sees a fully-baked artifact.

### `skillBankRef` binding — consumer extension namespace

openteams' `SkillsConfig` describes *what* skills to compile (profile, include,
exclude, max_tokens). It does **not** describe *which skill bank* to compile
against — that's a runtime/storage concern owned by the consumer.

OpenHive's binding lives in the consumer extension namespace at the
**loadout level**, not on `SkillsConfig`:

```yaml
# loadouts/security-auditor.yaml
name: security-auditor
skills:
  profile: security-engineer
  include: [s1, s2]
  max_tokens: 4000
# Consumer-specific binding — OpenHive's convention:
openhive:
  skillBankRef: res_01HX...
# A different consumer can ride alongside without conflict:
claude_code:
  skillBankPath: ./.skilltree
```

This is supported by `LoadoutDefinition`'s `[key: string]: unknown` index
signature, which openteams stores verbatim and never interprets.

**Resolution order** (handled in `src/openteams/resolver.ts:readSkillBankRef`):

1. `loadout.openhive.skillBankRef` — authored on the loadout itself
2. `team_template.metadata.defaultSkillBankRef` — team-level fallback owned
   by OpenHive's resource model (outside openteams)
3. None → skill compilation is skipped (`MaterializedLoadout.skills` is `null`)

**Why outside `SkillsConfig`.** openteams stays neutral about runtime concerns.
Different consumers want different binding shapes (resource id vs. local path
vs. URI), and putting any of them on `SkillsConfig` would couple openteams'
core schema to a single consumer's storage model. Mirrors how the
`team_template.metadata.defaultSkillBankRef` was already kept outside the
openteams template manifest.

**Tradeoffs accepted:** authors don't get YAML-LSP autocomplete on the
`openhive.skillBankRef` key (since it's not in openteams' published JSON
Schema). The convention is documented here, in `readSkillBankRef`'s JSDoc,
and surfaced in OpenHive UI authoring tools.

---

## Distribution

No new fetch RPC for loadouts. Three primitives cover all cases:

### 1. Sync — for hub-to-hub federation

`team_template` and `loadout` resources flow over the existing mesh sync protocol like skills, sessions, and mail. Nothing new to build at the protocol level — register the two types as syncable and they're covered.

### 2. Dispatch payload — for hub-to-agent task hand-off

The orchestrator's prompt builder (`src/dispatch/prompt.ts`) calls `materializeRoleLoadout` when a spec/dispatch metadata carries a `loadout_ref` and embeds the rendered output in the prompt. The agent receives a prompt that already contains the curated skill bundle — no resolution needed agent-side.

### 3. MAP `resources/get` + `resources/list` — for agent-driven boot

The swarm isn't a sync peer (it connects to one hub via MAP, doesn't run a mesh). For the boot-time team resolution flow, claude-code-swarm calls a generic resource-read primitive over its existing MAP connection:

```
MAP method: resources/get
  request:  { id: string }
  response: SyncableResource

MAP method: resources/list
  request:  { type: ResourceType, name?: string, filter?: object }
  response: SyncableResource[]
```

These are **generic, not loadout-specific** — useful for skills, sessions, anything else the agent might need to read on demand. They mirror the bulk operations sync already uses, exposed in request-response shape over MAP.

The earlier challenge to loadout-specific RPCs holds: we don't add `skills/loadout.fetch`. We add `resources/get`, which is the same primitive sync uses, just wrapped for non-peer consumers.

---

## Agent-side wiring (claude-code-swarm)

The agent already has most of this:

- `template.mjs` calls `TemplateLoader.load()` (sync) — needs to move to `loadAsync()` for the hub path.
- `skilltree-client.mjs` already bridges openteams `loadout.skills` → skill-tree `LoadoutCriteria` via `mergeOpenteamsSkillsIntoCriteria`.
- `loadout-materializer.mjs` is a pure function over `ResolvedLoadout`. Hub vs file source doesn't matter to it.

Three new modules, ~150–250 LOC each:

```
src/hive-source.mjs       # MAP-backed resource fetcher with read-through cache
src/hive-resolver.mjs     # buildHiveResolvers(hiveSource) → openteams LoadOptions
src/hive-template.mjs     # loadHiveTeam: stage authored content → openteams loadAsync
```

### Module: `hive-source.mjs`

Single point of contact for hub data, scoped to one MAP connection.

```js
export function createHiveSource({ mapConnection, cacheDir, ttlMs = 5 * 60 * 1000 }) {
  const memCache = new Map();   // resourceId → { content, fetchedAt }

  async function getResource(id) {
    const hit = memCache.get(id);
    if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit.content;
    const result = await mapConnection.callExtension('resources/get', { id });
    memCache.set(id, { content: result, fetchedAt: Date.now() });
    persistCache(cacheDir, id, result);
    return result;
  }

  async function getResourceByName(type, name) {
    const list = await mapConnection.callExtension('resources/list', { type, name });
    return list[0] ? getResource(list[0].id) : null;
  }

  return { getResource, getResourceByName };
}
```

### Module: `hive-resolver.mjs`

Wires hive-source into openteams' `LoadOptions`:

```js
export function buildHiveResolvers(hiveSource) {
  return {
    resolveExternalLoadout: async (refOrName) => {
      const ldt = await hiveSource.getResourceByName('loadout', refOrName);
      return ldt?.content;
    },
    resolveExternalRole: async (name) => {
      // Optional — only if a `role` resource type is added later
      return undefined;
    },
  };
}
```

### Modified: `template.mjs:loadTeam`

```js
export async function loadTeam(templateRef, ctx = {}) {
  const hiveRef = parseHiveRef(templateRef);   // "hive://gsd" → "gsd", else null

  if (hiveRef && ctx.hiveSource) {
    return loadHiveTeam(hiveRef, ctx);
  }
  return loadLocalTeam(templateRef);   // existing sync path, unchanged
}

async function loadHiveTeam(name, { hiveSource }) {
  const tmpl = await hiveSource.getResourceByName('team_template', name);
  if (!tmpl) return { success: false, error: `hive template not found: ${name}` };

  // Stage authored content into a temp dir openteams' loader expects
  const stagingDir = path.join(TMP_DIR, 'hive-templates', name);
  await stageAuthoredToDir(tmpl.content, stagingDir);

  const ot = loadOpenteams();
  const resolved = await ot.TemplateLoader.loadAsync(
    stagingDir,
    buildHiveResolvers(hiveSource),
  );

  return finalizeTeam(resolved, name);  // existing artifact generation, unchanged
}
```

`stageAuthoredToDir` writes the resource's `content` field back into a directory layout openteams' file-based loader recognizes (`team.yaml`, `loadouts/*.yaml`, `prompts/*`). The downstream pipeline doesn't change.

### Skill-bank loading

skill-tree currently expects a local basePath. Two options for hub-bound configs:

- **Easy (ship-first):** prefetch skills via `hive-source.callList('skills', { skillBankRef })`, write to a temp dir, point the existing SkillBank at it.
- **Right (later):** implement a `HiveStorageAdapter` for skill-tree (sibling to `MemoryStorageAdapter`/`CachedStorageAdapter`). Reads through hive-source on demand. Smaller cache footprint.

Start with prefetch; promote when caching footprint matters.

### Config

```jsonc
// .swarm/claude-swarm/config.json
{
  "template": "gsd"               // local — existing behavior
}
// or
{
  "template": "hive://gsd",       // hub-bound
  "hive": {
    "skillBankRef": "res_01HX...",       // optional team-level default
    "resourceCacheTtlMs": 300000          // optional override
  }
}
```

### Boot flow with hive-bound template

```
1. SessionStart hook → bootstrap()
2. MAP sidecar starts; MAP connection becomes available
3. parseHiveRef(template) returns "gsd"
4. createHiveSource({ mapConnection })
5. loadTeam("hive://gsd", { hiveSource })
   ├── hiveSource.getResourceByName('team_template', 'gsd')
   ├── stageAuthoredToDir(tmpl.content, stagingDir)
   ├── ot.TemplateLoader.loadAsync(stagingDir, buildHiveResolvers(hiveSource))
   │   └── any extends: chains fetch via MAP
   └── finalizeTeam(resolved)
       ├── skilltree-client.compileAllRoleLoadouts(...)
       │   └── (prefetches skill bank locally if hub-bound)
       └── agent-generator.generateAllAgents(...)
           └── per-role .claude/agents/<team>-<role>.md written
6. /swarm coordinator spawns
```

**No HTTP awareness on the agent side.** All hub access flows through MAP via hive-source.

---

## Hub-side surface

### HTTP endpoints (UI only)

```
GET    /teams                                          # browse
GET    /teams/:id                                      # authored
GET    /teams/:id/roles/:role                          # ResolvedRole (preview)
POST   /teams/:id/roles/:role/loadout/materialize      # MaterializedLoadout (preview)
POST   /teams/:id                                       # create/update
DELETE /teams/:id

GET    /loadouts                                       # browse
GET    /loadouts/:id                                   # authored
POST   /loadouts/:id                                    # create/update
DELETE /loadouts/:id
POST   /loadouts/:id/materialize                       # MaterializedLoadout (preview)
```

These endpoints are **not on the agent path**. The implementation calls into `src/openteams/resolver.ts`, the same module dispatch uses internally — single code path for materialization.

### MAP methods

```
resources/get   { id }                                 → SyncableResource
resources/list  { type, name?, filter? }               → SyncableResource[]
```

Generic resource access. Authorized via the same ACL that gates REST. Used by claude-code-swarm and by future agent-driven consumers (e.g., a thin CLI tool reading hub state).

### Internal modules

```
src/openteams/
  resolver.ts          # resolveTeam, materializeRoleLoadout
  skill-bridge.ts      # compileSkillsForLoadout — calls SkillGraphServer
  mcp-bridge.ts        # resolveMcpRefs — registry + bundled refs
  types.ts             # MaterializedLoadout, openteams type re-exports
  events.ts            # emits team_template:changed, loadout:changed for sync + WS

src/db/dal/
  team-templates.ts    # CRUD for resource_type='team_template'
  loadouts.ts          # CRUD for resource_type='loadout'

src/api/routes/
  teams.ts             # HTTP routes (UI surface)
  loadouts.ts          # HTTP routes (UI surface)
  resources.ts         # MAP methods resources/get + resources/list
                       # (or wired into existing MAP handler module)
```

---

## MCP defaults — graceful degradation

Three layers of MCP knowledge, each consulted in order. Missing layers degrade rather than fail.

| Layer | Source | Authority | Failure mode |
|---|---|---|---|
| **Authored** | loadout `mcp_servers:` and team `mcp_providers:` | template author | n/a — declared content |
| **Registry** | hub-side ref resolution (`@openhive/secrets-scanner` → install spec) | hub | unknown ref → returned in `unresolvedRefs[]`, never throws |
| **Active set** | consumer detection: `plugin.json`, project `.mcp.json`, user `~/.claude/mcp.json` | runtime (claude-code-swarm) | declared but missing → SessionStart warning; not declared but installed → silently available |

### Behaviors

1. **Bare name** (`mcp_servers: [chrome-devtools]`) — scope-only declaration. Hub doesn't need install info; consumer's active-set detection figures out whether it's installed. If not, SessionStart warns; doesn't block.
2. **Symbolic ref** (`{ ref: '@openhive/secrets-scanner' }`) — hub registry attempts resolution. Three outcomes: resolved → install spec returned; bundled-known → install spec returned; unknown → goes into `unresolvedRefs[]`.
3. **Inline install spec** (`{ name, command, args }`) — pass through verbatim. Advisory; consumer chooses whether to honor.
4. **Already installed, untracked** — server isn't in any loadout or registry, but the consumer's `discoverActiveSet()` finds it. Just use it. We don't centrally track every installed MCP.

### Hub registry shape (v1)

A small bundled JSON file:

```
src/openteams/refs/builtin.json   # @openhive/* → McpProviderSpec
```

Promote to a `mcp_provider` resource type only if external authoring becomes a need.

```ts
// src/openteams/mcp-bridge.ts
export async function resolveMcpRefs(servers: McpServerEntry[]): Promise<{
  scope: NormalizedMcpScope[];
  providers: McpProviderSpec[];
  unresolvedRefs: Array<{ ref: string; reason: 'not-in-registry' | 'no-resolver' }>;
}>;
```

Surface, never throw. Consumer (claude-code-swarm) merges with active set, reports gaps via SessionStart hook.

---

## openteams modifications required

All additive, none breaking. Coordinated in tandem with the OpenHive resolver work.

### 1. Richer key for `resolveExternalLoadout`

Today: `(name: string) => Loadout | undefined`.
Loosen to: `(ref: { name: string; version?: string; source?: string } | string) => Loadout | undefined`.
Backwards-compat for plain strings. Enables version pinning (`extends: 'security-auditor@v3'`) and source routing.

### 2. `postProcessTemplate` hook

Per-role / per-loadout `postProcess*` exists. Add a top-level hook so the resolver can attach `unresolvedExtends`, `materializedAt`, `skillBankVersions[]`, and similar to `ResolvedTemplate`.

### 3. Surface "not found" without throwing

When `resolveExternalLoadout(name)` returns `undefined`, push the unresolved ref into `ResolvedTemplate.unresolvedExtends: string[]` rather than failing the load. Mirrors how MCP refs already degrade.

### 4. ~~First-class `skill_bank_ref` on `SkillsConfig`~~ — explicitly NOT done

An earlier draft of this design proposed adding `skill_bank_ref?: string` to
openteams' `SkillsConfig` as a "consumer-resolved hint." That change was
implemented (Slice 12.4) and then reverted on review.

**Decision:** the binding lives in the consumer extension namespace at the
loadout level (`loadout.openhive.skillBankRef`), not on `SkillsConfig`. See
the [`skillBankRef` binding](#skillbankref-binding---consumer-extension-namespace)
section above for the rationale and resolution order.

The remaining three modifications above (richer `resolveExternalLoadout`
ref shape, `postProcessTemplate`, surface unresolved extends) are still
worth shipping in a small openteams PR if/when authoring ergonomics or
cross-hub federation pressure them. They're not blockers for Milestone A.

---

## What this design replaces

| Concept (old) | Replacement |
|---|---|
| `metadata.savedLoadouts` on skill resource | `loadout` resource type (openteams shape, only `skills:` field for the same use case) |
| `skills/loadout.fetch` MAP RPC | `resources/get` MAP method (generic) |
| Per-resource skill loadout persistence in skill-tree | Authored openteams loadouts, stateless skill compilation on read |
| Hub-side per-loadout endpoints for agent consumption | MAP `resources/get` + agent-side resolution |

---

## Open questions and decisions

### Settled

| Question | Decision |
|---|---|
| Saved skill loadouts as a separate concept? | Drop. openteams loadouts subsume them. |
| Storage shape: pre-resolved or authored? | Authored. Cache resolved by `(id, contentHash)`. |
| Where to resolve cross-hub `extends:` chains? | Publishing hive. Materialized form crosses federation. |
| Loadout-specific MAP fetch RPCs? | Drop. Use generic `resources/get` + sync + dispatch carry. |
| HTTP endpoints required on agent path? | No. UI only. |
| MCP default: untracked-but-installed | Active-set detection by consumer; hub doesn't centrally track. |
| MCP default: missing declared | SessionStart warning, no block. |
| MCP registry shape v1 | Bundled JSON file under `src/openteams/refs/`; promote to resource type later. |

### Deferred

| Question | Default behavior | When to revisit |
|---|---|---|
| `mcp_provider` as resource type | Bundled JSON registry suffices | When external authoring needed |
| `HiveStorageAdapter` for skill-tree | Prefetch to local dir | When prefetch footprint matters |
| Versioning for `team_template` / `loadout` | Use the existing skill resource version model | Once federation use cases mature |
| Cross-hub `extends:` mid-resolution | Surface as `unresolvedExtends` if not federated | When cross-hub authoring is common |
| Swarm as full sync peer | MAP `resources/get` is enough | When offline-capable swarms become a requirement |

---

## Implementation slicing

Sized so each slice ships independently with a demo-able outcome.

### Hub side

1. **`team_template` + `loadout` resource types** — DAL, schema, basic CRUD routes, sync registration. ~2 days. *Distribution works.*
2. **`src/openteams/resolver.ts` + skill-bridge + mcp-bridge** — shared resolution code used by both UI and dispatch. ~1.5 days. *Materialization works.*
3. **MAP `resources/get` + `resources/list`** — generic resource access. ~0.5 day. *Agents can read hub state.*
4. **HTTP endpoints (UI surface)** — `GET /teams`, `/loadouts`, materialize previews. ~1 day. *UI authoring + browsing.*
5. **Dispatch integration** — orchestrator calls resolver to embed materialized loadout in prompt. ~0.5 day. *Hub-side consumption demo.*
6. **UI authoring pages** — teams browser, loadout authoring page. Larger, parallel.

### Agent side (claude-code-swarm)

7. **`hive-source.mjs` + tests** — pure resource fetcher with caching. ~0.5 day.
8. **`loadTeam` async + hive branch** — `parseHiveRef`, `stageAuthoredToDir`, `loadAsync` wiring. ~1 day.
9. **Skill-bank prefetch** for hive-bound configs. ~0.5 day. *Demo: swarm boots from hub.*
10. **Cache invalidation via `resource.changed`** subscription. ~0.5 day. Skippable for v1; TTL is fine.
11. **`HiveStorageAdapter` for skill-tree** — replaces step 9's prefetch. Future.

### openteams

12. **Schema and `LoadOptions` modifications** (1–4 above). ~0.5 day. Coordinated with #2.

### Suggested sequencing

Two natural milestones:

- **Milestone A** (after #1, #2, #3, #5): the hub can dispatch with curated loadouts. Hub-side end-to-end.
- **Milestone B** (after #7, #8, #9, #12): swarms boot from hub-published team configs. Agent-side end-to-end.

#4 (UI), #6 (UI authoring), and #10/#11 (caching upgrades) parallelize across both milestones.

---

## References

- `references/openteams/CLAUDE.md` — openteams architecture, `LoadOptions` hooks
- `references/openteams/schema/loadout.schema.json` — authored loadout schema
- `references/openteams/schema/team.schema.json` — team manifest schema
- `references/skill-tree/CLAUDE.md` — skill-tree architecture, `SkillGraphServer`
- `references/skill-tree/src/serving/types.ts` — `LoadoutCriteria`, `LoadoutSource`, `LoadoutState`
- `references/claude-code-swarm/docs/loadout-consumer-design.md` — claude-code-swarm consumer design (per-role AGENT.md, scope-check hook, MCP active-set detection)
- `references/claude-code-swarm/src/skilltree-client.mjs` — openteams ↔ skill-tree bridge (`mergeOpenteamsSkillsIntoCriteria`, `OPENTEAMS_BRIDGED_FIELDS`)
- `references/claude-code-swarm/src/loadout-materializer.mjs` — pure ResolvedLoadout → AGENT.md frontmatter materializer
- `src/api/routes/skill-management.ts` — current skill-tree loadout endpoints (this design preserves them; UI exploration tool)
- `src/dispatch/prompt.ts` — dispatch prompt builder (target for #5)
