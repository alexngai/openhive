---
status: draft
owner: alexngai
created: 2026-05-07
revised: 2026-05-08
---

# Dispatch Inbox Threads

## Problem

When an agent is dispatched to execute a spec, it has no structured way to reach back to the initiating context. If it hits a blocker, needs clarification, or wants to coordinate with agents on related tasks, the only options are: guess and continue, fail silently, or leave opentasks feedback that nobody is watching in real time.

Beyond the missing channel, three infrastructure gaps prevent reliable multi-agent coordination through dispatch threads:

1. **No coordination channel**: The trajectory shows *what the agent did*. The dispatch record shows *what happened*. Neither provides a channel for the agent to *ask for help* or for the initiator to *intervene mid-flight*.
2. **No wake signal**: When an agent finishes its dispatch and goes dormant, incoming thread messages sit in the inbox with no mechanism to reactivate the agent.
3. **No participant presence**: An agent posting a question has no way to know whether the recipient is online, dormant, or gone — so it can't decide whether to wait, escalate, or re-dispatch.
4. **Split agent identity**: cc-swarm registers with MAP as `sessionId` (ephemeral) but with agent-inbox as `${teamName}-main` (stable). The hub can't correlate the two, and thread membership breaks across session boundaries.

## Goals

1. Every dispatched agent has a **lazy-but-guaranteed-available** coordination channel back to its initiating context (user or agent).
2. Threads are **per-dispatch**, not per-task — but every dispatch thread is **traceable back to its linked tasks** for megathread views.
3. The channel reuses the existing **agent-inbox mail infrastructure** — no new persistence layer.
4. Retry attempts on the same dispatch **share the conversation** — agent B can read what agent A tried.
5. Users can **view and participate** in dispatch threads from the UI.
6. Silent dispatches (no interaction needed) produce **no empty conversations**.
7. Agents are **wakeable** when thread messages arrive, with the dispatch orchestrator as the wake authority.
8. Thread participants can **query presence** to decide whether to wait, escalate, or re-dispatch.

## Non-goals

- Proactive status posting by agents (trajectory covers observability).
- Replacing opentasks feedback for post-hoc notes on completed tasks.

## Design Principles

- The **dispatch orchestrator is the wake authority** for dispatched agents — not the inbox. The inbox stores messages and signals presence; the orchestrator decides whether to extend, re-dispatch, or nudge.
- **Presence is informational, not blocking.** Agents can always post to a thread regardless of recipient presence. Presence enriches the sender's decision-making (wait vs. escalate) but doesn't gate delivery.
- **Identity follows the role, not the session.** Thread membership binds to stable inbox agent IDs (`${teamName}-${role}`), so conversations survive session restarts and re-dispatches.

---

## Part 1: Agent Identity Unification

### Current state

| System | Agent ID | Derivation | Stable? |
|---|---|---|---|
| MAP (hub connection) | `sessionId` (Claude Code UUID) | Hook data | No — new per session |
| Agent-inbox (main) | `${teamName}-main` | Config-derived | Yes |
| Agent-inbox (teammate) | `${teamName}-${roleName}` | Config + role match | Yes |
| Agent-inbox (subagent) | `${teamName}-subagent-${timestamp}` | Generated | No |

MAP and inbox identities are never correlated. The hub sees a MAP agent ID it can't map to an inbox participant, and vice versa.

### Proposed change

Unify on the inbox ID as the canonical agent identity. Two-part fix:

#### 1a. cc-swarm: use inbox ID for MAP registration

In `bootstrap.mjs`, the `spawn` command for the main agent should use the inbox-derived ID:

```javascript
// Before (split identity)
sendCommand(config, {
  action: "spawn",
  agent: {
    agentId: sessionId,           // MAP gets session UUID
    name: `${teamName}-main`,
    ...
  }
}, sessionId);

// After (unified identity)
sendCommand(config, {
  action: "spawn",
  agent: {
    agentId: `${teamName}-main`,  // MAP gets same ID as inbox
    name: `${teamName}-main`,
    metadata: { sessionId, ... }, // sessionId preserved as metadata
    ...
  }
}, sessionId);
```

Same pattern for teammates (`${teamName}-${role}`) and subagents (use `hookData.agent_id` when available, fall back to `${teamName}-subagent-${timestamp}`).

#### 1b. MAP registration metadata: `inboxAgentId`

For cases where the MAP agent ID must remain different (backward compat, multi-session scenarios), include the inbox ID in MAP registration metadata:

```typescript
metadata: {
  inboxAgentId: `${teamName}-main`,  // Canonical inbox identity
  sessionId: "...",                   // Claude Code session (for trajectory, etc.)
}
```

The hub's connection registry (`connection-registry.ts`) can resolve `MAP agentId -> inbox agentId` via this field.

#### 1c. Hub-side resolution helper

```typescript
// connection-registry.ts
function resolveInboxAgentId(swarmId: string, mapAgentId: string): string | null {
  const conn = getInbound(swarmId);
  const agent = conn?.registeredAgents.get(mapAgentId);
  return agent?.metadata?.inboxAgentId ?? mapAgentId;
}
```

### Migration

Existing sessions with the old ID scheme continue to work — the hub falls back to `mapAgentId` when `inboxAgentId` is absent. New sessions get unified IDs. No database migration required.

### Files affected

| File | Change |
|---|---|
| `references/claude-code-swarm/src/bootstrap.mjs` | Use `${teamName}-main` as `agentId` in spawn command; preserve `sessionId` in metadata |
| `references/claude-code-swarm/src/map-events.mjs` | `buildSubagentSpawnCommand`: prefer stable ID derivation |
| `references/claude-code-swarm/scripts/map-hook.mjs` | `handleTeammateIdle` etc.: ensure MAP state updates use inbox-aligned ID |
| `src/map/connection-registry.ts` | Add `resolveInboxAgentId()` helper |

---

## Part 2: Conversation Model

### Two conversations per dispatch

Two agent-inbox conversations may exist per dispatch — they serve different purposes and must not be confused:

| | Delivery conversation | Coordination thread |
|---|---|---|
| **Scope** | `swarm-dispatch` | `dispatch-thread` |
| **Keyed by** | (swarm, agent) — shared across dispatches | dispatch — one per dispatch |
| **Content** | Structured JSON envelopes (`application/json`) | Natural language turns (`text`) |
| **Participants** | `openhive:dispatcher` + agent | Initiator (user/agent) + executor agent(s) |
| **Created by** | Mail transport on first delivery | Lazy, on first coordination message |
| **Consumed by** | Orchestrator's `demuxMailTurn` handler | Initiator via UI or inbox pull |
| **User-visible** | No (plumbing) | Yes (dispatch detail page) |

The delivery conversation is the orchestrator's RPC channel — it exists regardless of whether coordination is needed. The coordination thread only exists when someone has something to say.

### Conversation schema

```typescript
{
  id: `dispatch-conv-${dispatchId}`,       // Deterministic for idempotent lazy creation
  scope: 'dispatch-thread',
  subject: `Dispatch: ${specTitle} → ${swarmName}`,
  metadata: {
    source: 'dispatch-thread',
    dispatch_id: string,
    spec_id: string,
    spec_resource_id: string,
    target_swarm_id: string,
    linked_tasks: Array<{
      resource_id: string,   // syncable_resources.id
      node_id: string,       // opentasks node id
    }>,
    initiator: {
      type: 'user' | 'agent',
      id: string,
    },
  },
  participants: [
    { agent_id: initiatorId, role: 'initiator' },
    { agent_id: executorAgentId, role: 'executor' },
  ],
}
```

### Dispatch row extension

```sql
ALTER TABLE dispatches ADD COLUMN conversation_id TEXT;
```

Written on lazy creation. Nullable — silent dispatches never get one.

### Task backreference

```typescript
// Appended to syncable_resources.metadata.dispatch_threads
{
  dispatch_id: string,
  conversation_id: string,
  target_swarm_id: string,
  created_at: string,       // ISO 8601
  status: "active" | "completed",
}
```

Array, appended on each dispatch that creates a conversation for this task. Powers the megathread query: given a `resource_id`, read `metadata.dispatch_threads` directly.

### Subagent participation

Coordinators are the thread participants, not subagents. The coordinator relays relevant information from its workers into the dispatch thread. This keeps the participant list clean and avoids ephemeral subagent ID problems.

Flow for subagent-discovered issues:
1. Worker reports to coordinator (via native task tools or SendMessage)
2. Coordinator decides this needs cross-dispatch coordination
3. Coordinator posts to dispatch thread (using its stable ID `${teamName}-coordinator`)

cc-swarm native team teammates (`${teamName}-${roleName}`) have stable IDs and can participate directly if needed. Direct subagent thread access is deferred until a concrete use case requires it; if needed, the ID derivation would be `${teamName}-${role}-${taskNodeId}` for dispatch-context stability.

