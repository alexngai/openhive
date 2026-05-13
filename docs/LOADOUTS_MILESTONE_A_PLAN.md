# Loadouts — Milestone A Implementation Plan

**Status:** Shipped (2026-05-02). All slices landed; Milestone B closed the verification loop.
**Goal:** Hub-side end-to-end. When this milestone lands, OpenHive can store openteams team templates and loadouts as resources, resolve and materialize them into curated bundles (skills + MCP scope + permissions + capabilities + prompt material), and dispatch can embed a materialized loadout into the boot prompt of an agent picking up a spec.

**Companion:** [`LOADOUTS_DESIGN.md`](./LOADOUTS_DESIGN.md) — design rationale and full architecture context.

**Slices in this milestone:** 1, 2, 3, 5 from the design doc, plus a small openteams modification (slice 12) coordinated alongside slice 2.

---

## Slice status — 2026-05-03

| Slice | Status | Notes |
|---|---|---|
| 1 — resource types + DAL + CRUD | ✅ Shipped | `team_template` and `loadout` resource_types added; routes at `POST /api/v1/teams`, `POST /api/v1/loadouts`. Owner ACL via `canAccessResource`. |
| 2 — openteams resolver bridge | ✅ Shipped | `src/openteams/resolver.ts` with `resolveTeam`, `materializeRoleLoadout`, `materializeLoadoutById`, `stageTemplate`. `resolveExternalLoadout` hook routes through hub-stored loadouts. |
| 3 — MAP `resources/get` + `resources/list` | ⚠️ Dropped on review | Per `LOADOUTS_DESIGN.md` "What this design replaces" — agent-side fetch was rejected. Distribution is dispatch-only. |
| 5 — dispatch enrichment + prompt builder | ✅ Shipped | `enrichWithLoadout` in `src/dispatch/openhive-source.ts`; `openHivePromptBuilder` in `src/dispatch/prompt.ts`. WS broadcast on materialization failure. |
| 12 — openteams 0.3.0 (loadout schema + resolver hooks) | ✅ Shipped | Published. `ResolvedRole.loadout` carries the merged loadout; `resolved.loadouts` map exists; snake_case → camelCase mapping for `prompt_addendum` etc. |

### Test coverage delivered alongside Milestone A

- `src/__tests__/dispatch/loadout-prompt.test.ts` — prompt-builder + materialized-loadout integration (6 tests).
- `src/__tests__/dispatch/openhive-source.test.ts` — `enrichWithLoadout` + `enrichWithSpec` semantics.
- `src/__tests__/dal/team-templates-loadouts.test.ts` — DAL pattern.
- `src/__tests__/integrations/loadout-author-to-dispatch.test.ts` — author REST → dispatch enrichment chain.
- `src/__tests__/integrations/loadout-authorization.test.ts` — `canAccessResource` ACL on materialization.
- `src/__tests__/integrations/loadout-concurrency.test.ts` — promise coalescing on concurrent materialize.
- `src/__tests__/integrations/loadout-update-propagation.test.ts` — `(id, contentHash)` cache invalidation.
- `src/__tests__/integrations/openteams-roundtrip.test.ts` — `stageTemplate` round-trips through openteams' `TemplateLoader`.
- `src/__tests__/integrations/skill-bridge-on-disk.test.ts` — `compileSkillsForLoadout` with the real skill-tree compiler.

---

## Dependencies & order

```
                     ┌───────────────────────────┐
                     │ Slice 1                   │
                     │ resource types +          │
                     │ DAL + CRUD routes         │
                     └─────────────┬─────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
       ┌─────────────────┐ ┌─────────────────┐ ┌──────────────────┐
       │ Slice 12        │ │ Slice 3         │ │ (parallel: UI    │
       │ openteams PR    │ │ MAP resources/  │ │  authoring out   │
       │ schema + hooks  │ │ get + list      │ │  of scope here)  │
       └────────┬────────┘ └─────────────────┘ └──────────────────┘
                ▼
       ┌─────────────────┐
       │ Slice 2         │
       │ resolver +      │  ◀── depends on Slice 1 (DAL) and 12 (openteams hooks)
       │ skill-bridge +  │
       │ mcp-bridge      │
       └────────┬────────┘
                ▼
       ┌─────────────────┐
       │ Slice 5         │
       │ dispatch        │  ◀── demo unlock: hub dispatches with curated prompt
       │ integration     │
       └─────────────────┘
```

