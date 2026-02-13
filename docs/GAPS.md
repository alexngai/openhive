# Sync Protocol — Known Gaps & Fixes

Tracking document for issues identified in the OpenHive cross-instance sync protocol.

---

## Critical (blocks multi-instance sync)

### GAP-3: `pushToPeer` uses local sync_group_id as remote URL path

**File**: `src/sync/service.ts` — `pushToPeer()`

**Problem**: Push requests target `/groups/${syncGroupId}/events` using the **local** sync group ID. The remote instance has its own ID for the same sync group (generated independently via `nanoid`). Pushes will 404.

**Fix**: Store the remote peer's `sync_group_id` (returned during handshake) in `hive_sync_peers` and use it when constructing push/pull URLs.

**Status**: ✅ Fixed

---

### GAP-4: Heartbeat requests are sent without Authorization header

**File**: `src/sync/service.ts` — `runHeartbeatLoop()`

**Problem**: Heartbeat `fetch()` calls omit the `Authorization: Bearer <token>` header, but the `/sync/v1/heartbeat` endpoint requires `syncAuthMiddleware`. All heartbeats receive 401 responses.

**Fix**: Include the peer's `sync_token` in heartbeat request headers.

**Status**: ✅ Fixed

---

### GAP-13: `sync_endpoint` sent as empty string during handshake initiation

**File**: `src/sync/service.ts` — `initiateHandshakes()`

**Problem**: Both branches of the ternary produce `''`. The remote peer can't push events back without knowing our sync endpoint.

**Fix**: Accept a `syncEndpoint` config option and pass it through during handshake.

**Status**: ✅ Fixed

---

## Security

### GAP-1: Signature verification silently skipped for unknown origins

**File**: `src/sync/service.ts` — `handleIncomingEvents()`

**Problem**: If the origin instance's public key is missing from the `peerKeyMap`, the event is accepted without verification. In multi-hop gossip scenarios, relayed events routinely skip verification.

**Fix**: Reject events whose origin signing key is unknown, and log a warning so operators can investigate.

**Status**: ✅ Fixed

---

### GAP-2: Handshake endpoint is completely unauthenticated

**File**: `src/api/routes/sync-protocol.ts` — `POST /handshake`

**Problem**: No authentication on the bootstrap endpoint. Any party can claim any `instance_id`, enumerate sync groups by name, and register bogus peers.

**Fix**: Add optional pre-shared key verification to the handshake. When `sync.handshake_secret` is configured, require it in the `X-Handshake-Secret` header.

**Status**: ✅ Fixed

---

## Robustness

### GAP-5: Sequential push to all peers blocks on network I/O

**File**: `src/sync/service.ts` — `pushToAllPeers()`

**Problem**: Peers are pushed sequentially. A slow/timing-out peer (10s) cascades delay to all subsequent peers.

**Fix**: Use `Promise.allSettled()` for parallel fan-out.

**Status**: ✅ Fixed

---

### GAP-6: No backoff or circuit breaker for failed peers

**File**: `src/sync/service.ts` — `pushToAllPeers()`, `runHeartbeatLoop()`

**Problem**: Failed peers are marked `'error'` but retried every heartbeat cycle (30s) indefinitely. No backoff, no circuit breaker.

**Fix**: Track consecutive failure count. Skip peers in heartbeat/push based on exponential backoff (2^failures heartbeat cycles, capped). Transition to `'unreachable'` after max failures.

**Status**: ✅ Fixed

---

### GAP-7: Rate limiter memory leak

**File**: `src/sync/middleware.ts`

**Problem**: `peerRequestCounts` Map grows with every unique peer identity and never shrinks.

**Fix**: Add periodic cleanup of expired entries.

**Status**: ✅ Fixed

---

### GAP-8: Heartbeat sender matching is fragile

**File**: `src/sync/service.ts` — `handleHeartbeat()`

**Problem**: Matches sender by `sc.name === input.instance_id`. `name` is a user-provided display name; `instance_id` is a system identifier. These rarely match.

**Fix**: Match by peer endpoint or by a dedicated `instance_id` field stored during handshake.

**Status**: ✅ Fixed

---

### GAP-9: No deduplication of incoming events in `handleIncomingEvents`

**File**: `src/sync/service.ts` — `handleIncomingEvents()`

**Problem**: Events in a push batch are inserted without checking for duplicates. Retried pushes can cause errors or double-materialization.

**Fix**: Check for existing events by `(sync_group_id, origin_instance_id, id)` before inserting.

**Status**: ✅ Fixed

---

### GAP-10: `pullFromPeer` doesn't verify event signatures

**File**: `src/sync/service.ts` — `pullFromPeer()`

**Problem**: Pulled events are inserted and materialized without any signature verification, unlike the push path.

**Fix**: Apply the same signature verification logic used in `handleIncomingEvents`.

**Status**: ✅ Fixed

---

### GAP-11: No conflict resolution for concurrent edits

**File**: `src/sync/materializer.ts`

**Problem**: Concurrent `post_updated`/`comment_updated` events — last materialized wins. No timestamp comparison.

**Fix**: Use last-writer-wins with `origin_ts` comparison. Only apply the update if the incoming event is newer than the current `updated_at`.

**Status**: ✅ Fixed

---

### GAP-12: Pending event queue has no maximum depth

**File**: `src/sync/materializer.ts`, `src/sync/service.ts`

**Problem**: `hive_events_pending` grows without bound if dependencies are never satisfied. Hourly cleanup removes >24h entries, but burst orphans can cause pressure.

**Fix**: Add a per-sync-group cap (default 1000). Drop oldest pending events when cap exceeded.

**Status**: ✅ Fixed
