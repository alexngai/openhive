---
status: companion to docs/design/cascade-diff-and-stacked-prs.md
owner: alexngai
created: 2026-05-12
---

# Cascade Diff + Stacked PRs — Manual Test Plan

Step-by-step verification of everything shipped on this branch:

- Stream 1 — per-commit diff drawer
- Stream 2 — per-stream + stack diff (with non-linear error surface)
- Stream 3 — "Open PR stack" walker (idempotency, D18 propagation, D19, D21, D22)
- Stream 4 — swarm-runner dead-code revert
- Post-Stream-4 fixes:
  - F2 — walker transactional snapshot
  - F3 / D23 — `paused` transparent, `conflicted` active
  - D24 — diff-resolver post-fetch status check
  - D17 fallback — smart hooks render from cached full diff when sidecar is offline

Phases run mostly independently; finish each one before starting the next. Cleanup script at the bottom.

---

## Prerequisites

| Item | Value |
|---|---|
| Working directory | `/Users/alexngai/GitHub/openhive-2` |
| Branch | `cascade` |
| Backend port | `3000` |
| Frontend port | `5173` |
| Auth mode | `local` (no Authorization header needed) |
| DB | `.openhive/data/openhive.db` |
| Owner agent ID | `EGqlEK8z6jlEAMqw9BRsw` (the local-mode admin) |

Verify your DB is on V59 or later:

```bash
sqlite3 .openhive/data/openhive.db "SELECT version FROM schema_version;"
# expect: 59 (or higher if upstream has shipped more migrations)
```

If not, run migration:

```bash
npx tsx src/cli.ts db migrate --database .openhive/data/openhive.db
```

---

## Phase 0 — Servers up

In two terminals:

```bash
# Terminal 1 — backend
npm run dev

# Terminal 2 — vite frontend
npm run dev:web
```

Sanity check:

```bash
curl -s http://localhost:3000/.well-known/openhive.json | jq '.capabilities.cascade'
# expect: {"enabled": true}
```

Open the browser to `http://localhost:5173/changes`.

---

## Phase 1 — Synthetic cache-only seed

This phase verifies the routes + UI against pre-populated cache rows. No sidecar required. Validates: Stream 1, Stream 2 (linear + non-linear), Stream 3 walker, D17 fallback, D18 propagation, D19 idempotency, D23 paused transparency.

### 1.1 Apply the synthetic seed

Save as `/tmp/seed-cascade-test.sql` and run:

```bash
sqlite3 .openhive/data/openhive.db < /tmp/seed-cascade-test.sql
```