---

## Part 3: Conversation Lifecycle

### Lazy creation

Conversations are created on first message, not on dispatch start (D2). The dispatch prompt *advertises* the channel but doesn't create it. Silent dispatches produce no conversation.

```
Dispatch queued
  → prompt builder injects coordination channel metadata into agent context
  → no conversation exists yet

Agent (or user) posts first message
  → hub calls ensureDispatchConversation()
  → conversation created, participants added, backreferences written
  → first turn added

Subsequent messages
  → turns added to existing conversation
  → participants can be added (retry agents, user intervention)

Dispatch reaches terminal state
  → conversation stays open (coordination may continue post-dispatch)
```

### Conversation factory

```typescript
// src/dispatch/dispatch-conversation.ts

interface CreateDispatchConversationOpts {
  dispatchId: string;
  specId: string;
  specResourceId: string;
  specTitle: string;
  targetSwarmId: string;
  swarmName: string;
  linkedTasks: Array<{ resource_id: string; node_id: string }>;
  initiator: { type: 'user' | 'agent'; id: string };
  executorAgentId: string;
}

async function ensureDispatchConversation(
  opts: CreateDispatchConversationOpts,
  deps: { getMailJsonRpc(): MailJsonRpcServer; db: Database }
): Promise<string>
```

Idempotent: checks `dispatches.conversation_id` first. On create:
1. `mail/create` with metadata above and deterministic ID `dispatch-conv-${dispatchId}`
2. `mail/invite` for initiator and executor participants
3. Write `conversation_id` back to dispatch row
4. Append backreference to each linked task resource's metadata

### Thread lifetime

Threads are **archived on task completion, not dispatch completion.** This allows:

- Post-dispatch follow-up ("I finished my part, but here's a caveat")
- Multiple dispatches on the same task sharing history via task backreference
- New agents joining via re-dispatch and reading full context

The lifecycle:

```
Dispatch starts → no conversation yet (lazy)
First message → conversation created (status: active)
Dispatch completes → conversation stays active
Task completes → conversation closed (status: completed, via mail/close)
Task reopened → conversation reopened (via mail/reopen)
```

The cascade task-binder already listens for `mapHubEvents.task_status_changed`. The thread-close hook sits alongside it:

```
task.status → completed/closed
  → cascade task-binder: merge check (existing)
  → thread lifecycle: mail/close on all dispatch_threads for this task (new)

task.status → open/in_progress (from completed)
  → thread lifecycle: mail/reopen on linked conversations (new)
```

**TTL fallback for orphaned threads:** If the last message in a conversation is older than 30 days and no dispatch is `running` against linked tasks, a background sweep auto-archives. This handles the "task never closes" edge case.

### Thread reopen

New JSON-RPC method on agent-inbox for reopened tasks:

```typescript
"mail/reopen": {
  params: { conversationId: string },
  result: { conversationId: string, status: "active" }
}
```

Storage already allows this (no transition enforcement in `putConversation`), so the implementation is a thin status write + event emit.

### Cross-dispatch coordination

Separate threads per dispatch. Cross-dispatch coordination uses direct agent-inbox messaging with source tracing metadata:

```typescript
// Agent B (on dispatch B) asks agent A (on dispatch A) a question
{
  to: "teamA-coordinator",               // Target agent's stable inbox ID
  body: "What's the users table schema?",
  importance: "high",
  threadTag: "dispatch-disp_B_456",       // Sender's dispatch thread
  metadata: {
    source_dispatch_id: "disp_B_456",
    source_task_ref: { resource_id: "res_B", node_id: "task_B" },
    cross_dispatch: true                   // Hint for UI/orchestrator
  }
}
```

**Why not shared threads:** Permission scoping. If dispatch A has a loadout with different tool permissions than dispatch B, mixing their coordination in one thread creates confusion about what context applies. Separate threads keep each dispatch's context clean.

Cross-dispatch thread *discovery* (agent queries "what other dispatches exist for tasks that block mine?") is deferred to v2. The `dispatch_threads` backreference index exists to support it later.

---

## Part 4: Message Routing

### Agent → thread (three capability-dependent paths)

| Agent capability | Posting path |
|---|---|
| Has agent-inbox MCP tools | `send_message` with `thread_tag: "dispatch-{dispatchId}"` |
| Has `messaging.canSend` (no inbox tools) | MAP scope message `x-dispatch/thread`, hub routes to conversation |
| Neither | `coordination_message` field in `map/dispatches/report` payload |