**Critical path:** 1 → 12 → 2 → 5. Slice 3 parallelizes with 12 + 2 (only consumed by agent-side, not by Milestone A demo).

**Total target effort:** ~5–6 days of focused work plus the openteams PR.

---

## Slice 1 — Resource types: `team_template` + `loadout`

**Goal:** Persist authored openteams content as syncable resources. CRUD, list, sync coverage.

**Effort:** ~1.5–2 days.

### Files

| File | Change | Notes |
|---|---|---|
| `src/types.ts` | Extend `SyncableResourceType` union to add `'team_template' \| 'loadout'` | Single line; touches every consumer that switches on the union |
| `src/db/schema.ts` | No new migration | The `syncable_resources` table is already type-agnostic; new types slot in. Confirm by running `db migrate` on a clean DB. |
| `src/db/dal/team-templates.ts` | New thin wrapper | `createTeamTemplate`, `getTeamTemplate(id)`, `getTeamTemplateByName(name, ownerId)`, `listTeamTemplates(filter)`, `updateTeamTemplate`, `deleteTeamTemplate`. Each calls into the existing syncable-resources DAL with `resource_type: 'team_template'` and a typed `content` field. |
| `src/db/dal/loadouts.ts` | New thin wrapper | Mirror of team-templates DAL with `resource_type: 'loadout'`. |
| `src/api/schemas/teams.ts` | Zod schemas | Validate `TeamManifest`, `RoleDefinition`, `LoadoutDefinition` shapes against openteams' JSON schemas. Source: `references/openteams/schema/*.schema.json`. |
| `src/api/schemas/loadouts.ts` | Zod schemas | Standalone loadout shape. |
| `src/api/routes/teams.ts` | New | `GET /teams`, `GET /teams/:id`, `POST /teams`, `PATCH /teams/:id`, `DELETE /teams/:id`. Uses `_resource-helpers.ts`. |
| `src/api/routes/loadouts.ts` | New | Mirror of teams routes. |
| `src/server.ts` | Register new route plugins | Add `await fastify.register(teamsRoutes, { prefix: '/api/v1' })` and same for loadouts. |
| `src/sync/materializer.ts` | Verify both types pass through | Likely no change — the materializer is type-agnostic. Add types to allowlist if it has one. |

### Content shape (Zod)

```ts
// src/api/schemas/teams.ts
const TeamTemplateContent = z.object({
  manifest: z.object({
    name: z.string(),
    version: z.literal(1),
    roles: z.array(z.string()),
    topology: z.unknown(),                // pass-through; openteams validates on load
    communication: z.unknown().optional(),
    mcp_providers: z.record(z.unknown()).optional(),
  }).passthrough(),
  roles: z.record(z.unknown()).default({}),       // RoleDefinition
  loadouts: z.record(z.unknown()).default({}),    // LoadoutDefinition
  prompts: z.record(z.string()).default({}),
});
```

Use `.passthrough()` so openteams extension namespaces (e.g., the `openhive:` and `claude_code:` keys) survive the round-trip. Validation is mostly structural; the deep semantic check happens during resolution (Slice 2).

### Tests

- `src/__tests__/dal/team-templates.test.ts` — CRUD + UNIQUE constraint on `(owner_agent_id, resource_type, name)`.
- `src/__tests__/dal/loadouts.test.ts` — same.
- `src/__tests__/routes/teams.test.ts` — Zod accepts a real openteams team (use `references/openteams/examples/loadout-demo` as a fixture).
- `src/__tests__/routes/loadouts.test.ts` — same with `references/openteams/examples/loadout-demo/loadouts/*.yaml`.
- `src/__tests__/sync/syncable-types.test.ts` — verify the new types appear in sync materialization output (small integration test).

