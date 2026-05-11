---
status: stream-1-shipped
owner: alexngai
created: 2026-05-05
revised: 2026-05-11
---

# Cascade Diff Browsing + Stacked PRs

Bring PR-style diff review into openhive so users can coordinate agents to produce git stacks and open PRs without leaving the UI for code-viewing. Comments / approvals stay on GitHub; openhive owns the "see the change, open the PR(s)" surface.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[?]` blocked / needs decision

---

## Scope

**In:**
- View diffs at three levels: per-commit, per-stream (`base_commit..HEAD`), per-stack (cumulative across parent chain).
- Stack view enhancements — diff-on-click, "Open PR stack" action.
- Stacked PR creation — one PR per stream, base = parent stream's branch.
- Local-vs-remote split: every diff routed through MAP (uniform).

**Out (deferred):**
- Comments, threads, approvals, review states — defer to GitHub.
- Subset collapse (multiple streams → one PR via `mergeReviewBlocks`).
- gzip compression in chunker.
- Auto-push on commit.

---

## Decisions made

- **D1**: **All PR creation lives on openhive** (hub-side). macro-agent's `_macro/diffStacks/createPR` stub is deprecated — it predated the hub-side PR endpoint at `src/api/routes/cascade.ts:537+`.
- **D2**: **Diff serving lives on macro-agent** via raw `git show` / `git diff` in stream worktrees. No git library; shell-out only.
- **D3**: **Uniform MAP-only fetching path.** No local-filesystem optimization for hosted swarms in v1. Add later if latency complaints surface.
- **D4**: **Reuse trajectory chunking** (`src/map/sync-client.ts:478-535`). Inline ≤512 KB; chunked above at 1 MB chunks; base64 in JSON-RPC notifications.
- **D5**: **Bump diff-request timeout to 60s** (vs trajectory's 10s at `src/map/trajectory-content.ts:21`). Diff-specific; don't change trajectory.
- **D6**: **Cache by `(stream_id, commit_hash, base_hash, file_path?)`** in a new `cascade_diff_cache` table. Content-addressed → immutable entries. Eviction by stream lifecycle (drop on `merged`/`abandoned`/`rebased`).
- **D7**: **Cache schema includes flexibility columns from day one** — `last_accessed_at`, `size_bytes`, `compression DEFAULT 'none'`. Unused at launch; cheap to add now.
- **D8**: **Offline-agent PR path = Option C** — hub checks if branch exists on GitHub via Octokit; if yes, opens PR directly without involving agent. If not, returns `push_required` per stream. Auto-push (Option D) deferred.
- **D9**: **Stack-of-PRs walker is server-side** in openhive. Toposort descendants from a root via existing `getStreamDAG` (`src/db/dal/cascade-streams.ts:1274`), filter unmerged, call existing per-stream `POST /cascade/streams/:id/pr` path with `base = parent.publish_branch || parent.branch_name || trunk_default`.
- **D10**: **Diff renderer = `react-diff-viewer-continued`** (or equivalent). Lazy per-file fetch on stack diffs; large-file collapse with expand-on-click.
- **D11**: **Defer compression**, but ship `compression` column so we can flip it on per-entry without migration when needed.
- **D12** *(new)*: **Diff request uses a request/response notification pair**, mirroring `src/map/trajectory-content.ts`. The existing `src/map/cascade-actions.ts` channel is fire-and-forget notifications only and is the wrong shape; the new `cascade/diff.request` + `cascade/diff.chunk` pair installs separately on the bridge.
- **D13** *(revised 2026-05-11)*: **Migration slot is V56** (`V56_CASCADE_DIFF_CACHE`). The original V37 slot was used for `cascade_operations`; V38 = `cascade_pushes_and_queue`, V39 = `cascade_pr`; V40–V55 also taken. V56 is the next free slot after V55_DISPATCH_CONVERSATION. Schema version bumped 55 → 56. No `repairSchema` entry (matches V36–V39 cascade-lineage convention; ALTER-style repairs don't help brand-new tables).
- **D14** *(new)*: **Worktree resolution from stream id is solved by `adapter.listWorktrees().find(wt => wt.currentStream === streamId)`**, already used by `references/macro-agent/src/map/cascade-action-handler.ts:60-64`. Fallback when no live worktree: shell out against the bare repo via `adapter.getRepoPath()` (commit-level diffs don't need a checkout). OD1 closed.
- **D15** *(new)*: **Cache key includes `file_path`**. Per-file requests dominate (the file tree in Stream 2 fetches lazily) so caching `(stream, commit, base, file)` rows wins over caching the whole-commit blob and slicing. Whole-commit fetches stay rare; revisit only if sidecar shell-out cost shows up under load.
- **D16** *(new)*: **Stack diff range = `lowest_base..highest_head`**, computed once and fed through the single-range MAP protocol. Assumes the stack is a linear chain — which is the only shape stacked PRs make sense for. Walker rejects non-linear stacks with **HTTP 400 `non_linear_stack`**; the UI surfaces it as "this view requires a linear stack". Branching stacks are not a v1 concern.
- **D17** *(new)*: **`cascade/diff.request` carries an optional `files_only: true` param.** When set, the sidecar runs `git diff --name-only base..head -- <files>` and returns `{ streaming: false, files_touched, diff: '' }` without producing a blob. Folds the file-tree query into the existing method instead of adding a separate `cascade/files.request`. Resolver also short-circuits the cache when `files_only` is set — files-touched is cheap enough to recompute that an extra cache column isn't worth it.
- **D18** *(new)*: **Stack-PR walker is sequential and propagates `push_required` to descendants as `blocked_by_parent`.** A stack `A → B → C` where A isn't pushed means B's `base` (= A's `head_branch`) doesn't exist on origin either; GitHub would reject B with "base does not exist". The walker stops walking past the first `push_required` *for that lineage* — siblings of a different parent can still proceed. Surface lineage status as `created | existing | push_required | blocked_by_parent | failed`.
- **D19** *(new)*: **Walker consults `getPRForStream(stream.id)` before acting**, returning `status='existing'` with the cached `pr_url` instead of re-POSTing. Makes stack-PR runs idempotent — second invocation after a partial failure only acts on unmerged-unopened entries. Also catch GitHub 422 (duplicate-PR-for-branch) by looking up the open PR via `pulls?head=…&state=open` and treating as `existing`; otherwise users see "failed" cards for what was a race.

---

## Open decisions

- **OD2**: Chunker factoring — copy-paste from `sync-client.ts` in Phase 1, or factor `src/map/chunked-rpc.ts` upfront? Lean: copy in Phase 1, factor in Phase 4 (unchanged).
- **OD3**: Trunk default per swarm — read from `swarm.metadata.trunk_branch` first; fall back to `'main'`. Decide whether to surface in Settings UI.

---

## Protocol — `cascade/diff.request`

Mirrors `trajectory/content.request`. Hub → agent. Implemented as a JSON-RPC **notification** carrying a `request_id`; the runtime responds with a `cascade/diff.response` notification (inline) or a `cascade/diff.response` + N `cascade/diff.chunk` notifications (streamed). The hub's reassembler keys on `request_id`.

```ts
// Request notification
{
  method: "cascade/diff.request",
  params: {
    request_id: string,
    stream_id: string,
    head: string,            // commit SHA
    base?: string,           // SHA; defaults to head's parent for single-commit
    file_paths?: string[],   // optional file scope
    files_only?: boolean,    // D17: skip blob, return files_touched only
    format: 'unified',
  }
}

