---
status: draft
owner: alexngai
created: 2026-05-08
parent: docs/design/dispatch-inbox-threads.md
---

# Dispatch Inbox Threads — Implementation Plan

Detailed implementation guide for the design spec in
[dispatch-inbox-threads.md](./dispatch-inbox-threads.md). Organized by phase
with per-file change lists, code sketches, test strategies, and dependency
ordering.

**Minimum viable**: Phases 1-3 deliver the core loop — agents can post to
dispatch threads, the hub lazily creates conversations, and initiators receive
messages.

---

## Phase 1: Identity Unification

**Goal**: cc-swarm agents register with MAP using their stable inbox ID so the
hub can correlate MAP agents with inbox participants.

### 1.1 cc-swarm: unified agent ID

**File**: `references/claude-code-swarm/src/bootstrap.mjs`

Find the spawn command where `agentId` is set to `sessionId`. Change to use
the inbox-derived ID:

```javascript
// Current (split identity):
//   agentId: sessionId
// New (unified):
//   agentId: `${teamName}-main`
//   metadata.sessionId preserved for trajectory correlation

const inboxAgentId = `${teamName}-main`;
sendCommand(config, {
  action: "spawn",
  agent: {
    agentId: inboxAgentId,
    name: inboxAgentId,
    metadata: {
      sessionId,
      inboxAgentId,
      // ... existing metadata
    },
  },
}, sessionId);
```

Same pattern for teammates: `${teamName}-${role}`.

**File**: `references/claude-code-swarm/src/map-events.mjs`

Update `buildSubagentSpawnCommand` and `handleTeammateIdle` to derive IDs
consistently from the inbox pattern.

### 1.2 Hub-side resolution helper

**File**: `src/map/connection-registry.ts`

Add after existing helpers (`findAcpAgent`, `findSidecarAgentId`):

```typescript
/**
 * Resolve a MAP agent ID to its canonical inbox agent ID.
 * Falls back to the MAP ID when metadata.inboxAgentId is absent
 * (backward compat with pre-unification agents).
 */
export function resolveInboxAgentId(
  swarmId: string,
  mapAgentId: string,
): string {
  const conn = getInbound(swarmId);
  if (!conn) return mapAgentId;
  const agent = conn.registeredAgents.get(mapAgentId);
  const inbox = agent?.metadata?.inboxAgentId;
  return typeof inbox === 'string' ? inbox : mapAgentId;
}
```

### 1.3 Tests

- **Unit**: `src/__tests__/map/resolve-inbox-agent-id.test.ts`
  - Agent with `inboxAgentId` metadata returns it
  - Agent without metadata falls back to MAP ID
  - Unknown swarm/agent returns MAP ID
- **Integration**: Update existing MAP registration tests to verify `inboxAgentId`
  metadata flows through

### 1.4 Migration risk

None. The `inboxAgentId` metadata field is additive. Agents without it continue
to work via the fallback. No database migration required.

---

## Phase 2: Schema + Conversation Factory

**Goal**: The `dispatches` table gains a `conversation_id` column and a factory
function can lazily create dispatch conversations via agent-inbox mail RPC.

### 2.1 Database migration (V52)

**File**: `src/db/schema.ts`

```typescript
export const SCHEMA_VERSION = 52; // bump from 51

export const MIGRATION_V52_DISPATCH_CONVERSATION = `
  ALTER TABLE dispatches ADD COLUMN conversation_id TEXT;
`;
```

Add to the migration runner array and `repairSchema` (follow V49 pattern).

**File**: `src/db/dal/dispatches.ts`

Add `conversation_id` to:
- `Dispatch` interface (nullable `string | null`)
- `DispatchRow` interface
- `rowToDispatch()` mapping
- No change to `createDispatch()` — column is nullable, written on lazy creation

New DAL helper:

```typescript
export function setDispatchConversationId(
  id: string,
  conversationId: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE dispatches
       SET conversation_id = ?, updated_at = datetime('now')
     WHERE id = ? AND conversation_id IS NULL`,
  ).run(conversationId, id);
}
```

Idempotent — no-ops if already set.

### 2.2 Conversation factory

**New file**: `src/dispatch/dispatch-conversation.ts`

```typescript
import * as dispatchesDAL from '../db/dal/dispatches.js';