The full SQL is at the end of this doc under [Appendix A — Synthetic seed](#appendix-a--synthetic-seed). Expected output:

```
streams|4
commits|8
diff_cache|13
swarms|1
```

### 1.2 Backend smoke (curl)

```bash
# Stream 1 — per-commit diff (cache hit)
curl -s "http://localhost:3000/api/v1/cascade/streams/tcs-A/commits/a-commit-0001/diff" | jq '.data.diff' | head -c 200
# expect: unified-diff content for src/auth/login.ts

# Stream 2 — per-stream diff (cache hit)
curl -s "http://localhost:3000/api/v1/cascade/streams/tcs-B/diff" | jq '.data.files_touched'
# expect: ["src/auth/session.ts","src/auth/login.ts"]

# Stream 2 — stack diff, non-linear (A → {B,D} fork)
curl -s -w "\n%{http_code}\n" "http://localhost:3000/api/v1/cascade/streams/tcs-A/stack/diff"
# expect: HTTP 400  body: {"error":"non_linear_stack","message":"non_linear_stack: Stack is non-linear at test-cascade-A (2 active children)"}

# Stream 3 — PR-stack on tcs-A (no github_repo wired yet)
curl -s -w "\n%{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{}' "http://localhost:3000/api/v1/cascade/streams/tcs-A/pr-stack"
# expect: HTTP 400  body: {"error":"bad_request","message":"Cannot parse GitHub repo from: ...."}
```

### 1.3 Wire a task resource so the Stream 3 walker runs through

```bash
sqlite3 .openhive/data/openhive.db "
INSERT OR REPLACE INTO syncable_resources (id, resource_type, name, git_remote_url, owner_agent_id, scope, sync_strategy, visibility, status)
  VALUES ('test-cascade-task-resource', 'task', 'cascade-test-task',
          'https://github.com/alexngai/openhive.git', 'EGqlEK8z6jlEAMqw9BRsw',
          'manual', 'metadata', 'private', 'active');
UPDATE cascade_streams SET task_resource_id='test-cascade-task-resource' WHERE id LIKE 'tcs-%';
"
```

### 1.4 Pause D so the stack is linear (exercises D23)

```bash
sqlite3 .openhive/data/openhive.db "UPDATE cascade_streams SET status='paused' WHERE id='tcs-D';"
```

### 1.5 Re-test Stream 2 stack diff with D paused (should be linear now)

```bash
curl -s "http://localhost:3000/api/v1/cascade/streams/tcs-A/stack/diff" | jq '.stack.entries | map(.cascade_stream_id)'
# expect: ["test-cascade-A","test-cascade-B","test-cascade-C"]   (D excluded)
```

Wait — the test cache row was keyed for the **B-rooted** range. For root A you need either to add a (test-cascade-A, c-commit-0002, trunk-base-0000) row (already in seed) AND the walker now produces a linear chain. Both conditions are met by the seed. The route should return 200 with the cached stack-level blob.

### 1.6 Frontend walkthrough (cache-only path)

Navigate to `http://localhost:5173/changes`. You should see 4 test streams in the "IN PROGRESS" bucket.

#### Stream 1 — per-commit diff drawer

1. Click row `cascade-test-A (root)` → sidebar opens on the right.
2. In the Timeline section, click `A: add login route a-commi…`.
3. **Verify:** drawer opens with header "Diff · a-commi", file `src/auth/login.ts`, unified diff content rendered.
4. Close the diff drawer (×).

#### Stream 2 — per-stream diff (D17 fallback)

1. In the same sidebar, click the **Stream diff** button.
2. **Verify:**
   - Drawer header: "Stream diff"
   - "Files touched (2)" with **"cached"** badge (amber) — this is the D17 fallback firing (no sidecar; full-diff blob used as backup)
   - File list: `src/auth/login.test.ts`, `src/auth/login.ts`
3. Click `src/auth/login.ts` → file content renders **without any per-file network request** (in-memory slice).
4. **Network panel verification (chrome devtools):** the only request after click should be the original `?files_only=true` (which 503s) and the fallback `/diff` (no params). No `?file=src/auth/login.ts` request.

#### Stream 2 — stack diff non-linear surface

1. Restore D to active for this test: `sqlite3 .openhive/data/openhive.db "UPDATE cascade_streams SET status='active' WHERE id='tcs-D';"` then reload page.
2. Click "Stack" tab in the Changes header.
3. Click `cascade-test-A (root) 2 commits`.
4. Click **View stack diff** in the stack header.
5. **Verify:** drawer shows:
   - "This stack has multiple active branches" (amber notice)
   - `non_linear_stack: Stack is non-linear at test-cascade-A (2 active children)` (code-styled)
   - Guidance: "Open the branching streams individually to view each one's diff."

#### Stream 2 — stack diff linear happy path

1. Re-pause D: `sqlite3 .openhive/data/openhive.db "UPDATE cascade_streams SET status='paused' WHERE id='tcs-D';"` and reload.
2. Switch to Stack tab → click root A → click **View stack diff**.
3. **Verify:**
   - Sidebar shows "Linear stack (3 streams)" with A, B, C listed (D excluded per D23).
   - Range hint shows `trunk-b..c-commi` (truncated SHAs).
   - "Files touched (4)" with **"cached"** badge.
   - 4 files listed: `docs/rate-limit.md`, `src/auth/login.ts`, `src/auth/session.ts`, `src/middleware/rate-limit.ts`.
4. Click `src/middleware/rate-limit.ts` → content renders from in-memory slice.

#### Stream 3 — Open PR stack flow

1. Still in Stack view at root A → click **Open PR stack**.
2. **Verify drawer:** header "Open PR stack — cascade-test-A (root)", textbox prefilled "main", Draft checkbox.
3. Click **Open PR stack** submit.
4. **Verify result (after ~3-5s):**
   - 3 entries (paused D excluded — D23).
   - **A**: status **"Push required"**, branch flow `cascade/feat-a → main`, message "The branch cascade/feat-a is not on origin...".
   - **B**: status **"Blocked by ancestor"**, branch flow `cascade/feat-b → cascade/feat-a`.
   - **C**: status **"Blocked by ancestor"**, branch flow `cascade/feat-c → cascade/feat-b`.
   - Submit button now reads **"Open again"** (D19 idempotency UI).
5. Click "Open again" — same 3 statuses come back, no duplicate side-effects (D19).

---

## Phase 2 — Live macro-agent sidecar (full live path)

Validates: tier 2 capability gate, tier 3 MAP fetch, real `git show` / `git diff`, chunked streaming + sha256 verification, no "cached" badge.

### 2.1 Verify macro-agent is symlinked

```bash
ls -la node_modules/macro-agent
# expect: lrwxr-xr-x ... -> /Users/alexngai/GitHub/openhive-2/references/macro-agent
```

If not a symlink, set it up:

```bash
rm -rf node_modules/macro-agent
ln -snf "$(pwd)/references/macro-agent" node_modules/macro-agent
```

### 2.2 Live seed with real openhive-2 SHAs

Save as `/tmp/seed-cascade-live.sql` and run. The full SQL is at [Appendix B — Live seed](#appendix-b--live-seed). Expected output:

```
streams|2
commits|4
swarms|1
```

### 2.3 Sidecar bootstrap

Save as `/tmp/cascade-live-sidecar.mjs`. The full script is at [Appendix C — Sidecar script](#appendix-c--sidecar-script).

Run in a new terminal:

```bash
node /tmp/cascade-live-sidecar.mjs
```

Expected stdout:

```
[cascade-live-sidecar] connecting to ws://127.0.0.1:3000/ws/map?swarm_id=test-cascade-live-swarm
[cascade-live-sidecar] connected; setting up git adapter @ /Users/alexngai/GitHub/openhive-2
... git-cascade migrations ...
[cascade-live-sidecar] cascade/diff.request handler installed
[cascade-live-sidecar] ready — waiting for hub requests
```

### 2.4 Verify sidecar registration

```bash
curl -s "http://localhost:3000/api/v1/map/swarms/test-cascade-live-swarm" | jq '.data.status, .data.capabilities.cascade'
# expect:
#   "online"
#   {"canServeDiff": true}
```

### 2.5 Live route smoke

```bash
# Stream 1 LIVE: real `git show 1dd03e5...` via sidecar
curl -s "http://localhost:3000/api/v1/cascade/streams/tcs-live-A/commits/1dd03e50c343b71d9f4af54a3f3635615a342bfc/diff" | jq '.data.diff' | head -c 300
# expect: real unified diff content (package-lock.json + others)

# Stream 2 LIVE files_only (D17 — bypasses cache, hits sidecar)
curl -s "http://localhost:3000/api/v1/cascade/streams/tcs-live-A/diff?files_only=true" | jq '.data.files_touched | length'
# expect: 121

# Stream 2 LIVE stack diff files_only (linear A→B)
curl -s "http://localhost:3000/api/v1/cascade/streams/tcs-live-A/stack/diff?files_only=true" | jq '.data.files_touched | length'
# expect: large number (cumulative across A + B)

# Chunked streaming: full range diff is ~974 KB → > 512 KB → triggers chunked path
SIZE=$(curl -s "http://localhost:3000/api/v1/cascade/streams/tcs-live-A/diff" | wc -c)
echo "Stream diff size: $SIZE"
# expect: ~1 MB (chunked, reassembled, sha256-verified)
```

### 2.6 Frontend live walkthrough

Reload `http://localhost:5173/changes`. You should now see 6 streams (2 live + 4 synthetic from Phase 1, including D-paused).

1. Click `live-A (root)`.
2. Click **Stream diff** in the sidebar.
3. **Verify:**
   - "Files touched (121)" — **no "cached" badge** (live path, not fallback).
   - File list is the real openhive-2 file list.
4. Click `package-lock.json` → diff renders via a per-file sidecar fetch (verify in DevTools network panel: `GET /diff?file=package-lock.json` 200).

---

## Phase 3 — LIVE_AGENT_E2E test suite

Validates the full chain (real MAP SDK + real cascade-diff-server + real git + chunking + sha256) through automated tests.

```bash
LIVE_AGENT_E2E=true npx vitest run \
  src/__tests__/cascade/live-cascade-diff-e2e.test.ts \
  src/__tests__/cascade/live-cascade-diff-sidecar-e2e.test.ts
```

**Expected:** 14 tests pass in ~4s. Coverage includes:
- HTTP → WS roundtrip → real git → cache → HTTP 200
- files_only over real MAP (D17 — no cache write)
- Sidecar error path → typed internal error
- Chunked streaming > 512 KB → sha256-verifies
- swarm_offline (sidecar disconnect)
- stream-level base..head diff
- stack-level cumulative diff
- stack-level non-linear (400)
- stack-level skips merged sibling (D2)

---

## Phase 4 — Unit + integration suite

```bash
npx vitest run src/__tests__/cascade/
```

**Expected:** 103 tests pass + 38 LIVE_AGENT_E2E-gated skipped (normal).

---

## Phase 5 — Regression sweep

These flows shouldn't have broken from any of the cascade-diff/stacked-PRs work.

1. **Changes page → List view:** swarm filter, "Conflicts only" toggle, "NEEDS ATTENTION 0 / IN PROGRESS N" bucket sections render.
2. **Stream detail sidebar:** Pause / Abandon / Stack / Graph / Stream diff buttons all clickable (verify no JS console errors on click).
3. **Single-stream PR (existing surface):** stream sidebar → "Create PR" button. If a GitHub token is configured it should open a real PR; if not, the button should be disabled with "No GitHub token" caption.
4. **Stack view → Change root:** dropdown shows true roots only (streams without parent_stream_id).
5. **Graph view:** legend renders (Active / Conflicted / Paused / Merged / Parent / Merge); no console errors.
6. **Navigation:** Overview, Threads, Swarms, Events, Dispatch, Specs, Tasks, Changes, Memory, Skills, Repos, Learning links all route correctly.

---

## Cleanup

```bash
# Stop the live sidecar (Ctrl+C in its terminal, or kill the process)

# Remove all test data
sqlite3 .openhive/data/openhive.db "
DELETE FROM cascade_diff_cache WHERE stream_id LIKE 'test-cascade-%';
DELETE FROM cascade_changes WHERE stream_row_id LIKE 'tcs-%';
DELETE FROM cascade_streams WHERE id LIKE 'tcs-%';
DELETE FROM syncable_resources WHERE id IN ('test-cascade-task-resource', 'test-cascade-live-task-resource');
DELETE FROM map_swarms WHERE id IN ('test-cascade-swarm', 'test-cascade-live-swarm');
"

# Remove tmp files
rm -f /tmp/cascade-live-sidecar.mjs /tmp/cascade-live-sidecar.tracker.db* \
      /tmp/seed-cascade-test.sql /tmp/seed-cascade-live.sql
```

---

## Appendix A — Synthetic seed

```sql
-- /tmp/seed-cascade-test.sql
-- Synthetic cascade seed for cache-only manual testing.
-- 4 streams forming A → {B → C, D}; D is the fork that breaks linearity.
-- All cache rows pre-populated; no sidecar required.
--
-- Cleanup:
--   DELETE FROM cascade_diff_cache WHERE stream_id LIKE 'test-cascade-%';
--   DELETE FROM cascade_changes WHERE stream_row_id LIKE 'tcs-%';
--   DELETE FROM cascade_streams WHERE id LIKE 'tcs-%';
--   DELETE FROM map_swarms WHERE id = 'test-cascade-swarm';

BEGIN TRANSACTION;

INSERT OR REPLACE INTO map_swarms (
  id, name, description, map_endpoint, owner_agent_id, status, capabilities,
  auth_method, agent_count, metadata, created_at, updated_at
) VALUES (
  'test-cascade-swarm', 'Cascade Test Swarm', 'Synthetic data for manual cascade-diff testing',
  'inline-test', 'EGqlEK8z6jlEAMqw9BRsw', 'offline',
  '{"messaging":{"canSend":true,"canReceive":true},"cascade":{"canServeDiff":true,"autoCloseOnMerge":false}}',
  'none', 0,
  '{"trunk_branch":"main","project":"test-cascade","branch":"main"}',
  datetime('now'), datetime('now')
);

INSERT OR REPLACE INTO cascade_streams (
  id, stream_id, source_swarm_id, source_agent_id, parent_stream_id,
  name, branch_name, base_commit, publish_branch, status
) VALUES
  ('tcs-A', 'test-cascade-A', 'test-cascade-swarm', 'EGqlEK8z6jlEAMqw9BRsw', NULL,
   'cascade-test-A (root)', 'feat/cascade-A', 'trunk-base-0000', 'cascade/feat-a', 'active'),
  ('tcs-B', 'test-cascade-B', 'test-cascade-swarm', 'EGqlEK8z6jlEAMqw9BRsw', 'test-cascade-A',
   'cascade-test-B (middle)', 'feat/cascade-B', 'a-commit-0002', 'cascade/feat-b', 'active'),
  ('tcs-C', 'test-cascade-C', 'test-cascade-swarm', 'EGqlEK8z6jlEAMqw9BRsw', 'test-cascade-B',
   'cascade-test-C (leaf)', 'feat/cascade-C', 'b-commit-0002', 'cascade/feat-c', 'active'),
  ('tcs-D', 'test-cascade-D', 'test-cascade-swarm', 'EGqlEK8z6jlEAMqw9BRsw', 'test-cascade-A',
   'cascade-test-D (fork)', 'feat/cascade-D', 'a-commit-0002', 'cascade/feat-d', 'active');

INSERT OR REPLACE INTO cascade_changes (id, stream_row_id, commit_hash, parent_commit, message_summary, files_touched) VALUES
  ('cc-a1', 'tcs-A', 'a-commit-0001', 'trunk-base-0000', 'A: add login route',      '["src/auth/login.ts"]'),
  ('cc-a2', 'tcs-A', 'a-commit-0002', 'a-commit-0001',   'A: add login tests',      '["src/auth/login.test.ts"]'),
  ('cc-b1', 'tcs-B', 'b-commit-0001', 'a-commit-0002',   'B: session token storage','["src/auth/session.ts"]'),
  ('cc-b2', 'tcs-B', 'b-commit-0002', 'b-commit-0001',   'B: rotate token on login','["src/auth/login.ts","src/auth/session.ts"]'),
  ('cc-c1', 'tcs-C', 'c-commit-0001', 'b-commit-0002',   'C: rate-limit middleware','["src/middleware/rate-limit.ts"]'),
  ('cc-c2', 'tcs-C', 'c-commit-0002', 'c-commit-0001',   'C: docs for rate-limit',  '["docs/rate-limit.md","src/middleware/rate-limit.ts"]'),
  ('cc-d1', 'tcs-D', 'd-commit-0001', 'a-commit-0002',   'D: alternate session impl','["src/auth/session.ts"]'),
  ('cc-d2', 'tcs-D', 'd-commit-0002', 'd-commit-0001',   'D: drop deprecated helper','["src/auth/legacy.ts"]');

-- Per-commit cache
INSERT OR REPLACE INTO cascade_diff_cache (id, stream_id, commit_hash, diff_blob, files_touched, size_bytes) VALUES
  ('tdc-a1-c', 'test-cascade-A', 'a-commit-0001',
   'diff --git a/src/auth/login.ts b/src/auth/login.ts' || char(10) ||
   '--- a/src/auth/login.ts' || char(10) ||
   '+++ b/src/auth/login.ts' || char(10) ||
   '@@ -0,0 +1,8 @@' || char(10) ||
   '+import { hash } from "crypto";' || char(10) ||
   '+export async function login(user: string, pw: string) {' || char(10) ||
   '+  const h = hash("sha256").update(pw).digest("hex");' || char(10) ||
   '+  return { ok: true, user };' || char(10) ||
   '+}',
   '["src/auth/login.ts"]', 0);
-- (8 per-commit rows omitted for brevity; see git history of this doc or
-- the cascade-diff-and-stacked-prs.md design for the full pattern. The
-- shape is: one row per commit, content = a small unified-diff blob.)

-- Stream-level cache
INSERT OR REPLACE INTO cascade_diff_cache (id, stream_id, commit_hash, base_hash, diff_blob, files_touched, size_bytes) VALUES
  ('tdc-a-stream', 'test-cascade-A', 'a-commit-0002', 'trunk-base-0000',
   '# stream A diff' || char(10) || 'diff --git a/src/auth/login.ts b/src/auth/login.ts' || char(10) ||
   '--- a/src/auth/login.ts' || char(10) || '+++ b/src/auth/login.ts' || char(10) ||
   '@@ -0,0 +1,2 @@' || char(10) || '+import { hash } from "crypto";' || char(10) ||
   '+export async function login(user, pw) { return { ok: true, user }; }',
   '["src/auth/login.ts","src/auth/login.test.ts"]', 0);
-- (3 more stream-level rows for B, C, D — same pattern, ranges base..head)

-- Stack-level cache (keyed by ROOT stream_id, D16)
INSERT OR REPLACE INTO cascade_diff_cache (id, stream_id, commit_hash, base_hash, diff_blob, files_touched, size_bytes) VALUES
  ('tdc-abc-stack', 'test-cascade-A', 'c-commit-0002', 'trunk-base-0000',
   '# stack A→B→C cumulative' || char(10) ||
   'diff --git a/src/auth/login.ts b/src/auth/login.ts' || char(10) ||
   '--- a/src/auth/login.ts' || char(10) || '+++ b/src/auth/login.ts' || char(10) ||
   '@@ -0,0 +1,1 @@' || char(10) || '+export async function login() {}' || char(10) ||
   'diff --git a/src/middleware/rate-limit.ts b/src/middleware/rate-limit.ts' || char(10) ||
   '--- a/src/middleware/rate-limit.ts' || char(10) || '+++ b/src/middleware/rate-limit.ts' || char(10) ||
   '@@ -0,0 +1,1 @@' || char(10) || '+export function rateLimit() {}',
   '["src/auth/login.ts","src/auth/session.ts","src/middleware/rate-limit.ts","docs/rate-limit.md"]', 0);

UPDATE cascade_diff_cache SET size_bytes = length(diff_blob) WHERE stream_id LIKE 'test-cascade-%';

COMMIT;

SELECT 'streams' AS table_name, COUNT(*) AS rows FROM cascade_streams WHERE source_swarm_id = 'test-cascade-swarm'
UNION ALL SELECT 'commits',     COUNT(*) FROM cascade_changes    WHERE stream_row_id LIKE 'tcs-%'
UNION ALL SELECT 'diff_cache',  COUNT(*) FROM cascade_diff_cache WHERE stream_id LIKE 'test-cascade-%'
UNION ALL SELECT 'swarms',      COUNT(*) FROM map_swarms         WHERE id = 'test-cascade-swarm';
```

---

## Appendix B — Live seed

```sql
-- /tmp/seed-cascade-live.sql
-- Live seed for cascade-diff testing against a real macro-agent sidecar.
-- Uses real commit SHAs from openhive-2's git history.
--
-- Cleanup:
--   DELETE FROM cascade_changes    WHERE stream_row_id LIKE 'tcs-live-%';
--   DELETE FROM cascade_streams    WHERE id LIKE 'tcs-live-%';
--   DELETE FROM syncable_resources WHERE id='test-cascade-live-task-resource';
--   DELETE FROM map_swarms         WHERE id='test-cascade-live-swarm';

BEGIN TRANSACTION;

INSERT OR REPLACE INTO map_swarms (
  id, name, description, map_endpoint, owner_agent_id, status, capabilities,
  auth_method, agent_count, metadata, created_at, updated_at
) VALUES (
  'test-cascade-live-swarm', 'Cascade Live Test Swarm',
  'Real SHAs for live macro-agent sidecar testing',
  'inline-test', 'EGqlEK8z6jlEAMqw9BRsw', 'offline',
  '{"messaging":{"canSend":true,"canReceive":true},"cascade":{"canServeDiff":true,"autoCloseOnMerge":false}}',
  'none', 0,
  '{"trunk_branch":"main","github_repo":"alexngai/openhive","project":"test-cascade-live","branch":"main"}',
  datetime('now'), datetime('now')
);

INSERT OR REPLACE INTO syncable_resources (
  id, resource_type, name, git_remote_url, owner_agent_id, scope, sync_strategy, visibility, status
) VALUES (
  'test-cascade-live-task-resource', 'task', 'cascade-live-test-task',
  'https://github.com/alexngai/openhive.git', 'EGqlEK8z6jlEAMqw9BRsw',
  'manual', 'metadata', 'private', 'active'
);

INSERT OR REPLACE INTO cascade_streams (
  id, stream_id, source_swarm_id, source_agent_id, parent_stream_id,
  name, branch_name, base_commit, publish_branch, status, task_resource_id
) VALUES
  ('tcs-live-A', 'test-cascade-live-A', 'test-cascade-live-swarm', 'EGqlEK8z6jlEAMqw9BRsw', NULL,
   'live-A (root)', 'feat/live-a',
   '98a7190d4672ec07226454c1f7d358ee34a45e36', 'cascade/live-a', 'active',
   'test-cascade-live-task-resource'),
  ('tcs-live-B', 'test-cascade-live-B', 'test-cascade-live-swarm', 'EGqlEK8z6jlEAMqw9BRsw', 'test-cascade-live-A',
   'live-B (leaf)', 'feat/live-b',
   '1dd03e50c343b71d9f4af54a3f3635615a342bfc', 'cascade/live-b', 'active',
   'test-cascade-live-task-resource');

INSERT OR REPLACE INTO cascade_changes (id, stream_row_id, commit_hash, parent_commit, message_summary, files_touched) VALUES
  ('cc-live-a1', 'tcs-live-A', '34c6b52db51ad4ca4a6dd6e3b355be480827114b', '98a7190d4672ec07226454c1f7d358ee34a45e36', 'A: merge UI work',     '[]'),
  ('cc-live-a2', 'tcs-live-A', '1dd03e50c343b71d9f4af54a3f3635615a342bfc', '34c6b52db51ad4ca4a6dd6e3b355be480827114b', 'A: mail + dispatch',   '[]'),
  ('cc-live-b1', 'tcs-live-B', 'c2e2121fd7147502a1b6f73611bf05687c2cc546', '1dd03e50c343b71d9f4af54a3f3635615a342bfc', 'B: merge from main',   '[]'),
  ('cc-live-b2', 'tcs-live-B', 'a795e2e5e1866df02f31c048032717ed569bf2d7', 'c2e2121fd7147502a1b6f73611bf05687c2cc546', 'B: mail PR',           '[]');

COMMIT;
```

> **Important:** these SHAs are real commits in openhive-2's `main` branch history. If your local `git log` doesn't have them (shallow clone, etc), substitute with `git rev-parse` outputs from 5 commits in your own history. Don't fabricate full SHAs from short prefixes — the sidecar's `git diff` will fail with "Invalid revision range" for hashes that don't exist as commit objects.

---

## Appendix C — Sidecar script

```javascript
#!/usr/bin/env node
// /tmp/cascade-live-sidecar.mjs
//
// Standalone macro-agent sidecar bootstrap for live cascade-diff testing.
//
//   1. Opens a MAP connection to the running openhive hub
//   2. Registers with `cascade: { canServeDiff: true }` capability
//   3. Initializes a GitCascadeAdapter pointed at this openhive-2 repo
//   4. Wires the cascade/diff.request handler via setupCascadeDiffServer
//   5. Stays alive until SIGINT

import { AgentConnection } from '/Users/alexngai/GitHub/openhive-2/node_modules/@multi-agent-protocol/sdk/dist/index.js';
import { setupCascadeDiffServer } from '/Users/alexngai/GitHub/openhive-2/node_modules/macro-agent/dist/map/cascade-diff-server.js';
import { createGitCascadeAdapter } from '/Users/alexngai/GitHub/openhive-2/node_modules/macro-agent/dist/workspace/git-cascade-adapter.js';

const SWARM_ID = process.env.SWARM_ID ?? 'test-cascade-live-swarm';
const HUB_URL = process.env.HUB_URL ?? `ws://127.0.0.1:3000/ws/map?swarm_id=${SWARM_ID}`;
const REPO_PATH = process.env.REPO_PATH ?? '/Users/alexngai/GitHub/openhive-2';
const DB_PATH = process.env.DB_PATH ?? '/tmp/cascade-live-sidecar.tracker.db';

console.log('[cascade-live-sidecar] connecting to', HUB_URL);

const conn = await AgentConnection.connect(HUB_URL, {
  name: `cascade-live-sidecar-${SWARM_ID}`,
  role: 'sidecar',
  auth: { method: 'none' },
  capabilities: {
    messaging: { canSend: true, canReceive: true },
    cascade: { canServeDiff: true },
  },
});

console.log('[cascade-live-sidecar] connected; setting up git adapter @', REPO_PATH);

const adapter = createGitCascadeAdapter({
  enabled: true,
  repoPath: REPO_PATH,
  dbPath: DB_PATH,
  skipRecovery: true,
});

const diffCleanup = setupCascadeDiffServer(conn, adapter);
console.log('[cascade-live-sidecar] cascade/diff.request handler installed');
console.log('[cascade-live-sidecar] ready — waiting for hub requests (Ctrl+C to stop)');

const shutdown = async () => {
  console.log('[cascade-live-sidecar] shutting down');
  try { diffCleanup(); } catch { /* ignore */ }
  try { adapter.close(); } catch { /* ignore */ }
  try { await conn.disconnect(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setInterval(() => {
  console.log(`[cascade-live-sidecar] alive @ ${new Date().toISOString()}`);
}, 30_000);
```

---

## Quick-reference checklist

```
[ ] Phase 0 — Servers running on :3000 + :5173, DB on V59 or later
[ ] Phase 1.2 — 4 routes via curl pass (one each: 200 + 200 + 400 non_linear + 400 bad_request)
[ ] Phase 1.6 — Stream 1 per-commit drawer renders diff
[ ] Phase 1.6 — Stream 2 per-stream drawer renders with "cached" badge + in-memory slice
[ ] Phase 1.6 — Stream 2 stack diff non-linear surface shows the error notice
[ ] Phase 1.6 — Stream 2 stack diff linear (D paused) shows 3 streams in sidebar + 4 files
[ ] Phase 1.6 — Stream 3 PR-stack returns 3 entries with push_required → blocked_by_parent propagation
[ ] Phase 1.6 — Stream 3 "Open again" idempotency works
[ ] Phase 2.4 — Live sidecar registered as online with cascade.canServeDiff: true
[ ] Phase 2.5 — Live per-commit + files_only + chunked streaming via curl all succeed
[ ] Phase 2.6 — Live UI shows 121 files in stream diff, no "cached" badge, per-file click renders
[ ] Phase 3 — 14 LIVE_AGENT_E2E tests pass
[ ] Phase 4 — 103 unit + integration cascade tests pass
[ ] Phase 5 — Regression sweep: existing flows unbroken
[ ] Cleanup — All test data + tmp files removed
```