### Demo-able outcome

```bash
# Create a team template via API
curl -X POST $HUB/api/v1/teams \
  -H 'Authorization: Bearer ...' \
  -d @loadout-demo-team.json

# List
curl $HUB/api/v1/teams        # → [{ id, name: 'loadout-demo', ... }]
curl $HUB/api/v1/loadouts     # → standalone loadouts
```

Authored content round-trips through the DB. No resolution yet.

### Risks

- The existing `syncable_resources` UNIQUE constraint is `(owner_agent_id, resource_type, name)`. Two different users can both have a `team_template` named `gsd`. That's correct per existing semantics; just note it for the UI.
- Long content payloads. A `team_template` carries `roles/`, `loadouts/`, `prompts/` inline. Confirm the existing column type tolerates ~100KB JSON; otherwise plan an offload.

---

## Slice 12 — openteams modifications (coordinated, upstream PR)

**Goal:** Make openteams' resolver hooks fit OpenHive's needs. All additive.

**Effort:** ~0.5 day in the openteams repo.

### Changes (in `references/openteams/src/template/loader.ts` + types)

1. **Loosen `resolveExternalLoadout` to accept ref-or-name.**
   ```ts
   type LoadoutRef = string | { name: string; version?: string; source?: string };
   resolveExternalLoadout?: (ref: LoadoutRef) => LoadoutDefinition | undefined | Promise<LoadoutDefinition | undefined>;
   ```
   Backwards-compat: callers passing strings continue to work.

2. **Add top-level `postProcessTemplate` hook.**
   ```ts
   postProcessTemplate?: (resolved: ResolvedTemplate, manifest: TeamManifest) => ResolvedTemplate | Promise<ResolvedTemplate>;
   ```

3. **Don't throw on undefined external resolution.**
   When `resolveExternalLoadout(ref)` returns `undefined`, push the unresolved ref onto a new `ResolvedTemplate.unresolvedExtends: string[]` field instead of throwing. Mirrors how MCP refs degrade.

4. **First-class `skill_bank_ref?: string` on `SkillsConfig`.**
   Update `loadout.schema.json` $defs.SkillsConfig to add `skill_bank_ref` with description "consumer-resolved reference to a skill bank/library". Bridge code in claude-code-swarm already tolerates extra fields; this just makes the field first-class.

### Tests

- Unit tests in openteams covering: ref-shape resolver, undefined-returns-no-throw, postProcessTemplate runs after merge.
- Update the existing `loadout.test.ts` fixtures to exercise unresolved-extends path.

### Distribution

- Bump openteams to `0.4.0` (new minor since these are additive).
- OpenHive's slice 2 takes a dependency on `^0.4.0`.

---

## Slice 3 — MAP `resources/get` + `resources/list`

**Goal:** Generic MAP-side resource access primitives. Used by claude-code-swarm at boot (Milestone B); also useful for any future agent that wants to read hub state. Standalone slice — does not block Milestone A demo, but inexpensive to land in this milestone since it's small.

**Effort:** ~0.5 day.

### Files

| File | Change |
|---|---|
| `src/map/resources-handler.ts` | New. Two handler functions: `handleResourcesGet({ id })`, `handleResourcesList({ type, name?, filter? })`. Authorize via the connection's authenticated identity (use existing patterns from `trajectory-handler.ts`). |
| `src/map/map-server-setup.ts` | In `buildAdditionalHandlers()`, register `'resources/get'` and `'resources/list'` to the new handlers. |
| `src/map/resource-types.ts` | New (or extend existing). Type definitions for the request/response shapes. |
| `src/__tests__/map/resources-handler.test.ts` | New. Cover: get by id, get by name+type, list with filter, unauthorized access returns -32004. |

