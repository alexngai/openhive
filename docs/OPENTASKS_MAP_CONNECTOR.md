# OpenTasks MAP Connector Design

## Problem

OpenTasks graphs are local — they live on the filesystem where the daemon runs. When a remote agent connects to OpenHive via MAP, it can't query or mutate another agent's task graph because:

1. The daemon only accepts local Unix socket connections
2. OpenHive can't proxy to a remote daemon (no TCP/RPC support)
3. The only option today is cloning the git repo (slow, read-only for non-git sources)

## Solution

Build a MAP connector in the opentasks package that exposes daemon operations over the MAP protocol. This follows the same request/response notification pattern used by the trajectory protocol.

## Architecture

```
Agent A (has local OpenTasks daemon)
  │
  ├── MCP tools (create_task, query, link, annotate)
  │     └── daemon IPC (local)
  │
  └── MAP connector (new)
        ├── Listens for opentasks/*.request notifications
        ├── Forwards to local daemon
        └── Sends opentasks/*.response back

OpenHive Hub
  │
  ├── Routes MAP notifications between agents
  ├── REST content endpoints (for frontend, local daemon)
  └── Does NOT proxy daemon calls — just routes messages

Agent B (remote, no local daemon)
  │
  └── Sends opentasks/query.request to Agent A's scope
        via MAP WebSocket → Hub routes → Agent A handles → response
```

## Protocol

### Methods

3 request/response pairs, matching the opentasks 3-tool interface:

| Request | Response | Maps to |
|---------|----------|---------|
| `opentasks/query.request` | `opentasks/query.response` | `tools.query` — nodes, edges, ready, blockers, feedback |
| `opentasks/link.request` | `opentasks/link.response` | `tools.link` — create/remove edges |
| `opentasks/annotate.request` | `opentasks/annotate.response` | `tools.annotate` — feedback lifecycle |

Plus task-specific operations:

| Request | Response | Maps to |
|---------|----------|---------|
| `opentasks/task.request` | `opentasks/task.response` | `tools.task` — transition, assign, ready, validActions |

### Wire Format

JSON-RPC 2.0 notifications (no `id` — these are MAP notifications, not RPC):

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "opentasks/query.request",
  "params": {
    "request_id": "req-abc123",
    "query": {
      "nodes": { "type": "task", "status": "open" },
      "limit": 50
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "method": "opentasks/query.response",
  "params": {
    "request_id": "req-abc123",
    "items": [
      { "id": "t-1", "type": "task", "title": "Fix auth", "status": "open" }
    ],
    "total": 1,
    "hasMore": false
  }
}
```

**Error response:**
```json
{
  "jsonrpc": "2.0",
  "method": "opentasks/query.response",
  "params": {
    "request_id": "req-abc123",
    "error": "Daemon not running"
  }
}
```

### Pending Request Tracking

The requester maintains a `Map<requestId, { resolve, timer }>`:

1. Generate unique `request_id`
2. Send notification with `request_id` in params
3. Start 10s timeout timer
4. On matching response: clear timer, resolve promise
5. On timeout: resolve with null

This is the same pattern used by `trajectory/content.request` → `trajectory/content.response`.

## Implementation

### Where code lives

| Component | Package | Purpose |
|-----------|---------|---------|
| Request handler | `opentasks` | Receives `opentasks/*.request`, queries daemon, sends response |
| MAPEventBridge | `opentasks` (exists) | Outbound event emission (task.created, etc.) |
| Notification listener | `cc-swarm` sidecar | Registers `onNotification` handlers, forwards to daemon |
| Response interceptor | `openhive` (optional) | Hub-side interception if hub itself queries remote graphs |
| MAP provider | `opentasks` (exists) | Represents remote tasks as `map://` URIs in the graph |

### opentasks package changes

**New: `src/map/connector.ts`**

A request handler that receives MAP notifications and queries the local daemon:

```typescript
export interface MAPConnectorConfig {
  /** Function to send MAP notifications (provided by sidecar or SDK) */
  send: (method: string, params: Record<string, unknown>) => void;
  /** OpenTasks client instance (connected to local daemon) */
  client: OpenTasksClient;
}

