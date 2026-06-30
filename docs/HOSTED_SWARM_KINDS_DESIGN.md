# Hosted Swarm Kinds: Design

**Status:** Implemented end-to-end for `kind: 'claude-code'` and `kind: 'codex'` (TUI parity). The strategy-pattern refactor (Approach B from the manager refactor plan) has shipped — the manager has one shared TUI spawn pipeline (`spawnTuiKind`) that both kinds drive via per-kind strategy objects (`src/swarm/tui-strategies.ts`). Adding a third TUI-shaped kind is a single new strategy implementation. Codex's programmatic-mode (`codex app-server`) is documented as the next kind/mode but not yet shipped. See `## Implementation status` below for the per-piece breakdown and live-e2e coverage.
**Date:** 2026-05-05 (updated 2026-05-06)
**Scope:** Generalize the hosted-swarm pipeline so OpenHive can spawn and manage agent processes that aren't SwarmRunner — Claude Code first, with the architecture extending to codex / gemini / other CLIs later. Keep the existing SwarmRunner flow working unchanged.

**Out of scope:**
- Live programmatic injection into a running interactive Claude Code session (TUI binary doesn't support multi-driver IPC; see "Limits we're accepting").
- Codex / gemini implementations. The kind system is designed to admit them, but the only kind we ship in this round is `claude-code`.
- Replacing macro-agent / cc-swarm / swarm-runner. Those keep their roles; we're widening the pipeline that wraps them.
- Mobile/web access to running agents. happy solves this differently and we explicitly chose not to embed it.

---

## TL;DR

Today every hosted swarm is SwarmRunner-shaped — same `swarm_runner_command`, same bootstrap-token handshake, same MAP-registration assumption. To support Claude Code, codex, and similar agent CLIs we add a `kind` field to the hosted-swarm record and route each kind through its own spawn-plan resolver. For the `claude-code` kind, OpenHive spawns the `claude` binary alone in a PTY the embedded terminal attaches to, after writing a project-local `.swarm/claude-swarm/config.json` file pointing cc-swarm's plugin at the openhive hub. cc-swarm is a **Claude Code plugin** (already installed on the host); its `SessionStart` hook fires from inside `claude`, detaches a MAP sidecar process, and the sidecar registers with the hub. Users see and use the real Claude Code TUI; OpenHive observes via cc-swarm's sidecar. **No PTY-level injection from OpenHive chat into a live TUI in v1.**

---

## Motivation

Two product asks are bumping into the same wall:

1. **"Run claude-code-swarm directly under OpenHive."** cc-swarm already integrates (registers MAP, emits trajectory, speaks ACP), but you can't spawn it through the swarms UI today — `default_provider: 'local'` hardcodes `swarm_runner_command` and assumes the spawned binary will dial in via swarm-runner's bootstrap-token handshake. Without that, the lifecycle stays in `provisioning` forever.
2. **"Manage Claude Code sessions visibly inside OpenHive."** Operators want a Claude Code TUI accessible from the browser the same way SwarmRunner is, with lifecycle controls (stop/restart/logs), trajectory in the Threads list, and a single hub-of-record for what's running where.

Both unlock the same primitive: **OpenHive as a fleet manager for *kinds* of agent processes**, not a fleet manager for SwarmRunner.

A `kind` field also unblocks codex (different binary, different RPC, but conceptually the same hosted-swarm shape) and any future agent CLI.

---

## Limits we're accepting

The Claude Code TUI binary is interactive-only. It doesn't expose an IPC RPC the way codex's `codex-app-server` does. So:

- **Reading from a Claude Code session is easy.** Hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) plus the per-session JSONL transcript at `~/.claude/projects/<proj>/<session-id>.jsonl` give cc-swarm everything it needs to project the conversation into MAP/Threads. This is what cc-swarm already does standalone.
- **Writing into a running TUI session is not.** The TUI owns its stdin and assumes one driver. Three known options — `claude --resume <sid> -p "<msg>"` (only works on idle sessions; concurrent JSONL writes with an active TUI race), raw PTY stdin keystroke injection (works mechanically, races with concurrent human typing), or upstream RPC mode (doesn't exist) — are all unsuitable for a live multi-driver UX.

We accept this and **don't promise live injection in v1**. OpenHive *manages* and *observes* the Claude Code session; the user *drives* it through the embedded terminal. Autonomous dispatch can use `claude --resume -p` against idle sessions as a best-effort, explicitly labeled.

The SDK path (claude-agent-sdk / claude-agent-acp) is already covered by macro-agent under SwarmRunner and remains the right answer when programmatic driving is needed. The `claude-code` kind is for the case where the user wants the *actual* Claude Code product (Max plan billing, full feature set) under OpenHive's management, accepting the interaction limits.

---

## Goals

- Add a `kind` field to hosted swarms that routes spawn behavior cleanly.
- Ship `kind: 'claude-code'` end-to-end: spawn → terminal → trajectory in Threads → lifecycle (stop/restart/logs).
- Keep `kind: 'swarm-runner'` (the current behavior) working with no functional change.
- Make the design admit `kind: 'codex'`, `kind: 'gemini'`, and `kind: 'cc-swarm'` as future entries without re-architecting.
- Be explicit about what each kind can and can't do, so the UI can shape itself accordingly.

## Non-goals

- Live mid-session injection from OpenHive chat into Claude Code TUI.
- Replacing the macro-agent / swarm-runner SDK-driven path. Different kind, different use case.
- Multi-user concurrent driving of the same TUI (one driver at a time; queueing is a future concern).

---

## Current state

- `src/db/dal/` `hosted_swarms` table — no `kind` column today; behavior is implicitly SwarmRunner.
- `src/swarm/manager.ts` — `spawn()` builds an SwarmRunner-specific bootstrap token, calls the provider, expects MAP-side registration (matched via `bootstrap_token_hash`) within a timeout to flip lifecycle from `provisioning` → `running`.
- `src/swarm/providers/local.ts` — runs `config.swarm_runner_command` (a single string from `SwarmHostingConfig`), no per-kind branching.
- `src/api/routes/swarm-hosting.ts:359-431` — `terminal-info` resolves the SwarmRunner TUI binary unconditionally.
- `src/web/components/swarm/SpawnSwarmDialog.tsx` (and the spawn dialog rendered from `Swarms.tsx`) — provider/adapter pickers, no kind picker.
- cc-swarm exists in `references/cc-swarm/` (submodule) and already integrates with OpenHive when run standalone — it registers a MAP agent, configures Claude Code hooks, projects trajectory.

The pipeline is SwarmRunner-baked at every layer (DB, manager, provider, route, UI). Generalization touches all of them but each touch is small.

---

## Design

### 1. `kind` field on hosted-swarms

Add `kind` to the `hosted_swarms` table (migration). Type: a TypeScript enum / string union.

```ts
export type HostedSwarmKind =
  | 'swarm-runner'   // current behavior, default for backwards compat
  | 'claude-code' // claude TUI + cc-swarm sidecar (cc-swarm is the sidecar, not a separate kind)
  // future:
  // | 'codex'
  // | 'gemini'
```

Defaults: existing rows default to `'swarm-runner'`. New spawns require kind in the API; UI defaults to whatever was selected last (or `'swarm-runner'`).

### 2. Spawn-plan resolver

A pure function per kind:

```ts
// src/swarm/spawn-plans/types.ts
export interface SpawnPlan {
  /** Primary subprocess(es) to spawn. Order matters: started in sequence. */
  processes: SpawnProcess[];
  /** Lifecycle policy: how do we decide when this hosted swarm is "running" / "stopped" / "failed". */
  lifecycle: LifecyclePolicy;
  /** What the embedded terminal connects to — see "Terminal binding" below. */
  terminal: TerminalBindingHint;
  /** Files to write under the swarm's data_dir before processes start (e.g. .claude/settings.json). */
  prelaunchFiles?: PrelaunchFile[];
}

export interface SpawnProcess {
  id: string;             // logical name, e.g. "sidecar" or "tui"
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd: string;
  /** Whether this process must already be running for the next one to start. */
  blocksFollowing?: boolean;
}

export type LifecyclePolicy =
  | { kind: 'map-registration'; expectedAgentRole?: string; timeoutMs: number }      // swarm-runner: wait for inbound MAP register
  | { kind: 'sidecar-registers'; sidecarId: string; timeoutMs: number }              // claude-code: cc-swarm sidecar registers
  | { kind: 'process-up'; processIds: string[] };                                    // raw: just check both processes are alive
```

`resolveSpawnPlan(kind, options) → SpawnPlan` lives in `src/swarm/spawn-plans/<kind>.ts`. Manager calls it once per spawn; provider executes the resulting plan.

### 3. Provider changes

**Status update — 2026-05-06:** Initial design proposed multi-process spawning through `LocalProvider`. Actual implementation diverges: claude-code spawns route through `PtyManager` directly (see `src/swarm/manager.ts` — `spawnClaudeCode` and `setPtyManager`), NOT through `LocalProvider.provision()`. 

Reason discovered during PR 4 live-test: `claude` is an interactive TUI and crashes under `child_process.spawn` (no TTY). `PtyManager` wraps node-pty and gives it a real TTY, so the PTY is long-lived and can be attached to by the embedded terminal. OpenHive's existing `LocalProvider` continues to handle SwarmRunner spawning unchanged; `PtyManager` is the separate path for claude-code only.

Downstream consequence: `instanceToHostedId` and `hostedToInstanceId` mappings are NOT populated for claude-code rows, so anything that goes through `getInstanceId()` is a no-op for claude-code. This includes `getLogs`, `restart`, `reviveHostedSwarms` — those need explicit kind branches.

The DB schema for the hosted-swarms row stays a single row. Per-process state is in-memory in the manager. We don't need a `hosted_processes` child table for v1.

### 4. Terminal binding

Today `terminal-info` is hard-coded to spawn an SwarmRunner TUI in a new openhive-owned PTY (separate from the spawned subprocess). For `claude-code`, the embedded terminal needs to attach to the *actual* Claude Code TUI subprocess.

Two architectural options:

**A. Embedded terminal owns the Claude Code PTY directly.** OpenHive's existing PTY manager spawns Claude Code; cc-swarm runs as a sibling but doesn't own the PTY. User keystrokes in the embedded terminal go straight to Claude Code; cc-swarm captures conversation state via hooks + JSONL.

**B. cc-swarm owns the Claude Code PTY; embedded terminal connects through cc-swarm.** cc-swarm forwards bytes between the Claude Code child and OpenHive's WS. Adds a forwarding hop; gains the option of cc-swarm interposing on input later (for live injection v2).

**Decision: A for v1.** It's strictly simpler and matches how SwarmRunner's terminal works today. If we ever want cc-swarm-mediated injection, we can swap to B without breaking the UX. The plan should make this a `TerminalBindingHint` field so the choice is per-kind, not architectural.

```ts
export type TerminalBindingHint =
  | { kind: 'spawn-tui-on-connect'; resolveCommand: () => Promise<TuiInfo> }   // swarm-runner today
  | { kind: 'attach-to-process'; processId: string }                            // claude-code v1 — Option A
  | { kind: 'sidecar-mediated'; sidecarId: string };                             // future — Option B
```

`processId` corresponds to a `SpawnProcess.id`; the manager exposes a way to attach a PTY to that process's stdio. (Implementation detail: Claude Code is spawned by the local provider via `node-pty.spawn()` from the start, so the PTY is a long-lived handle the manager keeps; the WS handler attaches to its data stream rather than spawning fresh.)

### 5. cc-swarm integration model

**Important correction** (verified against `references/claude-code-swarm/`): cc-swarm is a **Claude Code plugin**, not an independently-spawnable subprocess. The user installs it once via `claude plugin add /path/to/claude-code-swarm`; thereafter Claude Code's own plugin runtime fires cc-swarm's `SessionStart` hook on every session, and that hook detaches the persistent MAP sidecar process. **OpenHive spawns `claude` only**; cc-swarm activates from inside.

Concretely:

```
PtyManager.create() ← OpenHive spawns claude in a PTY with node-pty
  └─ claude TUI (started with cwd = swarm's data_dir)
     └─ Claude Code plugin runtime fires SessionStart
        └─ scripts/bootstrap.mjs reads .swarm/claude-swarm/config.json (project-local)
           └─ spawn-detach scripts/map-sidecar.mjs
              └─ MAP sidecar registers as <teamName>-sidecar with the hub
```

**Status update — 2026-05-06:** The spawn process for claude-code routes through `PtyManager` directly (`src/swarm/manager.ts:spawnClaudeCode` → `ptyManager.create()`), NOT through `LocalProvider.provision()`. The PTY is long-lived and can be attached to by the embedded terminal. This is a **one process** spawn (just the claude TUI) plus one prelaunch file:

- **The process**: `claude` itself, spawned via `PtyManager.create()` in the swarm's `data_dir`, with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in env (cc-swarm requires it).
- **The prelaunch file**: `.swarm/claude-swarm/config.json` under `data_dir`, written by OpenHive before `claude` starts, containing the hub MAP URL, scope, system id, and bootstrap token. cc-swarm's bootstrap reads it without any user-global config touch.

Example `prelaunch` content:

```json
// <data_dir>/.swarm/claude-swarm/config.json
{
  "map": {
    "server": "ws://127.0.0.1:<hub-port>/ws/map",
    "scope": "<hosted-swarm-id>",
    "systemId": "<hosted-swarm-id>",
    "swarmId": "<hosted-swarm-id>",
    "auth": { "token": "<bootstrap-credential>" }
  },
  "sessionlog": { "enabled": true, "sync": "metrics" },
  "opentasks": { "enabled": false }
}
```

**Status update — 2026-05-06:** Deviation captured in actual implementation (`src/swarm/claude-code-config.ts:71-76`). The design showed `auth.credential`; the implementation uses `auth.token` (not `auth.credential`) and adds a `swarmId` field at the map level. Reason: cc-swarm's `buildServerUrl` skips appending `?swarm_id=...` to the WS URL when `credential` is set (it assumes verified-mode identity comes from the credential). Open-mode openhive *needs* the swarm_id query param so the inbound MAP registration keys against our pre-registered swarm id. Setting `credential` would break registration matching. The `swarmId` field pins cc-swarm's URL-side identity hint to our pre-registered swarm id.

(Template / mesh / inbox config can be added later. The minimum for "spawn and register" is `map.server` + auth.)

OpenHive does NOT need to install hooks itself — cc-swarm's plugin manifest registers them with Claude Code on plugin install. The user-global constraint is honored naturally: we only write into `data_dir`, never `~/.claude/settings.json` or `~/.claude-swarm/`.

#### Prerequisites the operator must satisfy

- **cc-swarm installed as a Claude Code plugin** on the openhive host — `claude plugin add /path/to/claude-code-swarm` (or the published equivalent). This is one-time setup, not per-spawn.
- **`claude` binary available** on the openhive host's PATH (or at a known location resolvable like the SwarmRunner TUI is today).
- **Claude Code logged in** under the operator's user (`claude login`). See "Resolved decisions" #1 for failure handling.

OpenHive surfaces a clear error if any of these are missing rather than spinning in `provisioning`. We do NOT attempt to auto-install the cc-swarm plugin or auto-login Claude Code from the spawn path — those are documented host setup.

#### Lifecycle for the detached sidecar

cc-swarm's bootstrap detaches the sidecar (`detached: true, stdio: 'ignore'`) and writes its PID to `<data_dir>/.swarm/claude-swarm/tmp/map/sidecar.pid`. When OpenHive stops the hosted swarm, the manager:

1. Reads the sidecar PID file from `data_dir`.
2. SIGTERMs the sidecar (after the `claude` PTY exits).
3. Falls back to SIGKILL after a short grace.

This keeps sidecar lifecycle dependent on the hosted-swarm record, even though cc-swarm itself would otherwise let the sidecar idle for ~30 minutes before self-shutdown. From OpenHive's perspective the sidecar is a child of the hosted-swarm record, full stop.

#### Lifecycle policy: registration target

The `sidecar-registers` lifecycle policy watches MAP for an inbound registration tagged with the swarm's auth credential. cc-swarm's sidecar registers with `name="<teamName>-sidecar"` and `role="sidecar"` shortly after `claude` starts (typically <2s based on bootstrap timings). The hosted-swarm row flips to `running` on that registration. If no registration arrives within the timeout (~15s), the row goes to `failed` with a message like "cc-swarm sidecar did not register — is the plugin installed?"

### 6. Lifecycle semantics

Per-kind rules for what counts as "running" vs "stopped" vs "failed":

| Kind | Running when… | Stopped when… | Failed when… |
|---|---|---|---|
| `swarm-runner` | SwarmRunner registers via MAP within timeout | Operator clicks Stop, process exits cleanly | Registration timeout, process crash before registration |
| `claude-code` | cc-swarm sidecar registers via MAP within timeout *and* `claude` PTY is up | `claude` exits with code 0 (operator stop or user typed `/exit`) | `claude` exits non-zero (crash, auth failure, plugin not installed); sidecar fails to register within timeout |

**`claude` is the only process OpenHive directly spawns**, but the manager still treats the cc-swarm sidecar (detached internally by `claude`'s plugin runtime) as a dependent. When `claude` exits — for any reason — the manager:

1. Reads the sidecar PID from `<data_dir>/.swarm/claude-swarm/tmp/map/sidecar.pid`.
2. SIGTERMs the sidecar.
3. Falls back to SIGKILL after a short grace.

This keeps the sidecar from outliving the TUI session. cc-swarm's own 30-minute idle-timeout is the second-line safety net, but OpenHive doesn't rely on it.

A user-driven exit of the TUI **is** a normal terminal state for `claude-code`, unlike `swarm-runner` where the daemon is meant to keep running until told to stop. The lifecycle policy interprets `claude`'s exit code: 0 → `stopped`, non-zero → `failed`.

### 7. Terminal-info contract changes

```ts
GET /map/hosted/:id/terminal-info?mode=tui|shell
```

becomes per-kind aware:

- For `swarm-runner`, `mode=tui` returns the SwarmRunner TUI command (current behavior).
- For `claude-code`, `mode=tui` returns the binding hint `{ kind: 'attach-to-process', processId: 'tui' }`. The frontend uses a different code path: it tells `/ws/terminal` to attach to an existing PTY rather than spawn a new one.
- `mode=shell` keeps the same shape across kinds (drop into `$SHELL` in the swarm's data dir, sandboxed).

```ts
// New response shape (covers both spawn-fresh and attach modes)
type TerminalInfoResponse =
  | { mode: 'tui'; binding: 'spawn'; available: boolean; command: string | null; args: string[]; endpoint: string; sandbox: boolean }
  | { mode: 'tui'; binding: 'attach'; available: boolean; processId: string; sandbox: boolean }
  | { mode: 'shell'; available: boolean; command: string; args: string[]; cwd: string; sandbox: boolean; endpoint: string };
```

### 8. UI changes

- Spawn dialog: **Kind** picker as the first field. Per-kind, the rest of the form re-shapes (e.g. `claude-code` shows project-dir + initial-prompt; `swarm-runner` keeps adapter + bootstrap-coordinator).
- Swarm list: kind shown as a small chip on each card.
- SwarmDetail: kind-specific section labels — "Open TUI" stays for `swarm-runner`, becomes "Open Claude Code" or similar for `claude-code`. Logs section identical.

The spawn-dialog re-shaping is the main UX work; the rest is small.

### 9. API changes (compatibility)

- `POST /map/hosted/spawn` accepts an optional `kind` field (defaults to `'swarm-runner'`).
- Existing callers that don't pass kind keep getting SwarmRunner behavior.
- Response shape unchanged (the row now carries `kind` but consumers that ignore the field are unaffected).

---

## Resolved decisions

These were open in the first draft; locked in after review:

1. **Auth / credentials.** Operator's local credentials, whatever's available — Claude Code's normal login under the operator's user account. Don't manage credentials per-spawn. **Detect invalid state and recover gracefully**: if `claude` exits immediately with an auth error, surface that as the hosted-swarm `error` field with a clear message ("Claude Code is not logged in — run `claude login` on the host") rather than spinning in `provisioning`.

2. **Hook config coexistence.** User-global `~/.claude/settings.json` may keep firing alongside whatever cc-swarm watches. We accept this — operators may have intentional hooks they want to keep. Spawn never writes user-global config (see Section 5).

3. **Initial prompt is optional.** `claude-code` kind can spawn with no initial prompt; `claude` opens cleanly in the swarm's data_dir and waits for input. The spawn dialog gets an optional prompt field; empty is a valid value.

4. **Sidecar lifecycle ties to the TUI.** When `claude` exits (any cause — `/exit`, crash, kill), the manager terminates the cc-swarm sidecar shortly after. Manager owns lifecycle end-to-end; sidecar is treated as a dependent process, not a peer. Hosted-swarm row goes to `stopped` for clean exits, `failed` for crashes.

5. **No separate `cc-swarm` kind.** cc-swarm IS the sidecar in the design. There's no orchestrator-mode-as-its-own-kind to plan for; if cc-swarm grows multi-Claude-Code-worker semantics internally, that's still just cc-swarm running as the sidecar in `claude-code` kind. Drop this from the kind enum.

## Spike-validation items

Two remaining unknowns we settle by writing code, not by debating:

1. **`claude --resume <sid> -p "<msg>"` against an idle session.** Does it work cleanly when the TUI process is paused/idle but still alive (sharing the same `.jsonl` file), or does it race? Small isolated test in the spike: spawn `claude`, wait until idle, run `--resume -p` from a separate process, observe whether the message lands and whether the running TUI sees it. If clean → unlocks autonomous dispatch turn injection for v1. If messy → drop from v1, document.

2. **Multi-tab terminal access semantics for `claude-code`.** OpenHive's terminal supports multi-tab attach for swarm-runner TUI — verify the same works when the underlying PTY is a `claude` subprocess. Same-user multi-device is the target use case; concurrent typing producing garbled stdin is a known/accepted limitation, but anything worse (e.g. tab disconnect kills the session) is a blocker we'd want to know about.

---

## Future kinds (sketch)

- **`codex` — TUI mode (✅ shipped 2026-05-06)** — `codex` CLI in PTY; openhive manages process lifecycle. No openhive-aware plugin yet (a future codex-swarm plugin will add MAP integration analogous to cc-swarm). Mirrors claude-code structurally minus the sidecar; pre-trust uses `~/.codex/config.toml` `[projects."<realpath>"] trust_level = "trusted"`.
- **`codex` — programmatic mode (✅ shipped 2026-05-06)** — second mode of `kind: 'codex'` selected via `mode: 'tui' | 'rpc'` on the spawn payload. Defaults to `'rpc'` (openhive chat is the canonical driver); `mode: 'tui'` opts into the existing PTY-based TUI experience. Codex's `codex app-server` speaks a rich JSON-RPC protocol (`thread/start`, `turn/start`, `turn/steer` with `expectedTurnId` precondition for live mid-turn injection, `turn/interrupt`, streaming `item/agentMessage/delta`, etc.) — TS bindings live under `codex app-server generate-ts`.

  **Decision: same kind, two modes, separate threads.** A probe attempted the macro-agent shape (one app-server process, sibling `codex resume <threadId>` PTY as a second surface onto the same conversation) and confirmed it doesn't work mechanically: codex's app-server holds thread state in-memory and snapshots to disk; `codex resume` reads the snapshot and starts an independent in-memory copy. The TUI loads existing history but does NOT re-render when the app-server processes new turns — the two processes diverge silently after the resume point. Until codex itself adds shared-state IPC, openhive treats `mode: 'rpc'` and `mode: 'tui'` as two coherent paths per spawn: each swarm picks its surface; if a user wants both experiences they spawn two swarms.

  **What `mode: 'rpc'` unlocks** that TUI mode and `claude-code` architecturally can't:
    - Live mid-session injection from openhive chat (`turn/start`, `turn/steer`)
    - Full streaming output through openhive's existing chat surface (no JSONL scrape)
    - Programmatic chat/control hand-off to a codex agent
    - Built-in observability notifications (rate limits, token usage, MCP startup, thread status — fire automatically)

  **Dispatch executor decision (2026-06-18): hosted `kind: 'codex'` is not the autonomous-dispatch sidecar.** The dispatch path uses a separate `swarm-codex` executor target wired through `src/dispatch/swarm-codex-runtime.ts`, which consumes `swarm-codex`'s `createCodexDispatchRuntime()` directly. That keeps OpenHive's existing `swarm-dispatch` orchestrator, retry policy, event bridge, and terminal-state writes authoritative. A target swarm must be explicitly marked with `metadata.kind = "swarm-codex"` or an equivalent dispatch capability; hosted `kind: 'codex'` TUI/RPC rows remain interactive chat/session surfaces. Repo dispatches resolve their working directory from `dispatch.clone_path` first, then the linked repo resource's `local_path`. The runtime opens swarm-codex coordination with MAP + git-cascade enabled, uses the first linked OpenTasks task as the v1 cascade attribution ref, and refreshes attribution programmatically because live probes showed Codex `PostToolUse` hooks do not fire inside nested `codex mcp-server` role threads. Dispatch workers default to Codex `danger-full-access` because git-cascade needs real commits and Codex `workspace-write` blocks `.git/index.lock`; operators can override `dispatch.codex_executor.sandbox` when they provide another commit-capable sandbox boundary. Codex-delivered attempts are one-shot: after a clean Codex exit, the continuation policy releases the dispatch instead of entering the normal multi-turn mail/ACP route path.
- **`gemini`** — gemini CLI; integration shape TBD when the use case arrives. Likely fits `TuiKindStrategy` directly with a new `makeGeminiStrategy()` and minimal changes elsewhere.

---

## Spike plan

**Goal of the spike: validate the kind-based architecture by getting `kind: 'claude-code'` working end-to-end on a single happy path.** Not feature-complete; not polished UI. The point is to surface the open questions in code and pin down the unknowns.

**Deliberately deferred from the spike:**
- Codex / gemini.
- Spawn dialog re-shaping per kind (use a hardcoded button "Spawn Claude Code" alongside the existing SwarmRunner flow).
- Autonomous-dispatch turn injection.
- Lifecycle-state polish for clean `/exit` (treat any non-zero or operator-stop as the only outcomes for now).

**Status update — 2026-05-06:** Restart and revive for claude-code are now both wired up. `restart()` branches to `restartClaudeCode` which tears down the PTY+sidecar, rotates the onboard token, re-writes the prelaunch config, and re-spawns through `PtyManager` against the same row. `reviveHostedSwarms()` deliberately marks claude-code rows `stopped` on hub restart (with a "session ended; spawn fresh to resume" diagnostic) — interactive TUIs can't survive a hub restart cleanly, so we don't try, and best-effort SIGTERM the sidecar in case it survived. Both are covered by the live e2e at `src/__tests__/swarm/live-claude-code-e2e.test.ts`.

**Scope of the spike:**

1. Add `kind` column to `hosted_swarms` (migration + DAL).
2. Implement `resolveSpawnPlan('claude-code', opts)` — one `claude` process + one prelaunch file (`.swarm/claude-swarm/config.json`).
3. Teach the local provider to execute prelaunch-file writes before spawning. The multi-process plumbing isn't needed for `claude-code` v1 (single process), but keep `processes: SpawnProcess[]` shape for forward compatibility.
4. Resolve the `claude` binary on PATH (similar pattern to `resolveSwarmRunnerTuiBinary`); surface a clear error if not found.
5. Document the operator prerequisite: `claude plugin add /path/to/claude-code-swarm` must have been run once. Spike does NOT auto-install the plugin.
6. Extend `terminal-info` to return the `attach-to-process` shape for `claude-code`.
7. Teach the WS handler to attach to an existing PTY by `processId` (via `swarmManager.getProcessPty(hostedId, processId)` or similar).
8. Wire sidecar-PID-based shutdown: on stop, read `<data_dir>/.swarm/claude-swarm/tmp/map/sidecar.pid`, SIGTERM the sidecar after the `claude` PTY exits.
9. Add a "Spawn Claude Code" button on the swarms page wired to the new flow.
10. Live-test: spawn → cc-swarm sidecar registers → embedded terminal shows real Claude Code TUI → user types → response renders → swarm shows up in MAP → `/exit` cleanly stops both processes.

**What we'll learn from the spike:**
- Whether Option A (embedded terminal owns the PTY) actually works cleanly in `node-pty` for an interactive Claude Code session, or whether we hit signal/TTY issues that push toward Option B.
- Whether the prelaunch config approach (`.swarm/claude-swarm/config.json`) is sufficient for cc-swarm to find and authenticate to the openhive hub, or whether env vars are also needed.
- Realistic lifecycle timings — how fast does cc-swarm's bootstrap detach the sidecar, how long until MAP registration arrives. Sets the registration timeout.
- Auth/credential gotchas — operator credentials work for both Claude Code (via `~/.claude/credentials.json`) and openhive's MAP auth (via the bootstrap credential we generate). Document any weird interactions.
- What happens when the cc-swarm plugin ISN'T installed — does `claude` still launch and we just never see registration, or does some other error path fire? The error UX needs to be clear.

**After the spike:** revise this doc with what we learned, then expand to the full UI re-shaping, real cc-swarm integration, and the lifecycle polish. Codex comes after that.

---

## Key files (will be touched)

- `src/db/schema.ts` — migration for `hosted_swarms.kind`
- `src/swarm/dal.ts` — `kind` in `CreateHostedSwarmInput`, `HostedSwarm`
- `src/swarm/types.ts` — `HostedSwarmKind`, `SpawnPlan`, lifecycle policies
- `src/swarm/spawn-plans/{swarm-runner,claude-code}.ts` — new (per-kind resolvers)
- `src/swarm/manager.ts` — call `resolveSpawnPlan`, hand plan to provider
- `src/swarm/providers/local.ts` — execute multi-process plans, expose `getProcessPty`
- `src/api/routes/swarm-hosting.ts` — `kind` in spawn payload, terminal-info per-kind
- `src/terminal/terminal-ws.ts` — attach-to-process mode (read PTY handle from manager rather than spawning)
- `src/web/components/swarm/SpawnSwarmDialog.tsx` — kind picker, per-kind form
- `src/web/components/terminal/TerminalPanel.tsx` — handle `binding: 'attach'` response
- `src/web/pages/SwarmDetail.tsx` — kind chip, kind-aware labels

Tests: at least one integration test per kind exercising spawn → terminal-info → lifecycle → stop.

---

## Implementation status (2026-05-06)

`kind: 'claude-code'` ships end-to-end. Below is what's actually in the tree and what's deliberately deferred.

### Shipped

| Layer | Component | Notes |
|---|---|---|
| DB | `hosted_swarms.kind` (V50 + V51) | V50 added the column with a CHECK constraint; V51 dropped the constraint so new kinds can be added without a migration. Validation moved to Zod. |
| Manager | TUI-kind strategy pattern (`src/swarm/tui-strategies.ts`) | Per-kind strategy objects (`makeClaudeCodeStrategy`, `makeCodexStrategy`) implement `TuiKindStrategy`. The manager has ONE shared spawn/stop/restart pipeline (`spawnTuiKind`, `stopTuiKind`, `restartTuiKind`); all kind-specific behavior (binary resolution, prelaunch files, env hygiene, sidecar wait, workdir trust) lives in the strategy. Adding a new TUI kind is a single new strategy. |
| Manager | `spawn()` dispatcher | `isTuiKind(kind)` → resolve strategy → `spawnTuiKind(agentId, input, strategy)`. SwarmRunner continues through the original `spawnSwarmRunner()`. |
| Manager | `stopTuiKind()` | Destroys PTY, signals per-kind sidecar (only for kinds with `hasSidecar: true`), MAP swarm → offline |
| Manager | `restartTuiKind()` | Cold-restart only; rotates onboard token, re-writes prelaunch files via strategy, re-spawns against the same row. Sidecar wait gated on `hasSidecar`. |
| Manager | `reviveHostedSwarms()` TUI branch | Marks TUI rows `stopped` on hub restart with operator-actionable diagnostic; best-effort sidecar SIGTERM only for kinds with one |
| Manager | `getLogs()` TUI branch | Returns `({kind} logs stream live in the embedded terminal — no scrollback buffer)` instead of misleading `(no tracked instance)` |
| Manager | Health monitor skip for TUI kinds | Liveness comes from PTY exit (+ sidecar registration where applicable), not HTTP `port+1/health` |
| Manager | `handleClaudePtyExit()` | Kind-agnostic; reads kind from row. Maps clean exit → `stopped`, non-zero exit OR signal kill → `failed` (Deviation 5). Sidecar SIGTERM only for kinds with one. |
| Helpers (claude-code) | `resolveClaudeBinary()`, `buildClaudeSwarmConfig()` / `writeClaudeSwarmConfig()`, `preTrustClaudeWorkdir()` | PATH + known locations probe; cc-swarm prelaunch config writer (`auth.token` + `swarmId` per Deviation 1); pre-mark data_dir trusted in `~/.claude.json` (per Deviation 4) |
| Helpers (codex) | `resolveCodexBinary()`, `preTrustCodexWorkdir()` | PATH + known locations probe; pre-mark data_dir trusted in `~/.codex/config.toml` via `[projects."<realpath>"] trust_level = "trusted"` stanza |
| API | `POST /map/hosted/spawn` | Accepts `kind ∈ {swarm-runner, claude-code, codex}`; superrefine rejects swarm-runner-only fields for TUI kinds with kind-aware error messages |
| API | `GET /map/hosted/:id/terminal-info?mode=tui` | Returns `binding: 'attach'` with live PtyManager `sessionId` for any TUI kind |
| API | `GET /map/hosted/:id/logs` | Surfaces the TUI scrollback hint as plain text |
| API | `POST /map/hosted/:id/stop` and `/restart` | Branch through manager dispatchers (kind-agnostic) |
| API | `initial_prompt` field on spawn payload | Passed to the TUI binary as positional arg; both `claude` and `codex` accept this and open with the prompt prefilled |
| API | `workspace.repos` for TUI kinds | Clones into `data_dir` before PTY spawn (reuses `cloneWorkspaceRepos`); the TUI opens with the cloned tree under cwd |
| Terminal | `terminal-ws.ts` `?sessionId=` attach mode | Existing path; works for any PtyManager session the manager owns |
| UI | Spawn dialog kind picker | Three-card chooser (SwarmRunner, Claude Code, Codex); swarm-runner-only fields hidden for TUI kinds; per-kind prerequisite hint |
| UI | `KindBadge` chip | Renders "Claude Code" (violet) or "Codex" (emerald) on swarm cards |
| UI | `TerminalPanel` `binding: 'attach'` handling | Reads `sessionId` from terminal-info, passes through `?sessionId=` query |
| UI | Initial-prompt textarea + single-repo URL/branch inputs | Shown for TUI kinds (claude-code + codex) |
| Config | Sidecar registration timeout | Bumped 15s → 60s (only applies to kinds with sidecars; cc-swarm bootstrap installs swarmkit packages on first launch). Codex skips this entirely. |
| Tests | `src/__tests__/swarm/live-claude-code-e2e.test.ts` | 11 tests, ~37s, gated on `LIVE_AGENT_E2E=true`. Spawn → register → capability surface → terminal-info → getLogs → browser WS attach → restart → stop → forced-crash → initial_prompt arg → workspace clone. Zero mocks. |
| Tests | `src/__tests__/swarm/live-codex-e2e.test.ts` | 9 tests, ~25s, gated on `LIVE_AGENT_E2E=true`. Codex `mode: 'tui'`: spawn → terminal-info → getLogs → browser WS attach → restart → stop → forced-crash → initial_prompt → workspace clone. Zero mocks. |
| API | `mode: 'rpc' \| 'tui'` field on spawn payload (codex-only) | Defaults to `'rpc'` for codex (chat-driven canonical surface); `'tui'` is opt-in. Schema rejects `mode` for non-codex kinds. |
| Manager | `spawnCodexRpc()` / `stopCodexRpc()` / `restartCodexRpc()` | Routes through `CodexAppServerManager` instead of `PtyManager`. Drives `initialize` → `thread/start` synchronously during spawn so the row only flips to `running` after a thread id is captured. Restart starts a fresh thread (codex's app-server doesn't expose live-thread takeover; see Deviation 6). |
| Manager | `handleCodexRpcExit()` | Symmetric to `handleClaudePtyExit`: clean exit (code 0, no signal) → `stopped`; non-zero or signal-kill → `failed`. Operator-driven stop deletes from `codexRpcSessions` BEFORE destroy so the handler returns early on that path. |
| Manager | `getLogs()` codex-rpc branch | Returns "(codex-rpc output streams live via JSON-RPC notifications into openhive chat — no scrollback buffer)". |
| Helpers | `CodexAppServerManager` (`src/swarm/codex-app-server-manager.ts`) | Singleton analog to `PtyManager` for codex-rpc. Spawns `codex app-server --listen ws://127.0.0.1:0`, parses listen URL from stderr (gotcha: not stdout), opens WS, drives `initialize` + `initialized` + `thread/start`, exposes `sendTurn`, `interrupt`, `destroy`, emits per-session `notification` events for the chat bridge to fan out. |
| Tests | `src/__tests__/swarm/live-codex-rpc-e2e.test.ts` | 5 tests, ~7s, gated on `LIVE_AGENT_E2E=true`. Codex `mode: 'rpc'`: spawn → thread-id captured → sendTurn → streaming `item/agentMessage/delta` → turn/completed → getLogs hint → stop → forced-crash. Zero mocks. Real model call asserts streaming. |
| Dispatch | `swarm-codex` executor branch (`src/dispatch/swarm-codex-runtime.ts`) | Optional `dispatch.codex_executor.enabled` branch. Routes only explicitly marked `swarm-codex` targets, resolves repo cwd from dispatch/repo bindings, creates a swarm-codex `CoordinationPlane` with MAP + git-cascade, and spawns Codex workers through `createCodexDispatchRuntime()` under OpenHive's existing orchestrator. Attempts record `transport: 'codex'`; default sandbox is commit-capable `danger-full-access`. |
| Tests | `src/__tests__/dispatch/swarm-codex-runtime.test.ts`, `src/__tests__/dispatch/routing.test.ts` | Hermetic unit coverage for explicit target detection, MAP URL shaping, repo path resolution, runtime delegation, delivery recording, and task-ref resolver wiring. Broader `src/__tests__/dispatch` server suite covers compatibility with existing ACP/mail dispatch. |

### Deferred / future

- **Gemini and other future CLI kinds.** The `kind` enum is open; a new entry plus its own strategy drops in alongside the existing TUI kinds without re-architecting.
- **Live mid-session injection** from openhive chat into a running claude TUI. Out per "Limits we're accepting" — codex's RPC may admit this when that kind lands.
- **`inject_resources` for claude-code.** Currently warned-and-dropped during spawn.
- **Hot-restart for claude-code.** Always cold-restart; the bootstrap is config-file + plugin-hook, not a long-running daemon. Hot bounce isn't meaningful here.
- **Multi-tab attach to the same claude PTY.** Mechanically should work via `?sessionId=` (multiple WS clients attaching to one PtyManager session is supported by `terminal-ws.ts`), but not yet asserted by a test.
- **Strategy-pattern refactor (Approach B from the manager refactor plan).** The duplication between `spawnSwarmRunner` and `spawnClaudeCode` is real but bounded; we'll extract when codex lands and three call sites can inform the interface shape.

### Deviations from the original design (cumulative)

1. **Prelaunch config uses `auth.token` instead of `auth.credential`** plus a `swarmId` field. Original design wrote `auth.credential`; cc-swarm's `buildServerUrl` skips appending `?swarm_id=...` to the WS URL when `credential` is set, which would break our open-mode hub's swarm_id-based registration matching. (Already documented above at the prelaunch config section.)

2. **Claude-code spawns route through `PtyManager`, not `LocalProvider.provision()`.** `claude` is interactive and crashes under `child_process.spawn` (no TTY). PtyManager wraps node-pty and gives it a real TTY. Downstream consequence: `instanceToHostedId` and `hostedToInstanceId` mappings are NOT populated for claude-code rows. Anything routing through `getInstanceId()` is a no-op for claude-code; the manager has explicit kind branches for `getLogs`, `stop`, `restart`, `reviveHostedSwarms`, and the health monitor.

3. **`reviveHostedSwarms()` marks claude-code rows `stopped` on hub restart** instead of attempting to revive. Interactive TUIs can't survive a hub restart cleanly — the PTY is gone, the sidecar self-stopped on idle (or we lost track of its PID). Rather than ship a half-working revival path, we mark the row stopped with a clear "spawn fresh to resume" diagnostic and best-effort SIGTERM the sidecar in case it survived. The operator clicks Restart or Spawn fresh as they prefer.

4. **Pre-trust the data_dir in `~/.claude.json` before launching `claude`** (`preTrustClaudeWorkdir()` in `claude-code-config.ts`). Without this, claude shows its "Trust this folder?" gate and SessionStart never fires, which means the cc-swarm plugin never runs and the sidecar never registers. The fix mirrors what claude itself writes when the user clicks "Yes": `projects.<realpath(data_dir)>.hasTrustDialogAccepted = true`. Realpath is required because macOS resolves `/tmp → /private/tmp` (and `/var → /private/var`), and claude looks up the canonical path. Idempotent, atomic write, missing/malformed `~/.claude.json` is a soft no-op (the user just sees the prompt).

5. **Signal-kills classified as crashes in `handleClaudePtyExit`.** node-pty reports `exitCode=0, signal=N` for SIGKILL/SIGSEGV/etc on macOS+Linux (the OS sets the termination signal, not the exit code). The original handler only checked `exitCode === 0`, misclassifying kills as clean stops. Now any `signal > 0` reaching the handler is treated as a crash → `state=failed`. Operator-driven `stop()` is unaffected: `stopTuiKind` deletes the session-map entry before destroying the PTY, so the handler returns early on its lookup miss for that path. The same fix applies to `handleCodexRpcExit` for consistency.

6. **Codex `mode: 'rpc'` and `mode: 'tui'` operate on independent threads.** A probe (see "codex — programmatic mode" above) confirmed that `codex resume <threadId>` against an active app-server thread loads the existing snapshot but does NOT re-render when the app-server processes new turns — the two processes diverge silently after the resume point. Codex's app-server holds thread state in-memory and snapshots to disk; `codex resume` reads those snapshots into a separate in-memory copy with no IPC between them. This rules out the macro-agent "one process, two surfaces" model for codex until upstream changes ship. Until then, openhive treats the two modes as two coherent paths per spawn — each swarm picks its surface; if a user wants both experiences they spawn two swarms, accepting separate threads.
