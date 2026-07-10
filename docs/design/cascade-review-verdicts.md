# QC station: cascade review verdicts and the verified-merge gate

**Status:** Q1 implemented (V66 + DAL + REST + WS + console Approve/Request-changes; verified via route/DAL tests and a live console round-trip). Q2 (policy + gates) and Q3 (reviewer dispatch) not started.
**Owner surface:** `src/cascade/` (hub-side QC), companion track in `git-cascade` (we own `~/GitHub/git-cascade`).
**Program context:** the software-factory measurement program. The factory's **unit of production is `spec → verified merge`, where *verified* means human acceptance**. This doc designs the station that produces the "verified" fact: who accepted what code, at which head, and how that gates landing. It is downstream of the factory-metrics instrumentation (which gives lead-time/yield their denominators) and upstream of autonomation Stage B (which needs a trustworthy quality signal to optimize against).

## Revision log

- **2026-07-09 — initial draft**, following an empirical audit of git-cascade v0.0.9's stacked-review surface (driven live with an emit recorder; findings below).

## 1. Audit findings this design rests on

git-cascade contains **two parallel review models, both dormant**:

| | `stacks.ts` review blocks | `diff-stacks.ts` diff stacks |
|---|---|---|
| Statuses | `draft → review → approved → merged` | `pending / approved / rejected / merged / abandoned` |
| Transition validation | **None** (only terminal `merged` frozen; `approved → draft` allowed; updating without `reviewer` nulls `reviewed_by`) | **Enforced state machine** (`isValidStatusTransition`) |
| Enforcement | **None** — `mergeStream` and the merge queue both merge with unapproved blocks (verified empirically); `StackConfig.reviewWorkflow.requireApproval` / `allowedReviewers` are dead code | `cherryPickStackToTarget` refuses non-`approved` stacks — the only gate in the library |
| Events | **None** | **None** |

The `x-cascade/*` protocol is symmetrically review-blind: 16 event methods, 7 action methods, and the `CascadeCapability` block contain **zero review vocabulary**. OpenHive's `cascade-handler` covers all 16 events — full parity; there is simply nothing to project. macro-agent calls none of the review APIs.

Two integration bugs found during the audit (tracked in §7 as G1):

1. **Queue-driven merges are invisible.** `processMergeQueue` calls module-level `mergeStream` directly, bypassing the tracker's emit wrapper — no `stream.merged`, no `queue.removed`. A runtime adopting the merge queue silently breaks hub merge projections and the task auto-close binder.
2. **The merge queue can't land on a real branch.** `mergeStream` hardcodes `stream/<id>` as the target branch (`streams.ts:654`), so local-mode streams (tracked branches like `main`) can't be merge targets; `targetBranch: 'main'` throws `StreamNotFoundError`. The queue is stream→stream only.

## 2. Architecture: verdicts are hub state, review mechanics are runtime state

The existing cascade boundary holds: **the hub never writes cascade state; cascade facts enter via `x-cascade/*` events**. A review *verdict* is not cascade state — it is a QC record (who accepted which head) that the hub owns natively, exactly as it owns dispatch rows and experiment projections. The runtime keeps owning branches, merges, and (eventually) library-level review enforcement.

```
                       agent runtime (git-cascade tracker)
                         owns: streams, merges, review mechanics
                              │ x-cascade/* events        ▲ x-cascade/request.merge
                              ▼                           │ (withheld until verdict, §5)
        ┌───────────────────────────────────────────────────────────┐
        │                          hub                              │
        │  cascade projections  ◄──join (stream_id, head)──┐        │
        │  (read-only lens)                                │        │
        │                                    cascade_review_verdicts│
        │  policy.ts: resolveReviewPolicy    (hub-owned QC record)  │
        │      task > swarm > hub                  ▲                │
        │                                          │                │
        │  console diff view ── Approve / Request changes (human)   │
        │  reviewer dispatch ── advisory agent verdicts             │
        └───────────────────────────────────────────────────────────┘
```

Enforcement is therefore **two-layer**:

- **Layer 1 (this doc, OpenHive):** the hub withholds hub-initiated landing actions (`request.merge`, PR-stack opening, queue-ready surfaces) until a current-head approval exists. Agent-local merges physically can't be blocked from the hub — they are *detected* instead (§6, `unreviewed_merge` is a first-class quality-escape metric, mirroring the task-binder's "no retry queue, drop visibly" philosophy).
- **Layer 2 (companion track, git-cascade):** the library gains review events, a capability flag, and a real gate in `mergeStream`/`processQueue`, at which point runtimes that opt in enforce locally and the hub's gate becomes defense-in-depth.

## 3. Data model (V66)

`cascade_review_verdicts` — append-only; the latest verdict **per (stream, head_commit)** is current. A new head invalidates prior approvals by construction (the join key changes), giving re-review-on-push for free.

| Column | Notes |
|---|---|
| `id` | `rv_` prefixed nanoid (house convention) |
| `source_swarm_id`, `stream_id` | joins to cascade stream projections (no SQL FKs, house convention) |
| `head_commit` | the commit the reviewer actually looked at — resolved server-side from `getLatestCommitForStream` at verdict time, never client-supplied |
| `verdict` | `'approved' \| 'changes_requested' \| 'rejected'` |
| `reviewer_kind` | `'human' \| 'agent'` |
| `reviewer_id` | agent id, or the authenticated human/admin principal |
| `notes` | free text (the v1 review payload; no inline comment threads) |
| `dispatch_id` | nullable — set when the verdict was produced by a reviewer dispatch (§5.3), joining QC cost into factory metrics |
| `created_at` | ISO-8601 |

DAL: `src/db/dal/cascade-review-verdicts.ts`. Key queries: `getCurrentVerdict(streamId, headCommit)`, `listVerdictsForStream`, and `isApprovedAtHead` (the gate predicate). Eviction piggybacks the diff-cache pattern: terminal stream events (`stream.merged`/`.abandoned`) leave rows in place — verdicts are the audit trail, never cleaned by cache sweeps.

## 4. Policy chain

`review_policy: 'none' | 'advisory' | 'required'`, resolved most-specific-first, mirroring `resolveClosePolicy` exactly:

| Scope | Source |
|---|---|
| per-task | `syncable_resources.metadata.review_policy` |
| per-swarm | `ParticipantCapabilities.cascade.reviewPolicy` |
| per-hub | `config.cascade.defaultReviewPolicy` (default `'none'`) |

Pure `resolveReviewPolicy(...)` added to `src/cascade/policy.ts` (no I/O, never throws — same invariants as the close-policy resolver). Semantics:

- `none` — verdicts recordable, nothing gated (fleet default; zero-cost like the task binder).
- `advisory` — verdicts surfaced everywhere (UI badges, PR-stack annotations) but nothing withheld.
- `required` — the Layer-1 gates in §5 activate. **`required` means a current-head `approved` verdict with `reviewer_kind='human'`** — this is the program's "verified = human acceptance" decision, encoded ([D3]). Agent approvals never satisfy `required` in v1.

## 5. Hub surfaces

### 5.1 REST + realtime

- `POST /cascade/streams/:id/verdicts` `{verdict, notes?}` — records a verdict at the stream's current head. Auth: any authenticated principal; `reviewer_kind` derived from the principal (admin/human console → `human`, agent key → `agent`), never client-declared.
- `GET /cascade/streams/:id/verdicts` (`?current=true` for latest-at-current-head).
- New hub event `cascade_review_verdict_recorded` → WS broadcast on the existing cascade channels, feeding the console and the metrics rollup.

### 5.2 The gates (policy `required` only)

| Gate point | Behavior |
|---|---|
| Hub-initiated merge (REST → `x-cascade/request.merge`) | 409 `review_required` unless `isApprovedAtHead` |
| `POST /cascade/streams/:id/pr-stack` | per-stream check; unapproved streams marked `blocked_by_review` in the plan (same shape as `blocked_by_parent`) |
| Merge-queue projection `queued → ready` surface | ready-marking via hub UI/API withheld; runtime-originated `queue.ready` events still project (runtime is authoritative) with an `unreviewed` annotation |

### 5.3 Reviewer dispatch (agent QC, advisory)