### Request/response shapes

```ts
// resources/get
type Request = { id: string };
type Response = SyncableResource;   // existing type from src/types.ts

// resources/list
type Request = {
  type: SyncableResourceType;
  name?: string;
  filter?: { ownerAgentId?: string; visibility?: string };
};
type Response = { resources: SyncableResource[]; total: number };
```

### Authorization

Reuse the resource-ACL helpers already used by REST routes. The MAP connection's authenticated agent identity (`ctx.connection.agentId` per existing handler patterns) is the principal. Don't introduce a new auth model.

### Demo-able outcome

```bash
# From a connected swarm (or test client)
mapClient.callExtension('resources/list', { type: 'team_template' })
  // → { resources: [{ id, name: 'gsd', ... }], total: 1 }

mapClient.callExtension('resources/get', { id: 'res_01HX...' })
  // → full SyncableResource
```

---

## Slice 2 — Resolver + skill-bridge + mcp-bridge

**Goal:** Hub-side resolution and materialization. Single code path consumed by both UI (Slice 4 — out of Milestone A scope) and dispatch (Slice 5).

**Effort:** ~1.5 days.

### Files

| File | Change |
|---|---|
| `src/openteams/types.ts` | New. `MaterializedLoadout`, re-exports of openteams types (`ResolvedTemplate`, `ResolvedRole`, `LoadoutDefinition`). |
| `src/openteams/resolver.ts` | New. Two entry points: `resolveTeam(templateId)`, `materializeRoleLoadout(templateId, roleName)`. |
| `src/openteams/skill-bridge.ts` | New. `compileSkillsForLoadout(skillsConfig, contextRefs)` — calls `getServingLayer()` from `skill-management.ts` (extract the helper if needed) and translates openteams `SkillsConfig` → skill-tree `LoadoutCriteria`. |
| `src/openteams/mcp-bridge.ts` | New. `resolveMcpRefs(servers)` — looks up against bundled JSON, returns scope/providers/unresolvedRefs. |
| `src/openteams/refs/builtin.json` | New. Initially empty `{}` or seeded with a few `@openhive/*` known refs. |
| `src/openteams/cache.ts` | New. `(templateId, contentHash) → ResolvedTemplate` LRU with invalidation hook. Same eviction shape as `getServingLayer()` (10-min TTL). |
| `package.json` | Add `openteams: ^0.4.0` as a dependency. |
| `src/api/routes/skill-management.ts` | Refactor: extract `getServingLayer(skillBankResourceId)` so skill-bridge can call it without going through HTTP. |

### Resolver pseudocode

```ts
// src/openteams/resolver.ts
import { TemplateLoader } from 'openteams';
import { getTeamTemplate } from '../db/dal/team-templates.js';
import { getLoadoutByName } from '../db/dal/loadouts.js';
import { resolveCachedOrCompute } from './cache.js';
import { compileSkillsForLoadout } from './skill-bridge.js';
import { resolveMcpRefs } from './mcp-bridge.js';
import type { MaterializedLoadout } from './types.js';

export async function resolveTeam(templateId: string) {
  return resolveCachedOrCompute(templateId, async () => {
    const tmpl = await getTeamTemplate(templateId);
    if (!tmpl) throw new NotFoundError('team_template');

    return TemplateLoader.loadAsync(tmpl.content, {
      resolveExternalLoadout: async (ref) => {
        const name = typeof ref === 'string' ? ref : ref.name;
        const ldt = await getLoadoutByName(name, tmpl.owner_agent_id);
        return ldt?.content;
      },
      // postProcessTemplate to attach unresolved-refs metadata once we have it
    });
  });
}

export async function materializeRoleLoadout(
  templateId: string,
  roleName: string,
): Promise<MaterializedLoadout> {
  const resolved = await resolveTeam(templateId);
  const role = resolved.roles.get(roleName);
  if (!role) throw new NotFoundError('role');
  if (!role.loadout) return emptyMaterialization();

  const skillBankRef =
    role.loadout.skills?.skill_bank_ref ??
    resolved.metadata?.defaultSkillBankRef ??
    null;

  const [skills, mcp] = await Promise.all([
    compileSkillsForLoadout(role.loadout.skills, skillBankRef),
    resolveMcpRefs(role.loadout.mcpServers ?? []),
  ]);

  return {
    capabilities: role.loadout.capabilities ?? [],
    mcpScope: role.loadout.mcpScope ?? [],
    mcpProviders: mcp.providers,
    permissions: role.loadout.permissions ?? { allow: [], deny: [], ask: [] },
    promptAddendum: role.loadout.promptAddendum ?? '',
    skills,
    unresolvedRefs: mcp.unresolvedRefs,
    materializedAt: new Date().toISOString(),
  };
}
```

