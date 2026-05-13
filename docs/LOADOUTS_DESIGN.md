# Loadouts: Design

**Status:** Implemented — Milestones A + B shipped; structured-field propagation (skills, MCP trinity, permissions) wired end-to-end and live-asserted (2026-05-03).
**Date:** 2026-05-01 (design); 2026-05-03 (status update — incl. propagation channels + per-spawn permission enforcement)
**Scope:** OpenHive's role as the source-of-truth and resolution layer for openteams team templates and loadouts, used hub-side for dispatch prompt building and UI authoring. Compatibility with the existing skill-tree loadout flow.

**Out of scope:** any swarm-side fetch mechanism for templates or loadouts. The hub→swarm bridge is **dispatch carrying baked-in prompts**, not template distribution. Agent-side template consumption stays on openteams' existing install path (git clone → local disk → `TemplateLoader.load`); OpenHive is not in that path.

---

## Implementation status — 2026-05-03

The dispatch-driven flow (author → resolve → materialize → dispatch → agent receives → reply) is fully shipped and verified live against a real macro-agent worker. See `LOADOUTS_MILESTONE_A_PLAN.md` and `LOADOUTS_MILESTONE_B_PLAN.md` for slice-level state.

### Working today

- **Author**: `POST /api/v1/loadouts`, `POST /api/v1/teams` create resources owned by an agent. ACL gates read access via `canAccessResource`.
- **Resolve / materialize**: `materializeLoadoutById(id, viewerAgentId?)` and `materializeRoleLoadout(templateId, role, viewerAgentId?)` produce `MaterializedLoadout` with `promptAddendum` (camelCase from snake_case YAML), compiled `skills`, resolved MCP refs, permissions. Cached by `(templateId, contentHash)` with promise coalescing.
- **Dispatch enrichment**: `enrichWithLoadout` reads `spec_metadata.loadout_ref` (preferred) or `spec_metadata.team_role_ref`, materializes, attaches as `task.metadata.materializedLoadout`, **and registers the materialization in the loadout side-channel keyed by taskId**. Failures attach a `loadout_error` marker and broadcast a `dispatch.materialization_failed` event on `map:dispatches` rather than blocking dispatch.
- **Prompt builder**: `openHivePromptBuilder` embeds `loadout.skills.rendered` at the top, `loadout.promptAddendum` below the task body and above the role line, and an "Expected MCP servers for this role: …" advisory line above the addendum when `mcpProviders`/`mcpScope` is non-empty. Continuations skip loadout sections.
- **Loadout side-channel** (`src/dispatch/loadout-side-channel.ts`): module-level `Map<taskId, MaterializedLoadout>` with TTL bridges enrichment-time (where the loadout is known) to deliver-time (where the envelope is built). Needed because swarm-dispatch's `MessagePort.deliver(to, payload)` has a fixed payload shape with no metadata slot.
- **Envelope metadata injection**: `openhive-mail-port.injectLoadoutMetadata` wraps the transport's `sendToAgent`, looks up the materialized loadout from the side-channel by taskId, and injects `body.metadata.permissions` and `body.metadata.mcpProviders` before the wire send. Consumed-on-read so memory stays bounded.
- **Mail-routed delivery**: hub `forwardTurnToSwarms` writes to live WS + always-queues for retry; drain on `node_registered` (with 2s fallback timer); hub-side dedup by `turn_id` prevents queue growth.
- **Worker pickup (mail+fresh, macro-agent)**: `mail-bridge` translates hub `mail/turn.received` → local inbox; `mail-inbound-consumer` filters envelopes addressed to the sidecar, dedupes by taskId (1h TTL), reads `data.loadout` (or legacy `data.metadata`), spawns a fresh worker via `agentManager.spawn({ isolatedSettings: true, permissions, fullAutonomous: true })`, drives Claude with `promptUntilDone`, posts the worker's `done()` summary back via `mapSidecar.postMailTurn`.
- **Worker pickup (mail+reuse, macro-agent)**: `mail-inbound-reuse-consumer` filters envelopes addressed to **non-sidecar** agents (long-lived workers/coordinators), tracks `inflightDispatches` per agentId, drives the existing session via raw `agentManager.prompt(agentId, prompt)` (NOT `promptUntilDone` — that auto-terminates on `done()`, fatal for reuse), captures `args.summary` inline from the done() tool-call update, posts the summary back as a mail turn. Concurrent dispatches on a busy agent get rejected with `recipient_busy`; non-dispatch work (peer messages, user chat) does not block.
- **Worker MCP trinity** (macro-agent's `agentManager.spawn`): per-spawn entries always written for `agent-inbox` (via `dist/cli/inbox-mcp-proxy.js` → `InboxMcpProxy(socketPath, agentId)`) and `opentasks` (via the `opentasks mcp` CLI subcommand, conditional on daemon). Independent of `isolatedSettings: true` — the flag strips host-user plugins but preserves per-spawn config. This is what gives the worker `list_agents`, `check_inbox`, `task`, etc. without depending on host-level Claude plugins.
- **Worker permissions enforcement**: `agentManager.spawn` writes the loadout's permission rules to `agentMeta.claudeCode.options.settings.permissions` — an inline pass-through to Claude Agent SDK that triggers no `.claude/settings.json` file write. Concurrent spawns sharing a CWD don't collide. `deny` rules win over `permissionMode: "auto-approve"` (verified live). `ask` rules collapse based on `fullAutonomous`: `true` → `allow`, `false` → `deny` (autonomous workers shouldn't make judgment calls).
- **Reply path**: hub stores reply turn → `mail.turn.added` → dispatch initiator's listener captures it. Echo containment: bridge correctly drops the re-broadcast plain-text reply (no second worker spawn).
- **MAP SDK + openteams alignment**: openteams 0.3.0 in use (full `ResolvedRole.loadout` shape); agent-inbox 0.1.9 in macro-agent (exports `InboxMcpProxy`); MAP SDK's `BaseConnection` carries a `#streamGeneration` guard so a stale receive loop can't kill a freshly reconnected stream.

### Test coverage

- `src/__tests__/swarm/live-loadout-dispatch-e2e.test.ts` — 5/5 pass with real Claude API in ~25s. Four hard-asserted layers of evidence: (1) **delivery** — SENTINEL from `prompt_addendum` and `SKILL_MARKER_WIDGET_99` from the rendered skill catalog both appear in the delivered envelope's prompt body; (2) **skill consumption** — `SKILL_MARKER_WIDGET_99` appears in the agent's reply because the marker skill's description carries an embedded self-instruction the agent followed; (3) **MCP actually invoked** — `AGENT_COUNT=N` with `N > 0` in the reply, proving the loadout-declared MCP (`agent-inbox.list_agents`) was executable on the spawned worker; (4) **permissions enforced** — `PERM_DENIED=true` in the reply, proving the loadout's deny rule (`Bash(echo perm-deny-test:*)`) actually blocked a tool call on the spawned worker. Each of these layers caught a real wiring gap on first verification: agent-inbox wasn't mounted on mail-inbound workers (fixed); permissions weren't propagated past materialization (fixed). The test continues to serve as a regression guard against future spawn changes that would silently drop the structured loadout fields.
- `src/__tests__/openteams/skill-bank-ref.test.ts` — 4/4 fast lock-in tests covering `loadout.openhive.skillBankRef` resolution: loadout-level ref wins, team-level `defaultSkillBankRef` fallback, loadout overrides team default, missing-bank-id degrades to `skills:null`. Fires immediately on any openteams version bump that drops the consumer extension namespace.
- `src/__tests__/helpers/skill-bank-fixture.ts` — shared `createTestSkillBank()` + `MARKER_SKILL` + `SKILL_MARKER` helpers used by the lock-in test and the live e2e.
- `src/__tests__/swarm/full-stack-loadout-prompt-receipt.test.ts` — 7/7 pass under `FULL_STACK_E2E=true`. Asserts dispatch exercises real materialization against a real DB with a real macro-agent process.
- `src/__tests__/mail/forward-retry.test.ts` — 6/6 covering live happy path, dedup, stale → drain on reconnect, fallback timer, mismatched-swarm filter, skip-self.
- `src/__tests__/integrations/dispatch-mail-routing.test.ts`, `dispatch-multi-turn.test.ts`, `dispatch-source-prompt.test.ts`, `loadout-author-to-dispatch.test.ts`, `loadout-authorization.test.ts`, `loadout-concurrency.test.ts`, `loadout-update-propagation.test.ts`, `openteams-roundtrip.test.ts`, `skill-bridge-on-disk.test.ts` — hub-side flow segments.
- `references/macro-agent/src/dispatch/__tests__/mail-inbound-consumer.test.ts` (14/14) — failure-mode coverage: spawn rejecting, missing `_lastSummary`, missing `conversationId`, dedup TTL expiry, malformed-envelope counter via `consumer.stats()`, `_lastSummary` cleared after `postMailTurn`.
- `references/macro-agent/src/dispatch/__tests__/mail-inbound-consumer.integration.test.ts` (5/5) — bridge↔consumer composition; echo-loop containment (plain-text + JSON-shaped non-dispatch schema); `type: "data"` regression guard.

### Known limitations

| Area | State | Notes |
|---|---|---|
| `extends` chains across owners | Designed; not live-tested | Same-owner chains work via openteams 0.3.0's `resolveExternalLoadout`; cross-owner chains have no live coverage. |
| Cache invalidation mid-dispatch | Designed; race exists | `(templateId, contentHash)` keying invalidates on edit, but in-flight orchestrator state could race with a loadout edit during dispatch. No test asserts propagation. |
| Loadout-provided MCP servers | Phase 0 + macro-agent trinity wiring shipped (2026-05-03); Phase 1 scope-filter + Phase 2 install-spec delivery still deferred | Hub does not install MCPs on workers — that's the operator's responsibility on the macro-agent host. The loadout's `mcp_servers` and `mcp_scope` are advisory: the prompt builder appends "Expected MCP servers for this role: …". **Resolved live (2026-05-03):** an earlier verification pass found that even built-in MCPs like `agent-inbox` and `opentasks` were not being mounted on mail-inbound spawned workers (`parent: null` + `isolatedSettings: true`) — the architecture docs claimed they were, but `agentManager.spawn` only mounted the macro-agent MCP server. Fixed in macro-agent: `agentManager.spawn` now always writes per-spawn entries for `agent-inbox` (via `dist/cli/inbox-mcp-proxy.js` → `InboxMcpProxy(socketPath, agentId)`) and `opentasks` (via the `opentasks mcp` CLI subcommand), independent of `isolatedSettings`. Live test now confirms `list_agents` returns real data. Phase 1 (hub-side scope filter that narrows the worker's MCP set per loadout) and Phase 2 (delivering loadout-authored inline install specs) remain deferred. See "MCP defaults" section for the operator-provisioned trust model. |
| Loadout `skills.rendered` at runtime | Live-tested end-to-end (2026-05-03) | `live-loadout-dispatch-e2e.test.ts` binds a real test skill bank via `loadout.openhive.skillBankRef`; asserts the rendered skill catalog (with marker `SKILL_MARKER_WIDGET_99`) appears in the delivered prompt body and macro-agent's reply. Lock-in unit test at `src/__tests__/openteams/skill-bank-ref.test.ts` covers the resolution chain (loadout-level ref / team-default fallback / loadout-overrides-team / missing-bank-graceful-null). |
| Permission propagation | Shipped end-to-end (2026-05-03); fullAutonomous flag controls `ask` resolution | Loadout `permissions.{allow, deny, ask}` ride from hub-side materialization → openhive-mail-port side-channel → envelope `body.metadata.permissions` → mail-inbound-consumer → `agentManager.spawn({ permissions, fullAutonomous: true })` → `agentMeta.claudeCode.options.settings.permissions`. Verified live: deny rules block tool calls even under `permissionMode: "auto-approve"`. **`fullAutonomous` semantics** (new spawn option): when `true`, `ask` rules collapse to `allow` (autonomous worker proceeds without human); when `false` (default), `ask` rules collapse to `deny` (safe — autonomous workers don't make judgment calls). Mail-inbound consumer sets `fullAutonomous: true` because no human is in the loop. Inline-via-SDK delivery (no `.claude/settings.json` written), so concurrent spawns sharing a CWD never collide. |
| UI authoring | REST surface works; UI exists | React routes for the Loadouts page work against the same endpoints. No Playwright/visual coverage. |
| Federation | Loadouts sync; cross-instance dispatch untested | Mesh sync treats loadouts as syncable resources. No test pushes a loadout cross-instance and dispatches against the federated copy. |
| Versioning / pinning | Not implemented | Dispatches always materialize the latest contentHash; no surface for "use loadout X at version Y". |
| Hierarchical role loadouts | Out of scope | Children spawned via the `spawn_agent` MCP tool inherit parent runtime context, not a per-role loadout. The mail-inbound consumer always spawns parentless workers. |
| Loadout audit log | Not implemented | `materializedLoadout` lives in in-memory task metadata, not persisted to the dispatch row. |

---

## TL;DR

Today, OpenHive's loadout flow only covers **skill-tree loadouts** — curated bundles of skill-bank content. That's one piece of a larger primitive. **openteams loadouts** are role bundles that include skills *plus* MCP scope, capabilities, permissions, and prompt material — and openteams is already the consumed format on the swarm side.

The design **layers the two systems**:

- skill-tree continues to be the *skill compilation engine*.
- openteams is the *role-bundle declaration layer* — the unit of saving, sharing, and binding.
- OpenHive becomes the storage and resolution backend openteams was designed for, **for hub-side flows only**.
- The hub→swarm bridge is **dispatch with materialized loadouts baked into the prompt**. No template fetch on the swarm side; no new MAP wire surface for templates/loadouts.

Hub-side HTTP endpoints exist only for the OpenHive UI. The materialized loadout — capabilities, MCP scope, permissions, rendered skill bundle, prompt addendum — travels with the dispatched task in its prompt body. Agents execute the prompt; they don't need to know which team it came from or where it was authored.

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

### 3. Swarm-side template loading — outside OpenHive's purview

For "boot a swarm with team X" use cases (no dispatch, just team setup),
**OpenHive is not in the path**. Templates are authored content distributed
via openteams' existing mechanism: clone from a git repo into
`.openteams/templates/<name>/`, then `TemplateLoader.load("<name>")`.

```
User authors template → publishes to a git remote
                      → openteams template install <git-url>
                      → cc-swarm: TemplateLoader.load(<name>)
```

OpenHive may *also* store an authored copy (for hub-side dispatch + UI),
and could later grow a "publish authored content to a git remote" feature
so users get integrated authoring + distribution. But that's an
optional convenience, not a wire requirement. The swarm doesn't fetch
from OpenHive directly.

**No MAP methods for templates or loadouts.** Earlier drafts proposed
generic `resources/get` and then per-domain `openteams/template.get` —
both rejected. Reasoning:

- The hub→swarm bridge that *actually matters* is dispatch (§2 above).
  It carries fully-baked prompts, so the swarm needs nothing else.
- For non-dispatch boots, openteams' install path already exists.
  Adding a parallel MAP fetcher duplicates a working mechanism.
- HTTP from the swarm side is off the table (one of the design
  principles); MAP methods solved that, but at the cost of a new wire
  surface OpenHive shouldn't own.

If/when a real use case for *live* swarm-side fetch appears (it hasn't
yet), it would belong in openteams as a registered source — not in
OpenHive's MAP server.

---

## Propagation channels for materialized fields

The single `MaterializedLoadout` is produced once at the hub and fans out to
the worker over **three distinct channels**, picked per-field by what the
data is and how it must be consumed. There is no one-size-fits-all path.

| Field | Channel | Where it lands on the worker |
|---|---|---|
| `promptAddendum` | Text in prompt body | Agent's system prompt context |
| `skills.rendered` | Text in prompt body (top) | Agent's system prompt context |
| `mcp_servers` (advisory) | Text in prompt body (advisory hint) | Agent reads as context only |
| `mcp_servers` (trinity: agent-inbox, opentasks) | Operator-provisioned at macro-agent install | Spawn-time `.mcp.json` written by `agentManager.spawn` |
| `permissions.{allow, deny, ask}` | `body.loadout.permissions` (mail) / `dispatch/spawn-agent` params (ACP+fresh) | `agentMeta.claudeCode.options.settings.permissions` (inline SDK pass-through) |
| `mcpProviders` (resolved install specs) | `body.loadout.mcpProviders` (mail) / `dispatch/spawn-agent` params (ACP+fresh) | Currently unused; reserved for Phase 1/2 work |

### Dispatch lifecycle matrix

The orchestrator picks both a **transport** (mail vs ACP) and a
**lifecycle** (fresh-spawn vs reuse-existing) per dispatch. Both axes are
controlled by per-dispatch DB columns (V47 `acp_lifecycle`, V48
`mail_lifecycle`) with cluster-wide defaults
(`config.dispatch.acp_lifecycle_default`,
`config.dispatch.mail_lifecycle_default`, both default `'reuse'`).

| | Spawn fresh | Reuse existing |
|---|---|---|
| **Mail** | `mail_lifecycle: 'fresh'` — hub mail port overrides routing to the connection's sidecar; sidecar's `mail-inbound-consumer` spawns a new ephemeral worker per envelope. Loadout permissions enforced at spawn time. | `mail_lifecycle: 'reuse'` (default) — `prefer-route` picks a non-busy long-lived worker; `mail-inbound-reuse-consumer` drives the existing session and posts the summary back. Loadout permissions advisory (existing session has its own rules). Falls back to the sidecar (and fresh-spawn) when the roster has no non-busy match. |
| **ACP** | `acp_lifecycle: 'fresh'` — runtime adapter calls `dispatch/spawn-agent` notification-pair RPC; macro-agent's handler spawns a fresh coordinator with the loadout applied. Loadout permissions enforced at spawn time. | `acp_lifecycle: 'reuse'` (default) — runtime adapter resolves the target via `findAcpAgentInfo` (an existing ACP-capable agent on the swarm). Loadout permissions advisory. |

**Reuse semantics for both transports**: the existing agent's session was
created earlier with whatever rules it had then; the dispatch's loadout
informs the prompt body (skills, addendum) but cannot retroactively change
permissions. This is documented as a known limitation, not a bug —
operators choose `'fresh'` when they need strict permission enforcement.

**Mid-task reject**: mail+reuse rejects a second dispatch on an
already-busy agent with `recipient_busy` only when the agent is processing
a **tracked dispatch**. Non-dispatch work (peer messages, user chat,
team-internal coordination) does not gate; those stack naturally via the
session's serial prompt loop.

**Fresh-route override (mail)**: when `mail_lifecycle: 'fresh'` is set, the
hub mail port (`openhive-mail-port.send`) reads the side-channel hint and
overrides `executor.to.agentId` to the sidecar id (`findSidecarAgentId`).
This bypasses any long-lived worker the roster might have picked. Falls
through silently when no sidecar is registered or the picked agent already
IS the sidecar.

### Channel 1 — text in the prompt body

Used for content the agent reads as part of its system prompt context: the
addendum, the rendered skill catalog, and the advisory MCP-expectation hint.
Built by `openHivePromptBuilder` in `src/dispatch/prompt.ts`. Section
ordering is fixed:

```
[skills.rendered]            — system-prompt fragment, top of prompt
[task.content / title]
[acceptance criteria]
[relevant files]
[promptHints.additionalContext]
[Expected MCP servers: …]    — advisory hint when mcp_servers is non-empty
[promptAddendum]             — role-specific addendum
[role line]                  — "Role: <role>"
```

Continuation/retry prompts deliberately skip the loadout sections — the
agent already loaded them on turn 0.

### Channel 2 — `loadout` as a first-class wire concept

Structured loadout fields (permissions, MCP refs, capabilities) need to
reach the worker as JSON, not as text in the prompt body. Both wire
channels — the mail envelope's `body` and the `dispatch/spawn-agent` MAP
method's request params — carry a single named slot called `loadout`,
holding the same `MaterializedLoadout`-shaped payload:

```jsonc
// MaterializedLoadout subset, used as the canonical wire shape on both routes
{
  "permissions": { "allow": [...], "deny": [...], "ask": [...] },
  "mcpProviders": [...],
  "mcpScope": [...],
  "capabilities": [...]
  // skills.rendered + promptAddendum ride in prompt body for both routes
}
```

**Why a single shape across routes**: each runtime that participates in
dispatch implements its own translator from `MaterializedLoadout` to its
native config (in macro-agent: `loadoutToSpawnOptions` in
`src/dispatch/loadout-translation.ts`). The hub doesn't need to know
runtime-specific spawn options — it just packs the loadout. New runtimes
(beyond macro-agent) implement their own translator, no protocol changes.

Hub-side, the loadout is staged in a module-level cache keyed by taskId
(`src/dispatch/loadout-side-channel.ts`) at enrichment time, then consumed
by whichever wire path the orchestrator chooses (mail port for mail-routed,
runtime adapter for ACP-routed). This bridges the gap caused by
`swarm-dispatch.MessagePort.deliver`'s fixed payload shape.

#### Mail wire

The mail envelope packs the loadout as `body.loadout`:

```jsonc
{
  "type": "x-dispatch/work",
  "body": {
    "prompt": "...",
    "taskId": "disp_...",
    "role": "executor",
    "loadout": { /* MaterializedLoadout subset */ }
  }
}
```

The hub also writes legacy `body.metadata.permissions/mcpProviders` for one
deprecation cycle so older mail-inbound consumers keep working. The
mail-inbound-consumer on the swarm side reads `body.loadout` first, falling
back to the legacy fields only when the new slot is absent.

#### ACP wire

The orchestrator's runtime adapter calls a per-runtime MAP method when
`lifecycle === 'fresh'`, passing the loadout in the request:

```jsonc
{
  "method": "dispatch/spawn-agent",
  "params": {
    "role": "coordinator",
    "cwd": "/path/to/cwd",
    "capabilities_required": ["acp"],
    "lifecycle": "fresh",
    "loadout": { /* same shape as mail's body.loadout */ }
  }
}
```

The runtime returns `{ agentId }` once the agent is spawned and its
capabilities are registered with the hub (so subsequent `findAcpAgentInfo`
finds it). For `lifecycle === 'reuse'`, the orchestrator skips the MAP call
and uses an existing ACP-capable agent's id directly — but in that case,
loadout permissions are advisory (the existing agent's session was created
with whatever rules it had then). The mail-route mirror of this advisory-
permissions caveat applies to `mail_lifecycle: 'reuse'` as well; see the
"Dispatch lifecycle matrix" table above.

### Channel 3 — operator-provisioned (no wire involvement)

The MCP "trinity" — `agent-inbox`, `opentasks`, and macro-agent's own
built-in MCP server — is mounted on every spawned worker by
`agentManager.spawn` itself, as a per-spawn `.mcp.json` written
independently of `isolatedSettings: true`. Operators get these for free by
running macro-agent at all; loadouts don't need to declare them.

The trust model is symmetric:
- **Trinity**: trusted because the operator chose to install macro-agent.
- **Loadout-declared `mcp_servers`**: advisory only (Phase 0). Loadout
  authors can declare expectations; operators decide whether to satisfy
  them.
- **Loadout-declared install specs**: deferred (Phase 2). Would require a
  trust model for arbitrary `command + args` from authored content.

### Why three channels, not one

Each channel is shaped by the data it carries:

- **Text** is sufficient for content the agent just needs to see. Cheap to
  add, cheap to consume.
- **Sidechannel + inline SDK pass-through** is the only way to deliver
  structured runtime config (permissions) without writing files that would
  collide between concurrent spawns sharing a CWD.
- **Operator-provisioned** keeps install decisions out of the hub→worker
  wire entirely, eliminating the "loadout authors can run arbitrary code on
  workers" attack surface.

The verification strategy mirrors this: each channel has a marker in the
agent's reply that proves end-to-end delivery worked (see "Test coverage"
above).

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

### MAP wire surface

**No new MAP namespace for templates or loadouts.** The hub→swarm
content path is **dispatch with materialized prompts** (covered in the
Distribution section above). The existing MAP namespaces (`map/tasks/*`,
`mail/*`, `trajectory/*`, `opentasks/*`) carry the dispatch event;
materialized loadout content rides along inside the prompt body.

### Internal modules

```
src/openteams/
  resolver.ts          # resolveTeam, materializeRoleLoadout, materializeLoadoutById
  skill-bridge.ts      # compileSkillsForLoadout — calls SkillGraphServer
  mcp-bridge.ts        # resolveMcpRefs — registry + bundled refs
  types.ts             # MaterializedLoadout, openteams type re-exports
  cache.ts             # (templateId, contentHash) → ResolvedTemplate cache
  refs/builtin.json    # bundled @openhive/* MCP ref → install spec map

src/db/dal/
  team-templates.ts    # CRUD for resource_type='team_template'
  loadouts.ts          # CRUD for resource_type='loadout'

src/api/routes/
  teams.ts             # HTTP routes (UI surface) — CRUD + materialize
  loadouts.ts          # HTTP routes (UI surface) — CRUD + materialize

src/dispatch/
  openhive-source.ts          # enrichWithLoadout: materializes + registers in side-channel
  prompt.ts                   # embeds skills.rendered + addendum + MCP advisory hint
  loadout-side-channel.ts     # taskId → MaterializedLoadout map (TTL, consume-on-read)
                              #   bridges enrichment-time → deliver-time for structured fields
                              #   that can't ride in swarm-dispatch's fixed deliver payload
  openhive-mail-port.ts       # injectLoadoutMetadata wraps transport: pulls from side-channel,
                              #   adds body.metadata.{permissions, mcpProviders} before send
```

Worker-side files (in `references/macro-agent/`):

```
src/agent/agent-manager-v2.ts
  - SpawnAgentOptions.permissions, .fullAutonomous added
  - spawn() always mounts the trinity: agent-inbox + opentasks (+ macro-agent built-in)
  - spawn() writes loadout permissions to agentMeta.claudeCode.options.settings.permissions
    (inline pass-through to Claude Agent SDK; no .claude/settings.json file)
  - `ask` rule resolution: fullAutonomous=true → allow, fullAutonomous=false → deny

src/cli/inbox-mcp-proxy.ts
  - Tiny stdio entry. Instantiates InboxMcpProxy(INBOX_SOCKET_PATH, MACRO_AGENT_ID),
    starts via stdio. Mounted as the "agent-inbox" MCP server in every spawn.

src/dispatch/mail-inbound-consumer.ts
  - Reads data.metadata.permissions from the envelope
  - Passes to spawn({ permissions, fullAutonomous: true }) — autonomous mail-inbound
    workers have no human in the loop, so `ask` collapses to `allow`
```

---

## Failure modes

### Loadout materialization failure

When `enrichWithLoadout` (in `src/dispatch/openhive-source.ts`) cannot resolve a
`loadout_ref` or `team_role_ref` — for example, a typo'd `extends:` chain, a
deleted loadout, or a non-existent team template id — it follows a best-effort
strategy:

1. **Dispatch proceeds** with the unenriched prompt (no skill bundle, no prompt
   addendum). The agent still receives the spec body; it just lacks the loadout
   overlay.
2. **Operator signal** — a `dispatch.materialization_failed` event is broadcast
   on the `map:dispatches` WebSocket channel carrying `{ dispatch_id, error }`.
   Subscribers (UI, monitoring) see the failure immediately.
3. **`console.warn`** at the catch site so the hub log captures the failure even
   when no WS subscriber is connected.
4. **`loadout_error`** is attached to the in-memory `DispatchTask.metadata` so
   downstream consumers (prompt builder, tests) can detect the degraded state.
   This field is not persisted to the `dispatches` DB row.

**Why not fail the dispatch?** The "best-effort, never block" principle is
deliberate — a misconfigured loadout should not silently kill an otherwise valid
spec dispatch. The operator signal (WS event + warn log) surfaces the
configuration error so it can be fixed without losing work.

### listInProgress — enrichment intentionally skipped

`listInProgress` is called once at orchestrator startup to reconstruct the
in-memory tracker for dispatches that were `running` when the hub restarted.
`reconstructFromTasks()` only reads `id`, `claimed_by`, `metadata.attempt`,
`metadata.role`, `tags`, and `metadata.dimensions` — none of which come from
loadout enrichment.

Enrichment is **not** applied to `listInProgress` results. The orchestrator
always re-enriches via `getTask()` (which calls `enrichContent`) before building
any retry or continuation prompt, so the asymmetry has no correctness impact.
Adding enrichment here would cause unnecessary spec fetches and resolver calls
on every hub restart, with zero benefit.

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
| `skills/loadout.fetch` MAP RPC (earlier draft) | Dropped. Hub→swarm content rides inside dispatch prompts (§Distribution); non-dispatch boot uses openteams' standard install path. |
| Generic `resources/get` / `resources/list` MAP methods (earlier draft) | Dropped. Would leak OpenHive's resource-model shape onto the wire. |
| Per-domain `openteams/template.*` + `openteams/loadout.*` MAP methods (earlier draft) | Dropped. Inventing a fetcher when openteams' install path already does the job; HTTP from the swarm side is also off the table per the no-HTTP-awareness principle. |
| Per-resource skill loadout persistence in skill-tree | Authored openteams loadouts, stateless skill compilation on read |
| Hub-side per-loadout endpoints for agent consumption | Dispatch carries materialized loadout in the prompt body. UI-only HTTP endpoints handle authoring + preview. |

---

## Open questions and decisions

### Settled

| Question | Decision |
|---|---|
| Saved skill loadouts as a separate concept? | Drop. openteams loadouts subsume them. |
| Storage shape: pre-resolved or authored? | Authored. Cache resolved by `(id, contentHash)`. |
| Where to resolve cross-hub `extends:` chains? | Publishing hive. Materialized form crosses federation. |
| MAP wire surface for templates/loadouts? | None. Hub→swarm content travels via dispatch prompts. Swarm-side template loading uses openteams' existing install path (git → local disk → `TemplateLoader.load`). |
| HTTP endpoints required on agent path? | No. UI only. |
| MCP default: untracked-but-installed | Active-set detection by consumer; hub doesn't centrally track. |
| MCP default: missing declared | SessionStart warning, no block. |
| MCP registry shape v1 | Bundled JSON file under `src/openteams/refs/`; promote to resource type later. |
| `skill_bank_ref` location | Consumer extension namespace (`loadout.openhive.skillBankRef`), not on openteams' `SkillsConfig`. |

### Deferred

| Question | Default behavior | When to revisit |
|---|---|---|
| `mcp_provider` as resource type | Bundled JSON registry suffices | When external authoring needed |
| Hub publishes authored content to a git remote | Out of scope; users manage their own template git repos | When integrated authoring + distribution is needed |
| openteams `bake`/freeze step (resolve + serialize self-contained) | Not needed (dispatch flattens internally; openteams doesn't need a publish step yet) | If/when openteams gains a publish workflow |
| Versioning for `team_template` / `loadout` | Use the existing skill resource version model | Once federation use cases mature |
| Cross-hub `extends:` mid-resolution | Surface as `unresolvedExtends` if not federated | When cross-hub authoring is common |
| Live swarm-side template fetch | Skip — dispatch covers the realtime use case; install path covers boot | If a real use case appears that neither covers |

---

## Implementation slicing

Sized so each slice ships independently with a demo-able outcome.

### Hub side (Milestone A — shipped)

1. **`team_template` + `loadout` resource types** — DAL, schema, basic CRUD routes, sync registration. *Distribution works.*
2. **`src/openteams/resolver.ts` + skill-bridge + mcp-bridge** — shared resolution code used by both UI and dispatch. *Materialization works.*
3. **HTTP endpoints (UI surface)** — `GET /teams`, `/loadouts`, materialize previews. *UI authoring + browsing.*
4. **Dispatch integration** — orchestrator calls resolver to embed materialized loadout in prompt. *Hub-side consumption demo.*

### Verification (Milestone B — current)

5. **End-to-end author-to-dispatch tests** — author content via DAL/REST → enrich dispatch task → assert prompt embeds skills + addendum. Variants: `team_role_ref` and `loadout_ref`.
6. **Update propagation tests** — edit content → next materialize call sees the update. Catches cache-invalidation regressions.
7. **openteams round-trip test** — author via OpenHive → stage to tmpdir → openteams' `TemplateLoader.loadAsync` parses it correctly. Catches drift between OpenHive storage and openteams loader.
8. **Full-stack hub→macro-agent test** — gated on `FULL_STACK_E2E=true`. Real OpenHive + OpenSwarm + macro-agent. Asserts the materialized loadout's distinctive markers reach the live agent's prompt.

### Future (out of scope here)

- UI authoring pages (teams browser, loadout authoring) — surfaced after Milestone B verifies the foundation.
- Hub publishes authored content to a git remote — only if integrated distribution becomes a real ask.
- openteams modifications (richer `resolveExternalLoadout` ref shape, `postProcessTemplate`, `unresolvedExtends`) — when authoring ergonomics or cross-hub federation pressure them.

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
