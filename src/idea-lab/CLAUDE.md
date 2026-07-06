# src/idea-lab — autonomous brainstorm-and-work loop

A self-running space where agents generate ideas from seed objectives,
critique and merge them, judge the most promising, and put winners to work —
feeding results back as fresh seeds. It is **configuration + prompts on top
of existing OpenHive primitives, not new infrastructure**: ideas are specs,
discussion is spec-threads, the ledger is a memory bank, cadence is the
scheduler, execution is dispatch. This directory only adds a declarative
*pack* and an idempotent boot *provisioner*.

## Model: blackboard, not pipeline

There is no central controller. Each role is a recurring `dispatch_prompt`
schedule that wakes on its own cadence, reads shared state (the idea graph +
ledger), and acts. "Rounds" are emergent from cron offsets, not enforced.
The shared state IS the coordination (stigmergy).

Roles (see `roles/*.ts`): `ideator` (divergent generation, two-tier budget +
novelty pressure) → `skeptic` (critique + de-dup vs ledger) → `synthesizer`
(merge/split into stronger ideas) → `judge` (score on a fixed rubric, promote
on an absolute threshold with async human veto) → `dispatcher` (route
`build`/`research` by type, active-idea cap, reflect results into the ledger).

Idea lifecycle rides the spec `status` field: `draft → open → selected →
active → done` (archived = killed). Idea metadata lives under
`metadata.idealab` (`tier`, `type`, `score`); lineage uses graph links
(`derived_from`, `merged_from`). See `roles/conventions.ts` for the full
contract shared by every prompt.

## Loading the lab (it's a workload, not hub config)

The idea-lab is **loaded at runtime**, not configured globally at boot — it's a
workload you run, not hub infrastructure. `POST /idea-lab/load`
(`src/api/routes/idea-lab.ts`, admin-or-auth-key) calls `provisionIdeaLab(deps)`
with the instance args in the body:

- `targetSwarmIds`, `gitRemote`, `hiveId`, `reconcile`, and an optional full
  `pack` override (defaults to the checked-in `DEFAULT_IDEA_LAB_PACK`).

The preset (role prompts + cadences) is checked-in source a hub edits; the
instance specifics (objectives, target swarms, git remote) come in on load.
`GET /idea-lab` reports the loaded role schedules; `POST /idea-lab/unload`
pauses them (dormant, reversible). A dedicated preset/instance system (multiple
named labs, a `playbook` resource) can be factored out later — this is the
minimal runtime loader. There is **no** `config.ideaLab` and no boot-time
provisioning.

## Provisioning (the "reload reliably" guarantee)

`provisionIdeaLab(deps)` (`provision.ts`) applies a pack idempotently — safe to
re-run on every load. Reconciliation is **keyed, never blind**:

| Thing | Keyed by | Mode | Primitive |
|---|---|---|---|
| graph + ledger resources | `(owner, type, name)` | upsert | `upsertDiscoveredResource` |
| objectives (specs) | `metadata.idealab_key` | create-only | `daemonCreateSpec` / `daemonGetGraph` |
| role schedules | `payload.idealab_key` | managed | `schedules` DAL |

Objectives are **create-only** — never rewrite an idea agents may have
evolved. Schedules are **managed** — drifted cron/prompt/targets reconcile on
each load, but paused-state is operator-owned after first create. Nothing is
destructive; the provisioner only creates and updates lab-owned rows.

`schedules` has no unique-by-name column, so idempotency comes from stamping
`idealab_key` into the payload and matching on it (the app-level analogue of
what `upsertDiscoveredResource` does for resources). No schema migration.

## Load args

The `POST /idea-lab/load` body (all optional):
- `targetSwarmIds` — swarms the role dispatches target. **Empty → schedules
  loaded paused** (dormant until you set a target and resume). The kill switch
  (`autonomousDispatchPaused`) still gates fires.