### Skill bridge

`compileSkillsForLoadout` reuses the existing `SkillGraphServer` factory from `src/api/routes/skill-management.ts`. The current code has `getServingLayer(skillBankResourceId)` inline in route handlers; extract it as a public export so the bridge can call directly. No behavior change to the existing endpoints.

The translation from openteams `SkillsConfig` to skill-tree `LoadoutCriteria` mirrors `mergeOpenteamsSkillsIntoCriteria` in claude-code-swarm — keep it isomorphic so both sides do the same thing.

### MCP bridge

```ts
// src/openteams/mcp-bridge.ts
import builtin from './refs/builtin.json';

export async function resolveMcpRefs(servers: McpServerEntry[]) {
  const scope: NormalizedMcpScope[] = [];
  const providers: McpProviderSpec[] = [];
  const unresolvedRefs: Array<{ ref: string; reason: string }> = [];

  for (const entry of servers) {
    if (typeof entry === 'string') {
      scope.push({ server: entry });
    } else if ('ref' in entry) {
      const resolved = builtin[entry.ref];
      if (resolved) providers.push({ name: entry.ref, ...resolved });
      else unresolvedRefs.push({ ref: entry.ref, reason: 'not-in-registry' });
    } else if ('command' in entry) {
      providers.push(entry);
    } else {
      // Single-key scope object — pass through
      scope.push(normalizeScopeObject(entry));
    }
  }

  return { scope, providers, unresolvedRefs };
}
```

### Tests

- `src/__tests__/openteams/resolver.test.ts` — load `references/openteams/examples/loadout-demo` (round-trip through Zod into a `team_template` resource), resolve, assert role's loadout contains expected merged fields.
- `src/__tests__/openteams/skill-bridge.test.ts` — feed a `SkillsConfig`, mock the serving layer, assert criteria translation.
- `src/__tests__/openteams/mcp-bridge.test.ts` — string, ref, install spec, scope-object — each maps to the expected shape; unknown ref surfaces in `unresolvedRefs`.
- `src/__tests__/openteams/cache.test.ts` — cache hits on identical content, misses on update, eviction respects TTL.

### Demo-able outcome

```ts
// In a script or test
const mat = await materializeRoleLoadout(templateId, 'reviewer');
// → { capabilities: ['file.read', ...], skills: { rendered: '...', estimatedTokens: 2400 }, ... }
```

---

## Slice 5 — Dispatch integration

**Goal:** When a spec dispatches with a `loadout_ref` (or per-role implicit binding), the orchestrator materializes the loadout and embeds it in the boot prompt.

**Effort:** ~0.5–1 day.

### Files

| File | Change |
|---|---|
| `src/dispatch/openhive-source.ts` | When building a `DispatchTask` from a spec, look up `spec.metadata.loadout_ref` or `spec.metadata.team_template_ref + role`. If present, call `materializeRoleLoadout` and attach the result to `task.metadata.materializedLoadout`. |
| `src/dispatch/prompt.ts` | At the top of `openHivePromptBuilder`, if `task.metadata.materializedLoadout?.skills?.rendered` exists, prepend the rendered skill bundle. If `materializedLoadout.promptAddendum` exists, append it. Document the prompt-section ordering. |
| `src/api/schemas/specs.ts` | Add optional `loadout_ref?: string` and `team_role_ref?: { teamTemplateId, role }` to spec metadata Zod schema. |
| `src/web/components/dispatch/DispatchModal.tsx` | (Optional v1) Add a loadout/team selector. Defer if Milestone A is targeting backend-first. |