The prompt builder advertises whichever path the agent's declared capabilities support. The hub needs a handler for path 2 — intercept `x-dispatch/thread` scope messages in `ws-map.ts` and route to `ensureDispatchConversation`.

### User → thread

UI posts via `POST /dispatches/:id/thread/turns` (new REST endpoint). Hub calls `ensureDispatchConversation` if needed, then `mail/turn`.

### Thread → agent

Standard inbox delivery. Agent picks up on next `UserPromptSubmit` hook (pull-based). Wake/nudge mechanisms (Part 5) handle the case where the agent is idle or dormant.

### Thread → user

UI polls or subscribes via WebSocket on `map:dispatches` channel. New turn events broadcast as `dispatch.thread.turn`. Wired in `src/server.ts` by subscribing to `mail.turn.added` events filtered by scope `dispatch-thread`.

---

## Part 5: Prompt Injection

### First-run prompt

The prompt builder (`src/dispatch/prompt.ts`) injects a coordination section after the task content, before the role line:

```markdown
## Coordination

A dispatch thread is available for this work. If you need clarification,
hit a blocker, or need input from the dispatch initiator, post a message:

  Thread: dispatch-{dispatchId}
  Initiator: {initiator.type} {initiator.id}
  Linked tasks: {task titles}

To post, use the agent-inbox send_message tool with thread_tag "dispatch-{dispatchId}".
The thread will be created on your first message.
```

### Retry prompt

Shorter reminder that the thread exists, plus note that prior agent's conversation history is available.

### Continuation prompt

If `dispatch.conversation_id` exists and has unread turns (fetched via `mail/turns/list`, filtered client-side by `created_at` after last agent post), mention pending messages.

---

## Part 6: Wake and Reactivation

### Architecture: orchestrator as wake authority

The inbox is not an orchestrator — it stores messages and emits events. The dispatch orchestrator (swarm-dispatch) owns agent lifecycle and decides when to wake, extend, or re-dispatch.

```
Message arrives in dispatch thread
  |
  v
agent-inbox stores message, emits inbox.message event
  |
  v
Orchestrator receives signal (via event subscription or poll)
  |
  +---> Agent is ACTIVE (mid-dispatch)
  |       -> macro-agent: WakeManager injects/interrupts based on importance
  |       -> cc-swarm: message queued, picked up on next UserPromptSubmit hook
  |
  +---> Agent is IDLE (dispatch completed, session still alive)
  |       -> continuationPolicy returns 'continue', orchestrator schedules next turn
  |
  +---> Agent is DORMANT (session ended, inbox ID still registered)
  |       -> Orchestrator re-dispatches to same role (inbox ID is stable)
  |       -> New agent joins conversation, has full thread history
  |
  +---> Agent is EXPIRED/UNKNOWN
          -> Orchestrator treats as fresh dispatch to that role
          -> New agent joins conversation
```

### Tier 1: macro-agent (already has wake infrastructure)

macro-agent's WakeManager + TriggerSystemV2 pipeline handles message-driven wake. The work is wiring dispatch-thread messages into this pipeline with appropriate importance:

| Message type | Importance | Wake action |
|---|---|---|
| Agent-to-agent question (blocking) | `high` | Inject into active session; prompt if idle |
| Status update / FYI | `normal` | Queue for next turn |
| Orchestrator recall | `urgent` | Interrupt mid-turn |

**No new infrastructure needed.** The InboxAdapter's `onDelivery` handler already feeds into TriggerSystemV2. Dispatch-thread messages flow through the same path as any other inbox message — importance tagging is the only new concern.

#### Importance derivation for dispatch threads

The sender tags importance explicitly, or the system infers it:

```typescript
{
  to: "teamA-worker",
  body: "What's the DB schema for the users table?",
  importance: "high",
  threadTag: "dispatch-disp_abc123",
  metadata: {
    dispatch_id: "disp_abc123",
    expects_reply: true
  }
}
```

### Tier 2: cc-swarm (needs new work)

cc-swarm has no WakeManager. The dispatch orchestrator (running on the hub) drives wake externally.

#### 6a. continuationPolicy inbox check (hub-side, near-term)

The swarm-dispatch orchestrator already supports a `continuationPolicy` callback. Extend it to check for pending thread messages:

```typescript
continuationPolicy: async (task, turnCount, { reason, threadDrivenCount }) => {
  if (reason === 'completed') {
    if (threadDrivenCount >= config.continuation.maxThreadTurns) {
      return 'release';
    }
    const pending = await checkDispatchThreadPending(task.dispatchId);
    if (pending > 0) {
      return 'continue';
    }
  }
  return turnCount < config.continuation.maxTurns ? 'continue' : 'release';
}
```

