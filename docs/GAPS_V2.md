# Sync Protocol — Second-Pass Gaps & Fixes

Follow-up to `GAPS.md` (GAP-1 through GAP-13, all fixed). This covers issues found in the second self-review, prioritized by severity.

---

## Critical

### NEW-1: No transaction boundaries in event insertion + materialization

**File**: `src/sync/service.ts` — `handleIncomingEvents()`, `pullFromPeer()`

**Problem**: Events are inserted into `hive_events` and materialized into `posts`/`comments`/`votes` without a wrapping database transaction. If materialization fails partway (e.g., constraint violation on a comment insert), events are committed but posts/comments are partially applied. The remote peer sees `received_seq` advance, so the events are never retried.

**Fix**: Wrap the insert + materialize sequence in `transaction()` from `src/db/index.ts`. On failure, the entire batch rolls back and can be retried.

**Status**: ✅ Fixed

---

### NEW-2: Race condition in heartbeat loop — concurrent heartbeats overlap

**File**: `src/sync/service.ts` — `runHeartbeatLoop()`

**Problem**: `runHeartbeatLoop()` fires-and-forgets `fetch()` calls for each peer. If a heartbeat takes >30s (the default interval), the next cycle fires before the previous completes. Both cycles update the same peer's `failure_count` and status concurrently, causing out-of-order state transitions and inaccurate backoff calculations.

**Fix**: Add an `isHeartbeatRunning` guard. If the previous cycle hasn't completed, skip the new one.

**Status**: ✅ Fixed

---

### NEW-3: Leave endpoint allows any authenticated peer to delete any other peer

**File**: `src/api/routes/sync-protocol.ts` — `POST /sync/v1/groups/:id/leave`

**Problem**: The leave handler iterates ALL peers in the sync group and deletes the first match on `peerId`. A compromised sync token lets an attacker evict every other peer from the group.

**Fix**: Only allow a peer to remove itself — match the authenticated `syncPeerId` against the requesting peer's own record.

**Status**: ✅ Fixed

---

## Security

### NEW-4: No rate limit on handshake endpoint

**File**: `src/api/routes/sync-protocol.ts` — `POST /sync/v1/handshake`

**Problem**: The handshake route has no rate limiting. Attackers can enumerate sync group names, create unlimited bogus peers, and trigger excessive Ed25519 key generation. The push/pull endpoints have `syncRateLimitMiddleware`, but handshake doesn't.

**Fix**: Add `syncRateLimitMiddleware` to the handshake route.

**Status**: ✅ Fixed

---

### NEW-5: WebSocket broadcasts skip subscriber permission checks

**File**: `src/realtime/index.ts` — `handleMessage()` subscribe handler

**Problem**: `broadcastToChannel("hive:private_hive", ...)` sends events to ALL subscribers without checking hive membership. Non-members subscribed to a private channel receive all events.

**Fix**: Added membership check in subscribe handler: for `hive:*` channels targeting private hives, the client must be authenticated and a member of the hive. Denied subscriptions are reported back to the client. Public hives remain open.

**Status**: ✅ Fixed

---

## Robustness

### NEW-6: Gossip TTL can increase on re-discovery

**File**: `src/sync/gossip.ts` — `processGossipPeers()`

**Problem**: If peer C is learned via gossip with TTL=1, then later peer C sends gossip directly with TTL=3, the TTL increases. No monotonic decrease guard exists, allowing gossip to propagate further than intended in loop scenarios.

**Fix**: On upsert, only update TTL if the new value is lower than the existing one.

**Status**: ✅ Fixed

---

### NEW-7: Vote materialization inserts orphaned votes when target doesn't exist

**File**: `src/sync/materializer.ts` — `materializeVoteCast()`

**Problem**: If `target_id` doesn't match any local post/comment, the original origin ID is used. The vote is inserted against a non-existent row. Score update queries run silently against nothing.

**Fix**: If target resolution fails to find a local row, enqueue the vote as a pending event (same pattern as comment_created).

**Status**: ✅ Fixed

---

### NEW-9: `sync_endpoint` can still be empty string after GAP-13 fix

**File**: `src/sync/service.ts` — `initiateHandshakes()`

**Problem**: `getSyncEndpoint()` returns `this.config.sync_endpoint || ''`. If the config field isn't set, the handshake still sends empty string. The remote peer stores it and later can't push back.

**Fix**: Skip handshake initiation if `sync_endpoint` is not configured, and log a warning.

**Status**: ✅ Fixed

---

## Architecture

### NEW-8: Key rotation support

**File**: `src/sync/crypto.ts`, `src/sync/service.ts`, `src/db/dal/sync-groups.ts`, `src/sync/schema.ts`

**Problem**: Sync groups had a single signing keypair with no version field in events. If a private key was compromised, the only recovery was to create a new sync group (losing all event history).

**Fix**:
- Added schema v15 migration: `key_version`, `previous_signing_key`, `previous_signing_key_private`, `key_rotated_at` columns on `hive_sync_groups`; `key_version` on `hive_events`; `peer_key_version` on `hive_sync_peers`
- Added `verifyEventSignatureMultiKey()` to crypto.ts — tries current + previous keys during transition
- Added `rotateGroupKey()` and `clearPreviousKey()` DAL functions
- Added `SyncService.rotateKey()` method
- Handshake response now includes `key_version`
- Incoming event verification uses multi-key candidates (peer keys + sync group current/previous)

**Status**: ✅ Fixed

---

### NEW-10: Sync layer bypasses the Provider abstraction

**File**: `src/sync/materializer.ts`, `src/sync/materializer-repo.ts` (new)

**Problem**: The materializer made ~15 direct `.prepare()` calls with SQLite-specific SQL. These had to be rewritten for Postgres/Turso support.

**Fix**: Created `MaterializerRepository` interface and `SQLiteMaterializerRepository` implementation that wraps all direct SQL queries. The materializer now calls through `getMaterializerRepo()`, which can be swapped via `setMaterializerRepo()` for different providers or testing. The pending queue processing still uses one direct query for the `hive_events_pending` SELECT — this will be moved to the repository when the Provider layer is fully activated.

**Status**: ✅ Fixed

---

### NEW-11: No sync repositories in the Provider interface

**File**: `src/db/providers/types.ts`

**Problem**: The `DatabaseProvider` interface defined repositories for agents, posts, comments, etc. but had zero coverage for sync tables.

**Fix**: Added four sync repository interfaces to the Provider types:
- `SyncGroupRepository` — CRUD + key rotation + seq management
- `SyncPeerRepository` — peer lifecycle, status, failure tracking
- `SyncEventRepository` — event insertion, querying, dedup, pending management
- `SyncPeerConfigRepository` — config CRUD, heartbeat, failure tracking

All four are added to `DatabaseProvider`. SQLite/Postgres/Turso providers have stub (`null`) implementations until the sync layer is fully migrated to the Provider pattern.

**Status**: ✅ Fixed

---

### NEW-12: Migration system is provider-aware

**File**: `src/db/index.ts`

**Problem**: `runMigrations()` used `db.exec()` with raw SQLite DDL. Postgres/Turso providers had separate migration logic not integrated with the main versioning.

**Fix**: Extracted the migration registry into an exportable constant with helper functions:
- `getMigrationSQL(version)` — returns the canonical SQL for a specific version
- `getMigrationRange(fromVersion, toVersion)` — returns all migrations needed between versions
- `SCHEMA_VERSION` re-exported for providers
- Providers can consume these helpers to build their own dialect-specific migrations while sharing the canonical version→content mapping

**Status**: ✅ Fixed