### Ordering: where to materialize

Pre-resolve in the **source adapter**, not the prompt builder. Two reasons:

1. The prompt builder is synchronous (`PromptBuilder` returns a string). Materialization is async (DB + skill compilation).
2. Source adapters are the established place for content enrichment — `openHiveDispatchSource` already loads spec content. Loadout is just another field.

```ts
// src/dispatch/openhive-source.ts (sketch of the addition)
async function enrichTask(spec: Spec): Promise<DispatchTask> {
  const baseTask = buildBaseTask(spec);

  const ref = spec.metadata?.loadout_ref ?? spec.metadata?.team_role_ref;
  if (ref) {
    try {
      const mat = await materializeForRef(ref);    // calls resolver
      baseTask.metadata.materializedLoadout = mat;
    } catch (err) {
      log.warn('loadout materialization failed; dispatching without it', { err, ref });
      // Best-effort — never block dispatch on materialization failure
    }
  }

  return baseTask;
}
```

### Prompt assembly order

Decide once and document:

```
[skills.rendered]            — system-prompt fragment, top of prompt
[task.content / title]       — the dispatched work
[acceptance criteria]
[relevant files]
[promptHints.additionalContext]
[promptAddendum]             — role-specific addendum from the loadout
[role line]                  — "Role: <role>"
```

Skills above task content so the agent loads them as context before reading the work. promptAddendum below criteria so it shapes execution style without overriding what to do.

### Tests

- `src/__tests__/dispatch/loadout-prompt.test.ts` — dispatch a spec with `loadout_ref`, assert prompt contains rendered skills + addendum.
- `src/__tests__/dispatch/loadout-failure.test.ts` — when materialization throws, dispatch proceeds with un-enriched prompt and logs warning.
- `src/__tests__/dispatch/loadout-no-ref.test.ts` — spec without loadout_ref produces unchanged prompt (regression guard).

### Demo-able outcome

End-to-end:

1. POST a `team_template` resource (slice 1).
2. POST a `spec` with `metadata.team_role_ref = { teamTemplateId, role: 'reviewer' }`.
3. `POST /specs/:id/dispatch` to a connected swarm.
4. Inspect the dispatched prompt — contains rendered skill bundle + role addendum.

This is the Milestone A demo.

---

## Cross-cutting concerns

### Logging & telemetry

- `src/openteams/resolver.ts` — log resolution duration, cache hit/miss, unresolved-refs counts. Use existing logger pattern.
- `src/dispatch/openhive-source.ts` — log materialization attempts and failures. Don't fail dispatch on materialization error; warn and continue.

### Realtime / WebSocket

- Slice 1 — emit `resource:team_template:<id>` and `resource:loadout:<id>` events on create/update/delete. Pattern matches existing skill resources.
- Slice 2 — when a referenced loadout or skill bank changes, invalidate the `(templateId, contentHash)` cache. Wire into the existing `evictServingLayer` mechanism.

### Permissions

- Read access to `team_template` and `loadout` resources follows the same ACL as other syncable resources (visibility, owner).
- Materialize operations require read access to the referenced loadout AND its referenced skill bank. Surface as 403 with a clear message if any link is unauthorized.

### Sync interplay

The two new resource types ride the existing mesh sync protocol. No new sync wiring required, but verify two things in slice 1:

- `src/sync/materializer.ts` doesn't gatekeep on resource type.
- `src/sync/service.ts` includes the new types in its outbound digest.

---

## Definition of done — Milestone A