`checkDispatchThreadPending` queries the coordination thread (scope `dispatch-thread`, not the delivery conversation) for unread messages.

#### 6b. Sidecar nudge command (medium-term)

Add a new sidecar command that signals "check your inbox on next turn":

```typescript
{ action: "nudge", reason: "inbox.pending", messageCount: 3, threadTag: "dispatch-disp_abc123" }
```

Sidecar writes a flag file. The `UserPromptSubmit` hook checks for the flag and prepends a context hint:

```markdown
## [MAP] Nudge: 3 pending messages in dispatch thread
You have unread messages from other agents. Check your inbox and respond before continuing.
```

Advisory only — doesn't force a new turn. Ensures the *next* turn prioritizes thread replies.

#### 6c. Claude Code turn-trigger API (long-term, external dependency)

If Claude Code exposes a programmatic "start a new turn" API, the sidecar could call it directly on nudge receipt. Not in scope — noted as a future enabler.

#### 6d. Full wake/injection (future, dependent on agent-inbox evolution)

When agent-inbox gains better wake/injection primitives, the nudge path can be upgraded to a full delivery pipeline matching macro-agent's capabilities. The `continuationPolicy` remains the primary mechanism.

### Orchestrator wake signal interface

New method on the `MessagePort` contract:

```typescript
interface MessagePort {
  // ... existing methods ...

  checkThreadPending?(dispatchId: string): Promise<{
    count: number;
    oldestUnreadAt?: string;
    participants: Array<{
      agentId: string;
      unreadCount: number;
    }>;
  }>;
}
```

Implementation in `openhive-mail-port.ts` queries the coordination thread (scope `dispatch-thread`) for unread messages, not the delivery conversation.

### Reconciliation sweep (safety net)

The orchestrator reconciliation cycle (60s) gains a thread-check pass:

```typescript
async function reconcileOrphanedThreads() {
  const activeDispatches = tracker.getActive();
  const openConversations = await getOpenDispatchConversations();

  for (const conv of openConversations) {
    const hasActiveDispatch = activeDispatches.some(d => d.taskId === conv.dispatchId);
    if (!hasActiveDispatch && conv.unreadCount > 0) {
      const presence = await messagePort.getThreadPresence?.(conv.dispatchId);
      // Route to re-dispatch, escalation, or archive based on presence
    }
  }
}
```

Catches all missed messages regardless of cause — nudge failure, session crash, sidecar timeout.

### Turn budget

Separate budgets for task work and thread coordination:

```typescript
interface ContinuationConfig {
  maxTurns: number;           // Total cap (default 20)
  maxThreadTurns: number;     // Thread-driven continuation cap (default 3)
}
```

When the thread turn cap is hit, the agent is released. Remaining unread messages are handled by the reconciliation sweep. Turn budgets are configurable and can be adjusted or removed as usage patterns emerge.

---

## Part 7: Participant Presence

### Problem

An agent posting to a dispatch thread can't determine whether the recipient will actually see the message. The sender needs signal to decide: wait for reply, escalate to orchestrator, or flag for re-dispatch.

### Proposed API: `mail/presence`

New JSON-RPC method on the agent-inbox mail server. Read-only join of conversation participants with warm registry status.

```typescript
"mail/presence": {
  params: {
    conversationId: string
  },
  result: {
    conversationId: string,
    participants: Array<{
      agent_id: string,
      role?: string,
      joined_at: string,
      presence?: "active" | "away" | "dormant" | "expired" | "unknown",
      last_active_at?: string,
      display_name?: string,
      program?: string,
      metadata?: Record<string, unknown>
    }>
  }
}
```

### IPC and MCP exposure

```typescript
// IPC command
{ action: "conversation_presence", conversationId: "conv_abc123" }

// MCP tool (optional, for agent self-service)
// Tool: check_thread_presence
// Input: { conversationId: string } or { threadTag: string }
```

### Presence semantics

| Presence | Meaning | Agent action |
|---|---|---|
| `active` | Running, will see message on next turn | Post and wait (seconds) |
| `away` | Disconnected but within grace period (60s) | Post and wait (minutes) |
| `dormant` | Intentionally paused, registered but not running | Post and signal orchestrator |
| `expired` | Past grace period, no longer routable | Post and flag for re-dispatch |
| `unknown` | Not in registry | Post and flag for fresh dispatch |