// Response notification — inline (≤ 512 KB raw)
{
  method: "cascade/diff.response",
  params: {
    request_id: string,
    streaming: false,
    diff: string,            // unified diff text
    files_touched: string[],
    truncated: boolean,
  }
}

// Response notification — streamed (> 512 KB raw)
{
  method: "cascade/diff.response",
  params: {
    request_id: string,
    streaming: true,
    chunk_stream_id: string,
    total_size: number,
    files_touched: string[],
  }
}

// Followed by N chunk notifications:
{
  method: "cascade/diff.chunk",
  params: {
    chunk_stream_id: string,
    seq: number,
    data: string,            // base64
    final?: boolean,
    sha256?: string,         // on final
  }
}
```

Timeout: 60s for the initial response. Chunks delivered as fire-and-forget after; reassembler tracks `seq` for ordering and `sha256` for integrity.

---

## Stream 1 — Diff plumbing (single commit, single file)

**Status: ✅ Complete (2026-05-11).** Hub resolver + MAP protocol + macro-agent diff server + frontend drawer all shipped and verified end-to-end. 74 unit/integration tests (1 hub suite + 1 macro-agent suite) + 3 LIVE_AGENT_E2E tests + manual live verification against running fastify + Vite proxy. Real bugs caught: V56 migration slot, fresh-install CREATE_TABLES gap, getDiff stale-timestamp, missing error-response shape in protocol, listener-attach race on live WS.

Goal: open a stream in `Changes.tsx`, click a commit, see a unified diff for one file fetched via raw `git show` over MAP.

### Backend (openhive)
- [x] Migration `V56_CASCADE_DIFF_CACHE` in `src/db/schema.ts` + registry entry in `src/db/index.ts`
  - Columns: `id`, `stream_id`, `commit_hash`, `base_hash NULL`, `file_path NULL`, `diff_blob TEXT`, `files_touched JSON`, `size_bytes`, `compression DEFAULT 'none'`, `created_at`, `last_accessed_at`
  - Unique on `(stream_id, commit_hash, IFNULL(base_hash, ''), IFNULL(file_path, ''))` (SQLite NULL-safe via IFNULL)
  - Indexes on `stream_id` and `last_accessed_at` (future LRU sweep)
  - SCHEMA_VERSION bumped 55 → 56
  - Also added to `CREATE_TABLES` so fresh installs (which skip the migration runner) get the table
- [x] DAL `src/db/dal/cascade-diff-cache.ts` — `getDiff`, `putDiff`, `evictByStream`, `touchAccess`, `countDiffsForStream`. `getDiff` re-reads after `touchAccess` so the returned row reflects the bumped timestamp.
- [x] `src/cascade/diff-types.ts` — `CASCADE_DIFF_METHODS` constants, request/response/chunk types, error-response variant (`CascadeDiffErrorResponse`), `DiffPayload` / `DiffError` / `DiffResult`, tuning constants (`DIFF_INLINE_THRESHOLD_BYTES`, `DIFF_CHUNK_SIZE_BYTES`, `DIFF_REQUEST_TIMEOUT_MS`, `DIFF_MAX_RAW_BYTES`).
- [x] `src/cascade/diff-resolver.ts` — five-tier resolver with a swappable `MapDiffFetcher`. Tier 1 cache, tier 2 presence + capability gate, tiers 3/4 delegated to the fetcher, tier 5 cache write-through. `files_only` requests bypass the cache (D17).
- [x] `src/api/routes/cascade.ts` — `GET /cascade/streams/:id/commits/:hash/diff?file=...&base=...&files_only=true` + `diffErrorStatus` HTTP-status mapper covering all 7 `DiffErrorCode` values.
- [x] `src/map/cascade-diff-protocol.ts` — `sendDiffRequest` (outbound), `handleDiffResponse` (inline / streaming / error), `handleDiffChunk` (assembly + sha256 verify), `installAsResolverFetcher` (idempotent bootstrap). Pending state keyed on `request_id`; chunk routing via `chunk_stream_id → request_id` map. Wired into `src/server.ts` next to `startTaskBinder`.
- [x] `src/map/ws-map.ts` — dispatch branches for `CASCADE_DIFF_METHODS.RESPONSE` and `.CHUNK` in the existing notification interceptor.
- [x] Stream-terminal hooks in `src/map/cascade-handler.ts` — `handleStreamMerged` (source stream), `handleStreamAbandoned`, `handleCascadeRebased` all call `evictByStream(stream.stream_id)`. Wrapped in try/catch so eviction failure can't break the projection write.

### Backend (macro-agent)
- [x] Declare `cascade: { canServeDiff: true }` in `references/macro-agent/src/map/sidecar.ts` swarm-level capabilities, **conditional on `gitCascadeAdapter` being wired** so swarms without an adapter don't lie to the hub.
- [x] `references/macro-agent/src/map/cascade-diff-server.ts` — `cascade/diff.request` handler. Worktree resolution via `adapter.listWorktrees().find(...)` with `adapter.repoPath` fallback when no live worktree matches. Git args: `git show --no-textconv -U3 --format=` (single commit) / `git diff --no-textconv -U3 base..head` (range), with `--name-only` injected when `files_only: true`. 50 MB stdout cap with truncation marker; 30 s spawn timeout. Binary files surface as git's default `Binary files ... differ` marker. Inline response when ≤ 512 KB; streamed via N base64 chunks + final sha256 above.
- [x] Wire from `sidecar.ts` step 5 alongside the cascade-bridge + action-handler setup; cleanup chain extended.

### Frontend
- [x] **`react-diff-viewer-continued` not used.** The library accepts old/new string pairs and computes the diff internally — wrong shape for our backend which serves pre-computed unified-diff text. `DiffView.tsx` renders the unified diff directly with line-by-line styling, which is what most diff UIs (GitHub, GitLab) do.
- [x] `src/web/hooks/useCascadeDiff.ts` — React Query wrapper. `staleTime: Infinity` (content-addressed, immutable cache keys), retries once on 5xx, no retry on 4xx.
- [x] `src/web/components/cascade/DiffView.tsx` — per-file collapsible blocks, line-level coloring (`+` green / `-` red / `@@` blue / context muted), loading / error / empty / truncated states, friendly error hints keyed by `DiffErrorCode` (e.g. swarm_offline → "Reconnect the agent that owns this stream").
- [x] `src/web/pages/Changes.tsx` — diff drawer state, prop-drill `onShowDiff` through ChangesList/BucketSection/ChangeRow + StreamDetailSidebar. Clickable commits in **both** (a) the Stack view's per-stream expandable commit list and (b) the List view's StreamDetailSidebar Timeline panel. Drawer is a fixed-right overlay with backdrop click + X-button dismiss.

### Tests
- [x] `src/__tests__/dal/cascade-diff-cache.test.ts` (7 tests)
- [x] `src/__tests__/cascade/diff-cache-eviction.test.ts` (3 tests) — eviction on `stream.merged` / `.abandoned` / `cascade.rebased`
- [x] `src/__tests__/map/cascade-diff-protocol.test.ts` (10 tests) — inline + chunked + timeout + sha mismatch + oversize + swarm_offline ×2 + files_only + base+file plumbing + threshold export
- [x] `src/__tests__/cascade/diff-chain-e2e.test.ts` (8 tests) — full hub→bridge→sidecar→git→cache→hub chain with real git, real DB, in-process WS bridge. Includes concurrent-race test (S1.19) and real-adapter integration via the dist symlink.
- [x] `src/__tests__/cascade/diff-route.test.ts` (12 tests) — fastify inject covering 200, auth gate (×2), 7 HTTP-status mappings, query-param plumbing (×2)
- [x] `src/__tests__/cascade/diff-capability-handshake.test.ts` (6 tests) — sidecar caps shape → hub `hasCapability` recognition
- [x] `src/__tests__/map/ws-map-cascade-diff-intercept.test.ts` (5 tests) — structural smoke that ws-map.ts wires the dispatch + constants match
- [x] `src/__tests__/map/cascade-diff-ws-roundtrip.test.ts` (3 tests) — **live** real-WS round-trip via fastify+ws+real client
- [x] `references/macro-agent/src/map/__tests__/cascade-diff-server.test.ts` (13 tests) — real git, real `createGitCascadeAdapter` via S1.20
- [x] `references/macro-agent/src/map/__tests__/sidecar-diff-install-smoke.test.ts` (4 tests) — structural guards on the install hook + capability declaration
- [x] `src/__tests__/cascade/live-cascade-diff-e2e.test.ts` (3 tests, env-gated `LIVE_AGENT_E2E=true`) — real fastify with `setupMapWebSocket`, real WS sidecar simulator, real HTTP→WS→git→HTTP round-trip. Caught a listener-attach race that production sidecar SDKs presumably guard internally.

### Verification before coding
- [x] Confirm worktree resolution path (D14 closes OD1 — uses existing helper)
- [x] Confirm `git show` output format on a real cascade worktree — verified via the diff-server tests against real git output
- [x] Confirm `POST /cascade/streams/:id/pr` works today when source agent is offline. Read of `cascade.ts:537-737`: the route unconditionally calls `sendCascadeAction(..., 'push', ...)` first — that send fails silently when the swarm is offline, then `createPullRequest` proceeds. So today PR creation half-works: it succeeds iff the branch is already on origin. D8 (Octokit branch-exists check) formalizes this for Stream 3.

---

## Stream 2 — Stack-aware diffs

Goal: select a stream → cumulative diff (`base_commit..HEAD`); select a stack root → cumulative across stack.

- [ ] Extend `src/cascade/diff-resolver.ts` — `resolveStreamDiff(stream_row_id, file?)` (uses `stream.base_commit..stream.head_commit`) and `resolveStackDiff(stack_root_row_id, file?)` (walks descendants via `getStreamDAG`, computes `lowest_base..highest_head` per D16; throws `NonLinearStackError` → 400 on branching stacks)
- [ ] Use `files_only: true` for top-level requests (D17) to skip blob serialization when only the file tree is needed
- [ ] No new MAP work — existing handler already supports `base..head` range
- [ ] New endpoints: `GET /cascade/streams/:id/diff` and `GET /cascade/streams/:id/stack/diff` returning `files_touched` plus optional inline diff for a single file when `?file=` is set
- [ ] UI: stack-view sidebar (around `Changes.tsx:600-690`) adds "View stack diff" — opens `DiffView` with multi-file file tree (left) + per-file diff (right). On `non_linear_stack` 400, render an inline notice instead of the panel.
- [ ] Lazy per-file fetch: top-level returns `files_touched`; clicking file fetches that file only via `?file=...`

Independent of Stream 3 — can run in parallel after Stream 1.

---

## Stream 3 — Stack-of-PRs action

Goal: "Open PR stack" on a root stream → openhive walks descendants, opens one PR per unmerged stream.

- [ ] `src/cascade/pr-stack-walker.ts` — toposort descendants via `getStreamDAG`, filter `status NOT IN ('merged','abandoned')`, build `[(stream, head_branch, base_branch)]` plan. Walk **sequentially** per D18; on `push_required`, mark all lineage descendants `blocked_by_parent` without contacting GitHub.
- [ ] Per-stream base resolution: `parent.publish_branch || parent.branch_name || swarm.metadata.trunk_branch || 'main'`
- [ ] **Idempotent retries (D19)**: for each entry, consult `getPRForStream(stream.id)` first — if a non-closed PR exists, return `status='existing'` with `pr_url`. On GitHub 422 (duplicate head), look up via `pulls?head=…&state=open` and treat as `existing`.
- [ ] **Offline-agent path (D8)**: extend `src/integrations/github-api.ts` with `branchExists(owner, repo, branch)` (404 → false, others → throw); before invoking agent, check — if exists, skip agent and call `createPullRequest` directly
- [ ] `src/api/routes/cascade.ts` — `POST /cascade/streams/:id/pr-stack`; aggregates per-stream `{ status: 'created' | 'existing' | 'push_required' | 'blocked_by_parent' | 'failed', pr_url?, error?, branch? }`
- [ ] UI: `Changes.tsx` stack actions (currently around `:1221-1287`) — "Open PR stack" button + result drawer with per-stream cards (distinct rendering for `existing` / `blocked_by_parent`)

### Tests
- [ ] Walker: toposort correctness, parent-branch resolution, partial stack (mid-stream merged), single-stream root, non-linear stack rejection
- [ ] Lineage propagation: A unpushed → B+C marked `blocked_by_parent` without GitHub calls
- [ ] Idempotency: re-run after partial success returns `existing` for already-opened PRs; 422 race resolves to `existing`
- [ ] Integration: branch-exists happy path + branch-not-pushed case + mixed

---

## Stream 4 — Cleanup + protocol consolidation

- [ ] Remove `_macro/diffStacks/{list,get,create,createPR}` stubs from `references/openswarm/src/worker/streams.ts:124-165`
- [ ] Remove `references/openswarm/src/component/create-pr-dialog.tsx` (or repoint at hub `POST /cascade/streams/:id/pr`)
- [ ] Confirm `references/macro-agent/src/map/server.ts` carries no remaining handler reference for the deleted `_macro/diffStacks/*` methods
- [ ] Factor `src/map/chunked-rpc.ts` from `sync-client.ts:478-535` (chunker + reassembler); migrate `trajectory-content.ts` and `diff-resolver.ts` onto it
- [ ] Update `src/map/CLAUDE.md` and `src/cascade/CLAUDE.md` to document `cascade/diff.request`, `cascade_diff_cache`, the diff resolver, and stack-of-PRs walker
- [ ] Flip this doc's status to `implemented` (or move under `docs/superpowers/specs/`)

---

## Risks

| Risk | Mitigation |
|---|---|
| `git show` output varies with config (`core.autocrlf`, line endings) | Force `--no-textconv -U3`; pin to unified format |
| Multiple worktrees historically on the same stream | Use first live worktree; fall back to bare-repo `git show` via `adapter.getRepoPath()` (D14) |
| Octokit branch-check costs RTT per stream-PR | Acceptable; in-process 30s cache if it ever matters |
| 60s timeout still insufficient for multi-MB diffs over slow links | Stream 1 tests surface this; trigger compression then |
| `child_process.spawn` deadlock on huge git output | Cap stdout at 50 MB raw with truncation marker |
| Cache stale after `cascade.rebased` rewrites history | `evictByStream` on rebased event — entries become unreachable anyway since key includes `commit_hash` |
| Migration slot collision | V56 landed on 2026-05-11 as the next free slot after V55 |

---

## Sequencing

| Stream | Effort | Dependencies | Status |
|---|---|---|---|
| 1 | ~1 week (landed 2026-05-11) | None | ✅ Shipped |
| 2 | ~2 days | Stream 1 | ⏳ Ready to start |
| 3 | ~3 days | Stream 1 (independent of Stream 2) | ⏳ Ready to start |
| 4 | ~1 day | Streams 1 + 3 | ⏳ Blocked on 3 |

Streams 2 and 3 parallelizable.

---

## Future expansions (not in v1)

- **Subset collapse** — pick N streams, hub asks macro-agent to `mergeReviewBlocks` + push merged branch, hub opens single PR. Primitive exists in git-cascade; flow is net-new.
- **Auto-push toggle per stream** — closes the "branch not pushed" gap for D8.
- **Compression** — flip `compression` column to `'gzip'`, add wrap/unwrap in chunker. ~half a day when triggered.
- **Local-filesystem fast path** — for hosted swarms, hub `git show`s directly against `bootstrap.cwd`. Latency optimization; adds an architectural exception.
- **Inline review surface** — comments, threads, approvals in openhive. Deferred indefinitely per current direction.
