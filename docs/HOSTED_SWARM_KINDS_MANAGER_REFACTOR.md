# Hosted Swarm Kinds: Manager Refactor Plan

**Status:** ✅ Approach A shipped (2026-05-06). PRs 1–6 + follow-ons (UI picker, terminal attach, pre-trust workdir, signal-kill classification) all merged. See `docs/HOSTED_SWARM_KINDS_DESIGN.md` `## Implementation status` for the canonical list of what's in the tree, what's deferred, and the cumulative deviations from the original design. Approach B (strategy-pattern extraction) remains deferred until codex/gemini provides a third call site to inform the interface shape — the relevant section below still applies.
**Date:** 2026-05-05 (completed 2026-05-06)
**Scope:** Concrete refactor sequence for `src/swarm/manager.ts` + provider layer to support `kind: 'claude-code'` alongside existing `kind: 'openswarm'`. Companion to `docs/HOSTED_SWARM_KINDS_DESIGN.md`.

**Out of scope:**
- Codex / gemini kinds (architecture admits them; no implementation here)
- UI kind picker (separate slice)
- Terminal-info / WS attach plumbing (separate slice; covered in main design doc §4)

---

## Bottom line

Start with **Approach A (minimum-viable branch)** for claude-code. Refactor to **Approach B (strategy pattern)** when codex lands. **Skip the full plan-based refactor (Approach C)** until at least two non-openswarm kinds are real — the design abstraction risks being wrong if there's no second concrete kind to inform it.

This is the standard "rule of three" applied: openswarm is one, claude-code makes two. Two isn't enough to know what the right abstraction is. Codex would be the third, and we extract the strategy interface then with three real call sites informing its shape.

---

## Why Approach A first

The structural exploration of `manager.ts` (1000+ lines, 13 phases per spawn) surfaced two facts that change the calculus:

1. **The `spawn()` method is ~70% openswarm-shaped** — bootstrap-token construction, port allocation with macro-agent stride assumptions, MAP pre-registration with a specific endpoint shape, health check on `port+1`, registration-by-bootstrap-hash repair. Generalizing the whole thing in one pass risks regressing the openswarm path.

2. **The provider interface doesn't work for claude-code** — `claude` is an interactive TUI and crashes under `child_process.spawn` (no TTY). The actual implementation routes claude-code spawns through `PtyManager` directly (`src/swarm/manager.ts` lines 59-63, 129-136, method `spawnClaudeCode`), bypassing `LocalProvider.provision()` entirely. `PtyManager` wraps node-pty and provides a long-lived real TTY that the embedded terminal can attach to.

Branching early in `spawn()` means: claude-code gets its own ~150-line method (`spawnClaudeCode`) that does only what claude-code needs, calling `ptyManager.create()` instead of `provider.provision()`. The two methods share helpers (`delegateForSpawn`, DB writes, event broadcast) but the orchestration is per-kind. Duplication is real but bounded — ~150 lines of overlap with the existing path.

**Status update — 2026-05-06:** This is what actually shipped. See HOSTED_SWARM_KINDS_DESIGN.md Deviations 2 and 3.

The strategy pattern (Approach B) is the right shape long-term, but designing it correctly requires knowing where the seams actually are. The minimum-viable spike teaches us that.

---

## Approach A: minimum-viable branch

### Step sequence

**1. Plumb `kind` through the input layer.** ✓ schema done; still need:
- `SpawnSwarmInput.kind?: HostedSwarmKind` (default `'openswarm'`)
- Spawn route schema (`SpawnSwarmSchema` in `swarm-hosting.ts`) accepts `kind`
- DAL `CreateHostedSwarmInput.kind` is already optional (✓ done in schema migration commit)

**2. Add `spawnClaudeCode(agentId, input)` to `SwarmManager`** — sibling to `spawn()`, not invoked from inside it. The kind branch happens at the route layer or via a dispatch wrapper:

```ts
async spawn(agentId: string, input: SpawnSwarmInput): Promise<HostedSwarm> {
  if ((input.kind ?? 'openswarm') === 'claude-code') {
    return this.spawnClaudeCode(agentId, input);
  }
  return this.spawnOpenswarm(agentId, input);
}
```

The existing `spawn()` body becomes `spawnOpenswarm()`. Pure rename, zero behavior change. The route layer's `spawn()` call signature is preserved.

**3. Implement `spawnClaudeCode()`** — minimum viable shape:

```
Phase 1  Validation (max_swarms count, provider exists)              [shared with openswarm]
Phase 2  Skip port allocation                                        [claude-code-specific: no port needed]
Phase 3  Generate hostedSwarmId + data_dir                           [shared]
Phase 4  Hive validation                                             [shared]
Phase 5  Skip injected resources for v1                              [claude-code-specific: not yet supported]
Phase 6  MAP pre-registration with a placeholder endpoint            [claude-code-specific: endpoint = "internal:cc:<id>"]
Phase 7  Mint a slim onboard token (no BootstrapToken envelope)      [claude-code-specific]
Phase 8  Resolve credentials                                         [shared, simpler — no inherit_env juggling]
Phase 9  Create DB row with kind='claude-code'                       [shared with kind override]
Phase 10 Write prelaunch file: <data_dir>/.swarm/claude-swarm/config.json [claude-code-specific]
Phase 11 PtyManager.create() — spawn `claude` TUI in a real PTY      [claude-code-specific: NOT LocalProvider.provision()]
Phase 12 Wait for cc-swarm sidecar MAP registration (not HTTP health) [claude-code-specific]
Phase 13 Mark running, broadcast event; register PTY session         [shared + register in claudeCodeSessions map]
```

**Status update — 2026-05-06:** Phase 11 deviation: claude-code calls `ptyManager.create({ command: 'claude', cwd: dataDir, env })` directly instead of `provider.provision()`. The PTY is long-lived and registered in the manager's `claudeCodeSessions` map for the embedded terminal to attach to. This is because `claude` requires a real TTY and crashes under `child_process.spawn()`. See `src/swarm/manager.ts:spawnClaudeCode()` for the actual implementation.

**4. Provider command resolution.** ~~The local provider currently builds the command from `this.config.openswarm_command`. For claude-code, it needs to use `claude` instead.~~

**Status update — 2026-05-06:** Deviation: claude-code does NOT use `LocalProvider.provision()` at all. Instead, `spawnClaudeCode()` resolves the `claude` binary directly and calls `ptyManager.create()` (see `src/swarm/manager.ts:59-63, 129-136`). 

For OpenSwarm, the `spawn_command_override` and `spawn_args_override` fields were added to `SwarmProvisionConfig` (PR 3 of the plan), but they're not used by claude-code's spawn path:

```ts
interface SwarmProvisionConfig {
  // ...existing fields
  /**
   * Override for the provider's spawn command. When unset the provider uses
   * its kind-default (e.g. local provider's openswarm_command). When set,
   * it's used verbatim. Used by future kinds that route through LocalProvider.
   */
  spawn_command_override?: string;
  /**
   * Override args for the spawn command. When set, replaces (does not
   * append to) the provider's default args.
   */
  spawn_args_override?: string[];
}
```

`LocalProvider` reads these in its existing command-build path if set; one branch. claude-code's `PtyManager` path is separate and doesn't touch this field.

**5. cc-swarm sidecar registration wait.** `spawnOpenswarm` waits on `port+1/health`. `spawnClaudeCode` waits on the MAP hub seeing a new agent registration with a known shape. Concretely:

- After `provision()` returns, listen for inbound MAP registration events (the hub already emits these for any swarm registering)
- Match by `swarm_id === preRegisteredSwarmId` — the slim token we minted carries this id, cc-swarm config will use it
- Resolve when we see the registration; reject after timeout (~15s based on cc-swarm's bootstrap timings)

Existing event pipeline: `mapHubEvents` (in src/coordination or src/map). New listener wired in `spawnClaudeCode` only — doesn't touch the openswarm path.

**6. Kind-aware stop — politely signal the sidecar.** cc-swarm's sidecar manages itself: it has `SIGTERM`/`SIGINT` handlers in `scripts/map-sidecar.mjs:180-181` (clears timers, removes socket/pid files, disconnects MAP, exits cleanly) plus a 30-minute inactivity auto-shutdown. So strictly speaking we don't *need* to kill it — if we just kill claude, the sidecar will time itself out within 30 min.

But that 30-min window is bad UX (MAP shows the agent registered while openhive's row says `stopped`). The cheap fix is to send the sidecar the SIGTERM signal it already handles:

```ts
// In stop(), after provider.deprovision(instanceId):
if (hosted.kind === 'claude-code') {
  await this.signalSidecar(hosted, 'SIGTERM');
}
```

`signalSidecar()` reads `<data_dir>/.swarm/claude-swarm/tmp/map/sidecar.pid`, sends the signal, swallows errors (missing file = sidecar already exited, that's fine). This isn't "managing" the sidecar — we're using cc-swarm's existing well-defined shutdown channel, just earlier than the inactivity timer would.

**7. Kind-aware exit handler.** `handleProcessExit()` runs when the `claude` PTY exits (user typed `/exit`, crash, kill, etc.). Same hook — call `signalSidecar()` so the user-driven exit path also gets prompt cleanup, not just operator-driven `stop()`.

**8. Skip health monitor for claude-code.** The HTTP health-check loop (in `markStaleSwarms`) probes `port+1/health`, which doesn't exist for claude-code. Branch:

```ts
// In markStaleSwarms() or equivalent
if (hosted.kind === 'claude-code') {
  // No HTTP health check. Liveness = process up + sidecar registered.
  // Process-up is already tracked via handleProcessExit; sidecar registration
  // tracked via MAP hub state. Skip HTTP check.
  continue;
}
```

For v1 we accept that claude-code rows don't get the same staleness sweeping as openswarm. Refine in Approach B if needed.

**9. Restart for claude-code: cold only.** `restart()` tries hot-restart (provider.restart()) first, falls back to cold-restart. For claude-code, the bootstrap is a config file + plugin hook chain; hot-restart doesn't really apply. Branch in `restart()` to always cold-start when `kind === 'claude-code'`.

---

## What gets deferred from Approach A

Things that work for openswarm and should work for claude-code but aren't worth doing in this slice:

- **Sandbox policy** for claude-code (the TUI doesn't have a sandbox config in scope; defer)
- **Workspace repo cloning** for claude-code (provider does this; should "just work" but untested)
- **Bootstrap-hash repair path** in restart (claude-code doesn't put swarm_id in a bootstrap token; the repair fallback fails gracefully but doesn't repair). Document it; refine later.
- **Restart and revive for claude-code** — **not implemented**. Both `restart()` and `reviveHostedSwarms()` would need to call `ptyManager.create()`, but they go through `provider.provision()` which doesn't work for TTY-based processes. New PRs will add kind-branching to these methods to route claude-code through `PtyManager`.
- **Hot-restart** for claude-code (always cold-start; see step 9)
- **HTTP-style health monitor** for claude-code (skip the loop; see step 8)
- **Auto-restart** (works mechanically because cold-start path is generic, but might need tuning)

Each of these is a "works in approach B" item. Restart/revive are blockers for production use of claude-code and will be added in follow-up PRs; they're not part of the initial spike.

---

## Approach B preview (when codex lands)

The strategy interface emerges naturally from the duplication patterns we'll see in Approach A. Concretely, after both kinds are working:

```ts
interface SpawnStrategy {
  kind: HostedSwarmKind;

  // Phase 2 — port
  needsPort(): boolean;
  portStride(): number;

  // Phase 7 — bootstrap
  buildBootstrapPayload(opts: BootstrapOpts): { token: string; tokenHash?: string };

  // Phase 10 — prelaunch
  prelaunchFiles(opts: PrelaunchOpts): Array<{ path: string; content: string }>;

  // Phase 11 — command
  resolveCommand(config: SwarmHostingConfig): { command: string; args: string[] };

  // Phase 12 — wait for ready
  waitForReady(opts: ReadyOpts): Promise<void>;

  // Health monitor
  healthCheck(opts: HealthOpts): Promise<HealthResult> | null;  // null = skip

  // Stop hooks
  postDeprovisionHooks(opts: StopOpts): Promise<void>;
}
```

Manager calls `this.strategies[kind].method()` at each phase. The phases stay in the manager (orchestration); kind-specific bits live in strategies (data + small functions).

This is a **mechanical refactor** from Approach A — extract the per-kind branches into strategy methods, no behavior change. Estimate: 2-3 days once we have two working kinds informing the interface shape.

**We don't write the strategy interface now** because we'd be guessing at what codex needs. Doing it after we have two real implementations and codex on the table means the interface fits all three.

---

## Approach C is rejected for now

Full plan-based refactor (resolver returns a `SpawnPlan` data structure; provider executes generically) was the original design-doc proposal. Two reasons to defer:

1. **Provider rewrite scope.** Plan-based execution requires `executeSpawnPlan(plan)` on provider, which means refactoring `LocalProvider`, `SandboxedLocalProvider`, and any future remote providers. Not a single-PR change.
2. **Premature data abstraction.** Modeling spawn behavior as data (a plan) instead of code (a strategy method) is harder to get right with one example. The plan shape would have to anticipate what fields codex/gemini need; we'd be designing in the dark.

We can move from Approach B → C later if we ever want to ship hosted-swarm spawning *as data* (e.g. for federated setup, declarative configuration, etc.). That's a real capability but not the v1 driver.

---

## Gotchas to address in Approach A

From the structural map:

| Gotcha | Approach A handling |
|---|---|
| Health check hardcoded to `port+1` | Branch in `markStaleSwarms` to skip for claude-code (step 8) |
| Sandbox policy is openswarm-only | Skip for claude-code in `spawnClaudeCode`; resolve to undefined |
| Workspace repos clone in provider | claude-code doesn't use provider; skip in `spawnClaudeCode` |
| `bootstrap_token_hash` matching for late registrations | claude-code's slim token sets it to a deterministic hash of the onboard token; not strictly needed but matches existing schema |
| `repairSwarmIdLink` decodes bootstrap_token | claude-code's token doesn't carry swarm_id; repair path falls back to endpoint lookup. Endpoint is `internal:cc:<id>`, doesn't match anything → repair fails silently. **Acceptable for v1**; document |
| `getInstanceId()` returns null silently | Correct behavior for claude-code; `instanceToHostedId` and `hostedToInstanceId` are NOT populated for claude-code rows. Any code path relying on these mappings (getLogs, restart, reviveHostedSwarms) needs explicit kind branches. See HOSTED_SWARM_KINDS_DESIGN.md Deviation 2. |
| Restart HOT vs COLD | **Not implemented** for claude-code; will be added in follow-up PRs that route through `PtyManager` |
| Broadcast event-type infers stop vs crash from exit code | Same behavior; user-typed `/exit` returns 0 → "stopped". Some signal cases may show "crash" — minor UX detail, defer |
| `usedPorts` Set isolation | claude-code doesn't use ports; not an issue |
| `restartCounts` keyed by hosted_swarm_id | Survives restarts cleanly; works for both kinds (when restart is implemented) |

The two **real issues** that need explicit handling:
1. **Step 8 — health monitor branch** (mandatory; without this, claude-code rows get spurious unhealthy/stop transitions)
2. **Step 6 — sidecar SIGTERM on stop/exit** (recommended; without it, the sidecar self-shuts via its 30-min inactivity timer instead. Functionally fine but UX-confusing during that window. cc-swarm's existing handler does the actual cleanup; we just signal it.)

---

## Implementation order

Suggested commits / PRs:

1. **PR 1** (already done as part of spike start): schema V50 + DAL `kind` field. ✓
2. **PR 2**: rename `spawn()` body → `spawnOpenswarm()`, add `spawn()` dispatcher, no behavior change for openswarm. Pure refactor, all existing tests must pass. Adds `SpawnSwarmInput.kind?` and threads through the route schema. ✓
3. **PR 3**: add `SwarmProvisionConfig.spawn_command_override` + `spawn_args_override`; teach `LocalProvider` to honor them. No callers use them yet. Pure provider extension. ✓
4. **PR 4**: implement `spawnClaudeCode()` happy path. **DEVIATION**: Routes through `PtyManager.create()` directly instead of `LocalProvider.provision()` (discovered during live-test: `claude` crashes without a real TTY). Resolves `claude` binary via `resolveClaudeBinary()`. Writes prelaunch config with `auth.token` (not `auth.credential`) and `swarmId` field. Registers PTY session in manager's `claudeCodeSessions` map. Waits for cc-swarm sidecar MAP registration. See HOSTED_SWARM_KINDS_DESIGN.md Deviations 1–2. ✓
5. **PR 5**: kind-aware `stop()` and `handleProcessExit()` — sidecar PID file kill (step 6, 7). ✓
6. **PR 6**: kind-aware health monitor branch (step 8). ✓
7. **PR 7**: route layer accepts kind; spawn dialog gets the kind picker (UI slice).
8. **PR 8**: terminal-info attach-mode for claude-code (separate slice from main design doc §4).
9. **PR 9**: live-test end-to-end; tighten registration-wait timing based on real timings.
10. **Future PRs** (not in initial spike): `restart()` and `reviveHostedSwarms()` for claude-code via `PtyManager` routing. See HOSTED_SWARM_KINDS_DESIGN.md Deviation 3.

Each PR is reviewable on its own. 2-7 are the meat of the manager refactor; 8-9 are the UX surface.

---

## Estimated effort

- PR 2 (rename + dispatcher): ~2 hours, mostly mechanical
- PR 3 (provider override fields): ~1 hour
- PR 4 (`spawnClaudeCode`): ~half-day, including initial e2e run
- PR 5 (sidecar PID kill): ~1 hour
- PR 6 (health monitor branch): ~1 hour
- PR 7 (UI kind picker): ~half-day
- PR 8 (terminal attach): ~half-day, design-doc §4 has the contract
- PR 9 (live-test + timing tune): ~2-4 hours

Total: ~3 days of focused work for a working claude-code kind end-to-end. Approach B refactor (when codex lands) would add ~2-3 days on top.

---

## Open questions to resolve in PR 4

These came out of the structural exploration and weren't covered in the main design doc:

1. **Bootstrap token shape for claude-code.** Slim token (just onboard credential) — but cc-swarm's config schema expects a `map.auth.credential` field. Confirm the slim onboard token works there directly.
2. **Pre-registration endpoint for claude-code.** Manager pre-registers the MAP swarm with `endpoint = ws://127.0.0.1:<port>` for openswarm. claude-code has no port. Use `internal:cc:<hostedSwarmId>` as a placeholder endpoint? Or leave endpoint NULL? Schema allows NULL.
3. **Sidecar registration matching.** When the cc-swarm sidecar registers via MAP, it carries `name="<teamName>-sidecar"` with `role="sidecar"`. We pre-registered with `swarm_id = preRegisteredSwarmId`. cc-swarm reads `map.systemId` from the config file — does it use that as the swarm id, or generate its own and we fail to match? Confirm in PR 4 spike.
4. **Provision config persistence.** The manager persists `SwarmProvisionConfig` to the DB row's `config` column. For claude-code, much of `SwarmProvisionConfig` (adapter, bootstrap_token base64, assigned_port) is meaningless. Either set those fields to null/empty for claude-code rows, or split the persisted shape per kind. Lean: null/empty for v1, tighten in Approach B.

Each of these is a 30-minute spike — answer in PR 4 implementation.