### Orchestrator presence integration

```typescript
const presence = await messagePort.getThreadPresence?.(dispatchId);
for (const p of presence?.participants ?? []) {
  if (p.unreadCount > 0 && p.presence === 'dormant') {
    await scheduleWakeForRole(p.agent_id, dispatchId);
  }
  if (p.unreadCount > 0 && (p.presence === 'expired' || p.presence === 'unknown')) {
    await queueRedispatchForRole(p.role, dispatchId);
  }
}
```

---

## Part 8: Orchestrator Integration

### Event bridge

| Event | Thread action |
|---|---|
| `dispatched` | None (lazy creation) |
| `continuing` | If thread exists: fetch turns, check for unread, mention in continuation prompt |
| `retrying` | If thread exists: `mail/invite` new agent with `role: 'executor'`, post system turn with failure context |
| `completed` / `dead` / `cancelled` | No conversation update — dispatch row is the status source of truth |

On retry, the system turn gives the new agent context:

```
System: Retry attempt 2: previous agent failed with {error}
```

### continuationPolicy integration

The `continuationPolicy` checks the coordination thread (not the delivery conversation) before releasing:

```typescript
continuationPolicy: async (task, turnCount, { reason, threadDrivenCount }) => {
  if (reason === 'completed') {
    if (threadDrivenCount >= config.continuation.maxThreadTurns) return 'release';
    const pending = await messagePort.checkThreadPending?.(task.dispatchId);
    if (pending?.count > 0) return 'continue';
  }
  return turnCount < config.continuation.maxTurns ? 'continue' : 'release';
}
```

---

## Part 9: Surface Integration

### OpenTasks

**Feedback vs threads**: complementary, not overlapping.

- **Thread**: real-time, dispatch-scoped coordination ("I need an answer to continue").
- **Feedback**: durable, task-scoped observations ("this spec is ambiguous about X for future reference").

Threads don't create feedback automatically. The dispatch prompt tells the agent: if a thread conversation resolves something lasting about the spec or task, leave opentasks feedback so future dispatches benefit.

### git-cascade

Cascade events (merges, task auto-close, commit ranges) are **independent from the thread**. They are not posted as turns. The dispatch detail page already renders cascade data in its "Changes Opened" section. If agents later want merge notifications in their inbox, a cascade-to-thread bridge is additive.

### Sessions / trajectories

Session chat (`POST /sessions/:id/chat`) and dispatch threads are **separate conversations**:

- **Session chat**: about a specific session's trajectory ("why did you choose this approach?")
- **Dispatch thread**: about the dispatch's work unit ("should I use cursor pagination?")

A dispatch can span multiple sessions (retries). The thread spans all of them; session chat is per-session.

### MAP

Agents post via the three capability-dependent paths defined in Part 4. The hub needs a handler for `x-dispatch/thread` scope messages — intercept in `ws-map.ts` and route to `ensureDispatchConversation`.

### UI surfaces (deferred)

- **Dispatch detail page**: thread section inline (swarmcraft `ChatMessageList` + `ChatInput`). If no conversation: muted text "No coordination thread."
- **Task detail**: `dispatch_threads` as a list of links to dispatch detail thread sections.
- **Threads list** (`/threads`): dispatch threads with `scope: dispatch-thread` filter.
- **Dashboard**: "threads needing attention" indicator for unread turns where current user is initiator.

---

## Usage Flows

### Flow 1: Silent dispatch (no interaction)

```
1. Agent dispatched, receives prompt with coordination section
2. Agent completes work without needing input
3. No conversation created — zero overhead
```

### Flow 2: Agent hits a blocker

```
1. Agent dispatched, receives prompt with coordination section
2. Agent encounters ambiguous spec
3. Agent posts: "The spec says 'support pagination' but doesn't specify
   cursor vs offset. Which approach should I use?"
4. Hub: ensureDispatchConversation() → creates conversation, adds participants,
   writes backreferences
5. Hub: mail/turn with agent's message
6. Initiator (user): sees thread appear on dispatch detail page, replies
7. Agent: picks up reply on next UserPromptSubmit, continues work
```

### Flow 3: Dispatch fails, retried to different agent

```
1. Agent A dispatched, posts question to thread, gets answer, but fails
2. Orchestrator retries → agent B assigned
3. Hub: adds agent B as participant to existing conversation
4. Hub: adds system turn "Retry attempt 2: agent A failed with {error}"
5. Agent B: prompt includes coordination section; on first inbox pull,
   sees full conversation history (A's question, initiator's answer, failure)
6. Agent B: picks up where A left off with full context
```