export interface DispatchConversationOpts {
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

/**
 * Idempotent conversation factory for dispatch threads.
 *
 * If the dispatch already has a conversation_id, returns it immediately.
 * Otherwise creates via mail/create, adds participants, writes the
 * conversation_id back to the dispatch row, and appends backreferences
 * to linked task resources.
 */
export async function ensureDispatchConversation(
  opts: DispatchConversationOpts,
  deps: { mailRpc: MailJsonRpcLike },
): Promise<string> {
  // 1. Check if already created
  const dispatch = dispatchesDAL.findDispatchById(opts.dispatchId);
  if (dispatch?.conversation_id) return dispatch.conversation_id;

  const conversationId = `dispatch-conv-${opts.dispatchId}`;

  // 2. Create conversation via mail/create
  await deps.mailRpc.call('mail/create', {
    id: conversationId,
    scope: 'dispatch-thread',
    subject: `Dispatch: ${opts.specTitle} → ${opts.swarmName}`,
    metadata: {
      source: 'dispatch-thread',
      dispatch_id: opts.dispatchId,
      spec_id: opts.specId,
      spec_resource_id: opts.specResourceId,
      target_swarm_id: opts.targetSwarmId,
      linked_tasks: opts.linkedTasks,
      initiator: opts.initiator,
    },
  });

  // 3. Add participants
  await deps.mailRpc.call('mail/invite', {
    conversationId,
    agentId: opts.initiator.id,
    role: 'initiator',
  });
  await deps.mailRpc.call('mail/invite', {
    conversationId,
    agentId: opts.executorAgentId,
    role: 'executor',
  });

  // 4. Write back to dispatch row
  dispatchesDAL.setDispatchConversationId(opts.dispatchId, conversationId);

  // 5. Append backreference to linked task resources (best-effort)
  for (const task of opts.linkedTasks) {
    try {
      appendDispatchThreadRef(task.resource_id, {
        dispatch_id: opts.dispatchId,
        conversation_id: conversationId,
        target_swarm_id: opts.targetSwarmId,
        created_at: new Date().toISOString(),
        status: 'active',
      });
    } catch {
      // best-effort — task resource may not exist locally
    }
  }

  return conversationId;
}
```

### 2.3 Tests

- **Unit**: `src/__tests__/dispatch/dispatch-conversation.test.ts`
  - Creates conversation on first call, returns same ID on second call
  - Participants added with correct roles
  - `conversation_id` written to dispatch row
  - Idempotent when called concurrently (simulated)
- **DAL**: `src/__tests__/dal/dispatches-conversation.test.ts`
  - `setDispatchConversationId` is idempotent
  - `conversation_id` appears in `findDispatchById` and `listDispatches`

### 2.4 Dependencies

- Agent-inbox `mail/create`, `mail/invite` — exist today
- V52 migration must run before factory is called

---

## Phase 3: Prompt Injection + Message Routing

**Goal**: Dispatched agents know about the coordination channel and can post to
it. Users can post from the UI. Messages route correctly.

### 3.1 Prompt builder coordination section

**File**: `src/dispatch/prompt.ts`

#### First-run prompt (insert after `additionalContext`, before MCP expectations)

After line 88 (`hints.additionalContext` block), before line 92 (MCP
expectations):

```typescript
// Coordination channel (dispatch thread)
const dispatchId = task.id;
const initiatorType = meta.initiator?.type ?? 'unknown';
const initiatorId = meta.initiator?.id ?? 'unknown';
const linkedTaskTitles = (meta.linkedTasks as Array<{ title?: string }>)
  ?.map(t => t.title)
  .filter(Boolean)
  .join(', ') || 'none';

lines.push('');
lines.push('## Coordination');
lines.push('');
lines.push('A dispatch thread is available for this work. If you need');
lines.push('clarification, hit a blocker, or want input from the dispatch');
lines.push('initiator, post a message.');
lines.push('');
lines.push(`  Thread: dispatch-${dispatchId}`);
lines.push(`  Initiator: ${initiatorType} ${initiatorId}`);
lines.push(`  Linked tasks: ${linkedTaskTitles}`);
lines.push('');
lines.push('To post, use the agent-inbox send_message tool with');
lines.push(`thread_tag "dispatch-${dispatchId}".`);
lines.push('The thread will be created on your first message.');
```

#### Retry prompt (after error banner, line 49)

```typescript
if (meta.conversation_id) {
  lines.push(`> Prior conversation history is available in thread dispatch-${task.id}.`);
  lines.push('');
}
```

#### Continuation prompt (replace lines 35-41)

```typescript
if (context.turnCount > 0) {
  lines.push(`Continue work on dispatch ${task.id} (turn ${context.turnCount + 1}).`);
  lines.push('Re-check progress against the original task and proceed.');

  // Check for pending thread messages (conversation_id present = thread exists)
  if (meta.conversation_id && meta.pendingThreadMessages) {
    lines.push('');
    lines.push(`You have ${meta.pendingThreadMessages} unread message(s) in the`);
    lines.push(`dispatch thread. Check and respond before continuing work.`);
  }

  lines.push('');
  lines.push(`Role: ${context.role}`);
  return lines.join('\n');
}
```

### 3.2 MAP scope message handler

**File**: `src/map/ws-map.ts`

Add to the notification interceptor chain (alongside existing `isMapTaskEvent`,
`isMapContextEvent` handlers):

```typescript
// Handle dispatch thread messages from agents without inbox MCP tools
if (
  typeof msg.method === 'string' &&
  msg.method === 'x-dispatch/thread'
) {
  const params = msg.params as {
    dispatch_id?: string;
    content?: string;
    sender_agent_id?: string;
  };
  if (params.dispatch_id && params.content) {
    handleDispatchThreadMessage(params, swarmId).catch((err) => {
      logger.error('[ws-map] x-dispatch/thread error:', err);
    });
  }
  // Don't return — let MAPServer handle routing too if needed
}
```

New handler function:

```typescript
async function handleDispatchThreadMessage(
  params: { dispatch_id: string; content: string; sender_agent_id?: string },
  swarmId: string,
): Promise<void> {
  const dispatch = dispatchesDAL.findDispatchById(params.dispatch_id);
  if (!dispatch) return;

  const senderAgentId = params.sender_agent_id
    ?? resolveInboxAgentId(swarmId, /* mapAgentId from connection */);

  // Lazy-create conversation if needed
  const conversationId = await ensureDispatchConversation({
    dispatchId: dispatch.id,
    specId: dispatch.spec_id,
    specResourceId: dispatch.spec_resource_id,
    specTitle: /* fetch from spec */,
    targetSwarmId: dispatch.target_swarm_id,
    swarmName: /* fetch from swarm registry */,
    linkedTasks: dispatchesDAL.getDispatchLinkedTasks(dispatch.id),
    initiator: { type: dispatch.initiator_type, id: dispatch.initiator_id },
    executorAgentId: senderAgentId,
  }, { mailRpc });

  // Add turn
  await mailRpc.call('mail/turn', {
    conversationId,
    agentId: senderAgentId,
    content: params.content,
    contentType: 'text',
  });

  // Broadcast to WS subscribers
  broadcastToChannel('map:dispatches', {
    type: 'dispatch.thread.turn',
    data: {
      dispatch_id: dispatch.id,
      conversation_id: conversationId,
      sender: senderAgentId,
    },
    timestamp: new Date().toISOString(),
  });
}
```

### 3.3 REST endpoint for user posting

**File**: `src/api/routes/dispatches.ts`

Add after the cancel endpoint:

```typescript
/**
 * POST /dispatches/:id/thread/turns
 *
 * User posts a message to the dispatch coordination thread.
 * Lazily creates the conversation if needed.
 */
fastify.post<{
  Params: { id: string };
  Body: { content: string };
}>('/dispatches/:id/thread/turns', {
  preHandler: authOrAdminKey,
  schema: {
    params: z.object({ id: z.string() }),
    body: z.object({ content: z.string().min(1).max(10000) }),
  },
}, async (request, reply) => {
  const dispatch = dispatchesDAL.findDispatchById(request.params.id);
  if (!dispatch) {
    return reply.status(404).send({ error: 'Dispatch not found' });
  }
  if (dispatch.status === 'cancelled') {
    return reply.status(409).send({ error: 'Dispatch is cancelled' });
  }

  // Resolve user identity for participant
  const userId = request.user?.id ?? 'user:unknown';

  const conversationId = await ensureDispatchConversation({
    dispatchId: dispatch.id,
    /* ... fill from dispatch + spec lookup ... */
    initiator: { type: dispatch.initiator_type, id: dispatch.initiator_id },
    executorAgentId: /* resolve from current attempt's agent_id */,
  }, { mailRpc });

  await mailRpc.call('mail/turn', {
    conversationId,
    agentId: userId,
    content: request.body.content,
    contentType: 'text',
  });

  broadcastToChannel('map:dispatches', {
    type: 'dispatch.thread.turn',
    data: {
      dispatch_id: dispatch.id,
      conversation_id: conversationId,
      sender: userId,
    },
    timestamp: new Date().toISOString(),
  });

  return reply.status(201).send({
    conversation_id: conversationId,
    dispatch_id: dispatch.id,
  });
});
```

### 3.4 WS broadcast wiring

**File**: `src/server.ts` (or `src/realtime/index.ts`)

Subscribe to `mail.turn.added` events and filter for `dispatch-thread` scope:

```typescript
mailEvents.on('mail.turn.added', (event) => {
  if (event.conversation?.scope !== 'dispatch-thread') return;
  const dispatchId = event.conversation.metadata?.dispatch_id;
  if (!dispatchId) return;

  broadcastToChannel('map:dispatches', {
    type: 'dispatch.thread.turn',
    data: {
      dispatch_id: dispatchId,
      conversation_id: event.conversation.id,
      turn: {
        id: event.turn.id,
        sender: event.turn.agentId,
        content_preview: event.turn.content?.substring(0, 200),
        created_at: event.turn.created_at,
      },
    },
    timestamp: new Date().toISOString(),
  });
});
```

### 3.5 Tests

- **Unit**: `src/__tests__/dispatch/prompt-coordination.test.ts`
  - First-run prompt includes coordination section
  - Retry prompt mentions existing conversation
  - Continuation prompt includes pending message count
  - No coordination section when dispatch has no metadata
- **Integration**: `src/__tests__/dispatch/dispatch-thread-routing.test.ts`
  - Agent posts via inbox tools → turn appears on conversation
  - Agent posts via MAP scope message → hub creates conversation, adds turn
  - User posts via REST → turn appears, WS event broadcast
  - Concurrent first-message from agent and user → single conversation created
- **E2E** (gated by `LIVE_AGENT_E2E=true`): extend existing live dispatch tests
  to verify thread creation

### 3.6 Dependencies

- Phase 2 (conversation factory, V52 migration)
- Phase 1 (identity unification) — needed for correct `executorAgentId`

---

## Phase 4: Orchestrator Lifecycle Integration

**Goal**: The event bridge in `setup.ts` manages thread participants across
retries and injects thread context into continuation prompts.

### 4.1 Retry participant handoff

**File**: `src/dispatch/setup.ts`

In the `retrying` event handler (line 183), after the existing attempt
history update:

```typescript
if (event.type === 'retrying') {
  // ... existing attempt history logic ...

  // If a conversation exists, post a system turn for the retry
  const dispatch = dispatchesDAL.findDispatchById(event.taskId);
  if (dispatch?.conversation_id) {
    try {
      const error = 'error' in event ? (event as { error?: string }).error : undefined;
      await mailRpc.call('mail/turn', {
        conversationId: dispatch.conversation_id,
        agentId: 'system:dispatch-orchestrator',
        content: `Retry attempt ${attempt}: previous attempt failed${error ? ` with: ${error}` : '.'}`,
        contentType: 'text',
        metadata: { system: true, attempt },
      });
    } catch { /* best-effort */ }
  }
}
```

### 4.2 New agent joins on dispatched event

In the `dispatched` event handler (line 98), after delivery tracking:

```typescript
if (event.type === 'dispatched') {
  // ... existing delivery tracking ...

  // If a conversation exists and this is a retry, invite the new agent
  const dispatch = dispatchesDAL.findDispatchById(event.taskId);
  if (dispatch?.conversation_id && attempt > 1) {
    const agentId = eventDispatched.agentId ?? hint?.agent_id;
    if (agentId) {
      const inboxId = resolveInboxAgentId(dispatch.target_swarm_id, agentId);
      try {
        await mailRpc.call('mail/invite', {
          conversationId: dispatch.conversation_id,
          agentId: inboxId,
          role: 'executor',
        });
      } catch { /* best-effort — may already be participant */ }
    }
  }
}
```

### 4.3 Continuation thread check

The orchestrator's source adapter needs to enrich continuation context with
pending thread messages. This happens in `openhive-source.ts` during task
enrichment.

**File**: `src/dispatch/openhive-source.ts`

In the enrichment phase, after loadout materialization:

```typescript
// Enrich with pending thread messages for continuation prompts
if (task.metadata?.conversation_id) {
  try {
    const turns = await mailRpc.call('mail/turns/list', {
      conversationId: task.metadata.conversation_id,
    });
    // Count turns after the last agent post
    const agentId = /* current executor */;
    const lastAgentTurn = turns.filter(t => t.agentId === agentId).pop();
    const pending = lastAgentTurn
      ? turns.filter(t => t.created_at > lastAgentTurn.created_at).length
      : turns.length;
    task.metadata.pendingThreadMessages = pending;
  } catch { /* non-critical */ }
}
```

### 4.4 Tests

- **Unit**: `src/__tests__/dispatch/event-bridge-threads.test.ts`
  - `retrying` event posts system turn to existing conversation
  - `dispatched` event on attempt > 1 invites new agent
  - No action when `conversation_id` is null
- **Integration**: `src/__tests__/dispatch/continuation-thread-check.test.ts`
  - Continuation enrichment counts pending messages correctly
  - Zero pending when no conversation exists

---

## Phase 5: Participant Presence

**Goal**: Agents and the orchestrator can query who's online in a dispatch
thread.

### 5.1 agent-inbox `mail/presence` method

**File**: `references/agent-inbox/src/jsonrpc/mail-server.ts`

Add after `mail/replay` handler:

```typescript
this.methods.set('mail/presence', (params) => {
  const conversationId = params.conversationId as string;
  if (!conversationId) throw rpcError(-32602, 'conversationId required');

  const conv = this.storage.getConversation(conversationId);
  if (!conv) throw rpcError(-32001, 'Conversation not found');

  const participants = (conv.participants ?? []).map((p) => {
    const status = this.registry?.getStatus(p.agent_id) ?? 'unknown';
    const entry = this.registry?.getEntry?.(p.agent_id);
    return {
      agent_id: p.agent_id,
      role: p.role,
      joined_at: p.joined_at,
      presence: status,
      last_active_at: entry?.lastActiveAt,
      display_name: entry?.displayName,
    };
  });

  return { conversationId, participants };
});
```

### 5.2 IPC command

**File**: `references/agent-inbox/src/ipc/ipc-server.ts` (or equivalent)

```typescript
case 'conversation_presence': {
  const result = await mailServer.handleRequest({
    jsonrpc: '2.0', id: 1,
    method: 'mail/presence',
    params: { conversationId: cmd.conversationId },
  });
  return result;
}
```

### 5.3 Tests

- **Unit**: `src/__tests__/agent-inbox/mail-presence.test.ts`
  - Returns participants with presence from warm registry
  - Unknown agents return `presence: 'unknown'`
  - Non-existent conversation returns error

---

## Phase 6: Orchestrator Wake Signal

**Goal**: The orchestrator can detect pending thread messages and extend agent
turns to handle them. Safety-netted by reconciliation.

### 6.1 `checkThreadPending` on MessagePort

**File**: `references/swarm-dispatch/src/types.ts`

Add optional method to `MessagePort`:

```typescript
export interface MessagePort {
  // ... existing methods ...