export function createMAPConnector(config: MAPConnectorConfig) {
  return {
    /** Handle incoming request notifications */
    handleNotification(method: string, params: Record<string, unknown>): void;

    /** Stop processing (cleanup) */
    stop(): void;
  };
}
```

The connector:
- Listens for `opentasks/query.request`, `opentasks/link.request`, `opentasks/annotate.request`, `opentasks/task.request`
- Extracts `request_id` and operation params
- Calls `client.query()`, `client.link()`, `client.annotate()`, `client.task()` on the local daemon
- Sends `opentasks/*.response` notification back with `request_id` + result

**Updated: `src/providers/map.ts`**

The existing MAP provider surfaces remote tasks as `map://` URIs. It would be updated to use the new request/response pattern instead of (or in addition to) the current approach.

### cc-swarm changes

**`src/sidecar-server.mjs`** — Register notification handlers:

```javascript
// When MAP connection is established
conn.onNotification('opentasks/query.request', async (params) => {
  connector.handleNotification('opentasks/query.request', params);
});
conn.onNotification('opentasks/link.request', async (params) => {
  connector.handleNotification('opentasks/link.request', params);
});
// etc.
```

**`src/map-connection.mjs`** — Declare capability:

```javascript
capabilities: {
  trajectory: { canReport: true, canServeContent: true },
  opentasks: { canQuery: true, canLink: true, canAnnotate: true },
}
```

### openhive changes (minimal)

OpenHive's role is just message routing — MAP notifications flow through the hub automatically. The only OpenHive-side change would be if the hub itself needs to query a remote graph (e.g., for REST content endpoints serving a remote resource). In that case:

**`src/map/opentasks-remote.ts`** (new, optional):

```typescript
export async function queryRemoteGraph(
  swarmId: string,
  query: QueryParams,
): Promise<QueryResult | null> {
  // Send opentasks/query.request to connected swarm
  // Wait for opentasks/query.response via notification interceptor
  // Return result or null on timeout
}
```

This follows the exact pattern of `trajectory-content.ts`.

## Capability Declaration

Agents declare opentasks capabilities during MAP registration:

```json
{
  "capabilities": {
    "opentasks": {
      "canQuery": true,
      "canLink": true,
      "canAnnotate": true,
      "canTask": true,
      "locationHash": "abc123"
    }
  }
}
```

The hub uses this to:
1. Know which swarms can serve opentasks requests
2. Route requests to the right swarm (by location_hash or swarm_id)
3. Gate expensive operations (only request from swarms that declared support)

## Event Flow (Outbound — Already Exists)

The existing `MAPEventBridge` handles outbound events:

```
Local graph change → bridge.emitTaskCreated() → MAP notification
                   → bridge.emitTaskStatus()  → MAP notification
```

This is unchanged. The MAP connector adds the **inbound** direction:

```
Remote MAP request → connector.handleNotification() → local daemon query → MAP response
```

## Open Questions

1. **Should the connector run in the daemon process or the sidecar?**
   - Daemon: simpler, direct access to graph store, but requires MAP SDK in daemon
   - Sidecar: already has MAP connection, but adds another IPC hop (MAP → sidecar → daemon IPC → response)
   - **Recommendation**: Sidecar. It already has the MAP connection and the pattern matches trajectory.

2. **Should OpenHive cache remote query results?**
   - Pro: reduces latency for repeated queries
   - Con: stale data, cache invalidation complexity
   - **Recommendation**: No caching initially. Let the event bridge handle real-time updates.

3. **Should the MAP provider in opentasks use the connector or a separate transport?**
   - The MAP provider currently expects a `MAPTaskClient` interface
   - The connector could satisfy this interface
   - **Recommendation**: The connector provides the `send` function; the MAP provider uses it.

4. **Authentication for cross-system queries?**
   - MAP connections are already authenticated
   - Resource-level access control (who can query which graph) could be added later
   - **Recommendation**: Start with scope-based access (any agent in the same MAP scope can query).

## Implementation Order

1. **opentasks**: Create `MAPConnector` (request handler)
2. **cc-swarm**: Register notification handlers in sidecar
3. **cc-swarm**: Declare opentasks capabilities on registration
4. **openhive** (optional): Add hub-side remote query for REST endpoints
5. **opentasks**: Update MAP provider to use connector for remote operations
