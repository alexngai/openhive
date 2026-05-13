# Permission Overlay via ACP Permission-Request Interception

**Status**: Implemented (Phase 3 + Phase 4 — extends to ACP+reuse via the new `x-dispatch/permissions.{set,clear}` MAP wire)
**Date**: 2026-05-04
**Owners**: macro-agent / OpenHive dispatch path

## Phase 4 — ACP+reuse overlay enforcement

Extends Phase 3 (mail+reuse, where the consumer set/cleared the overlay
directly on swarm side) to the ACP+reuse path. The structural difference:
ACP+reuse has no swarm-side dispatch consumer — the prompt arrives via
`session/prompt` and goes straight to `agentManager.prompt(agentId, message)`.
There is no try/finally bracket point to call `setPermissionOverlay`.

The fix: **a new MAP wire pair** that lets OpenHive set/clear the overlay
remotely.

### Wire methods

```
x-dispatch/permissions.set.request    { correlation_id, agent_id, deny[], allow[] }
x-dispatch/permissions.set.response   { correlation_id, result | error }

x-dispatch/permissions.clear.request  { correlation_id, agent_id }
x-dispatch/permissions.clear.response { correlation_id, result | error }
```

Notification-pair pattern, same as the existing `x-dispatch/spawn-agent`
methods. Lives under the `x-dispatch/*` namespace owned by swarm-dispatch
so other hubs running their own dispatch can co-exist on the same wire.

### Flow

```
OpenHive orchestrator
  ├── resolveTarget (lifecycle='reuse')
  │     └── stagePendingOverlay({swarmId, agentId, deny, allow})
  ├── createStream(serverId, agentId)
  │     └── activatePendingOverlay → callViaNotificationPair(
  │           swarmId, 'x-dispatch/permissions.set.request', ...)
  │           → swarm's sidecar invokes setPermissionOverlay(agentId, ...)
  │           → response posts back with correlation_id
  ├── sendPrompt(streamId, sessionId, prompt)
  │     └── claude-agent-acp consults canUseTool for every tool
  │           → emits permission_request session updates
  │           → macro-agent's prompt iterator (P3) intercepts
  │           → evaluatePermission(...) → respondToPermission('reject'|'allow')
  └── closeStream(streamId)
        └── deactivateOverlay → callViaNotificationPair(
              swarmId, 'x-dispatch/permissions.clear.request', ...)
              → swarm's sidecar invokes clearPermissionOverlay(agentId)
```

### Files

| File | Change |
|---|---|
| `references/macro-agent/src/dispatch/permissions-handler.ts` | NEW — pure `handlePermissionsSet` / `handlePermissionsClear` (validation + overlay registry mutations + ok/error response shape) |
| `references/macro-agent/src/dispatch/__tests__/permissions-handler.test.ts` | NEW — 12 unit tests (all 3 set shapes, idempotency, validation rejection, clear, method-name pinning) |
| `references/macro-agent/src/map/sidecar.ts` | Register `x-dispatch/permissions.set.request` and `permissions.clear.request` notification handlers; reply via `connection.sendNotification(<method>.response, { correlation_id, result \| error })`. Wired alongside the existing spawn-agent handlers; cleanup via the same `cleanupSubModules()` path. |
| `src/dispatch/openhive-runtime.ts` | Add `stagePendingOverlay`/`activatePendingOverlay`/`deactivateOverlay` helpers + a per-stream `Map<streamId, ActiveOverlay>`. Hook them into `resolveTarget` (reuse path) → `createStream` → `closeStream`. Errors are non-fatal — the dispatch continues without overlay enforcement and logs the failure. |
| `src/map/ws-map.ts` | Generalize the response routing: `x-dispatch/<anything>.response` notifications dispatch to `handleNotificationPairResponse` (covers `spawn-agent`, `permissions.set`, `permissions.clear`, and any future additions). |
| `src/__tests__/swarm/live-acp-reuse-dispatch.test.ts` | Drop the "permissions advisory" carve-out; restore PERM_DENIED to the asserted markers; relax `afterCount` to `≤ beforeCount` (the existing coord may terminate via `done()`'s shouldTerminate=true; what's forbidden is a fresh spawn). |

