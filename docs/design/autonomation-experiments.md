# Autonomation Experiments — OpenHive as the experiment control plane

**Status:** draft · iteration target · 2026-06-24
**Owner:** (tbd)
**Related:** `src/swarm/` (hosting), `src/dispatch/CLAUDE.md`, `src/scheduler/CLAUDE.md`, `src/cascade/CLAUDE.md`, `src/coordination/CLAUDE.md`, `src/realtime/CLAUDE.md`
**Companion repo:** `autonomation` (`packages/ts-sdk`, exported as `autonomation` on npm — real subpaths include `autonomation/experiment` and `autonomation/deployment`; `autonomation/loop` is **not** an exported subpath, only re-exported internally)

> Living design doc, not a spec. Decisions marked **[D?]** have a recommended
> default and are open for iteration. The schema in §4 is meant to be lifted
> into a migration once §13 is settled.

### Revision log

- **2026-06-27 — bug scan follow-up.** A systematic scan of the landed Stage A
  experiment scheduling/UI paths found several regressions around the
  `kind: "experiment"` schedule payload, lifecycle gating, schedule ownership,
  and decrease-objective scoring. See
  [`../bug-reports/2026-06-27-experiment-regressions.md`](../bug-reports/2026-06-27-experiment-regressions.md)
  for root-cause evidence and reproduction steps.
- **2026-06-24 — pressure-test pass (17-agent adversarial review of both codebases).** Two load-bearing reframes adopted (all 12 high/critical findings survived adversarial verification):
  1. **A run is hosted as an OpenHive *hosted swarm* (`src/swarm`), not a dispatch.** The dispatch orchestrator's stall-timeout (5 min, frozen at spawn for the ACP runtime), blind retry (`maxRetries=3` re-runs the whole loop), single global concurrency counter (`global=5`), and coding-agent-only runtimes all actively break a multi-hour run. The hosted-swarm manager already has the correct long-lived-process lifecycle. **Dispatch is reserved for the short, retry-safe inner evolve/eval units in Stage B.**
  2. **Verifiability fields arrive via a worker *finalization POST*, not the tracker.** `content_hash`, `claim_strength`, and the train-vs-held-out score cards are *not* reachable through the `ExperimentTracker` interface (events + finish-summary). The worker reads autonomation's public outputs (`runWithControls()` return value + `runner.lineage`) at run end and POSTs them — zero autonomation changes. `env_fingerprint` is **worker-computed** (autonomation produces nothing like it).