### Flow 4: User intervenes mid-dispatch

```
1. User dispatched spec from UI, agent is working
2. User realizes a requirement changed
3. User opens dispatch detail page, types in thread input
4. Hub: ensureDispatchConversation() (triggered by user, not agent)
5. Hub: mail/turn with user's message
6. Agent: picks up user message on next UserPromptSubmit
7. Agent: adjusts approach based on new information
```

### Flow 5: Cross-dispatch coordination

```
1. Agent A on dispatch-1 (task: "build API") is working
2. Agent B on dispatch-2 (task: "build frontend") needs to know the API schema
3. Agent B posts to agent A's inbox: importance=high, cross_dispatch=true
4. Agent A picks up on next turn, replies with schema details
5. Agent B continues work with the answer
```

---

## Implementation Phases

### Phase 1: Identity unification
- Unify cc-swarm MAP and inbox agent IDs
- Add `inboxAgentId` to MAP registration metadata
- Add `resolveInboxAgentId()` to hub connection registry
- **Risk**: Low. Backward-compatible (metadata field, fallback to MAP ID).

### Phase 2: Schema + conversation factory (foundation)
- Migration: add nullable `conversation_id TEXT` to `dispatches` table
- New file `src/dispatch/dispatch-conversation.ts`: `ensureDispatchConversation()`
- **Risk**: Low. Uses existing agent-inbox mail RPC.

### Phase 3: Prompt injection + message routing
- Coordination section in dispatch prompt (first-run, retry, continuation)
- MAP scope message handler for `x-dispatch/thread` in `ws-map.ts`
- REST endpoint `POST /dispatches/:id/thread/turns`
- WS broadcast for thread turns on `map:dispatches` channel
- **Risk**: Low. Thin routing layer over existing infrastructure.

### Phase 4: Orchestrator lifecycle integration
- Retry participant handoff: `mail/invite` + system turn
- Continuation thread check: fetch turns, inject into continuation prompt
- **Risk**: Low. Event bridge additions to existing handlers.

### Phase 5: Participant presence
- `mail/presence` on agent-inbox JSON-RPC
- `conversation_presence` IPC command
- Optional: MCP tool for agent self-service
- **Risk**: Low. Read-only join of existing data.

### Phase 6: Orchestrator wake signal
- `checkThreadPending` on swarm-dispatch `MessagePort` interface
- `continuationPolicy` with inbox check + thread turn budget
- `threadDrivenCount` tracking in dispatch tracker
- `reconcileOrphanedThreads` in reconciliation cycle
- **Risk**: Medium. Changes orchestrator completion flow. Thread turn budget guards against infinite loops.

### Phase 7: cc-swarm sidecar nudge
- `nudge` command in sidecar server
- Nudge flag check in `UserPromptSubmit` hook
- Hub sends nudge via MAP notification
- **Risk**: Medium. Advisory only. Upgradeable when agent-inbox gains push primitives.

### Phase 8: macro-agent importance mapping
- Importance derivation rules for dispatch thread messages
- Wire through existing TriggerSystemV2 pipeline
- **Risk**: Low. Existing infrastructure, new routing rules.

### Phase 9: Thread lifecycle hooks
- `mail/reopen` on agent-inbox
- Thread close on task completion (alongside cascade task-binder)
- Thread reopen on task reopen
- TTL-based orphaned thread sweep (30 day default)
- **Risk**: Low. Thin wiring over existing event listeners.

### Phase 10: UI (deferred)
- Dispatch detail thread section
- Task megathread links
- Threads list filter
- Dashboard indicator

**Minimum viable feature**: Phases 1–3. An agent can post to its dispatch thread, the hub lazily creates the conversation, and the initiator receives the message.

---

## Resolved Design Decisions

### D1: One conversation per dispatch
Dispatches are the unit of orchestrated work. Per-task would mix unrelated dispatch attempts. The megathread view is a query over task backreferences.

### D2: Lazy creation on first message
Silent dispatches produce no conversation. The dispatch prompt advertises the channel without creating it. The `continuationPolicy` and `checkThreadPending` naturally handle the "no conversation exists" case by returning `{ count: 0 }`.

### D3: Initiator is a participant
User-initiated dispatches add the user; agent-initiated dispatches add the originating agent. This is the core value prop — the channel reaches back to whoever started the dispatch.