  /**
   * Check for pending messages in a dispatch's coordination thread.
   * Returns null if thread tracking is unavailable.
   */
  checkThreadPending?(dispatchId: string): Promise<{
    count: number;
    oldestUnreadAt?: string;
    participants: Array<{
      agentId: string;
      unreadCount: number;
    }>;
  } | null>;
}
```

### 6.2 Implementation in openhive-mail-port

**File**: `src/dispatch/openhive-mail-port.ts`

Add to the returned object from `createOpenHiveMailPort`:

```typescript
checkThreadPending: async (dispatchId: string) => {
  const dispatch = dispatchesDAL.findDispatchById(dispatchId);
  if (!dispatch?.conversation_id) return null;

  try {
    const turns = await mailRpc.call('mail/turns/list', {
      conversationId: dispatch.conversation_id,
    });

    // Find current executor from latest attempt
    const currentAttempt = dispatch.attempts_history
      .filter(a => a.status === 'running')
      .pop();
    const executorId = currentAttempt?.agent_id;
    if (!executorId) return { count: 0, participants: [] };

    const inboxId = resolveInboxAgentId(
      dispatch.target_swarm_id, executorId,
    );

    // Count turns the executor hasn't seen
    const lastExecutorTurn = turns
      .filter((t: any) => t.agentId === inboxId)
      .pop();
    const unread = lastExecutorTurn
      ? turns.filter((t: any) => t.created_at > lastExecutorTurn.created_at)
      : turns;

    return {
      count: unread.length,
      oldestUnreadAt: unread[0]?.created_at,
      participants: [{ agentId: inboxId, unreadCount: unread.length }],
    };
  } catch {
    return null;
  }
},
```

### 6.3 continuationPolicy with thread check

**File**: `src/dispatch/setup.ts`

The orchestrator config (line 63) currently has:

```typescript
continuation: { delayMs: 1_000, maxTurns: 20 },
```

Extend with thread-aware policy. This requires adding `continuationPolicy`
to the orchestrator config — check if `swarm-dispatch` supports it, or wire
it through the existing `continuation` config:

```typescript
continuation: {
  delayMs: 1_000,
  maxTurns: cfg?.continuation?.maxTurns ?? 20,
  maxThreadTurns: cfg?.continuation?.maxThreadTurns ?? 3,
  policy: async (task, turnCount, context) => {
    // Standard turn budget
    if (turnCount >= (cfg?.continuation?.maxTurns ?? 20)) return 'release';

    // Thread-driven continuation check
    if (context?.reason === 'completed' && opts.messagePort?.checkThreadPending) {
      const threadTurns = context?.threadDrivenCount ?? 0;
      if (threadTurns >= (cfg?.continuation?.maxThreadTurns ?? 3)) {
        return 'release';
      }
      const pending = await opts.messagePort.checkThreadPending(task.id);
      if (pending && pending.count > 0) {
        return 'continue';
      }
    }

    return turnCount < (cfg?.continuation?.maxTurns ?? 20) ? 'continue' : 'release';
  },
},
```

### 6.4 Thread turn tracking

**File**: `src/dispatch/delivery-tracker.ts` (or new side-channel)

Track thread-driven continuation count per dispatch:

```typescript
const threadDrivenCounts = new Map<string, number>();

export function incrementThreadDrivenCount(taskId: string): number {
  const current = threadDrivenCounts.get(taskId) ?? 0;
  const next = current + 1;
  threadDrivenCounts.set(taskId, next);
  return next;
}

export function getThreadDrivenCount(taskId: string): number {
  return threadDrivenCounts.get(taskId) ?? 0;
}

export function clearThreadDrivenCount(taskId: string): void {
  threadDrivenCounts.delete(taskId);
}
```

### 6.5 Reconciliation sweep

**File**: `src/dispatch/setup.ts`

Add to the reconciliation cycle. The orchestrator already reconciles every 5s
(line 76). Add a thread orphan check on a slower cadence (60s):

```typescript
// In the event bridge, after existing reconciliation logic:
let lastThreadReconcile = 0;
const THREAD_RECONCILE_INTERVAL = 60_000;

// Inside the reconcile tick (or as a separate setInterval):
if (Date.now() - lastThreadReconcile > THREAD_RECONCILE_INTERVAL) {
  lastThreadReconcile = Date.now();
  reconcileOrphanedThreads(orchestrator, opts.messagePort).catch(() => {});
}
```

New function:

```typescript
async function reconcileOrphanedThreads(
  orchestrator: Orchestrator,
  messagePort?: MessagePort,
): Promise<void> {
  if (!messagePort?.checkThreadPending) return;

  // Find dispatches with conversations that are in terminal state
  const dispatches = dispatchesDAL.listDispatches({
    status: ['complete', 'failed'],
  });

  for (const d of dispatches.data) {
    if (!d.conversation_id) continue;
    const pending = await messagePort.checkThreadPending(d.id);
    if (pending && pending.count > 0) {
      // Log for now; future: escalate or re-dispatch
      logger.warn(
        `[reconcile] Dispatch ${d.id} has ${pending.count} unread thread messages post-terminal`,
      );
    }
  }
}
```

### 6.6 Config surface

**File**: `src/config.ts`

Add to `dispatch` config section:

```typescript
continuation: z.object({
  maxTurns: z.number().default(20),
  maxThreadTurns: z.number().default(3),
}).default({}),
```

### 6.7 Tests

- **Unit**: `src/__tests__/dispatch/thread-wake-signal.test.ts`
  - `checkThreadPending` returns count from conversation turns
  - Returns null when no conversation exists
  - `continuationPolicy` returns `'continue'` when pending > 0
  - `continuationPolicy` returns `'release'` when thread budget exhausted
- **Unit**: `src/__tests__/dispatch/thread-reconciliation.test.ts`
  - Orphaned threads with unread messages are detected
  - Terminal dispatches without conversations are skipped

---

## Phase 7: cc-swarm Sidecar Nudge

**Goal**: When thread messages arrive for a cc-swarm agent, the hub sends an
advisory nudge so the agent prioritizes inbox check on next turn.

### 7.1 Nudge command

**File**: `references/claude-code-swarm/src/sidecar-server.mjs` (or equivalent)

New command handler:

```javascript
case 'nudge': {
  const { reason, messageCount, threadTag } = cmd;
  // Write flag file for UserPromptSubmit hook
  const nudgePath = path.join(swarmDir, '.nudge');
  await fs.writeFile(nudgePath, JSON.stringify({
    reason,
    messageCount,
    threadTag,
    timestamp: Date.now(),
  }));
  return { ok: true };
}
```

### 7.2 Hook check

**File**: `references/claude-code-swarm/scripts/map-hook.mjs`

In `UserPromptSubmit` handler, before existing inbox check:

```javascript
// Check for nudge flag
const nudgePath = path.join(swarmDir, '.nudge');
try {
  const nudge = JSON.parse(await fs.readFile(nudgePath, 'utf8'));
  await fs.unlink(nudgePath); // consume the nudge
  if (Date.now() - nudge.timestamp < 300_000) { // 5-min freshness
    contextLines.push('');
    contextLines.push(`## [MAP] Nudge: ${nudge.messageCount} pending messages`);
    contextLines.push(`Thread: ${nudge.threadTag}`);
    contextLines.push('Check your inbox and respond before continuing work.');
  }
} catch { /* no nudge pending */ }
```

### 7.3 Hub sends nudge

**File**: `src/dispatch/setup.ts` or `src/dispatch/openhive-mail-port.ts`

When `checkThreadPending` detects unread messages for a cc-swarm agent:

```typescript
// After detecting pending messages during continuation check
const conn = getInbound(dispatch.target_swarm_id);
if (conn?.ws) {
  conn.ws.send(JSON.stringify({
    jsonrpc: '2.0',
    method: 'nudge',
    params: {
      action: 'nudge',
      reason: 'inbox.pending',
      messageCount: pending.count,
      threadTag: `dispatch-${dispatch.id}`,
    },
  }));
}
```

### 7.4 Tests

- **Unit**: Nudge flag written and consumed correctly
- **Integration**: Hub sends nudge → sidecar writes flag → hook reads it

---

## Phase 8: macro-agent Importance Mapping

**Goal**: Dispatch thread messages flow through macro-agent's existing
TriggerSystemV2 with appropriate importance levels.

### 8.1 Importance derivation

**File**: `references/macro-agent/src/mail/mail-inbound-consumer.ts` (or
equivalent trigger wiring)

When processing an incoming mail turn from a `dispatch-thread` scoped
conversation:

```typescript
function deriveDispatchThreadImportance(
  turn: MailTurn,
  conversation: Conversation,
): ImportanceLevel {
  // Explicit importance from sender
  if (turn.metadata?.importance) return turn.metadata.importance;

  // System turns (retry notices) are normal
  if (turn.metadata?.system) return 'normal';

  // Messages expecting reply are high
  if (turn.metadata?.expects_reply) return 'high';

  // Default: normal (queue for next turn)
  return 'normal';
}
```

### 8.2 Tests

- **Unit**: Importance derivation returns correct levels
- macro-agent already has TriggerSystemV2 tests — extend with dispatch-thread
  message routing

---

## Phase 9: Thread Lifecycle Hooks

**Goal**: Threads close when tasks complete, reopen when tasks reopen, and
orphaned threads are swept after 30 days.

### 9.1 agent-inbox `mail/reopen`

**File**: `references/agent-inbox/src/jsonrpc/mail-server.ts`

```typescript
this.methods.set('mail/reopen', (params) => {
  const conversationId = params.conversationId as string;
  if (!conversationId) throw rpcError(-32602, 'conversationId required');

  const conv = this.storage.getConversation(conversationId);
  if (!conv) throw rpcError(-32001, 'Conversation not found');
  if (conv.status !== 'completed') {
    throw rpcError(-32002, 'Only completed conversations can be reopened');
  }

  conv.status = 'active';
  conv.updated_at = new Date().toISOString();
  this.storage.putConversation(conv);
  this.events.emit('mail.reopened', {
    conversation_id: conv.id,
    scope: conv.scope,
  });

  return { conversationId: conv.id, status: 'active' };
});
```

### 9.2 Task completion → thread close

**File**: `src/coordination/listener.ts` (or `src/map/task-broadcast.ts`)

Add alongside cascade task-binder hook:

```typescript
mapHubEvents.on('task_status_changed', async (event) => {
  const terminalStatuses = ['completed', 'closed', 'done', 'failed', 'cancelled'];
  if (!terminalStatuses.includes(event.status)) return;
  if (!event.resourceId) return;

  // Find dispatch threads linked to this task
  const resource = getResource(event.resourceId);
  const threads = resource?.metadata?.dispatch_threads as Array<{
    conversation_id: string;
    status: string;
  }> | undefined;

  if (!threads?.length) return;

  for (const thread of threads) {
    if (thread.status !== 'active') continue;
    try {
      await mailRpc.call('mail/close', { conversationId: thread.conversation_id });
      thread.status = 'completed';
    } catch { /* best-effort */ }
  }

  // Update resource metadata
  updateResourceMetadata(event.resourceId, { dispatch_threads: threads });
});
```

### 9.3 Task reopen → thread reopen

```typescript
mapHubEvents.on('task_status_changed', async (event) => {
  const reopenStatuses = ['open', 'in_progress'];
  const prevTerminal = ['completed', 'closed', 'done'];
  if (!reopenStatuses.includes(event.status)) return;
  if (!event.previousStatus || !prevTerminal.includes(event.previousStatus)) return;
  if (!event.resourceId) return;

  const resource = getResource(event.resourceId);
  const threads = resource?.metadata?.dispatch_threads as Array<{
    conversation_id: string;
    status: string;
  }> | undefined;

  if (!threads?.length) return;

  for (const thread of threads) {
    if (thread.status !== 'completed') continue;
    try {
      await mailRpc.call('mail/reopen', { conversationId: thread.conversation_id });
      thread.status = 'active';
    } catch { /* best-effort */ }
  }

  updateResourceMetadata(event.resourceId, { dispatch_threads: threads });
});
```

### 9.4 TTL sweep for orphaned threads

**File**: `src/dispatch/setup.ts` or new `src/dispatch/thread-sweep.ts`

```typescript
const THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function sweepOrphanedThreads(mailRpc: MailJsonRpcLike): Promise<number> {
  const cutoff = new Date(Date.now() - THREAD_TTL_MS).toISOString();
  const conversations = await mailRpc.call('mail/list', {
    scope: 'dispatch-thread',
    status: 'active',
  });

  let closed = 0;
  for (const conv of conversations) {
    if (conv.updated_at > cutoff) continue;

    // Check if any linked dispatch is still running
    const dispatchId = conv.metadata?.dispatch_id;
    if (dispatchId) {
      const dispatch = dispatchesDAL.findDispatchById(dispatchId);
      if (dispatch?.status === 'running') continue;
    }

    await mailRpc.call('mail/close', { conversationId: conv.id });
    closed++;
  }
  return closed;
}
```

Wire into a daily sweep (or piggyback on existing `markStaleSwarms` interval).

### 9.5 Tests

- **Unit**: `src/__tests__/dispatch/thread-lifecycle.test.ts`
  - Task completion closes linked threads
  - Task reopen reopens completed threads
  - TTL sweep closes stale threads but not active dispatches
  - `mail/reopen` transitions completed → active

---

## Phase 10: UI (Deferred)

Not detailed here. High-level targets from the design spec:

- **Dispatch detail page**: Thread section using swarmcraft `ChatMessageList` +
  `ChatInput`. If no conversation: muted placeholder text.
- **Task detail**: List of linked dispatch thread links from
  `metadata.dispatch_threads`.
- **Threads list** (`/threads`): Filter by `scope: 'dispatch-thread'`.
- **Dashboard**: Unread thread indicator for user-initiated dispatches.

---

## Dependency Graph

```
Phase 1 ─────────────────────────────────────────────┐
  (identity unification)                              │
                                                      ▼
Phase 2 ──────────────────────────────────────► Phase 3
  (schema + factory)                         (prompt + routing)
                                                      │
                                                      ▼
                                               Phase 4
                                          (orchestrator lifecycle)
                                                      │
            ┌─────────────────────────────────────────┤
            ▼                                         ▼
     Phase 5                                   Phase 6
  (presence API)                          (wake signal + policy)
            │                                         │
            ▼                                         ▼
     Phase 8                                   Phase 7
  (macro-agent importance)                (cc-swarm nudge)
            │                                         │
            └─────────────┬───────────────────────────┘
                          ▼
                   Phase 9
              (lifecycle hooks)
                          │
                          ▼
                   Phase 10
                    (UI)
```

Phases 5 and 7-8 can be developed in parallel after Phase 4.

---

## New Files Summary

| File | Phase | Purpose |
|------|-------|---------|
| `src/dispatch/dispatch-conversation.ts` | 2 | Conversation factory (`ensureDispatchConversation`) |
| `src/dispatch/thread-sweep.ts` | 9 | TTL-based orphaned thread sweep |
| `src/__tests__/dispatch/dispatch-conversation.test.ts` | 2 | Factory unit tests |
| `src/__tests__/dispatch/prompt-coordination.test.ts` | 3 | Prompt injection tests |
| `src/__tests__/dispatch/dispatch-thread-routing.test.ts` | 3 | Message routing integration tests |
| `src/__tests__/dispatch/event-bridge-threads.test.ts` | 4 | Event bridge thread management |
| `src/__tests__/dispatch/thread-wake-signal.test.ts` | 6 | Wake signal + continuation policy |
| `src/__tests__/dispatch/thread-lifecycle.test.ts` | 9 | Close/reopen/sweep lifecycle |
| `src/__tests__/map/resolve-inbox-agent-id.test.ts` | 1 | Identity resolution helper |
| `src/__tests__/dal/dispatches-conversation.test.ts` | 2 | DAL conversation_id helpers |

## Modified Files Summary

| File | Phases | Changes |
|------|--------|---------|
| `src/db/schema.ts` | 2 | V52 migration: `conversation_id` column |
| `src/db/dal/dispatches.ts` | 2 | Add `conversation_id` to types + `setDispatchConversationId()` |
| `src/dispatch/prompt.ts` | 3 | Coordination section in first-run, retry, continuation prompts |
| `src/dispatch/setup.ts` | 4, 6 | Event bridge thread hooks, continuation policy, reconciliation |
| `src/dispatch/openhive-mail-port.ts` | 6 | `checkThreadPending` implementation |
| `src/dispatch/openhive-source.ts` | 4 | Pending thread message enrichment for continuations |
| `src/dispatch/finalize.ts` | 9 | Thread close on dispatch terminal state |
| `src/dispatch/delivery-tracker.ts` | 6 | Thread-driven turn counter |
| `src/map/ws-map.ts` | 3 | `x-dispatch/thread` scope message handler |
| `src/map/connection-registry.ts` | 1 | `resolveInboxAgentId()` helper |
| `src/api/routes/dispatches.ts` | 3 | `POST /dispatches/:id/thread/turns` endpoint |
| `src/server.ts` | 3 | Mail event → WS broadcast bridge for dispatch threads |
| `src/config.ts` | 6 | `continuation.maxThreadTurns` config |
| `src/coordination/listener.ts` | 9 | Task completion → thread close hook |
| `references/swarm-dispatch/src/types.ts` | 6 | Optional `checkThreadPending` on `MessagePort` |
| `references/agent-inbox/src/jsonrpc/mail-server.ts` | 5, 9 | `mail/presence`, `mail/reopen` methods |
| `references/claude-code-swarm/src/bootstrap.mjs` | 1 | Unified agent ID for MAP registration |
| `references/claude-code-swarm/src/map-events.mjs` | 1 | Consistent ID derivation |
| `references/claude-code-swarm/src/sidecar-server.mjs` | 7 | `nudge` command handler |
| `references/claude-code-swarm/scripts/map-hook.mjs` | 7 | Nudge flag check in `UserPromptSubmit` |

---

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| 1 | ID change breaks existing sessions | Fallback to MAP ID when metadata absent; metadata-only on first release |
| 2 | Race condition on lazy creation | Deterministic conversation ID (`dispatch-conv-${id}`) + `setDispatchConversationId` idempotent guard |
| 3 | Prompt too long with coordination section | Section is ~10 lines; conditional on metadata presence |
| 4 | System turns on retry confuse agents | Mark with `metadata.system: true`; prompt builder can filter |
| 6 | Thread-driven continuations loop forever | `maxThreadTurns` cap (default 3) + reconciliation sweep |
| 7 | Nudge flag file race (consumed before hook reads) | Atomic read-and-delete; TTL freshness check |
| 9 | Task status event missed → thread never closes | TTL sweep (30 day) as safety net |