- `reconcile` (`managed` | `create-only`, default `managed`).
- `gitRemote` — shared git remote for the lab graph. **This is the wire that
  lets connected swarms actually read/write the shared ideas.** When set, the
  graph is registered as an ordinary git-synced task resource (`git_remote_url`
  = the remote, `metadata.git_sync` enabled, `applyGitSyncConfig` writing the
  daemon's `sync.git` block); swarms clone it, use their native opentasks tools,
  and converge via git-sync + MAP `context.*` pull signals. When unset, the
  graph is hub-local.
- `hiveId` — schedule tenancy tag.
- `pack` — full pack override; defaults to the checked-in `DEFAULT_IDEA_LAB_PACK`.

## The shared-graph mechanism (how roles act on ideas)

Role agents author/critique/score ideas with their **native opentasks tools**
on a shared, git-synced lab graph — no idea-lab-specific agent surface. The
path (traced + validated): register the graph git-backed (`gitRemote`) →
swarms discover it (`map/resources/list`) and subscribe → the graph mounts into
a swarm at spawn via `git_sync` config (`swarm/manager.ts` `applyGitSyncConfig`)
→ agents read/write their local clone → git-sync (`autoCommit`/`autoPush` +
pull-on-`context.*`-signal) converges hub ↔ swarm. The lab graph is **just a
git-synced task resource** — nothing here forks the general opentasks/sync path,
so regular opentasks flows (hub-local graphs, non-synced task resources) are
unaffected. `git-sync-convergence.test.ts` validates the hub↔agent round-trip;
`provision-git-backed.test.ts` validates the registration. The dispatch
reply/`done()` capture is irrelevant to this — work flows through the graph.

## Editing the lab

`pack.ts` is the single source of truth: replace the example objective with
real north-stars, tune cadences, edit `roles/*.ts` prompts. Every change is a
clean reviewable diff. Prompts are TS string modules (not `.md`) so they
bundle through tsup with no asset-copy step.

## Tests

- `src/__tests__/idea-lab/pack.test.ts` — schema validation (fast, no DB).
- `src/__tests__/idea-lab/load-route.test.ts` — the runtime loader: `POST
  /idea-lab/load` creates the schedules idempotently, `GET /idea-lab` reports
  them, `POST /idea-lab/unload` pauses them, invalid pack → 422, admin-gated.
- `src/__tests__/idea-lab/provision.test.ts` — idempotency ("provision twice,
  no duplicates"), paused-when-no-targets, managed vs create-only reconcile,
  and that provisioned payloads pass the fire handler's `isValidPayload`.
  Daemon-free (empty objectives).
- `src/__tests__/idea-lab/provision-objectives-daemon.test.ts` — objective
  seeding + create-only idempotency through a real OpenTasks graph store
  (`daemonCreateSpec` → `daemonGetGraph` round-trip). The standalone
  `opentasks daemon start` subprocess is unreliable outside the production
  image (it needs HOME/OPENHIVE_HOME to survive), so this hand-builds an
  in-process IPC server bound to the resolved socket — the same approach as
  `opentasks-daemon-integration.test.ts` — and `withDaemon` reuses it.
- `src/__tests__/idea-lab/provision-git-backed.test.ts` — with `gitRemote` set,
  the lab graph is registered as a git-synced task resource (git_remote_url,
  metadata.git_sync, `sync.git` on disk, git origin); without it, stays hub-local
  and no git repo is created. Proves regular flows are unaffected.
- `src/__tests__/idea-lab/git-sync-convergence.test.ts` — the shared-graph
  mechanism: a bare git remote + a hub clone + an agent clone; hub-authored
  objectives converge to the agent and an agent-authored idea back to the hub.
- `src/__tests__/idea-lab/live-role-dispatch-e2e.test.ts` — LIVE_AGENT_E2E
  drive path: `provisionIdeaLab` → role schedule → fire → dispatch (schedule
  initiator) → orchestrator claims + mail-routes to a real macro-agent.
  Agent-side completion of the `dispatch_prompt` is logged best-effort, not
  asserted.
- `src/__tests__/idea-lab/live-composed-rest-e2e.test.ts` — **the composed loop,
  green anywhere.** LIVE_AGENT_E2E; a real Claude Code agent reads a hub-seeded
  objective (carrying a read-token) and writes a derived idea (token + marker)
  back into the shared lab graph over the opentasks REST interface. Asserts a
  hub-graph node carrying both — so the agent provably read and wrote.
- `src/__tests__/idea-lab/live-composed-gitsync-e2e.test.ts` — **the
  production-faithful composed loop.** Same read→write→converge, but git-sync-
  native (a real cc-swarm agent's git-synced opentasks). Double-gated
  (LIVE_AGENT_E2E + IDEA_LAB_GITSYNC_E2E) because the agent-side opentasks daemon
  must run with git-sync — which needs HOME/OPENHIVE_HOME and doesn't start in
  every local env (cc-swarm swallows the failure). Run it in a daemon-capable
  CI/prod image; the REST test is the green proof elsewhere.

## Known nuances / follow-ups

- `dispatch_prompt` agent completion: the hub attaches a conversation and
  delivers correctly, but a real macro-agent may finish the prompt without
  calling `done()` (its reuse consumer races the worker consumer), so the
  reply/marker is not reliably captured for prompt dispatches — hence the live
  test asserts only the OpenHive drive path. Making role completion robust
  (thread a single consumer, or route roles via ACP-fresh) is the next step to
  a fully-green agent round-trip.
- The full agent-authoring loop (ideator authors ideas → skeptic → judge →
  dispatcher, acting on shared state) is unproven end-to-end and needs the
  macro-agent to have a working OpenTasks daemon (unavailable in the local
  test env).
- Semantic dedup for the skeptic is currently agent-judged; a similarity
  primitive would harden it at scale.
- Operator surface (REST/UI to pause/resume the lab, inspect the round) —
  today it is config + the existing schedules/specs surfaces.