- [ ] `team_template` and `loadout` resources can be created, read, listed, updated, deleted via REST. Sync materializer carries them.
- [ ] `materializeRoleLoadout(templateId, role)` returns a `MaterializedLoadout` for `references/openteams/examples/loadout-demo` round-tripped through OpenHive.
- [ ] MAP `resources/get` and `resources/list` work for both new types from a test MAP client.
- [ ] A spec carrying `metadata.team_role_ref = { teamTemplateId, role }` produces a dispatched prompt with rendered skill content and role-specific addendum embedded.
- [ ] Materialization failure logs a warning and dispatch proceeds with un-enriched prompt.
- [ ] Test coverage: DAL CRUD, resolver round-trip, skill-bridge translation, mcp-bridge ref handling, cache invalidation, dispatch enrichment + failure path.
- [ ] openteams 0.4.0 published with the four hook changes; OpenHive depends on it.

---

## What this milestone does NOT include

- Agent-side wiring in claude-code-swarm (slices 7–9). That's Milestone B.
- UI authoring pages (slice 6). UI may consume `GET /teams` and `/teams/:id/roles/:role/loadout/materialize` for read-only previews if convenient, but full authoring is out of scope.
- `HiveStorageAdapter` for skill-tree (slice 11). Skills compile against the local skill bank as today.
- Versioning for `team_template` / `loadout`. Use the existing skill-resource version model when needed; not in scope here.
- Cross-hub `extends:` resolution at federation time. Surface as `unresolvedExtends` when encountered; address when federation use cases mature.
- A `mcp_provider` resource type. Bundled JSON registry is enough for v1.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Large `team_template` content payloads exceed comfortable JSON column size | Confirm column tolerates ~100KB; chunk attachments (e.g., `prompts/*`) into separate fields if needed |
| openteams 0.4.0 not ready in time | Slice 2 can mock `loadAsync` against the local fork in `references/openteams` until the published version lands |
| Cache thrash under fast loadout edits | Coalesce invalidations with a 200ms debounce in `cache.ts`; same pattern as the WS realtime layer uses |
| Skill compilation failure in materialize blocks dispatch | Catch in source adapter, log, continue without skills (best-effort) |
| Existing dispatch tests break due to prompt format changes | Snapshot test the unenriched prompt explicitly; ensure new fields only appear when metadata is present |

---

## Open questions to resolve during implementation

1. **Where should `materializeForRef` live?** `src/dispatch/loadout-resolution.ts` (dispatch-local) or `src/openteams/resolver.ts` (shared)? Lean shared — the UI wants to call the same thing for previews.
2. **Stale-cache behavior on materialization error.** If skill compilation fails mid-resolution, do we cache the partial result? Probably no — return live, don't cache failures.
3. **Audit fields on materialization.** Do we want `materializedBy: string` (for telemetry) on `MaterializedLoadout`? Tracker question; default to no until needed.
4. **Spec metadata shape — `loadout_ref` vs `team_role_ref`.** Likely both. `loadout_ref` is direct (loadout resource id, no team context); `team_role_ref` is `{ teamTemplateId, role }` which resolves through a team. Default to supporting both in the spec schema; document precedence (direct loadout_ref wins).

---

## References

- [`LOADOUTS_DESIGN.md`](./LOADOUTS_DESIGN.md) — design rationale
- [`HIVE_SYNC_DESIGN.md`](./HIVE_SYNC_DESIGN.md) — sync protocol the new resource types ride
- `src/db/dal/syncable-resources.ts` — DAL pattern slice 1 follows
- `src/api/routes/skill-management.ts` — `getServingLayer` to extract for skill-bridge
- `src/dispatch/setup.ts`, `src/dispatch/prompt.ts`, `src/dispatch/openhive-source.ts` — slice 5 integration points
- `src/map/map-server-setup.ts` — slice 3 handler registration
- `references/openteams/schema/team.schema.json`, `loadout.schema.json` — slice 1 Zod schemas mirror these
- `references/openteams/examples/loadout-demo/` — slice 2 round-trip fixture