A stream reaching review triggers (manually in v1, policy-driven later) a dispatch with `metadata.role='reviewer'`, its prompt fed by the existing five-tier diff resolver. The reviewing agent's report writes an `agent` verdict carrying `dispatch_id`. This reuses the entire dispatch pipeline — roster role-matching, loadouts, retry, transports — with zero new execution machinery. Agent verdicts inform the human's acceptance; they do not replace it ([D3]).

### 5.4 Console

Stream detail already renders diffs; add **Approve / Request changes** on that view (verdict + optional note), a verdict badge on stream/dispatch cards, and the `review_required` state surfaced on merge/PR-stack affordances. The console is the human-acceptance surface — this button is where the factory's "verified" clock stops.

## 6. Factory-metrics contract

- **Verified merge** = `stream.merged` projection joined to a current-head human `approved` verdict. This is the unit-of-production denominator for throughput/yield/lead-time.
- **`unreviewed_merge`** = a merge with no qualifying verdict under a `required`/`advisory` policy — a first-class quality-escape counter, not an error.
- Verdict `created_at` is the "verified" timestamp in the spec→dispatch→merge→close lead-time join; `dispatch_id` on agent verdicts prices QC into per-unit cost.

## 7. Companion track: git-cascade (we own the repo; sequence at will)

- **G1 — bug fixes (do first, independent of review):** (a) route `processMergeQueue` merges through the tracker's emit path so `stream.merged` + `queue.removed` fire; (b) resolve merge targets via local-mode `existingBranch` in `mergeStream` so the queue can land on `main`.
- **G2 — protocol:** adopt the **diff-stack model as the canonical review primitive** ([D5]); add `review.stack_created` / `review.status_changed` event suffixes (payload: stack id, stream id, from/to status, `reviewed_by`, head commit), an `x-cascade/request.review_status` action, and a `CascadeCapability.review: {model: 'diff-stack', enforced: boolean}` flag. Hub then projects runtime-side review state alongside its own verdicts.
- **G3 — library enforcement:** `mergeStream`/`processQueue` consult approval for opted-in streams (wiring or replacing the dead `reviewWorkflow` config); deprecate the `stacks.ts` review-block model or port the state machine into it — carrying two half-review systems is worse than one.

Layer 1 (§3–§6) has **no dependency on G1–G3**; G2 landing later only upgrades bypass *detection* to bypass *prevention* for participating runtimes.

## 8. Decisions

- **[D1] Verdicts are hub-owned QC state, not cascade state.** The "hub never writes cascade state" invariant is untouched; verdicts join to projections, they don't mutate them.
- **[D2] Verdicts bind to `(stream, head_commit)`,** resolved server-side. New commits invalidate approval by construction.
- **[D3] "Verified" = human acceptance.** `required` policy is satisfied only by a human `approved` at current head; agent verdicts are advisory. (Program decision, 2026-07-09.)
- **[D4] Enforce at hub orchestration first; library gate later.** Agent-local merges are detected (`unreviewed_merge`), never blocked from the hub.
- **[D5] diff-stacks over review blocks** as the runtime review primitive — it has the state machine and the only working gate.
- **[D6] Append-only verdicts;** supersede by writing a new row, no updates. The audit trail is the point.

## 9. Non-goals (v1)

- Inline comment threads / line-level review (notes field only).
- Multi-reviewer quorum or CODEOWNERS-style routing.
- Syncing verdicts to GitHub PR reviews (the PR-stack opener stays a separate export path).
- Hub-blocking of runtime-local merges (physically impossible; see [D4]).
- Retroactive verdicts on already-merged streams.

## 10. Staged plan

| Stage | Scope | Proof |
|---|---|---|
| **Q1** | V66 + DAL + REST + WS + console Approve/Request-changes; `defaultReviewPolicy: 'none'` — purely additive | DAL + route tests; verdict round-trip in console |
| **Q2** | `resolveReviewPolicy` + the three gates + `unreviewed_merge` detection + verdict join in factory metrics | policy unit tests (mirror `policy.test` for close-policy); gate 409s; bypass-detection integration test |
| **Q3** | reviewer-dispatch wiring (role loadout, diff-fed prompt, verdict write-back with `dispatch_id`) | live-gated e2e alongside the existing `live-*-dispatch` suite |
| **G1–G3** | git-cascade track per §7, sequenced independently | git-cascade's own suite + a hub projection test per new event |
