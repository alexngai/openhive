# Hosted Swarm Kinds — Milestone A Plan

**Status:** ✅ Done and superseded (2026-05-06). All milestone-A PRs shipped, plus follow-ons originally under Milestone B (UI kind picker, terminal attach, restart, exit-code mapping, pre-trust workdir). A second TUI kind (`codex`) followed using the same shape; the duplication this plan accepted has since been collapsed via the strategy-pattern refactor (see `tui-strategies.ts`), so the per-kind copy-paste no longer exists. Live coverage: `src/__tests__/swarm/live-claude-code-e2e.test.ts` (11 tests) + `src/__tests__/swarm/live-codex-e2e.test.ts` (9 tests), both gated on `LIVE_AGENT_E2E=true`. See `docs/HOSTED_SWARM_KINDS_DESIGN.md` `## Implementation status` for the canonical list.
**Date:** 2026-05-05 (completed 2026-05-06)
**Scope:** Get the **spawn pipeline** for `kind: 'claude-code'` working end-to-end. Excludes UI, terminal-attach, and lifecycle polish — those are Milestone B.

**Companion docs:**
- Design: `docs/HOSTED_SWARM_KINDS_DESIGN.md`
- Refactor strategy: `docs/HOSTED_SWARM_KINDS_MANAGER_REFACTOR.md`

---

## What "milestone A done" looks like

A successful curl to `POST /api/v1/map/hosted/spawn { "kind": "claude-code", ... }` causes:

1. A new `hosted_swarms` row with `kind = 'claude-code'`, `state = 'starting' → 'running'`
2. `claude` running in a PTY managed by the local provider, cwd = `<data_dir>`
3. cc-swarm sidecar (spawned by claude's plugin runtime) registered against the openhive MAP hub with `swarm_id` matching the pre-registration
4. The hosted-swarm row's `state` flips to `running` within ~15s of the spawn call

No UI. No embedded terminal attach. No SIGTERM-on-stop UX polish. Just **the spawn pipeline works**.

---

## PRs in this milestone

### PR 2 — Rename + dispatcher (mechanical)

**Goal:** zero behavior change. Pure refactor that names things so we can branch later without fighting the existing structure.

**Changes:**
- `src/swarm/manager.ts`:
  - Rename `async spawn()` body → `async spawnOpenswarm()` (private)
  - New `async spawn()` becomes a 3-line dispatcher:
    ```ts
    async spawn(agentId: string, input: SpawnSwarmInput): Promise<HostedSwarm> {
      if ((input.kind ?? 'openswarm') === 'claude-code') {
        return this.spawnClaudeCode(agentId, input);  // throws "not implemented" until PR 4
      }
      return this.spawnOpenswarm(agentId, input);
    }
    private async spawnClaudeCode(_a: string, _i: SpawnSwarmInput): Promise<HostedSwarm> {
      throw new SwarmHostingError('NOT_IMPLEMENTED', 'kind=claude-code is not yet implemented');
    }
    ```
- `src/swarm/types.ts`:
  - Add optional `kind?: HostedSwarmKind` to `SpawnSwarmInput`
- `src/api/schemas/` (or wherever `SpawnSwarmSchema` lives):
  - Add `kind: z.enum(['openswarm', 'claude-code']).optional().default('openswarm')` to the spawn payload schema

**Acceptance:**
- All 482 existing tests still pass
- Manual: spawn an openswarm via UI / curl → identical behavior to before
- Manual: curl `kind: 'claude-code'` returns a 5xx with the `NOT_IMPLEMENTED` error message (not "kind not allowed" or anything else)

**Estimated effort:** ~2 hours

---

### PR 3 — Provider command override (additive)

**Goal:** add fields the local provider can use to spawn an arbitrary command instead of `openswarm`. No callers use them yet — pure provider extension.

**Changes:**
- `src/swarm/types.ts` (`SwarmProvisionConfig`):
  - Add `spawn_command_override?: string`
  - Add `spawn_args_override?: string[]`
  - Add JSDoc explaining: when set, replaces the provider's default command/args; when unset, provider uses its kind-default
- `src/swarm/providers/local.ts`:
  - In the command-build path, prefer `config.spawn_command_override` over `this.openswarmCommand` if set
  - Same for args — replace, don't append
  - One branch in the existing build function

**Acceptance:**
- All existing tests still pass
- New unit test: pass a `SwarmProvisionConfig` with overrides set, assert the spawned command line has the overrides not the default
- Manual: spawn an openswarm with empty overrides → unchanged behavior

**Estimated effort:** ~1 hour

---

### PR 4 — `spawnClaudeCode()` happy path

**Goal:** the actual spawn pipeline for `kind: 'claude-code'`. No lifecycle polish (that's milestone B), but enough to get cc-swarm registering and the row to flip to `running`.

**Phase-by-phase outline** (numbered to match the 13-phase decomposition in the refactor plan):

- **(1) Validation** — shared with `spawnOpenswarm`; extract a private `validateSpawnLimits(providerType)` helper that both methods call
- **(2) Skip port allocation** — claude-code doesn't bind a server
- **(3) Generate `hostedSwarmId` + `dataDir`** — same as openswarm; extract helper or duplicate (probably duplicate for v1; extract in milestone B if it bothers us)
- **(4) Hive validation** — same as openswarm
- **(5) Skip injected resources** for v1; document the limit
- **(6) MAP pre-registration with placeholder endpoint** — `endpoint = "internal:cc:<hostedSwarmId>"`. Confirms the schema accepts non-`ws://` prefixes; if not, use NULL and document
- **(7) Mint slim onboard token** — call `delegateForSpawn` directly to get the credential; no `BootstrapToken` envelope wrapping
- **(8) Resolve credentials** — simpler than openswarm; only what cc-swarm needs (the onboard token as `map.auth.credential`)
- **(9) Create DB row** with `kind: 'claude-code'`, `provider: 'local'`, `assigned_port: null`
- **(10) Write prelaunch file** at `<dataDir>/.swarm/claude-swarm/config.json`:
  ```json
  {
    "map": {
      "server": "ws://127.0.0.1:<openhive-port>/ws/map",
      "scope": "<hostedSwarmId>",
      "systemId": "<preRegisteredSwarmId>",
      "swarmId": "<preRegisteredSwarmId>",
      "auth": { "token": "<onboardToken>" }
    },
    "sessionlog": { "enabled": true, "sync": "metrics" },
    "opentasks": { "enabled": false }
  }
  ```

  **Status update — 2026-05-06:** Shipped with `auth.token` (not `auth.credential`) and added `swarmId` field. See HOSTED_SWARM_KINDS_DESIGN.md Deviation 1 for reasoning.

- **(11) PtyManager spawn** (NOT Provider.provision()): Resolve `claude` via `resolveClaudeBinary()` helper; call `ptyManager.create({ command: 'claude', args: [], cwd: dataDir, env })` directly to get a long-lived PTY handle. The PTY is registered in `claudeCodeSessions` keyed by `hostedSwarmId` for terminal attach.

  **Status update — 2026-05-06:** Deviation from design: claude-code spawns route through `PtyManager`, NOT `LocalProvider.provision()`, because `claude` is an interactive TUI and crashes without a real TTY. See HOSTED_SWARM_KINDS_DESIGN.md Deviation 2 for full context.
- **(12) Wait for cc-swarm sidecar registration** — listen for inbound MAP registration with `swarm_id === preRegisteredSwarmId`; resolve when it arrives, reject after 15s. Use existing `mapHubEvents` if available; fall back to polling `findSwarmByEndpoint` or similar
- **(13) Update DB** state to `'running'`; broadcast event; return row

**New helper files:**
- `src/swarm/claude-binary.ts` — `resolveClaudeBinary(): string | null` (similar pattern to `src/terminal/resolve-tui.ts`)
- `src/swarm/claude-code-config.ts` — `buildClaudeSwarmConfig(opts) → string` (the JSON for the prelaunch file)

**Open questions resolved during this PR:**

These are 30-min spikes per the refactor plan; commit answers as comments in code:

1. **Bootstrap token shape.** Test: drop the slim token (no envelope) into `map.auth.credential`. Verify cc-swarm authenticates against openhive's MAP hub. If cc-swarm fails, investigate format expectations and document.
2. **Pre-registration endpoint.** Test: register a MAP swarm with `endpoint = "internal:cc:hswarm_xxx"`. If `mapDal` rejects on the schema/validation, fall back to `endpoint = null` and update the doc.
3. **cc-swarm swarm-id matching.** Test: write `systemId: <preRegisteredSwarmId>` in the config; verify cc-swarm registers under that id. If cc-swarm uses a different field or self-generates, find the correct config field and update.
4. **`SwarmProvisionConfig` persistence.** For claude-code rows, set `assigned_port: null`, `bootstrap_token: ''` (or empty), and `adapter: 'claude-code'` (just as a label). The DB row carries this for restart purposes; we don't need to use it in PR 4.

**Acceptance:**
- All existing tests still pass
- New integration test: spawn a `kind: 'claude-code'` row; mock cc-swarm registration; assert state flips to `running`
- **Live test (manual):**
  1. Spawn a fresh swarm via curl with `kind: 'claude-code'`
  2. Confirm `claude` shows up in `ps`
  3. Confirm cc-swarm sidecar is detached + registered with MAP (visible in `/api/v1/map/swarms`)
  4. Confirm hosted-swarm row state is `running`
  5. Manually SIGTERM the claude PID; row goes to `stopped` (the existing exit handler covers this for non-zero exits at least)

**Estimated effort:** ~half-day, including the open-question spikes

---

## What's NOT in milestone A (deferred to B)

- **SIGTERM the cc-swarm sidecar PID file** on stop/exit — without this, the sidecar lingers ~30 min on cc-swarm's idle timer. Functionally fine, UX-confusing. (Refactor plan §6, §7.)
- **Skip HTTP health monitor for claude-code** — without this, the monitor probes a non-existent `port+1/health` and may falsely mark rows unhealthy. (Refactor plan §8.) Mandatory before the kind is usable in steady-state, but not blocking the milestone-A demo.
- **Restart and revive for claude-code** — both `restart()` and `reviveHostedSwarms()` are **not implemented** for claude-code. Hot-restart doesn't apply (bootstrap is config file + plugin hook chain). Cold-restart would require `PtyManager` routing, which doesn't fit the provider.provision() path. New PRs will add kind-branching to these methods.
- **UI kind picker** in the spawn dialog. PR 7.
- **Terminal-info attach mode** + WS attach-by-processId. PR 8.
- **Live e2e UI test** (spawn from UI → embedded terminal → /exit cleanly). PR 9.

These all hang off milestone-A's spawn pipeline; once it works, they slot in additively without re-architecting.

---

## Risks and how we mitigate

| Risk | Likelihood | Mitigation |
|---|---|---|
| cc-swarm's config schema doesn't accept slim onboard token | Medium | Open question 1; spike before the rest of PR 4 lands |
| MAP pre-registration rejects `internal:` endpoint scheme | Medium | Open question 2; fall back to NULL endpoint |
| cc-swarm registers under a different `swarm_id` than we pre-registered | Low | Open question 3; spike with manual test |
| `claude` binary location varies across hosts | Low | `resolveClaudeBinary()` checks PATH + a few common locations; clear error if not found |
| MAP registration arrives faster than our listener subscribes | Low | Subscribe to events BEFORE provider.provision returns; don't rely on post-spawn ordering |
| Hosted-swarm row persists provision config that's mostly null for claude-code | Low (cosmetic) | Document; tighten in milestone B |

---

## Why this scope is right for the first milestone

- **Pipeline works in isolation** — PR 4's success criterion is "registration arrives," which is the load-bearing claim of the whole architecture. If that doesn't work, everything else is moot.
- **No UI surface to ship** — UI has its own design questions (kind picker shape, per-kind form fields). Milestone A doesn't block on those decisions.
- **No terminal-attach plumbing** — that's a separate WS/PTY question that's already partially scoped (design doc §4) and benefits from a working spawn pipeline to test against.
- **Reversibility** — if PR 4's spike answers reveal something blocking (e.g. cc-swarm requires bootstrap-token-envelope shape), we revise the design doc and re-plan B from there. We haven't poured concrete on the UX yet.

End of milestone A: we have a working spawn pipeline that no human will use directly (no UI). Milestone B turns it into a feature.