- **2026-06-24 — [D8] resolved (6-agent check, both skeptics upheld the verdict).** Hosting a non-agent runner kind is **moderate** — bounded, additive, **no structural surgery, no DB migration** (`MIGRATION_V51` already dropped the `hosted_swarms.kind` CHECK → free TEXT column). The kind union (`openswarm | claude-code | codex`) is closed but additive (no `assertNever`/exhaustive switch anywhere); `LocalProvider` already has a verbatim-command spawn primitive (currently dead from the manager, must be newly wired); the **one real gate is the OpenSwarm-specific `/health` probe**, which a non-agent process must skip (codex-rpc already does, by allocating no port). Full change-list in §13 [D8].
- **2026-06-24 — launcher: dedicated process-host, not the hosted-swarm manager (supersedes the §2/§14 "run = hosted swarm" framing for the runner).** Reading the actual `src/swarm/manager.ts` showed its machinery exists to manage **MAP-registered agent swarms** (MAP pre-registration, HTTP `/health` polling, credential overlays) — an autonomation runner is none of those: it's a self-reporting compute process with no port, no health endpoint, no MAP identity, that PATCH/events/finalizes itself. So `src/experiments/launcher.ts` spawns the worker as a **detached child process** (token-in-env, PID-tracked, `cancel = kill -group`) via a generic seam — **zero core-manager surgery**. The [D8] hosted-swarm `autonomation-runner` kind remains available later if fleet-level lifecycle management is wanted. Decision made jointly with the user ("expand the interface for flexibility"); the autonomation side gains a `createExperimentRunnerFromConfig` factory (the lightweight/fast-iteration path) as the matching interface expansion.
- **2026-06-24 — slice 4 landed + hardened (launcher + scheduler `experiment` payload; adversarial review, 1 HIGH + 1 MEDIUM upheld + 4 MEDIUMs fixed).** The launch/cancel routes are **admin-only** (they spawn/kill OS processes — `createAuthOrAdminKey` would let any authenticated agent spawn a detached worker). Launch uses an **atomic DB claim** (`claimRunForLaunch`: conditional UPDATE on `status='queued' AND hosted_swarm_id IS NULL`) so concurrent launches can't double-spawn. The worker dials the hub's **actual bound port** via `setHubBaseUrl` set post-`listen` (`config.port` is wrong after an `EADDRINUSE` auto-increment). `cancel` falls back to the persisted `proc:<pid>` marker when the process isn't tracked (hub restart). Run-controls are validated (positive-int) before reaching argv; a spawn error finalizes the run `failed`; the validated-but-ignored `stopAfterNoPromotion` control was dropped. Deferred (documented): a reconciliation sweep for runs whose worker dies mid-run after a restart.
- **2026-06-24 — decisions resolved ([D1], [D2], [D6], [D7], [D9]).** Experiment **identity is content-hash-keyed (unique when present) with a free human label**; experiments are **not** bound to each other — the incremental "evolved candidates" story lives in the **candidate git lineage within an experiment** (`parent_candidate_id` + each ChangeSnapshot's commits + the promotion chain), not an experiment-to-experiment edge ([D2]). `content_hash` is **nullable** — lightweight runs are *exploratory* (fast-iteration default); a target adopts a deployment config to become content-keyed ([D9], confirmed: `createExperimentRunnerFromDeployment` drives a real run, exposes `plan.lock.contentHash` + a `gateFromClaims(plan.claims)` gate). Worker auth: hub-launched runs use a **launch-minted per-run token** (C); externally-launched runs get an `experiments`-scoped ingest key (A) later ([D6]). Worker ships as an `openhive experiment-worker` **subcommand** ([D1]); changeSnapshot stays **opaque** ([D7]).

---

## 1. What we're building

[autonomation](https://github.com/…/autonomation) is a **harness-optimization
framework**: it proposes, evaluates, and gates edits to an agent system to raise
that system's task performance. Its loop is `propose → admit → evaluate → gate →
promote`, run git-natively — an **Evolver** (a coding agent) edits a worktree at
the incumbent commit and produces a **ChangeSnapshot** (`base..head` +
`changedPaths`); an **Evaluator** command produces scalar metrics; an objective
gate keeps or discards; promotion squashes onto an experiment branch. Today the
runner is single-machine, one-candidate-per-cycle, with lineage in-memory or in
a git sidecar branch, and observability via CLI / optional W&B.

OpenHive becomes the **control plane** for that loop: it *defines, schedules,
hosts, persists, and visualizes* experiments across a fleet — while the
**optimization decision (gate, claims, held-out split) stays inside
autonomation**. OpenHive carries the work out and manages its lifecycle; it never
decides keep/discard.

This doc lands the **first-class managed construct** (the destination) as the
schema target, and stages the implementation A → B → C against that one schema so
each step is additive.

---

## 2. Design thesis: the hosted runner worker

Two constraints jointly determine the architecture:

1. **The optimization decision stays in autonomation.** OpenHive must not
   re-implement the gate, the claims, or the held-out seesaw.
2. **OpenHive carries the loop out and manages it** — it owns the experiment's
   lifecycle, scheduling, persistence, UI, and (later) distribution.

The seam that satisfies both is a **runner worker**: an OpenHive-managed process
that embeds autonomation's *programmatic* runner (`createExperimentRunner`) and
runs the loop on a target repo. The gate executes inside autonomation's code in
that process; OpenHive owns the process.

**The worker is hosted as a hosted swarm, not a dispatch.** `src/swarm` is a true
long-lived-process manager: states `provisioning → starting → running → unhealthy
→ stopping → stopped → failed`, per-id restart counts, exit-code/signal → terminal
state mapping, and optional auto-restart — with **no 5-minute stall killer and no
ACP/turn assumption** (`src/swarm/types.ts:14-21`, `src/swarm/manager.ts:390-467,
2121-2256`). That matches an overnight optimization loop. The dispatch
orchestrator, by contrast, is built around *claim → spawn a coding agent → prompt
→ turns → report*, with a stall timeout that (on the ACP runtime) is frozen at
spawn and a blind 3× retry — see §14 and the revision log for why that breaks a
long run.

Three channels connect the worker to the hub:

- **Report — live (out):** `OpenHiveExperimentTracker`, an OpenHive class that
  `implements` the `ExperimentTracker` interface *imported (type-only) from
  `autonomation/experiment`*, POSTs the event firehose to the hub ingest API.
- **Report — finalization (out):** at run end the worker captures the
  `runWithControls()` **return value** (carries `claim_strength`, counts,
  stop reason) and reads `runner.lineage` (carries per-candidate train `card` +
  held-out `gateCard`), plus the deployment lock `content_hash` if it ran via the
  deployment path, and POSTs a finalization payload. These do **not** travel
  through the tracker (see §6/§10).
- **Control (in):** the hub manages the run's lifecycle through the hosted-swarm
  manager (start / health / stop), not through the dispatch claim/retry/stall loop.

```
            ┌──────────────────── OpenHive hub (control plane) ───────────────────┐
            │                                                                       │
   operator │  experiments ─┬─ experiment_runs ─┬─ experiment_candidates           │
   / API ──▶│   (the line)  │  (1:1 hosted swarm)│  (lineage projection)           │
            │               │                   └─ experiment_events (append-only) │
            │               │                                                       │
            │  scheduler ────┘   ingest API   mapHubEvents.experiment_* ──▶ WS/UI   │
            │       │            ▲    ▲     │                                       │
            └───────┼────────────┼────┼─────┼───────────────────────────────────────┘
          start/stop│   live POST│    │fin. │ broadcast (map:experiments + experiment:<id>)
          (hosted   │   (tracker)│    │POST │
           swarm    ▼            │    │     ▼
           manager) ┌────────────┼────┼──────────────────────────────────────────┐
            │  runner worker (hosted-swarm process, OpenHive-managed)             │
            │                    │    │                                            │
            │  autonomation createExperimentRunner(...)  ← gate / claims live here │
            │   propose → evolve → evaluate → GATE → promote                       │
            │                    │    │                                            │
            │  observers:[experimentTrackerObserver({trackers:[OpenHiveTracker]})] │
            │  finish: read runWithControls() result + runner.lineage → POST       │
            └──────────────────────────────────────────────────────────────────────┘
```

In **Stage A** the worker runs the whole loop locally and reports. In **Stage B**
the worker's `CandidateRuntime` is swapped for a `HiveCandidateRuntime` that fans
each *inner* evolve/evaluate out to hub **dispatches** (those units are short,
agent-shaped, and retry-safe — a genuine dispatch fit); the gate still runs
locally on the returned metrics. In **Stage C** the entity model gains
cross-instance federation + a dedicated UI. No experiment-table schema change
between stages.

---

## 3. Dependency direction & the serializability seam

OpenHive depends on `autonomation`; autonomation never depends on OpenHive. No
cycle.

| OpenHive component | Imports from autonomation | Kind |
|---|---|---|
| Hub control plane (`src/experiments/`) | `ExperimentTracker`, `ExperimentEvent`, `ExperimentEventType`, `ExperimentRunMetadata`, `ExperimentRunSummary`, `ExperimentStopReason`, `ExperimentRunResult` | **type-only** (`import type …`) — erased at build, no runtime dep |
| Runner worker (the hosted process) | `createExperimentRunner`, `createExperimentRunnerFromDeployment`, `experimentTrackerObserver`, the runtime | **full runtime** dependency |

**LANDED:** `autonomation` is declared as an **optional peer dependency**
(`peerDependencies` + `peerDependenciesMeta.autonomation.optional`) and marked
`external` in `tsup.config.ts`. The hub never loads it: the tracker imports the
interface **type-only** (erased), and the worker loads the runtime via a dynamic
`import('autonomation/experiment')` (verified in `dist/cli.js`; autonomation
internals are not bundled; the hub library has no autonomation reference).

**Build-time vs runtime.** autonomation is *runtime-optional* but *build-time
required*: `tsc` (whole-project) must resolve the type-only import, so a
contributor building openhive-with-experiments needs autonomation present. Dev
wiring follows the repo's multi-repo convention — symlink it so edits are live:

```bash
# from openhive-2/  (idempotent)
ln -sfn /path/to/autonomation/packages/ts-sdk node_modules/autonomation
ls -la node_modules/autonomation   # should show the symlink target
```

**The hub cannot ship a runner-options object over the wire.**
`ExperimentRunnerOptions` carries live JS objects/functions — `evolver`
(a `GitWorkspaceEvolver` with an async method), `evalSet`/`evalSplit` (Tasks with
`verifier` closures), `command.metric` (a parser function), `gate`, `portfolio`,
`overlay*`, `harnessForWorktree`, `substrates`. None are JSON-serializable. So:

- the hub stores a **declarative config** — the **`RunExperimentConfig` (CLI Zod)
  shape** (`autonomation .../cli/configs.ts`): `evolver.kind` (`command` |
  `claude-code` | `agent-workspace`) and `evaluator.kind` (`command` | `swe` |
  `verifier`) discriminated unions, `objective`, `evalSet`/`evalSplit` as
  `{id,prompt}` task lists, `allowedPaths`, run controls, `lineage`, and an
  optional `deployment` ref (`{deploymentPath, runPath, root, gateAggregate}`).
- the worker **reconstructs** `ExperimentRunnerOptions` locally, exactly as the
  CLI does (`run-experiment.ts` `evolverFromConfig` / `evaluatorFromConfig` /
  `substratesFromConfig` / `gateFromClaims`), then injects observers. (For an
  `agent-workspace` evolver, even the backend arrives as a *module path* the
  worker dynamically imports.)

A hub **can** declaratively express evolver/evaluator kind+params, objective, task
ids/prompts, allowed paths, run controls, lineage mode, and deployment refs. A hub
**cannot** express live evolvers, verifier closures, or custom gate/portfolio/
overlay functions — those are kind-reconstructed worker-side.

**[D1] — RESOLVED: subcommand now, deepen later.** The runner worker ships as an
`openhive experiment-worker` subcommand (`src/experiments/worker/`), with the
`autonomation` runtime as an **optional/peer dependency** so non-experiment
deployments don't pay for it. Keep the worker free of hub imports except shared
types so a later extraction stays mechanical. Experiment *management* (launch,
pause, lineage, live tail) integrates progressively into the OpenHive UI over time.

**[D8] — RESOLVED (2026-06-24): feasible, moderate.** A non-agent
`autonomation-runner` kind is bounded, additive work — no structural surgery and
**no DB migration** (the `hosted_swarms.kind` CHECK was already dropped in
`MIGRATION_V51`; the column is free TEXT). The existing kinds are
`openswarm | claude-code | codex` (`src/swarm/types.ts:418-422`); the union is
closed but additive (no `assertNever`/exhaustive switch anywhere, so a new member
compiles cleanly and every kind-dispatch site falls through to the openswarm path
by default). `LocalProvider` already has the generic "run a command verbatim and
keep it alive" primitive (`spawn_command_override` + detached spawn + generic
exit-code→state mapping, `local.ts:163-166,248-253,396-410`) — but it is currently
*unexercised* from the manager (only `spawnOpenswarm` calls `provider.provision`)
and must be newly wired. The one real gate is the **health check**; full
change-list in §13 [D8].

---

## 4. Entity model (the schema to nail)

Four tables, mirroring autonomation's types so live ingest is a thin projection
and finalization fills the rest. IDs use the OpenHive convention
(`<prefix>_<nanoid>`; prefixes `exp_`/`exrun_`/`excand_`/`exev_` are
collision-free), timestamps are ISO-8601 strings, structured fields are JSON
`TEXT`. **Migration numbers V60–V63 are currently free against `SCHEMA_VERSION=59`;**
see §16 for the *full* registration mechanics (they are not auto-discovered).

> **Landed (2026-06-24).** Migrations V60–V63 + the DAL are implemented;
> `SCHEMA_VERSION` is bumped to 63. The shipped DDL (`src/db/schema.ts`) is now the
> reference and adds, on top of the columns below, house-style `DEFAULT` clauses
> (`objective_direction` `'increase'`, `status` `'draft'`/`'queued'`,
> `initiator_type` `'user'`, `hive_id` `''`) plus the partial-unique
> `content_hash` index — additive to the shapes here. DAL: `src/db/dal/experiments.ts`.

### 4.1 `experiments` — the optimization line (operator-owned)

```sql
-- Migration V60
CREATE TABLE IF NOT EXISTS experiments (
  id                   TEXT PRIMARY KEY,           -- exp_<nanoid>
  hive_id              TEXT NOT NULL,
  name                 TEXT NOT NULL,              -- free human label (not a binding)
  description          TEXT,
  content_hash         TEXT,                       -- NATURAL KEY when present (unique index below); NULL = exploratory/fast-iteration (§10)
  objective_metric     TEXT NOT NULL,
  objective_direction  TEXT NOT NULL CHECK (objective_direction IN ('increase','decrease')),
  objective_min_delta  REAL NOT NULL DEFAULT 0,
  claims               TEXT,                       -- JSON: pre-registered SignalClaims
  config               TEXT NOT NULL,              -- JSON: RunExperimentConfig (CLI Zod shape) — see §3
  repo_resource_id     TEXT,                       -- FK syncable_resources (target harness repo)
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  incumbent_candidate_id TEXT,                     -- FK experiment_candidates (current promoted best)
  initiator_type       TEXT NOT NULL CHECK (initiator_type IN ('user','agent')),
  initiator_id         TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_experiments_hive   ON experiments(hive_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_experiments_chash ON experiments(content_hash) WHERE content_hash IS NOT NULL;
```

### 4.2 `experiment_runs` — one loop invocation, hosted as a hosted swarm

```sql
-- Migration V61
CREATE TABLE IF NOT EXISTS experiment_runs (
  id                   TEXT PRIMARY KEY,           -- exrun_<nanoid>
  experiment_id        TEXT NOT NULL,
  autonomation_run_id  TEXT,                       -- runId emitted by the autonomation runner
  hosted_swarm_id      TEXT,                       -- FK hosted-swarm registry — the process hosting the run (NULL for external/manual runs)
  worker_token_hash    TEXT,                       -- [D6] SHA-256 of the launch-minted per-run worker token; cleared on finish (NULL for externally-launched runs using an ingest key)
  content_hash         TEXT,                       -- exact deployment lock for THIS run; NULL on the lightweight path (§10)
  env_fingerprint      TEXT,                       -- JSON { host, harnessCommit, hardwareClass, seedPolicy } — WORKER-COMPUTED (§10)
  repo_root            TEXT,
  experiment_branch    TEXT,
  experiment_worktree  TEXT,
  start_point          TEXT,
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','failed','cancelled')),
  stop_reason          TEXT,                       -- autonomation ExperimentStopReason (finalization POST)
  stop_message         TEXT,
  claim_strength       TEXT,                       -- JSON ClaimVerdict — finalization POST ONLY (not in events/summary; §10)
  cycles               INTEGER NOT NULL DEFAULT 0,
  total_proposed       INTEGER NOT NULL DEFAULT 0,
  total_admitted       INTEGER NOT NULL DEFAULT 0,
  total_promoted       INTEGER NOT NULL DEFAULT 0,
  candidate_failures   INTEGER NOT NULL DEFAULT 0,
  summary              TEXT,                       -- JSON ExperimentRunSummary + ExperimentRunResult
  initiator_type       TEXT NOT NULL CHECK (initiator_type IN ('user','agent','schedule')),
  initiator_id         TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exrun_experiment ON experiment_runs(experiment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_exrun_hosted     ON experiment_runs(hosted_swarm_id);
CREATE INDEX IF NOT EXISTS idx_exrun_arunid     ON experiment_runs(autonomation_run_id);
```

### 4.3 `experiment_candidates` — lineage projection (events + finalization)

```sql
-- Migration V62
CREATE TABLE IF NOT EXISTS experiment_candidates (
  id                   TEXT PRIMARY KEY,           -- excand_<nanoid>
  experiment_id        TEXT NOT NULL,
  run_id               TEXT NOT NULL,
  candidate_ref        TEXT NOT NULL,              -- autonomation candidateId
  parent_candidate_id  TEXT,                       -- lineage edge (hub id)
  cycle_index          INTEGER,
  proposer             TEXT,
  status               TEXT NOT NULL CHECK (status IN ('baseline','admitted','keep','discard','crash','no_candidate')),
  base_commit          TEXT,
  head_commit          TEXT,
  changed_paths        TEXT,                       -- JSON array
  patch_ref            TEXT,
  overlay              TEXT,                       -- JSON overlay values (privacy-gated)
  content_hash         TEXT,
  score_train          REAL,                       -- LineageEntry.card  (finalization; events carry only one scalar)
  score_held_out       REAL,                       -- LineageEntry.gateCard (finalization; the seesaw)
  scores               TEXT,                       -- JSON extra metrics map
  promoted             INTEGER NOT NULL DEFAULT 0,
  rationale            TEXT,
  failure_reason       TEXT,
  dispatch_id          TEXT,                       -- [B SEAM] inner evolve/eval dispatch — NULL in Stage A
  cascade_stream_id    TEXT,                       -- [C SEAM] projected cascade stream — NULL until projected
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_excand_ref ON experiment_candidates(run_id, candidate_ref);
CREATE INDEX IF NOT EXISTS idx_excand_experiment ON experiment_candidates(experiment_id, promoted);
CREATE INDEX IF NOT EXISTS idx_excand_parent     ON experiment_candidates(parent_candidate_id);
```

> **Why two score columns, not one JSON blob:** the event stream carries a single
> scalar `score` per candidate (the held-out/gate score for promotions in split
> mode). The **train-vs-held-out pair lives only on `LineageEntry` (`card` =
> train, `gateCard` = held-out)** and is exposed via `report.ts` over
> `runner.lineage` — *never* in events. So the seesaw is populated by the
> **finalization POST** (a lineage snapshot at run end), not by the event
> projection. `score_held_out` is what the live objective curve also uses.

### 4.4 `experiment_events` — append-only live telemetry

```sql
-- Migration V63
CREATE TABLE IF NOT EXISTS experiment_events (
  id                   TEXT PRIMARY KEY,           -- exev_<nanoid>
  experiment_id        TEXT NOT NULL,
  run_id               TEXT NOT NULL,
  autonomation_run_id  TEXT,
  seq                  INTEGER NOT NULL,           -- monotonic per run — ordering + dedup
  type                 TEXT NOT NULL,              -- ExperimentEventType (15 variants)
  cycle_index          INTEGER,
  candidate_ref        TEXT,
  metric               TEXT,
  score                REAL,                       -- single scalar (held-out for promotions in split mode)
  message              TEXT,
  payload              TEXT NOT NULL,              -- JSON full ExperimentEvent (remote-payload-stripped)
  created_at           TEXT NOT NULL,              -- event timestamp (from autonomation)
  received_at          TEXT NOT NULL               -- hub receive time
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_exev_seq ON experiment_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_exev_run       ON experiment_events(run_id, created_at);
```

**Source-of-truth rule (corrected):** `experiment_events` is the append-only live
log. `experiment_candidates` is a projection maintained from **two** inputs:
(1) the live event stream — candidate existence/status/incumbent from the 15
event types (`baseline_*`, `cycle_*`, `evolver_*`, `candidate_admitted/rejected`,
`evaluation_*`, `promotion_keep/discard`, `experiment_*`); and (2) the
**finalization POST** — `score_train`/`score_held_out` per candidate (from the
lineage snapshot) + `content_hash` + `claim_strength`. Events alone cannot
populate the train/held-out pair; the finalization snapshot is required. This
mirrors how `src/cascade` projects from a stream and `src/coordination` relays
without owning authority.

---

## 5. Lifecycle & write authority

Following the dispatch model's **split write authority** convention:

| Transition | Writer |
|---|---|
| experiment `draft → active → paused → archived` | hub (operator/API) |
| run `→ queued` | hub (launcher / scheduler) on insert |
| run `queued → running` | hub when the hosted swarm reaches `running`, or tracker `experiment_start` |
| run `running → complete` | tracker `experiment_complete` **and** finalization POST (graceful) / hosted-swarm `stopped` clean exit |
| run `running → failed` | tracker `experiment_error` / hosted-swarm `failed` (crash/non-zero exit) |
| run `running → cancelled` | hub on operator cancel → hosted-swarm `stop()` |
| `content_hash` / `claim_strength` / `score_train` / `score_held_out` | hub finalization handler (from the worker's finalization POST) |
| candidate existence / status / `incumbent_candidate_id` | hub ingest handler (event projection — never operator-authored) |

The keep/discard *decision* is autonomation's; the hub only **records** the
`promotion_keep`/`promotion_discard` verdict. The hosted-swarm lifecycle
(health/exit-mapping) governs the coarse run state — **not** a stall timeout or a
blind retry (see §14).

---

## 6. The tracker contract (interface from autonomation, impl in OpenHive)

autonomation defines (`autonomation/experiment`, verified):

```ts
// imported BY OpenHive (type-only) — not redefined
export interface ExperimentTracker {
  start?(run: ExperimentRunMetadata): void | Promise<void>;
  log(event: ExperimentEvent): void | Promise<void>;
  finish?(result: ExperimentRunSummary): void | Promise<void>;
}
```

OpenHive implements it as an HTTP client to the ingest API:

```ts
// src/experiments/worker/openhive-tracker.ts  (OpenHive code)
import type {
  ExperimentTracker, ExperimentEvent,
  ExperimentRunMetadata, ExperimentRunSummary,
} from "autonomation/experiment";

export class OpenHiveExperimentTracker implements ExperimentTracker {
  constructor(private readonly opts: {
    hubUrl: string; apiKey: string; experimentId: string; runId: string;
    failurePolicy?: "warn" | "fail";
    privacy?: { includePatch?: boolean; includeOverlay?: boolean };
  }) {}
  async start(meta: ExperimentRunMetadata)  { /* PATCH run → running + metadata (idempotent) */ }
  async log(event: ExperimentEvent)         { /* POST events (batched; seq from a local counter) */ }
  async finish(result: ExperimentRunSummary){ /* PATCH run → complete + summary */ }
}
```

The worker reconstructs runner options from the declarative config (§3) and wires
the tracker through autonomation's existing observer adapter — **but the tracker
is not sufficient by itself**:

```ts
import {
  createExperimentRunner, createExperimentRunnerFromDeployment,
  experimentTrackerObserver,
} from "autonomation/experiment";

// 1. reconstruct options locally (CLI-style) — NOT a hub-spread object
const opts = buildRunnerOptionsFromConfig(configFromHub);   // evolverFromConfig/evaluatorFromConfig/…
const runner = config.deployment
  ? await createExperimentRunnerFromDeployment({ ...opts, observers })   // content_hash available here
  : await createExperimentRunner({ ...opts, observers });                // content_hash NULL on this path

const observers = [experimentTrackerObserver({
  trackers: [new OpenHiveExperimentTracker({ hubUrl, apiKey, experimentId, runId })],
  failurePolicy: "warn",                  // telemetry never kills a run
})];

await runner.initializeBaseline();
const result = await runner.runWithControls(controls);   // claim_strength is HERE (return value)

// 2. finalization POST — the verifiability channel the tracker can't carry
await postFinalization(hubUrl, runId, {
  claim_strength: result.claimStrength,            // not in any event / summary
  content_hash: config.deployment ? plan.lock.contentHash : null,
  env_fingerprint: computeEnvFingerprint(),        // worker-computed; autonomation has no such field
  lineage: snapshotLineage(runner.lineage),        // per-candidate card (train) + gateCard (held-out)
  stop_reason: result.stopReason, summary: result,
});
```

`experimentTrackerObserver` already maps `experiment_start → tracker.start`, every
event → `tracker.log`, `experiment_complete → tracker.finish`, and strips
`stdout`/`stderr`/`patch`/`trajectory`. But `claim_strength` is on the
`runWithControls()` **return value only** (absent from events *and* from the
`ExperimentRunSummary` `tracker.finish` receives), the **held-out vs train cards**
live only on `runner.lineage`, and `content_hash` only exists on the deployment
path. Hence the finalization POST. All of this reads autonomation's *public*
surface — **no autonomation changes** (the "extend autonomation's events"
alternative was considered and rejected to keep that stance).

---

## 7. Ingest + management API

Under `/api/v1/experiments`, following the spec/dispatch/schedule route + DAL +
Zod-schema pattern. **Registration is not automatic** — add
`import { experimentsRoutes }` + `await api.register(experimentsRoutes, { config })`
in `src/api/index.ts` (alongside `schedulesRoutes`).

| Method + path | Purpose | Auth (preHandler) |
|---|---|---|
| `POST /experiments` | create/upsert an experiment line | operator (`createAuthOrAdminKey`) |
| `GET /experiments` · `GET /experiments/:id` | list / detail (detail embeds recent runs) | operator |
| `PATCH /experiments/:id` | update fields/status | operator |
| `POST /experiments/:id/pause` · `/resume` · `/archive` | operator lifecycle | operator |
| `POST /experiments/:id/runs` | launch a run (insert `queued` row + mint per-run token; Stage A returns it, the launcher injects it) | operator / scheduler |
| `GET /experiments/:id/runs` | list runs | operator |
| `PATCH /experiments/:id/runs/:runId` | run start/finish (tracker `start`/`finish`) | **worker key** |
| `POST /experiments/:id/runs/:runId/events` | append event(s) (tracker `log`, batched) | **worker key** |
| `POST /experiments/:id/runs/:runId/finalize` | finalization payload (claim_strength, content_hash, env_fingerprint, lineage) | **worker key** |
| `POST /experiments/:id/runs/:runId/cancel` | operator cancel → hosted-swarm stop | operator |
| `GET /experiments/:id/runs/:runId/events` | telemetry tail (paginated by `seq`) | operator |
| `GET /experiments/:id/candidates` | lineage projection | operator |

**Terminal-state semantics (§5):** `finalize` and `cancel` move the run to a
terminal state (`complete`/`failed`/`cancelled`) **and clear `worker_token_hash`**,
so the per-run token dies with the run. `events`/`finalize` against a terminal run
return `409` — a late or replayed POST cannot resurrect a closed run.

**[D6] — worker auth (RESOLVED: launch-minted token now, ingest-key scope later).**
For **hub-launched** runs (Stage A), the launcher mints a one-time per-run token,
stores its hash on the `experiment_runs` row, injects it as an env var into the
hosted worker, and the three worker-write routes check it — **row-scoped and
ephemeral by construction, no new table, no ingest-key change.** Background on why an
ingest key is the wrong tool here: `ingest_keys` provides only a **coarse
URL-segment scope enum** (`'map'|'sessions'|'resources'|'admin'|'*'`), is
**agent-bound, not run-bound**, and a new `/experiments` segment would fall through
`getRequiredScope` to require `*` (near-admin). **Later**, to let
externally-launched runs (dev/CI) report, add an `'experiments'` value to
`IngestKeyScope` (`src/types.ts`) + a `getRequiredScope` case and gate the key to its
run in the handler (option A). Do **not** assume row-scoped ingest keys exist — they
do not.

---

## 8. Event fan-out & UI

Live events project to hub events and broadcast, reusing the realtime fabric:

- **`mapHubEvents`** is an untyped `node:events` `EventEmitter` (`src/map/service.ts:18`)
  — adding `experiment_run_started` / `experiment_candidate` /
  `experiment_run_finished` needs **no** registry change.
- **`WSEventType` is a closed union** (`src/types.ts:89-220`): `broadcastToChannel`'s
  `event.type` must be one of its members, so each new `experiment.*` WS event type
  **must be appended to that union** to typecheck (follow the `schedule.*` /
  `cascade:*` precedent). Channel *names* are free-form.
- **Channel subscription has no authorization** — hive-channel gating was removed
  with the social layer (`src/realtime/index.ts:127-132`); any authenticated WS
  client can subscribe to any channel string. Since experiment telemetry can carry
  patches/overlays (§10/[D5]), enforce privacy at **broadcast time**, not via a
  channel ACL (there is none).
- **Use a paired fan-out helper.** The house convention is a single helper that
  fans out to both the fleet channel and the per-entity channel (see
  `src/realtime/swarm-events.ts`, `workspace-events.ts`, and the symmetry test in
  `src/realtime/CLAUDE.md`). Add `src/realtime/experiment-events.ts`
  (`broadcastExperimentLifecycleEvent`) fanning out to `map:experiments` +
  `experiment:<id>` — don't scatter raw `broadcastToChannel` calls.

The Threads surface can render an experiment run like any other trajectory: the
candidate lineage, the objective curve (the emitted promotion score — held-out/gate
in split mode), the **train-vs-held-out seesaw from the finalization lineage
snapshot**, and the live event tail. This is the "OpenHive *is* the experiment
tracker" payoff; the W&B tracker remains usable in parallel.

---

## 9. Scheduling recurring runs

A scheduler payload-type — the payload `kind` union is **extensible by design**
(`src/scheduler/payload-types.ts:23-25`):

```ts
interface OpenHiveExperimentPayload {
  kind: "experiment";
  experiment_ref: string;                 // experiments.id
  run_controls?: ExperimentRunControls;   // cycles, budgetSeconds, stop-after-* (autonomation shape)
  target_worker?: string;                 // which hosted-swarm host runs it
}
```

Adding the kind requires: a union member + `isValidPayload` branch + `getPayloadKind`
case in `payload-types.ts`, **and** a new branch in `createOpenHiveFireHandler`
(`fire-handler.ts`) plus new `FireHandlerDeps` (`resolveExperiment`,
`createExperimentRun`, `startHostedRunnerSwarm`) in `scheduler/setup.ts`. The
fire-handler is **a single hardcoded function, not a per-kind plugin system** — the
existing branches all end in `createDispatch`; the experiment branch instead
resolves the experiment (auto-pause on missing, mirroring the spec path), inserts a
`queued` `experiment_run`, and **starts a hosted swarm** (not a dispatch).

**Kill switches.** `autonomousDispatchPaused` is checked at the top of the fire
handler — but it is an **in-memory, non-persisted** flag (`src/map/dispatch-policy.ts`)
that resets to live on restart. For a *durable* pause, rely on
`experiments.status='paused'` (persisted), which the experiment fire-branch and the
`POST /runs` launcher must check explicitly — that check is **net-new code**, not
inherited.

---

## 10. Verifiability discipline (recorded, not re-derived)

The "verifiable loop" guarantees live in autonomation; the hub records and
surfaces them. **Where each field actually comes from (corrected):**

- **`content_hash`** (deployment lock) — exists **only** when the worker runs via
  `createExperimentRunnerFromDeployment` → `plan.lock.contentHash` (confirmed: that
  factory drives a real run and returns `{runner, plan, substrate}`, so the worker
  reads `plan.lock.contentHash` and gets a `gateFromClaims(plan.claims)` gate). The
  lightweight `createExperimentRunner` path produces **none**, and it is never in
  the event stream. → column is **nullable** and is the experiment's **natural key
  when present** (§4.1, [D2]); populated via the finalization POST from the plan
  lock. **[D9] — RESOLVED:** both paths supported, `content_hash` nullable.
  Fast-iteration (lightweight, null lock, *exploratory*) is the early default;
  targets adopt a deployment config to become content-keyed + bound. The UI badges
  locked vs exploratory runs.
- **`claim_strength`** (capability vs held-out-judge vs anchor vs gameable) — on the
  `runWithControls()` **return value only**; *not* in any event and *not* in the
  `ExperimentRunSummary` `tracker.finish` receives. → finalization POST. The UI must
  badge a judged-regime lift so it isn't read as a capability lift.
- **Held-out seesaw** — events carry a single scalar; the train `card` + held-out
  `gateCard` pair lives only on `LineageEntry` (`runner.lineage`), surfaced today via
  `report.ts`. → `score_train`/`score_held_out` populated via the finalization
  lineage snapshot. The `overoptimization` stop reason surfaces when train climbs
  while held-out plateaus.
- **`env_fingerprint`** — **autonomation produces nothing like it** (its only
  "fingerprint" hashes the eval *task set*). It is **worker-computed**: host (node
  `os`), harness commit (`git rev-parse` of the worker package), hardware class +
  seed policy (worker config). It is *not* a fact reported by autonomation.

---

## 11. Forward-compatible seams (A now, B/C additive)

| Seam | Stage A | Stage B / C |
|---|---|---|
| `experiment_candidates.dispatch_id` | `NULL` — worker ran evolve+eval locally | **B**: the inner evolve/eval **is** a dispatch (short, agent-shaped, retry-safe — the *correct* dispatch fit); `HiveCandidateRuntime` submits them; the gate still runs in the worker on returned metrics |
| `experiment_runs.env_fingerprint` | worker-computed, recorded | **B**: a paired candidate-vs-incumbent comparison (CRN, ADR-0002 — sensitive to the shared *instance* + incumbent cache) is **pinned to one fingerprint** as a dispatch routing constraint, preserving paired measurement under distribution |
| `experiment_candidates.changed_paths`/`base_commit`/`head_commit` | opaque metadata | **B/C**: project into a **cascade stream** (`cascade_stream_id`) → inherit the diff/stack UI; promotion → cascade merge |
| entity rows | local DB | **C**: lineage as a `SyncableResource` for cross-instance leaderboards |

**Scope of the "no migration" guarantee:** B and C fill nullable columns + swap a
runtime — they do not migrate the **four experiment tables**. The C-stage
`SyncableResource` projection *does* require a schema change: `resource_type` is a
CHECK-constrained enum, and SQLite can't `ALTER` a CHECK in place, so adding a
`'lineage'`/`'experiment'` type needs a recreate-and-rename migration (V46/V52
precedent) + a `SyncableResourceType` union update.

---

## 12. The managed construct (`src/experiments/`)

A **named subsystem with explicit policy surfaces + kill-switch** (the
`src/dispatch` / `src/cascade/task-binder` pattern):

- `src/db/dal/experiments.ts` — CRUD + projection helpers for the four tables (the
  `schedules.ts` shape; guard `JSON.parse` in `rowTo*` mappers, per `dispatches.ts`).
  Lives under `src/db/dal/` per the house rule that all DB access goes there;
  `src/experiments/` holds only business logic.
- `launcher.ts` — turns a run request into a **hosted swarm** (via `src/swarm`
  manager) that boots the runner worker with the declarative config + a scoped
  worker key. (Not a dispatch.)
- `ingest.ts` — projects live tracker events → candidate existence/status +
  `incumbent`; applies the finalization POST → `content_hash` / `claim_strength` /
  score cards; fans out via `src/realtime/experiment-events.ts`.
- `lifecycle.ts` — pause/resume/cancel; experiment-level kill-switch; maps
  hosted-swarm `failed`/`stopped` → run terminal state (no stall/retry loop).
- `worker/` — the hosted process embedding `createExperimentRunner` +
  `OpenHiveExperimentTracker` + the finalization POST. **[D1]**

---

## 13. Open decisions (recommended defaults — iterate here)

- **[D2] Experiment identity — RESOLVED: content-hash-keyed, human-labelled,
  experiments independent.** The natural key is `content_hash` (unique when present):
  re-running the same locked config accumulates under one experiment; a config tweak
  mints a new `content_hash` → a new, **independent** experiment (no
  `parent_experiment_id`). `name` is a free human label. The "build incrementally /
  results bound" story is the **candidate git lineage WITHIN an experiment** — the
  evolved candidates (`experiment_candidates.parent_candidate_id` + each
  ChangeSnapshot's commits + the promotion chain advancing the incumbent), which the
  schema already captures. `content_hash`-null runs are *exploratory* (fast-iteration),
  keyed by id+name.
- **[D3] Event volume.** Ingest the **full firehose** (15 event types) into
  `experiment_events`; derive candidate existence/status; finalization fills scores.
  *Recommended: yes; batch POSTs, index by `seq`.*
- **[D4] Lineage as a syncable resource — now or in C?** *Recommended: local tables
  in A; promote to a `SyncableResource` in C (recreate-and-rename migration).*
- **[D5] Remote payload policy.** Metadata + metrics only by default;
  `includePatch`/`includeOverlay` opt-in per experiment. **Enforce at broadcast
  time** (no channel ACL exists — §8).
- **[D6] Worker auth — RESOLVED: launch-minted token now (C), ingest-key scope later
  (A).** Hub-launched runs authenticate with a one-time per-run token minted at
  launch (hash on the `experiment_runs` row, injected as an env var, checked on the
  three worker-write routes) — no new table, no ingest-key change. Externally-launched
  runs (later) get an `'experiments'`-scoped ingest key gated to their run. See §7.
- **[D7] changeSnapshot representation — RESOLVED: opaque in A.** Store
  `base_commit`/`head_commit`/`changed_paths`/`patch_ref` as plain columns; no
  cascade coupling. Cascade-stream projection (B/C) stays open and is *not* free —
  the hub never authors cascade state, so projecting a candidate would need the
  worker to emit `x-cascade/*` events (see §14).
- **[D8] Hosted-swarm kind extensibility — RESOLVED: moderate** (verified; both
  skeptics upheld). A non-agent `autonomation-runner` kind is feasible and additive.
  Change-list:
  - *kind union* — add the literal to `HostedSwarmKind` (`types.ts:418-422`);
    compiles cleanly (no exhaustiveness guard exists).
  - *manager dispatch* — add an explicit arm in `spawn()` **before** the openswarm
    fallthrough (`manager.ts:1177`) → a new `spawnAutonomationRunner` helper; add
    awareness in `stop`/`restart`/`getLogs`/`reviveHostedSwarms` (~8 if-chain
    sites; no compiler safety net, so a missed site silently behaves as openswarm).
  - *provider* — wire `spawnAutonomationRunner` through `LocalProvider.provision`
    feeding `spawn_command_override`/`spawn_args_override` (the verbatim-command
    primitive); this provision-with-override path is dead from the manager today
    and must be newly exercised. Sandbox support needs the same branch added to
    `SandboxedLocalProvider` (it currently hardwires openswarm flags).
  - *health (the real gate)* — the spawn-time + periodic probe hardcodes
    `GET 127.0.0.1:(port+1)/health` and flips to `unhealthy` after
    `max_health_failures` (`manager.ts:2360-2389,2948-2977`). Make the runner
    allocate **no `assigned_port`** (codex-rpc already does this → never probed,
    reaches `running` from PID alone) or join the `isTuiKind` health-skip
    (`manager.ts:2338`). `provider.getStatus` is already generic process-alive.
  - *config Zod / API* — extend the closed spawn-route enum + `superRefine`
    (`swarm-hosting.ts:93`) and the mirrored `schedules.ts:26` enum; add any
    runner-config field to `SpawnSwarmSchema`.
  - *DB* — **none** (free-TEXT `kind` column post-`MIGRATION_V51`).
  - *UI* — ~6 frontend kind/adapter enum edits (spawn dialog, scheduler fallback,
    badge); suppress the chat affordance (`sendChatTurn` throws `NOT_IMPLEMENTED`
    for non-chat kinds).
  - *residual risk* — `reviveHostedSwarms` re-provisions as openswarm on hub
    restart unless given a skip/own-revive branch.
- **[D9] Canonical worker entry — RESOLVED: both, fast-iteration first.** Lightweight
  path (null lock) is the early default for speed; targets adopt a deployment config
  (`createExperimentRunnerFromDeployment`, confirmed to drive a run + expose
  `plan.lock.contentHash` + a `gateFromClaims(plan.claims)` gate) to become
  content-keyed + bound. The worker picks the path by `config.deployment` presence.

---

## 14. Relationship to other subsystems

- **Swarm hosting (`src/swarm`) — the run host.** Long-lived-process lifecycle
  (`provisioning→running→unhealthy→stopped→failed`, restart counts, exit-mapping,
  optional auto-restart). Existing kinds are `openswarm | claude-code | codex`;
  adding a non-agent `autonomation-runner` kind is bounded work (§13 [D8]) — the
  `kind` column is free TEXT (no migration), `LocalProvider` already runs arbitrary
  commands verbatim, and the only real gate is bypassing the OpenSwarm-specific
  `/health` probe. This is what runs the worker.
- **Dispatch (`src/dispatch`) — the *inner-unit* host in Stage B only.** The
  orchestrator's stall-timeout (`lastActivityAt` is frozen at spawn on the ACP
  runtime — `onUsage` is a dead sink, `recordActivity` never called — so a >5-min
  idle is marked `stalled` → terminated → **retried**), blind `maxRetries=3`
  (re-runs the whole loop, no idempotency), single `global=5` concurrency counter
  (long runs starve normal dispatches), and coding-agent-only runtimes (ACP, or the
  one-shot swarm-codex repo editor) make it **wrong for a long run**. It is *right*
  for the short, retry-safe per-candidate evolve/eval units in B. **The swarm-codex
  executor is repo-scoped and one-shot — it cannot host the runner** (correcting an
  earlier claim).
- **Cascade (`src/cascade`)** — candidate ChangeSnapshot ≈ cascade stream;
  promotion ≈ merge. Optional projection target in B/C.
- **Coordination (`src/coordination`)** — same hub-as-projector philosophy: the
  authority (the gate) lives off-hub; the hub relays + projects + visualizes.
- **Scheduler (`src/scheduler`)** — recurring runs via a new payload-`kind` + a new
  fire-handler branch that starts a hosted swarm.

---

## 15. Non-goals

- The hub never decides keep/discard, never runs the gate, never re-implements the
  optimization grammar.
- No hub-side held-out splitting or claim computation — those are reported facts
  (`claim_strength`/score cards via finalization; `content_hash` from the plan
  lock). `env_fingerprint` is the one verifiability field the hub *computes*
  (worker-side), because autonomation does not produce it.
- Stage A does **not** distribute candidate execution (B) or federate lineage (C) —
  the schema is shaped so both are additive (modulo the C `SyncableResource`
  migration, §11).

---

## 16. First slice (Stage A) — suggested order

1. **Migrations V60–V63 (full registration).** Export the four `MIGRATION_V6x`
   constants from `schema.ts`; import + register them in `MIGRATION_REGISTRY`
   (`src/db/index.ts`); **bump `SCHEMA_VERSION` 59→63** (else the branch
   `version < SCHEMA_VERSION` never trips and migrations silently don't run); **add
   the four `CREATE TABLE`s to `CREATE_TABLES`** (fresh installs skip migrations).
   Then `src/experiments/dal.ts` + DAL roundtrip tests.
2. Zod schemas + ingest/management routes; **register `experimentsRoutes` in
   `src/api/index.ts`**; pick preHandlers (operator vs worker-key).
3. `src/experiments/ingest.ts`: live-event projection (→ candidate existence/status
   /incumbent) + finalization handler (→ content_hash/claim_strength/score cards);
   add `experiment.*` types to the `WSEventType` union; add
   `src/realtime/experiment-events.ts` fan-out helper.
4. `OpenHiveExperimentTracker` (type-only import of the interface) +
   the finalization POST client.
5. **LANDED** — `openhive experiment-worker` subcommand (`src/experiments/worker/`)
   embedding `createExperimentRunnerFromDeployment` + the tracker + finalization;
   `autonomation` as an optional peer dep (dynamic import, `tsup` external).
   *Deployment path only* — the lightweight `createExperimentRunner` path is
   deferred (needs an autonomation config→runner factory export).
6. `src/experiments/launcher.ts` (run request → hosted swarm) — add the
   `autonomation-runner` kind + `spawnAutonomationRunner` (LocalProvider verbatim
   spawn, **no health port**), the manager dispatch/revive arms, and the Zod enum
   edits (§13 [D8]); then the scheduler `experiment` payload-kind + fire-handler
   branch + `FireHandlerDeps`.
7. Minimal UI: experiment list, run detail (objective curve from promotion events +
   train/held-out seesaw from finalization + candidate lineage + live tail).

Exit: a scheduled run starts a hosted-swarm worker, the loop runs to completion in
autonomation, and the hub shows the lineage + objective curve + seesaw + claim
strength — with **zero gate logic on the hub side**.
