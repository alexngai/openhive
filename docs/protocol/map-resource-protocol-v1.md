---
status: draft
version: v1
owner: MAP SDK (upstream candidate; OpenHive reference implementation)
canonical: references/multi-agent-protocol/docs/13-resource-protocol.md
created: 2026-05-07
revised: 2026-05-07
---

# MAP Resource Protocol v1 — OpenHive Reference Implementation

> **Canonical spec**: [`references/multi-agent-protocol/docs/13-resource-protocol.md`](../../references/multi-agent-protocol/docs/13-resource-protocol.md)
>
> This file reproduces the protocol for local reference and adds the [OpenHive reference implementation notes](#openhive-reference-implementation-notes) section below. When the two diverge, the canonical spec in the MAP SDK repo is authoritative for protocol semantics; this file is authoritative for OpenHive-specific behavior.

## Overview

The MAP Resource Protocol defines a standard surface for discovering, browsing, and observing typed resources on a MAP-protocol hub. Resources are any named, typed, owned entities that agents may need to discover or interact with — repositories, environments, memory banks, task boards, skill registries, sessions, etc.

The protocol defines:

- A standard resource envelope (`MAPResource`)
- Two read methods (`map/resources/list`, `map/resources/get`)
- A kind handler dispatch convention
- A type namespacing convention
- Capabilities advertisement for resource kind discovery
- An optional event contract for real-time updates

The protocol does **not** define:

- Storage (table schema, database choice)
- Access control (visibility models, permission checks)
- Federation (how resources propagate between hubs)
- Write operations (creation, mutation — kind-specific)
- Kind-specific metadata shapes

These are implementation concerns owned by each hub and each resource kind.

---

## Architecture

Three layers with distinct owners:

```
┌─────────────────────────────────────────────────┐
│  MAP SDK (upstream)                             │
│                                                 │
│  - MAPResource envelope                         │
│  - map/resources/list, map/resources/get        │
│  - ResourceKindHandler interface                │
│  - Capabilities: resources.kinds[]              │
│  - Event contract (optional)                    │
│  - Type namespacing convention                  │
└───────────────────┬─────────────────────────────┘
                    │ implements
┌───────────────────▼─────────────────────────────┐
│  Hub implementation (e.g., OpenHive)            │
│                                                 │
│  - Storage backend                              │
│  - Per-kind handler dispatch                    │
│  - Access control / visibility model            │
│  - Federation pipeline (if multi-hub)           │
│  - REST / UI enrichment                         │
└───────────────────┬─────────────────────────────┘
                    │ registers kind handlers for
┌───────────────────▼─────────────────────────────┐
│  Kind packages (metadata shape owners)          │
│                                                 │
│  x-workspace/repo        → RepoMetadata         │
│  x-workspace/environment → EnvironmentMetadata   │
│  x-minimem/memory-bank   → MinimemMetadata       │
│  x-opentasks/task-board  → OpenTasksMetadata     │
│  x-skill-tree/skill      → SkillMetadata         │
│  x-sessionlog/session    → SessionMetadata       │
└─────────────────────────────────────────────────┘
```

The SDK owns the wire format and dispatch. The hub owns storage and access control. Kind packages own their metadata shapes and export handler factories that hubs register.

---

## Resource envelope

Every resource on the wire conforms to the `MAPResource` shape:

```json
{
  "id":             "repo_abc123",
  "type":           "x-workspace/repo",
  "name":           "openhive",
  "status":         "active",
  "owner_id":       "agent_xyz",
  "origin_hub_id":  null,
  "created_at":     "2026-05-01T00:00:00Z",
  "updated_at":     "2026-05-07T12:00:00Z",
  "metadata":       { }
}
```

### Field definitions

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier. Format is kind-defined (e.g., `repo_xxx`, `env_xxx`). |
| `type` | string | yes | Namespaced resource type. See [Type namespacing](#type-namespacing). |
| `name` | string | yes | Human-readable display name. Not necessarily unique. |
| `status` | string | yes | Lifecycle status. Values are kind-defined. |
| `owner_id` | string | yes | ID of the agent/user that owns this resource. |
| `origin_hub_id` | string \| null | no | `null` for locally-created resources. Set to the originating hub's instance ID for resources learned via federation. |
| `created_at` | string (ISO 8601) | yes | Creation timestamp. |
| `updated_at` | string (ISO 8601) | yes | Last modification timestamp. |
| `metadata` | object | yes | Kind-specific payload. Opaque to the protocol; interpreted by the kind handler. May be `{}` but never absent. |

### Metadata conventions

The `metadata` object is kind-owned. The protocol imposes no schema on it. However, kinds that participate in federation SHOULD include:

- `visibility`: a federation tier indicating discovery reach (e.g., `'private' | 'hub_local' | 'federated'`)
- `origin`: provenance indicator for how the resource was created

These are conventions, not requirements. Kinds that don't federate can omit them.

---

## Type namespacing

Resource types follow the same namespacing convention as MAP method families:

| Prefix | Owner | Examples |
|---|---|---|
| `map/*` | MAP SDK (reserved) | Future standard types (e.g., `map/agent`) |
| `x-workspace/*` | agent-workspace package | `x-workspace/repo`, `x-workspace/environment` |
| `x-minimem/*` | minimem package | `x-minimem/memory-bank` |
| `x-opentasks/*` | opentasks package | `x-opentasks/task-board` |
| `x-skill-tree/*` | skill-tree package | `x-skill-tree/skill` |
| `x-sessionlog/*` | sessionlog package | `x-sessionlog/session` |
| `x-<vendor>/*` | third-party | Open for extension |

**Open type strings are supported on the wire.** Any string is a valid `type`. Namespacing is a convention enforced by documentation and tooling, not by the protocol itself. Hubs MAY accept un-namespaced shorthand strings (e.g., `repo` as alias for `x-workspace/repo`) for backwards compatibility; the canonical form is always namespaced.

---

## Capabilities advertisement

Hubs that implement the MAP Resource Protocol MUST include a `resources` key in their capabilities response during the MAP connection handshake:

```json
{
  "capabilities": {
    "resources": {
      "kinds": [
        "x-workspace/repo",
        "x-workspace/environment",
        "x-minimem/memory-bank",
        "x-opentasks/task-board",
        "x-sessionlog/session"
      ]
    }
  }
}
```

`kinds` lists every resource type the hub has a registered handler for. Agents SHOULD consult this before calling `map/resources/list` to avoid unnecessary round-trips. The `-32001` error code is a fallback for version skew or stale capability caches, not the primary discovery mechanism.

The list MAY change over the lifetime of a connection (e.g., a plugin is loaded at runtime). Hubs SHOULD re-advertise via a capabilities update if the underlying transport supports it.

---

## Methods

### `map/resources/list`

Browse resources by type with optional filtering.

**Request:**

```json
{
  "method": "map/resources/list",
  "params": {
    "type": "x-workspace/repo",
    "filter": { },
    "cursor": null,
    "limit": 50
  }
}
```

| Param | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | Namespaced resource type to list. |
| `filter` | object | no | Kind-specific filter object. Passed verbatim to the kind handler. The protocol does not define filter fields — each kind defines its own. |
| `cursor` | string \| null | no | Opaque pagination cursor. `null` or absent = first page. |
| `limit` | number | no | Max results per page. Hub MAY cap this. Default is hub-defined. |

**Response:**

```json
{
  "resources": [ ],
  "cursor": "next_page_token_or_null",
  "total": 142
}
```

| Field | Type | Description |
|---|---|---|
| `resources` | MAPResource[] | Resources matching the query, scoped by the hub's access control. |
| `cursor` | string \| null | Pagination cursor for the next page. `null` = no more pages. |
| `total` | number \| null | Total count matching the filter (before pagination). Hubs MAY omit if expensive to compute. |

**Access control.** The hub's kind handler is responsible for scoping results to what the caller can see. The protocol does not define an access model — only that the handler MUST NOT return resources the caller shouldn't see.

**Per-type dispatch.** The hub routes `list` to the registered handler for `params.type`. If no handler is registered for the type, the hub returns error code `-32001` (`unknown_resource_type`).

### `map/resources/get`

Fetch a single resource by ID.

**Request:**

```json
{
  "method": "map/resources/get",
  "params": {
    "id": "repo_abc123",
    "type": "x-workspace/repo"
  }
}
```

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Resource ID. |
| `type` | string | no | Resource type hint for direct handler routing. If omitted, the hub resolves the type from the ID (e.g., from a global index or ID prefix convention). |

When `type` is provided, the hub routes directly to that kind handler. When omitted, the hub resolves the resource's type and routes accordingly. Hubs that cannot resolve type from ID alone SHOULD return `-32003` with a message indicating `type` is required.

**Response:** a single `MAPResource` object, or error `-32004` (`not_found`).

---

## Kind handler interface

Hubs register per-type handlers that implement the resource protocol:

```typescript
interface ResourceKindHandler {
  /** The namespaced type this handler serves. */
  type: string;

  /** List resources matching a filter, scoped to the caller. */
  list(params: {
    filter?: Record<string, unknown>;
    cursor?: string | null;
    limit?: number;
  }, ctx: MAPContext): Promise<{
    resources: MAPResource[];
    cursor?: string | null;
    total?: number;
  }>;

  /** Fetch a single resource by ID. Returns null if not found or not accessible. */
  get(id: string, ctx: MAPContext): Promise<MAPResource | null>;
}
```

Hubs register handlers via:

```typescript
server.registerResourceKind(handler: ResourceKindHandler): void;
```

The SDK dispatches `map/resources/list { type }` and `map/resources/get { type?, id }` to the matching handler. Multiple handlers for the same type is an error at registration time.

### MAPContext

The context object passed to handlers contains at minimum:

```typescript
interface MAPContext {
  /** Authenticated caller identity. null if unauthenticated. */
  callerId: string | null;
  /** Hub-specific session metadata (swarm ID, capabilities, etc.). */
  session: Record<string, unknown>;
}
```

Hubs MAY extend `MAPContext` with additional fields. The SDK defines the minimum shape.

---

## Events (optional)

Hubs MAY emit resource lifecycle events on MAP scope channels. This enables agents to maintain a local cache of known resources without polling `list`.

### Event shape

```json
{
  "type": "resource.added",
  "resource_type": "x-workspace/repo",
  "resource_id": "repo_abc123",
  "resource_name": "openhive",
  "origin_hub_id": null,
  "timestamp": "2026-05-07T12:00:00Z"
}
```

### Event types

| Event | Emitted when |
|---|---|
| `resource.added` | A new resource is created or federated in. |
| `resource.updated` | Resource metadata or status changed. |
| `resource.removed` | Resource archived, redacted, or deleted. |

### Scope channels

Agents subscribe via the MAP scope mechanism:

- `resources:<type>` — events for a specific type (e.g., `resources:x-workspace/repo`)
- `resources:x-workspace/*` — all types under a namespace
- `resources:*` — all resource events (use sparingly)

Events are informational. They do NOT replace `list` / `get` — an agent receiving `resource.added` should call `get` if it needs the full resource. Events carry enough to decide whether to fetch.

---

## Error codes

| Code | Name | When |
|---|---|---|
| -32001 | `unknown_resource_type` | No handler registered for the requested type. |
| -32003 | `invalid_filter` | Filter params rejected by the kind handler. |
| -32004 | `not_found` | Resource doesn't exist or caller can't access it. |

Hubs SHOULD use `-32004` for both "doesn't exist" and "caller can't see it" to avoid leaking existence information.

---

## Conformance

A hub conforms to MAP Resource Protocol v1 if it:

1. Registers at least one `ResourceKindHandler`.
2. Advertises registered kinds via `capabilities.resources.kinds[]` during the MAP handshake.
3. Responds to `map/resources/list` and `map/resources/get` with the specified request/response shapes.
4. Returns `MAPResource` objects conforming to the envelope schema.
5. Uses namespaced type strings (or accepts them alongside shorthands).
6. Returns `-32001` for unregistered types and `-32004` for not-found / not-accessible resources.
7. Scopes results to the caller's access (implementation-defined).

Federation, events, and write operations are NOT required for conformance.

---

## OpenHive reference implementation notes

OpenHive is the reference implementation of this protocol. Implementation-specific details that do NOT belong in the upstream SDK:

- **Storage**: `syncable_resources` table (SQLite/PostgreSQL) stores all resource types in a single table with `resource_type` discriminator.
- **Access control**: dual visibility model — column-level (`private/shared/public`) for legacy resource types, metadata-level (`private/hub_local/federated`) for workspace kinds. Per-kind handlers apply the appropriate model.
- **Federation**: pull-based mesh sync protocol propagates resources between peer hubs. `origin_hub_id` is set on materialized resources.
- **REST enrichment**: the REST API returns `SyncableResourceWithMeta` (full owner profile, tags, subscriber count, permissions) — a superset of `MAPResource`. The MAP wire returns the standard envelope; REST adds hub-specific enrichment.
- **ID-to-type resolution**: all resources share one table, so `get` without `type` is a single `SELECT`. Hubs with per-type storage would need an index or ID prefix convention.
- **Type mapping**: OpenHive internally uses short `resource_type` values (`repo`, `session`, etc.) in the database. The MAP wire handler maps these to/from namespaced types (`x-workspace/repo`, `x-sessionlog/session`, etc.) at the protocol boundary.

---

## Cross-references

- [Agent ↔ Repo Coordination](../design/agent-repo-coordination.md) — the design doc that motivated this protocol.
- [`src/map/CLAUDE.md`](../../src/map/CLAUDE.md) — OpenHive MAP hub architecture.
- [`agent-workspace/docs/design/repo-kind.md`](../../references/agent-workspace/docs/design/repo-kind.md) — repo kind protocol (defines `x-workspace/repo` metadata shape).
- [`agent-workspace/docs/design/environment-kind.md`](../../references/agent-workspace/docs/design/environment-kind.md) — environment kind design (defines `x-workspace/environment` metadata shape).
