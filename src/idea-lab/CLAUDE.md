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

## Provisioning (the "reload reliably" guarantee)

`provisionIdeaLab(deps)` (`provision.ts`) applies a pack idempotently at boot,
wired into `server.ts` after the hub-default task graph (so an owner agent
exists), gated by `config.ideaLab.enabled` (default off). Reconciliation is
**keyed, never blind**:

| Thing | Keyed by | Mode | Primitive |
|---|---|---|---|
| graph + ledger resources | `(owner, type, name)` | upsert | `upsertDiscoveredResource` |
| objectives (specs) | `metadata.idealab_key` | create-only | `daemonCreateSpec` / `daemonGetGraph` |
| role schedules | `payload.idealab_key` | managed | `schedules` DAL |

Objectives are **create-only** — never rewrite an idea agents may have
evolved. Schedules are **managed** — drifted cron/prompt/targets reconcile on
each boot, but paused-state is operator-owned after first create. Nothing is
destructive; the provisioner only creates and updates lab-owned rows.

`schedules` has no unique-by-name column, so idempotency comes from stamping
`idealab_key` into the payload and matching on it (the app-level analogue of
what `upsertDiscoveredResource` does for resources). No schema migration.

## Config

`config.ideaLab`:
- `enabled` (default `false`) — master toggle.
- `hiveId` (default `''`) — schedule tenancy tag.
- `targetSwarmIds` (default `[]`) — swarms the role dispatches target. **Empty
  → schedules provisioned paused** (dormant until you configure a target and
  resume). The kill switch (`autonomousDispatchPaused`) still gates fires.
- `reconcile` (`managed` | `create-only`, default `managed`).
- `gitRemote` (optional) — shared git remote for the lab graph. **This is the
  wire that lets connected swarms actually read/write the shared ideas.** When
  set, the graph is registered as an ordinary git-synced task resource
  (`git_remote_url` = the remote, `metadata.git_sync` enabled, `applyGitSyncConfig`
  writing the daemon's `sync.git` block); connected swarms clone it, use their
  native opentasks tools, and converge via git-sync + MAP `context.*` pull
  signals. When unset (default), the graph is hub-local.

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
- `src/__tests__/idea-lab/live-role-dispatch-e2e.test.ts` — LIVE_AGENT_E2E
  drive path: `provisionIdeaLab` → role schedule → fire → dispatch (schedule
  initiator) → orchestrator claims + mail-routes to a real macro-agent.
  Agent-side completion of the `dispatch_prompt` is logged best-effort (see
  below), not asserted.

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