### D4: Retry agents join the existing conversation
Same `dispatch_id` = same conversation. New agent added as participant on retry. Full history visible. System turn provides failure context.

### D5: Thread lifetime — archive on task completion
Threads stay `active` as long as the task is open, allowing post-dispatch follow-up and multi-dispatch continuity. A 30-day TTL sweep handles orphaned threads where tasks never close. `mail/reopen` handles reopened tasks.

**Tradeoffs**: Threads accumulate if tasks stay open indefinitely. The TTL sweep mitigates this, and `last_active_at` on the conversation lets agents judge relevance of stale threads. Alternative (archive on dispatch completion) rejected because it cuts off the most valuable coordination window.

### D6: Separate threads per dispatch for cross-dispatch coordination
Cross-dispatch coordination uses targeted agent-inbox messaging with `metadata.cross_dispatch: true` and source tracing. No shared threads — avoids permission/scope confusion from mixed loadouts.

### D7: Continuation loop guard — separate thread turn budget
`maxThreadTurns` (default 3) alongside `maxTurns` (default 20). Thread-driven continuations capped independently. On cap hit, agent released; reconciliation sweep handles remaining unread. Budgets configurable and removable as usage patterns emerge.

### D8: Nudge is advisory
`continuationPolicy` inbox check is the primary wake mechanism. Sidecar nudge reduces latency in the happy path but is not a delivery guarantee. Reconciliation sweep (60s) is the safety net. Full push delivery is a future enhancement.

### D9: Coordinators are thread participants, not subagents
Subagents report to their coordinator, who surfaces relevant information in the dispatch thread. cc-swarm native teammates have stable IDs and can participate directly. Direct subagent access deferred.

### D10: Conversation metadata carries full dispatch context
`dispatch_id`, `spec_id`, `spec_resource_id`, `target_swarm_id`, `linked_tasks[]`, `initiator`. Enables filtering, discovery, and megathread queries without joining to the dispatch table.

---

## Open Questions

| # | Question | Leaning | Notes |
|---|----------|---------|-------|
| Q1 | Should system turns (retry notices, terminal status) be automatic? | Yes, lightweight | Gives retry agents context without requiring them to query dispatch status. Keep it terse. |
| Q2 | How does the agent address the thread without agent-inbox MCP tools? | MAP scope message fallback | Hub intercepts `x-dispatch/thread` scope messages and routes to conversation. |
| Q3 | Message format: plain text or structured envelope? | Plain text turns, structured metadata | Agent posts natural language. Metadata on the turn carries structured context for programmatic consumers. |
| Q4 | Rate limiting on thread messages? | Defer | Performative posting discouraged by prompt design. Add per-dispatch turn limit if agents spam threads. |
| Q5 | Should the megathread view be a dedicated page or inline? | Inline first | List of thread links on task detail is sufficient for v1. |

---

## Migration

- New column `dispatches.conversation_id` (nullable TEXT) — schema migration.
- Existing dispatches get no conversation (correct — they completed without one).
- Task resource `metadata.dispatch_threads` is additive.
- No changes to agent-inbox schema — uses existing conversation/turn/participant primitives.
- Agent ID unification is backward-compatible (metadata field, fallback to MAP ID).

## Dependencies

- **Agent-inbox mail RPC** (`mail/create`, `mail/turn`, `mail/join`, `mail/invite`, `mail/turns/list`) — exists today.
- **Agent-inbox new methods** — `mail/presence` (Phase 5), `mail/reopen` (Phase 9).
- **Dispatch prompt builder** (`src/dispatch/prompt.ts`) — needs coordination section.
- **Dispatch orchestrator events** (`src/dispatch/setup.ts`) — needs participant management + system turns.
- **swarm-dispatch `MessagePort`** — needs `checkThreadPending` extension (Phase 6).
- **WebSocket broadcast** — needs thread turn events on `map:dispatches` channel.
- **cc-swarm inbox pull** — works as-is for basic flow; nudge is Phase 7.

## Future Work (out of scope)

- **Cross-dispatch discovery** — agent queries "what other dispatches exist for tasks that block mine?" and reads their threads. The `dispatch_threads` backreference index supports this.
- **Thread-aware dispatch scoring** — orchestrator considers unresolved thread questions when scoring dispatch readiness.
- **Conversation-to-opentasks feedback bridge** — resolved thread Q&A automatically becomes opentasks feedback.
- **Cascade-to-thread bridge** — cascade merge events posted as system turns for agents wanting notifications in their inbox.