### P5.1 — two real bugs found and fixed (was masquerading as a routing timeout)

The "permissions.set timed out" warning that earlier shipped as a "cosmetic"
issue turned out to mask **two real enforcement bugs** that were producing a
false-positive PERM_DENIED=true. Diagnosed by pre-populating the deny target
file with known content (`/tmp/perm-deny-test-target.txt` ←
`sentinel-content-must-not-be-read`) and asserting the content does NOT leak
into the ACP stream.

**Bug 1 — Double `.request` suffix on the OpenHive caller**

`callViaNotificationPair(target, method, ...)` automatically appends
`.request` to the method name (line 70 of swarm-dispatch's notification-rpc).
The OpenHive runtime was passing `'x-dispatch/permissions.set.request'` as
the base, producing the over-the-wire method `'x-dispatch/permissions.set.request.request'`
— which macro-agent's handler (registered for `'x-dispatch/permissions.set.request'`)
silently ignored. The handler never fired, the timeout was a real timeout,
and `setPermissionOverlay` never ran. **Fix:** call with the BASE name
`'x-dispatch/permissions.set'` (mirrors `callSpawnAgent`'s
`SPAWN_AGENT_BASE` shape).

**Bug 2 — Bootstrap coord didn't have `askForAllTools`**

Even after Bug 1 was fixed and the overlay was being set correctly on the
swarm, the prompt iterator wasn't seeing `permission_request` updates for
Read calls. The reason: the **bootstrap coordinator** (the agent ACP+reuse
dispatches against) wasn't spawned with `askForAllTools: true`, so the SDK
auto-approved Read without consulting `canUseTool`. The overlay was set but
the iterator's interception path was never entered. **Fix:** new
`bootstrap.coordinator.dispatchTarget` boot config flag (env-var bridge
`MACRO_BOOTSTRAP_COORDINATOR_DISPATCH_TARGET=true`) that spawns the coord
with `askForAllTools: true` + `permissionMode: 'interactive'`. The flag is
opt-in to preserve the existing chat-friendly defaults — only enable it on
agents that need to receive ACP+reuse dispatches with overlay enforcement.

**Diagnostic that catches this class of bug**

The live test now creates `/tmp/perm-deny-test-target.txt` with known
content in `beforeAll` and asserts `expect(fileContentSeen).toBe(false)`.
If Read succeeds despite the deny rule, the file content shows up in the
ACP stream and the test fails — even if the agent reports PERM_DENIED=true
heuristically. This guards against any future regression where the agent
self-reports the wrong outcome.

**Verified end-to-end after fix**

- `file-content-leaked-into-stream: false` (real deny fired)
- No `permissions.set failed` timeout (wire works end-to-end)
- 4/4 markers including PERM_DENIED=true

## Live regression sweep (2026-05-04, post-implementation)

| Test | Result | Notes |
|---|---|---|
| `live-mail-reuse-dispatch.test.ts` | ✅ pass | 4/4 markers including PERM_DENIED=true |
| `live-acp-fresh-dispatch.test.ts` | ✅ pass | No regression on ACP-fresh path |
| `live-acp-reuse-dispatch.test.ts` | ✅ pass | No regression on ACP-reuse path |
| `live-loadout-dispatch-e2e.test.ts` | ❌ fail (Level 2) | Pre-existing — `Total captured turns: 0`; Level 2 ("agent processes mail turn and replies") doesn't fire. Reproduces in isolation without P3-touched code paths. The mail+fresh path goes through `mail-inbound-consumer` which P3 does not touch (the overlay/iterator interception only fires when an overlay is set, which mail+fresh doesn't do). Investigate separately. |

The unit-test pass: 5/5 in `agent-manager-v2.permission-interception.test.ts`, 19/19 in `permission-evaluator.test.ts` (including the regex-fix coverage for hyphenated MCP names).

## Implementation notes (2026-05-04)

Both layers proved necessary, not just one:

1. `settings.permissions.ask: ['*']` (via the new `SpawnAgentOptions.askForAllTools` flag) forces the Claude SDK to consult `canUseTool` for every tool call. Without this, the SDK auto-approves "safe" tools (Read included) without ever asking the host.
2. `permissionMode: 'interactive'` (on acp-factory's `AgentFactory.spawn`) makes acp-factory emit the resulting permission request as a `permission_request` *session update* instead of auto-approving via its default `'auto-approve'` mode. Without this, requests reach acp-factory but are short-circuited before they leave it.

The bootstrap dispatch target sets both via `boot-v2.ts`'s `bootstrap.worker` config; chat agents and parented children stay on their default static rules (no behavioral change).

A `deriveToolName()` helper in `agent-manager-v2.ts` extracts the canonical tool name from `permission_request.toolCall` because `claude-agent-acp`'s `toolInfoFromToolUse` uses display titles (e.g., `Read /tmp/x` instead of `Read`). The helper uses `toolCall.kind` for built-ins (read/edit/execute/search/think/switch_mode) and the input-shape (`old_string` vs `edits` to disambiguate Write/Edit/MultiEdit). MCP tools come through as their canonical `mcp__server__tool` name in the title and pass through unchanged.

The chat-surface routing (P3.4) is handled by overlay-gating: when no overlay is set on an agent, `permission_request` updates are yielded through unchanged so swarmcraft's `PermissionDialog` keeps rendering for ACP chat surfaces. Only dispatch-context agents (with overlay set) have their requests intercepted.

Permission-rule parser regex was widened to accept hyphens in tool names (matches MCP convention `mcp__agent-inbox__list_agents`).

A small bug in `permission-evaluator.ts`'s `parseRule()` regex was fixed alongside this work — it previously rejected hyphens, blocking any rule against an MCP tool whose server segment contains a hyphen. Now `[A-Za-z_][A-Za-z0-9_-]*` matches the full MCP convention.

## Context

OpenHive's mail+reuse dispatch flow needs to apply per-dispatch loadout deny rules
to a long-lived agent without recreating its session. Phase 1 attempted this by
installing a `PreToolUse` hook on the spawned agent that closed over an in-process
permission-overlay registry; the dispatch consumer set/cleared the overlay around
its prompt drive.

That approach failed at the live-test stage: the hook callback never fires.
Diagnosis (verified live):

```
macro-agent process
  ↓ acp-factory.handle.createSession
  ↓ JSON-RPC over stdio (child_process.spawn)
claude-agent-acp subprocess
  ↓ query() with options.hooks
claude binary subprocess
```

`JSON.stringify` silently strips functions inside arrays (replacing them with
`null`). When `_meta.claudeCode.options.hooks.PreToolUse[0].hooks` reaches
claude-agent-acp, the array entries are `null`. The SDK accepts the matcher with
a null callback list and silently no-ops on tool calls. The agent's tool calls
proceed under the session's static rules; the overlay never participates.

Confirmed by patching claude-agent-acp's `createSession` to log
`userProvidedOptions.hooks` — it logged `{"PreToolUse":[{"hooks":["object"]}]}`
where `"object"` is `typeof null`.

The Phase 1 wiring + a documenting `KNOWN LIMITATION` comment is currently checked
in at `references/macro-agent/src/agent/agent-manager-v2.ts` (around the
`claudeCodeOptions.hooks` block). The live test
`src/__tests__/swarm/live-mail-reuse-dispatch.test.ts` asserts PERM_DENIED is
*reported* but not *enforced* (`expect(permEnforced).toBe(true)` is commented).

## Goal

Replace the broken PreToolUse-hook mechanism with ACP-native permission-request
interception so dispatch loadout deny rules are actually enforced for mail+reuse,
without leaking agent-harness internals (claude-code hook protocol,
`.claude/settings.local.json` shape) into macro-agent or OpenHive.

## Non-goals

- Per-tool granular permission UI in the OpenHive frontend (already exists for
  ACP chat surfaces; not in scope here)
- Multi-harness validation (codex, gemini): the design is harness-agnostic by
  construction, but only Claude Code is exercised in Phase 3
- Overlay support for ACP+reuse (Mode A) dispatch — the same mechanism applies
  but it's a separate scope
- File-based settings hooks (the alternative path) — explicitly rejected because
  it leaks harness internals (see "Why ACP interception, not file hooks")

## Architecture

ACP already has the primitive we need. claude-agent-acp's `canUseTool` callback
emits a session update on every tool call when the session's permission mode
asks for it:

```
{ sessionUpdate: "permission_request",
  requestId: <opaque>,
  options: [{ optionId: "allow" }, { optionId: "deny" }],
  toolCall: { name, input } }
```

The host (macro-agent / OpenHive) replies via `respondPermission(requestId,
optionId)`. acp-factory already exposes this on its session handle (alongside
`cancelPermission`, `hasPendingPermissions`, `getPendingPermissionIds`).

This is the same channel that powers OpenHive's interactive PermissionDialog in
ACP chat. We reuse it for autonomous-dispatch enforcement.

```
agent calls tool
  ↓ Claude SDK consults canUseTool (set by claude-agent-acp)
  ↓ claude-agent-acp emits session update: permission_request
macro-agent prompt iterator receives the update
  ↓ look up overlay for this agentId
  ↓ evaluatePermission(toolName, toolInput, overlay)
  ↓ decision ∈ { allow, deny }
  ↓ session.respondPermission(requestId, decision)
agent continues (or sees deny)
```

### Layer ownership (clean cut)

| Layer | Owns | Does not know |
|---|---|---|
| **macro-agent** | Dispatch lifecycle; loadout → overlay translation; overlay set/clear timing; permission decision policy | Hook protocol, settings file paths, claude-code internals |
| **claude-agent-acp** | ACP wire protocol; emitting `permission_request` on `canUseTool`; receiving `respondPermission` | Dispatch concepts, loadout structure |
| **claude-code SDK** | `canUseTool` mechanism, permission mode classification | Application-level overlays |
| **cc-swarm / harness** | Nothing involved | All of this |

### Why ACP interception, not file hooks

The alternative ("(A)" in the spawn comment) — write `.claude/settings.local.json`
with a shell-command `PreToolUse` hook that reads overlay state from disk — is
also serializable across the boundary, but pulls macro-agent into harness
territory: settings file paths, hook script protocol, hook stdin/stdout JSON,
script lifecycle, on-disk IPC. Even when wrapped behind a cc-swarm-managed
abstraction, macro-agent or its caller has to know cc-swarm is the harness.

ACP interception talks the abstraction layer macro-agent already speaks for
everything else (sessions, prompts, mail, MCP, lifecycle). No new file paths,
no new IPC surface, no harness coupling. Same code works against any future
ACP-speaking harness.

## Design

### `permissionMode` selection

The SDK's permission classifier determines which tools surface
`permission_request` updates:

| Mode | Surfaces `permission_request` for | Suitable here? |
|---|---|---|
| `'default'` | "Potentially dangerous" only (Bash, some Edits) | No — Read won't surface |
| `'acceptEdits'` | Same but auto-approves edits | No |
| `'plan'` | Nothing executes | No |
| `'dontAsk'` | Nothing — denies anything not pre-approved by `settings.permissions.allow` | Maybe |
| `'interactive'` (claude-agent-acp's mode label) | Every tool call | Likely |

Two viable shapes:

**Shape A — `'interactive'` everywhere**: every tool call hits the host. Clean
semantics, but every tool roundtrips through macro-agent's prompt iterator. For
dispatch agents this is fine (latency-tolerant); for high-throughput chat agents
it would be measurable.

**Shape B — `'dontAsk'` + spawn-time `settings.permissions.allow`**: pre-approve
the agent's normal toolset at spawn so the SDK doesn't ask for those; the SDK
asks only for unmatched tools, and the overlay supplies the deny answer.
Cleaner runtime but requires the loadout to declare its `allow:` list more
precisely.

**Recommended**: start with Shape A on the dispatch path only (mail-inbound-reuse
agents, ACP-reuse agents), keep chat agents on `'default'`. If latency becomes
an issue, migrate to Shape B per agent class. Either way, the prompt-iterator
handler is identical.

A 30-min spike (one `console.log` in the prompt iterator) confirms which mode
emits `permission_request` for Read calls before committing to a code change.

### Prompt-iterator handler

`agent-manager-v2.ts`'s `prompt()` async generator already streams session
updates. Add a filter:

```ts
async function* prompt(agentId, message) {
  // ... existing setup
  for await (const update of activeSession.session.prompt(message)) {
    if (update.sessionUpdate === "permission_request") {
      const overlay = getPermissionOverlay(agentId);
      const { name: toolName, input: toolInput } = update.toolCall;
      const decision = overlay
        ? evaluatePermission(toolName, toolInput, overlay).decision
        : "allow";
      void activeSession.session.respondPermission(
        update.requestId,
        decision === "deny" ? "deny" : "allow",
      );
      // Don't yield permission_request to callers — internal-only.
      continue;
    }
    yield update;
  }
}
```

Important properties:

- **No-overlay default is allow**: when no overlay is set on the agent, the
  handler approves immediately. Maintains today's behavior for non-dispatch
  prompts.
- **Defense-in-depth**: wrap in try/catch; on any error, default to `'deny'`
  (fail-closed; safer than auto-approving on a registry bug). Log the error.
- **Internal-only**: don't yield `permission_request` updates upward to the
  consumer; macro-agent owns the decision now. (For ACP chat agents that
  want UI prompts, that's a separate code path that *does* yield — out of
  scope here.)
- **Synchronous response**: `respondPermission` is fire-and-forget; the SDK
  resolves the agent's pending tool call once it sees the response. We don't
  await it inside the iterator.

### Overlay registry (unchanged)

`references/macro-agent/src/dispatch/permission-overlay.ts` and
`permission-evaluator.ts` keep their current API:

```ts
setPermissionOverlay(agentId, { allow?, deny? }): void
clearPermissionOverlay(agentId): void
getPermissionOverlay(agentId): Overlay | null
evaluatePermission(toolName, toolInput, overlay): { decision, matchedRule }
```

The mail-inbound-reuse-consumer (and any future ACP-reuse equivalent) keeps its
existing `try/finally` around set/clear. **The only thing changing is where the
enforcement reads the overlay** — moving from a (broken) PreToolUse hook to the
prompt-iterator handler.

### Removing Phase 1 wiring

Strip cleanly in one commit:

- Delete the `claudeCodeOptions.hooks` block in `agent-manager-v2.ts` (around the
  `// 3. PreToolUse hook` comment + 60 lines of `KNOWN LIMITATION` doc)
- Delete the unused imports (`getPermissionOverlay`, `evaluatePermission`) at
  that site
- Add the prompt-iterator handler in their place
- Drop the doc-only spawn-time hook installation entirely; nothing else relies on it

`permission-overlay.ts` and `permission-evaluator.ts` stay — they're correct;
only the *consumer* changes.

## Migration plan

1. **Spike** — drop one `console.log` for `permission_request` updates into the
   prompt iterator on a worktree branch. Run the live-mail-reuse test with
   bootstrap worker spawned in `'interactive'` mode. Confirm Read surfaces a
   `permission_request`. Throw the spike away.
2. **Implement** — single PR:
   - Strip Phase 1 wiring
   - Add prompt-iterator handler
   - Set `permissionMode: 'interactive'` for bootstrap-worker spawn (gate behind a
     `permissionMode` option in `boot-v2.ts`'s bootstrap config; default
     unchanged)
3. **Test** — restore `expect(permEnforced).toBe(true)` in the live test; add a
   unit test for the prompt-iterator handler (mock session, overlay set →
   respondPermission called with `'deny'`; overlay clear → `'allow'`).
4. **Verify** — full live test suite (mail+fresh, mail+reuse, acp+fresh,
   acp+reuse — make sure no regressions on the chat surface that intentionally
   wants `permission_request` to bubble up to the UI dialog).
5. **Document** — update OpenHive's CLAUDE.md "Chat" section with one paragraph
   on dispatch-internal vs. chat-external permission decisions; cross-link this
   spec.

## Test strategy

### Unit (macro-agent)

- New: `src/agent/__tests__/agent-manager-v2.permission-interception.test.ts`
  - Mock session yields `permission_request` for `Read(/secret)`
  - Overlay set with `deny: ['Read(/secret)']` → `respondPermission(id, 'deny')`
  - Overlay clear → `respondPermission(id, 'allow')`
  - Overlay throws → fail-closed (`'deny'`); error logged
  - `permission_request` not yielded to consumer

### Live (OpenHive)

- `live-mail-reuse-dispatch.test.ts`:
  - Restore `expect(permEnforced).toBe(true)`
  - Drop "deferred" header note
  - Re-run end-to-end; confirm 4/4 markers (SENTINEL, SKILL_MARKER,
    AGENT_COUNT, PERM_DENIED=true)
- `live-mail-fresh-dispatch.test.ts` (or whatever the fresh-dispatch live
  variant is):
  - Sanity — fresh agents shouldn't regress (their permissions are wired via
    spawn-time `settings.permissions`, unaffected by this change)
- `live-acp-fresh-dispatch.test.ts` + chat surfaces:
  - Sanity — chat-side permission_request should still bubble to the UI
    PermissionDialog. The dispatch-side handler must NOT swallow chat events.
    This is solved by routing: dispatch-mode prompt iterator owns the
    decision; chat-mode iterator forwards to ACP host. Verify the routing
    is correct.

## Risks & open questions

- **Permission-mode semantics drift**: future Claude Code versions may change
  classification of which tools trigger `permission_request` under each mode.
  Mitigation: pin to `'interactive'` for dispatch and treat any unrecognised
  permission_request as 'deny'-by-default; rely on `settings.permissions.allow`
  for the agent's normal toolset.
- **Latency**: every tool call hits macro-agent. For dispatch agents this is
  fine; if ever applied to high-throughput chat agents, profile first.
- **Allow-list maintenance**: if Shape B is adopted later, loadouts need to
  declare their `allow:` precisely. Spec lookup of which tools the agent uses
  is currently informal — encoding it is non-trivial. Out of scope for this
  spec.
- **Concurrent dispatches on one agent**: today the consumer rejects
  concurrent dispatches per `inflightDispatches`. The overlay registry is
  per-agentId, single-slot. If we ever allow concurrent dispatches per agent
  (we don't currently), the overlay model would need extension.
- **Cleanup on connection drop**: the existing `try/finally` in the consumer
  clears the overlay on dispatch end; an abnormal connection drop or process
  crash might leave an overlay set. Acceptable: the overlay is in-process
  state, dies with the process; agentStore-persisted state is unaffected.

## Open questions for the spike

1. Does `'interactive'` mode emit `permission_request` for Read calls
   specifically, or does the SDK still classify Read as auto-allowed?
2. Does the `respondPermission` call need to happen synchronously (within the
   iterator's update loop) or can it be deferred? acp-factory's API suggests
   fire-and-forget; verify under load.
3. Does the SDK timeout on permission_requests? If yes, what's the timeout?
   (We set our own 5min timeout for chat-side ACP permissions; dispatch should
   be at least that lenient.)

## Out of scope

- File-based hook fallback (rejected — see "Why ACP interception, not file hooks")
- Per-dispatch overlay persistence across hub restart (overlay is in-memory by
  design)
- Overlay support for the ACP+reuse path (same mechanism applies; tracked
  separately)
- Multi-harness validation (codex, gemini)
- Overlay set/clear via MCP tool from within the agent (out-of-band; not
  needed for hub-driven dispatch)

## References

- `src/__tests__/swarm/live-mail-reuse-dispatch.test.ts` — header note documents
  the gap currently
- `references/macro-agent/src/agent/agent-manager-v2.ts` — `KNOWN LIMITATION`
  doc block + Phase 1 wiring (to be removed)
- `references/macro-agent/src/dispatch/permission-overlay.ts` — overlay registry
  (unchanged in Phase 3)
- `references/macro-agent/src/dispatch/permission-evaluator.ts` — rule
  evaluation (unchanged in Phase 3)
- `references/macro-agent/src/dispatch/mail-inbound-reuse-consumer.ts` —
  set/clear call sites (unchanged in Phase 3)
- acp-factory session handle — `respondPermission`, `cancelPermission`,
  `hasPendingPermissions` (existing API; reused as-is)
