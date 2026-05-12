---
status: streams-1-4-shipped, stream-5-planned
owner: alexngai
created: 2026-05-05
revised: 2026-05-11
---

# Cascade Diff Browsing + Stacked PRs

Bring PR-style diff review into openhive so users can coordinate agents to produce git stacks and open PRs without leaving the UI for code-viewing. Comments / approvals stay on GitHub; openhive owns the "see the change, open the PR(s)" surface.

**v1 must support cross-swarm collaboration on the same cascade.** A single human developer routinely works across multiple swarms (different macro-agent sidecars, different OpenHive hubs they're connected to), and a single Claude Code agent's local checkout can cross swarm boundaries. The cascade model below treats the **git repo** (not the swarm) as the unit of cascade identity, with swarms as observers/contributors. Stream 5 lands this.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[?]` blocked / needs decision

---

## Scope

**In:**
- View diffs at three levels: per-commit, per-stream (`base_commit..HEAD`), per-stack (cumulative across parent chain).
- Stack view enhancements — diff-on-click, "Open PR stack" action.
- Stacked PR creation — one PR per stream, base = parent stream's branch.
- Local-vs-remote split: every diff routed through MAP (uniform).
- **Cross-swarm cascade participation.** A cascade lives in a git repo, not a swarm; multiple swarms watching the same repo see one unified stream graph and can each contribute commits, open PRs (when authorized), and serve diffs. Same-instance only in v1 (cross-instance via mesh sync is a v1.5 expansion).

**Out (deferred):**
- Comments, threads, approvals, review states — defer to GitHub.
- Subset collapse (multiple streams → one PR via `mergeReviewBlocks`).
- gzip compression in chunker.
- Auto-push on commit.
- Cross-instance cascade federation (two different OpenHive hubs collaborating on one cascade via mesh sync). The Stream 5 model is shaped so this slots in later without a second redesign.

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
- **D20** *(Stream 3)*: **Walker accepts branching trees**, not just linear chains. Stream 2's stack-diff walker is linear because cumulative-diff semantics break under branching, but stack-PR semantics don't — each leaf is its own PR, parallel branches just become sibling PRs sharing an ancestor base. The push_required → blocked_by_parent propagation (D18) is per-lineage in the tree: a missing branch on `A` blocks descendants of A but not its siblings.
- **D21** *(Stream 3)*: **Best-effort push hint per entry**, matching the single-PR endpoint at `cascade.ts:684-688`. Before the branch-exists check on each plan entry, fire-and-forget `sendCascadeAction(..., 'push', { target_ref: head_branch })`. The cascade-actions channel is fire-and-forget, so failure or offline-swarm silently no-ops; the branch-exists check still gates whether GitHub actually receives the PR call. Concrete effect: a connected sidecar with a fresh local commit gets a chance to push it before the walker checks GitHub, eliminating the most common "branch not pushed yet" false negative.
- **D22** *(Stream 3)*: **"Open PR stack" lives only in the stack-view header**, not in StreamDetailSidebar. Single-stream PR creation is already surfaced via the existing "Create PR" button in the sidebar's GitHub section; duplicating the stack-PR affordance there would imply you can run it from a non-root stream, which doesn't typecheck (the walker descends from a chosen root). Stack-view UI already requires picking a root, so the surface composes naturally.
- **D23** *(post-Stream-4 review)*: **`paused` is transparent in both walkers; `conflicted` stays active.** A paused stream is operator-suspended and explicitly opted out of forward progress — it shouldn't surface in `stack-resolver` as a "this branch is the next stop" candidate, nor in `pr-stack-walker` as a PR candidate. It is collapsed out: descendants base on the next live ancestor, blocking propagation skips paused parents. `conflicted` is the opposite — it represents work-in-progress that needs attention and may still be pushable, so it stays in the chain. Pragma: walker skip set is now `{merged, abandoned, paused}` (renamed `SKIP_STATUSES`).
- **D24** *(post-Stream-4 review)*: **Walker reads run inside `db.transaction(...)`, and the diff resolver re-checks stream status before `putDiff`.** Both `resolveLinearStack` and `buildPRStackPlan` snapshot via better-sqlite3 transactions so children fan-out is consistent with the root read. The diff resolver's tier-5 write is gated by a post-fetch `getStreamByRowId(...).status` check against `{merged, abandoned}` — if the projection moved terminal during the on-demand fetch window, the eviction hook may have already fired and we'd otherwise leak a fresh row for an evicted stream. Doesn't cover the `cascade.rebased` race (status stays `active` post-rebase) — a small leak class explicitly accepted; LRU sweep on `last_accessed_at` is the longer-term mitigation.
- **D25** *(Stream 5)*: **Cascade identity is `(repo_resource_id, stream_id)`, not `(source_swarm_id, stream_id)`.** A cascade lives in a git repo. Multiple swarms that observe the same repo see the same stream graph. `cascade_streams` keys on `(repo_resource_id, stream_id)`; `source_swarm_id` survives as a non-authoritative "first reporter" hint (nullable, no UNIQUE participation). The repo identity is `syncable_resources.id` for a `resource_type='repo'` row — same primitive that already syncs across instances via the mesh, which sets up cross-instance cascade federation as a v1.5 add-on with no further schema work.
- **D26** *(Stream 5)*: **Multi-swarm participation tracked via `cascade_stream_observers`.** Each `(stream_row_id, swarm_id)` row records how a swarm relates to a stream: `'reporter'` (first to emit `stream.created`), `'contributor'` (subsequently emitted any `x-cascade/*` event), or `'reviewer'` (read-only via explicit grant, future use). `first_seen` / `last_event_at` columns drive routing and stale-observer cleanup. Cascade events from any participating swarm land on the same row; the observer table is the audit + routing source of truth.
- **D27** *(Stream 5)*: **Diff fetcher tries the original reporter first, then falls back to any active observer with `cascade.canServeDiff`.** If a stream's reporter swarm is offline but another contributor is online, diffs still resolve. `MapDiffFetcher` selection becomes a ranked lookup over observers (reporter > most-recent contributor > others), not a hard `getInbound(stream.source_swarm_id)`. Cascade actions (push, rebase) use the same routing — first responder wins, no arbitration ceremony.
- **D28** *(Stream 5)*: **PR creation requires a swarm that holds GitHub credentials for the target repo.** A repo can be observed by N swarms but only swarms whose `github_repo` config matches `repo.canonical_url` can open PRs. The route picks the first qualifying observer at PR-open time. If no observer qualifies, return `503 no_authorized_swarm` with a list of observers that lack credentials so the UI can prompt for one. Avoids the "which swarm's GitHub token gets used" arbitration problem by making it deterministic and surfacing the gap when it exists.
- **D29** *(Stream 5)*: **F1 tenancy lands as repo-resource access checks, not swarm-membership checks.** The cross-tenant gap raised in the post-Stream-4 review (HIGH) becomes `requireRepoAccess(stream.repo_resource_id, request.agent)`: passes if the agent is admin, owns the repo resource (`syncable_resources.owner_agent_id`), or has an explicit collaboration grant on the repo (grant table is part of Stream 5b). Side-effectful endpoints (PR-open, actions, status mutations) gate hard; read endpoints gate softer (admin + owner + grantee + currently-observing swarm). This is strictly more permissive than the original swarm-boundary proposal because it allows the cross-swarm-collaboration use case the model was redesigned to support.

---

## Open decisions

- **OD2** *(closed)*: Chunker factoring — deferred per Stream 4. Re-evaluate when a fourth caller appears.
- **OD3**: Trunk default per swarm — read from `swarm.metadata.trunk_branch` first; fall back to `'main'`. Decide whether to surface in Settings UI. **Stream 5 promotes this to a repo-resource setting** rather than a swarm setting (the trunk is a property of the repo, not the swarm watching it); migrate when Stream 5b lands.
- **OD4** *(Stream 5)*: Repo-binding semantics on `x-cascade/stream.created`. The sidecar's existing payload doesn't include the repo identity explicitly — it's implicit from the sidecar's MAP connection. Stream 5a needs the sidecar to send `repo_url` (or git remote canonical URL) so the hub can resolve to `syncable_resources.id` deterministically without round-tripping through swarm config. **Lean**: bump the cascade event protocol to include `repo_url`; hub falls back to `swarm.github_repo` for events from sidecars that haven't bumped yet.
- **OD5** *(Stream 5)*: Cross-swarm conflict surfacing. When Swarm A's commit produces a conflict on Swarm B's downstream stream, B's UI sees the `conflict.detected` event (it's an observer) but B's worktree can't resolve it — only A's can. **Lean**: show the conflict in every observer's UI as read-only with a "resolution owned by Swarm A" affordance; A's UI gets the editable controls. Only the worktree-holding swarm can fire `conflict.resolve`.
- **OD6** *(Stream 5)*: Repo collaboration grant table shape. Simplest is `repo_collaborations(repo_resource_id, grantee_agent_id, perms[])`; alternative is grantee-by-swarm (`grantee_swarm_id`). Agent-level is more flexible and matches how `syncable_resources.owner_agent_id` already works. **Lean**: agent-grantee; UI can map "share with this user's swarms" → "share with this agent".

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

**Status: ⏳ in progress (started 2026-05-11).** Decisions D20–D22 added during scoping.

Goal: "Open PR stack" on a root stream → openhive walks descendants, opens one PR per unmerged stream.

- [ ] `src/cascade/pr-stack-walker.ts` — DFS descendants from a root via `parent_stream_id`/`source_swarm_id` queries (the same pattern as `stack-resolver.ts` from Stream 2, but accepts branching trees per D20). Filter `status NOT IN ('merged','abandoned')`. Build `[{ stream, head_branch, base_branch, lineage_id }]` in parent-before-child order. `lineage_id` traces each entry back to its branching ancestor so the route can propagate `push_required → blocked_by_parent` correctly when sibling branches exist.
- [ ] Per-stream base resolution: `parent.publish_branch || parent.branch_name || swarm.metadata.trunk_branch || 'main'`. Root uses `swarm.metadata.trunk_branch || 'main'` directly. `findSwarmById(stream.source_swarm_id).metadata` is the trunk source.
- [ ] **Idempotency (D19)**: for each entry, consult `getPRForStream(stream.id)` first — if a non-closed PR exists, return `status='existing'` with `pr_url`. On GitHub 422 (duplicate head), look up via `pulls?head=…&state=open` and treat as `existing`.
- [ ] **Best-effort push hint (D21)**: before the branch-exists check, fire-and-forget `sendCascadeAction(swarmId, 'push', { stream_id, target_ref: head_branch })`. Matches the single-PR endpoint's current behavior. Connected sidecars get a chance to push fresh local commits before the walker queries GitHub.
- [ ] **Branch-exists gate (D8)**: extend `src/integrations/github-api.ts` with `branchExists(owner, repo, branch)` — 404 → false, other non-2xx → throw. Internal helper that bypasses `githubFetch`'s throw-on-not-ok behavior.
- [ ] **Branching lineage propagation (D18 + D20)**: per `lineage_id`, when a parent entry resolves `push_required`, mark every descendant in that lineage `blocked_by_parent` *without* contacting GitHub. Siblings of different parents are unaffected.
- [ ] `src/api/routes/cascade.ts` — `POST /cascade/streams/:id/pr-stack`; aggregates per-stream `{ status: 'created' | 'existing' | 'push_required' | 'blocked_by_parent' | 'failed', pr_url?, error?, branch?, base_branch? }` in walker order.
- [ ] UI (D22): `Changes.tsx` `StreamStackView` header — **"Open PR stack"** button next to "View stack diff" / "Change root". Result drawer (reuses the Stream 2 drawer-overlay pattern): per-stream cards with status badges, branch names, and click-through to `pr_url` for `created` / `existing`. **No "Open PR stack" affordance in `StreamDetailSidebar`** — single-PR creation already lives there via the existing "Create PR" button.

### Tests
- [ ] Walker unit: toposort correctness on linear chains AND branching trees (siblings), parent-branch resolution (publish_branch wins, then branch_name, then trunk fallback), partial stack (mid-stream merged → walker descends through it but skips it from the plan), single-stream root, terminal-status filter
- [ ] Walker unit: `lineage_id` correctness on a Y-shaped tree (one parent, two children → each child gets its own lineage_id)
- [ ] Lineage propagation: A unpushed → A.descendants in A's lineage marked `blocked_by_parent`; A's siblings unaffected
- [ ] Idempotency: re-run after partial success returns `existing` for already-opened PRs; 422 race resolves to `existing` via `pulls?head=…&state=open`
- [ ] Route: branch-exists happy path; branch-not-pushed → `push_required`; mixed lineages (one branch ready, one blocked); root has no trunk metadata → falls back to `main`
- [ ] Route: idempotent retry path returns same plan with updated statuses; GitHub auth missing → 502 with sanitized error
- [ ] **Live (LIVE_AGENT_E2E)**: extend `live-cascade-diff-sidecar-e2e.test.ts` with a 2-stream stack + a real sidecar that pushes the root's branch on `request.push`; assert root → `created` (since branch is now on origin via the push hint), leaf → `push_required` (no auto-push for leaf). Mocks GitHub via `vi.mock('../../integrations/github-api.js', ...)` matching the cascade-pr-management test pattern.

---

## Stream 4 — Cleanup + protocol consolidation

**Status: ✅ Complete (2026-05-11).** Chunked-rpc factoring deferred — see note below.

- [x] Removed `_macro/diffStacks/{list,get,create,createPR}` stubs from `references/openswarm/src/worker/streams.ts`. The methods were never implemented in macro-agent (no `_macro/diffStacks/*` handlers anywhere), so the openswarm caller path was dead from day one.
- [x] Removed downstream openswarm dead code that depended on the stubs:
  - `fetchDiffStacks` poller + caller in `context/stream-sync.tsx`
  - `refreshDiffStacks` action + `useGitDiffStacks` accessor in `context/sync.tsx`
  - `diffStacks` store field + initial value in `types/store.ts`
  - `useGitDiffStacks` import + `diffStacks().length` render + `p` keybinding + `p PR` help text in `routes/session/streams.tsx`
  - `TUIDiffStack` import lines in three files (interface itself retained — type-level dead code, harmless, future re-implementations can use it as a contract)
- [x] Deleted `references/openswarm/src/component/create-pr-dialog.tsx`. It called the never-implemented `map.diffStacks.createPR`; repointing at the hub `POST /cascade/streams/:id/pr` would have been a redesign (the dialog's diff-stack concept doesn't map to openhive streams). The new PR flow lives in the openhive web UI ("Open PR stack" button from Stream 3).
- [x] Confirmed `references/macro-agent/src/map/server.ts` has no handler reference for the deleted `_macro/diffStacks/*` methods (verified via grep — no matches anywhere in macro-agent).
- [⏸️] **Skipped: factor `src/map/chunked-rpc.ts` from `sync-client.ts` (OD2)**. The cascade-diff protocol uses the same chunking idiom (inline ≤ 512 KB → streamed in 1 MB base64 chunks → sha256 final), but the actual code paths are short and well-tested in their current form. Factoring would touch three modules (`sync-client.ts`, `trajectory-content.ts`, the new `cascade-diff-protocol.ts`) with proven behavior to swap in a shared helper that doesn't yet have a third caller demanding it. Re-evaluate if a fourth caller appears or if the current copies drift.
- [x] Updated `src/cascade/CLAUDE.md` with the new `diff-types`, `diff-resolver`, `stack-resolver`, `pr-stack-walker` modules + the `cascade_diff_cache` table semantics + the four REST endpoints introduced across Streams 1–3.
- [x] Updated `src/map/CLAUDE.md` with a dedicated "Cascade diff protocol" section covering the request/response/chunk shapes, the hub-side `cascade-diff-protocol.ts` + `ws-map.ts` intercept wiring, the capability gate, and the sidecar-side handler at `references/macro-agent/src/map/cascade-diff-server.ts`.
- [x] Flipped this doc's status to `implemented`.

---

## Stream 5 — Repo-keyed cascade (cross-swarm participation)

**Status: 📐 planned (scoped 2026-05-11).** Decisions D25–D29 above. Lands as v1 because the current single-swarm model is a regression vs. how Claude Code agents already cross swarm boundaries on a shared local checkout. No production data exists yet on the cascade tables, so the schema changes are direct (no migration/backfill dance).

### Why now

A single human developer's local checkout is regularly touched by multiple swarms — different macro-agent sidecars running locally, or sidecars from different OpenHive hubs that the dev is connected to. The cascade tracker in their git repo emits `x-cascade/*` events from a single sidecar at a time, but the *underlying work* belongs to the repo, not the sidecar. Today's schema enforces `(source_swarm_id, stream_id)` uniqueness, which silos the same logical cascade into N disconnected rows when N swarms watch it. Stream 5 reshapes the schema around the repo as the cascade-identity primitive.

### 5a — Schema reshape (no production migration; v1-in-flight changes)

- [ ] `src/db/schema.ts`: **Amend the `cascade_streams` CREATE in `CREATE_TABLES`** (the table is unlaunched — no migration runner needed).
  - Add `repo_resource_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE`
  - Make `source_swarm_id TEXT` (nullable; no longer authoritative)
  - Replace `UNIQUE(source_swarm_id, stream_id)` with `UNIQUE(repo_resource_id, stream_id)`
  - Add index on `(repo_resource_id, status, opened_at)` for stack-view aggregation queries
- [ ] New table `cascade_stream_observers`:
  ```sql
  CREATE TABLE cascade_stream_observers (
    stream_row_id TEXT NOT NULL REFERENCES cascade_streams(id) ON DELETE CASCADE,
    swarm_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('reporter', 'contributor', 'reviewer')),
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    last_event_at TEXT,
    PRIMARY KEY (stream_row_id, swarm_id)
  );
  CREATE INDEX idx_cascade_stream_observers_swarm ON cascade_stream_observers(swarm_id, last_event_at DESC);
  ```
- [ ] New table `cascade_diff_cache` keying: amend `(stream_id, ...)` → `(repo_resource_id, stream_id, commit_hash, base_hash, file_path)`. Cache rows are repo-scoped, not swarm-scoped — multi-swarm observers share the cache and don't double-fetch the same diff. Update the IFNULL unique index accordingly.
- [ ] `src/db/dal/cascade-streams.ts`:
  - `upsertStream` looks up by `(repo_resource_id, stream_id)`. Inserts/updates observer row in same transaction (`'reporter'` if absent, else `'contributor'` on subsequent events).
  - New helpers: `listObservers(stream_row_id)`, `getReporterSwarm(stream_row_id)`, `getActiveObservers(stream_row_id)` (joins on connection registry for live filter).
  - Drop `getStreamBySwarmAndId`; replace callers with `getStreamByRepoAndId(repo_resource_id, stream_id)`.

### 5b — Walker + resolver routing (depends on 5a)

- [ ] `src/cascade/stack-resolver.ts` + `pr-stack-walker.ts`: children-index query becomes `WHERE repo_resource_id = ?` instead of `WHERE source_swarm_id = ?`. Walkers now naturally aggregate streams across observing swarms.
- [ ] `src/cascade/diff-resolver.ts`: replace `getInbound(stream.source_swarm_id)` with `pickResolverSwarm(stream)` — tries reporter first, then `getActiveObservers(stream_row_id)` filtered by `cascade.canServeDiff` capability. Emits the same `swarm_offline` error if none qualify.
- [ ] `src/map/cascade-actions.ts` / `cascade-handler.ts`: cascade event ingest looks up `(repo_resource_id, stream_id)` not `(swarm, stream_id)`. Records observer entry on first event from each swarm. Per-stream WS broadcasts fan out to subscribers of any observing swarm (frontends already key on stream_id, not swarm_id, so no FE change here).
- [ ] PR-creation endpoint: when picking which swarm to dispatch the PR open against, iterate observers and pick the first whose `github_repo` config matches `repo.canonical_url`. Return `503 no_authorized_swarm` with diagnostic list if none qualify (D28).

### 5c — Sidecar protocol bump (depends on 5a)

- [ ] `references/macro-agent/src/map/cascade-emitter.ts` (or wherever `x-cascade/stream.created` originates): include `repo_url` (canonical git remote URL) in the payload. Hub resolves to `syncable_resources.id` via existing `canonical_key` matching.
- [ ] Hub fallback: if `repo_url` absent on an event, resolve from `swarm.github_repo`. Soft-deprecate the fallback; warn in logs.
- [ ] Sidecar must also opt-in to `cascade.observerEvents` — declared at handshake — so the hub knows the sidecar can handle cascade events that originated from a different swarm (e.g., "the stream you're observing was just merged by Swarm A"). Capability gate prevents accidentally fanning events to sidecars that aren't ready for cross-swarm semantics.

### 5d — Repo-access authz (closes F1)

- [ ] `src/api/middleware/repo-access.ts` (new): `requireRepoAccess(repo_resource_id, request.agent, mode: 'read' | 'mutate')`. Passes if:
  - `request.agent.is_admin === true`, OR
  - `syncable_resources.owner_agent_id === request.agent.id`, OR
  - `mode='read'` and a `cascade_collaborations` grant exists, OR
  - `mode='read'` and the agent owns any swarm that's currently a live observer (covers "I'm watching this repo via my swarm")
- [ ] New table `cascade_collaborations` (D29 + OD6):
  ```sql
  CREATE TABLE cascade_collaborations (
    repo_resource_id TEXT NOT NULL REFERENCES syncable_resources(id) ON DELETE CASCADE,
    grantee_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    perms TEXT NOT NULL,  -- JSON: ['read_diffs', 'open_prs', 'subscribe_events']
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    granted_by TEXT REFERENCES agents(id),
    PRIMARY KEY (repo_resource_id, grantee_agent_id)
  );
  ```
- [ ] Apply `requireRepoAccess` to the four new Stream 1–3 endpoints + the side-effectful pre-existing ones (`POST /pr`, `POST /actions/:action`, `PATCH /streams/:id/branch`, `PATCH /streams/:id`, `DELETE /streams/:id`). Read endpoints get the softer check.
- [ ] Cross-tenant 403 carries a typed body: `{ error: 'forbidden', code: 'no_repo_access', repo_resource_id, owning_agent_id }`.

### 5e — UI aggregation

- [ ] `src/web/pages/Changes.tsx` stack view: group by repo, not by swarm. When a repo has streams from multiple observing swarms, the view shows them in one tree (annotated with a small "via Swarm X" chip per stream for traceability — surface the data, don't hide it).
- [ ] Sidebar shows the observer list for a selected stream + the "owning" reporter, so users understand multi-swarm participation at a glance.
- [ ] Repo-settings panel (light, not the full Settings UI for OD3 yet): "swarms observing this repo" list + collaboration grant management for repo owners.

### Tests

- [ ] DAL: upsert from two swarms produces one row + two observer entries; reporter survives; second swarm registered as `contributor`.
- [ ] Walker: 3-stream chain split across 2 swarms (A → B → C where A,C in swarm-1 and B in swarm-2) returns linear plan with B's `via_swarm_id` recorded.
- [ ] Diff-resolver: reporter offline + contributor online → contributor serves; both offline → `swarm_offline`.
- [ ] PR-creation: two observers, only one has `github_repo` config → PR opens through that one; neither → `no_authorized_swarm` with diagnostic list.
- [ ] Repo-access middleware: cross-tenant request from agent with no relationship to repo → 403; admin → 200; collaborator grant → 200 on read, 403 on mutate; live-observer-owning agent → 200 on read.
- [ ] **Live (LIVE_AGENT_E2E)**: two macro-agent sidecars in the same local checkout, both registered against the hub via different swarms. Commit from sidecar A produces a stream row; commit from sidecar B on a child stream produces a second row + second observer entry on A's stream. Stack view aggregates correctly. PR-stack creation routes through whichever sidecar has GitHub creds.

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
| **Stream 5**: Two swarms race the same `stream.created` event | Hub `upsertStream` runs in a transaction; first writer wins reporter role, second becomes contributor. Idempotent. |
| **Stream 5**: Cascade event from swarm B arrives for a stream first seen via swarm A; `repo_url` lookup ambiguous | `syncable_resources.canonical_key` is repo-unique by canonical URL; both swarms resolve to the same `repo_resource_id`. If repo isn't synced to the hub yet, drop the event with a structured log entry (operator likely needs to wire repo sync first). |
| **Stream 5**: PR-routing arbitration when N observers have GitHub creds | Deterministic pick: first observer with matching `github_repo` config in observer-table insertion order. Operators can pin via a future `pr_preferred_swarm_id` column if it becomes a real complaint. |
| **Stream 5**: Conflict surfaces in B's UI but only A can resolve | Per OD5: read-only conflict view in non-worktree observers with attribution chip; only worktree-holder gets the resolution affordance. |
| **Stream 5**: Observer table grows unbounded as swarms come and go | `cascade_stream_observers` rows are CASCADE-deleted with the stream. Within a stream's lifetime, observer growth is bounded by swarms-watching-this-repo, which is small. No GC needed in v1. |
| **Stream 5**: Sidecar without `cascade.observerEvents` capability gets cross-swarm events it can't handle | Hub gates outbound observer-side events on the capability; pre-bump sidecars only receive events from their own swarm (current behavior). Backwards-compatible. |

---

## Sequencing

| Stream | Effort | Dependencies | Status |
|---|---|---|---|
| 1 | ~1 week (landed 2026-05-11) | None | ✅ Shipped |
| 2 | ~2 days (landed 2026-05-11) | Stream 1 | ✅ Shipped |
| 3 | ~3 days (landed 2026-05-11) | Stream 1 (independent of Stream 2) | ✅ Shipped |
| 4 | ~1 day (landed 2026-05-11) | Streams 1 + 3 | ✅ Shipped |
| 5a — schema reshape | ~1 day | Streams 1–4 | 📐 Planned |
| 5b — walker + resolver routing | ~1 day | 5a | 📐 Planned |
| 5c — sidecar protocol bump | ~half day | 5a | 📐 Planned (cross-repo: macro-agent submodule) |
| 5d — repo-access authz (closes F1) | ~1 day | 5a | 📐 Planned |
| 5e — UI aggregation | ~1 day | 5a, 5b | 📐 Planned |

Streams 2 and 3 parallelizable. Stream 5 substreams 5b/5c/5d/5e all depend on 5a; 5b + 5c + 5d are themselves parallelizable.

---

## Future expansions (not in v1)

- **Subset collapse** — pick N streams, hub asks macro-agent to `mergeReviewBlocks` + push merged branch, hub opens single PR. Primitive exists in git-cascade; flow is net-new.
- **Auto-push toggle per stream** — closes the "branch not pushed" gap for D8.
- **Compression** — flip `compression` column to `'gzip'`, add wrap/unwrap in chunker. ~half a day when triggered.
- **Local-filesystem fast path** — for hosted swarms, hub `git show`s directly against `bootstrap.cwd`. Latency optimization; adds an architectural exception.
- **Inline review surface** — comments, threads, approvals in openhive. Deferred indefinitely per current direction.
- **Cross-instance cascade federation** — two different OpenHive hubs collaborating on one repo's cascade. Stream 5's repo-keyed model is the prerequisite (the model is already cross-instance-shaped; `syncable_resources` syncs via the mesh). Adds: sync of `cascade_streams` + `cascade_stream_observers` rows over `/sync/v1`, identity reconciliation when an instance newly sees a peer's projection of a cascade it already knows about, and a cross-instance authz model layered on top of `cascade_collaborations`. v1.5 work.
- **Per-stream PR-routing pin** — `cascade_streams.pr_preferred_swarm_id` for operators who want a specific swarm to own PR creation regardless of insertion order. Defer until the deterministic-first-observer policy generates a real complaint.
- **Stream adoption / handoff** — explicit reassignment of the reporter role when the original reporter is permanently offline. Deferred; in practice "first contributor with capability becomes effective reporter" via D27's routing fallback is usually sufficient.
