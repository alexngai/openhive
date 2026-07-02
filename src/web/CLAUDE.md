# src/web — React frontend

Pages, components, hooks, stores, adapters. Most architecturally interesting concern: the unified chat surface, which rides swarmcraft's `ui/embed` primitives.

## Visual conventions

Design tokens live in `src/web/styles/globals.css`. Follow these rules so the UI stays consistent and both themes keep working:

- **Colors**: never hardcode hex / `rgb()` / `rgba()` / raw Tailwind palette classes (`bg-zinc-800`, `text-red-400`) for themed surfaces. Use the semantic tokens — either Tailwind utilities generated from `@theme` (`bg-bg`, `bg-surface`, `bg-elevated`, `bg-hover`, `border-border`, `border-border-subtle`, `text-text`, `text-text-secondary`, `text-text-muted`) or inline `style={{ color: 'var(--color-...)' }}`. Both are valid; the utility form is preferred. Status/danger surfaces use `--color-danger`, `--color-danger-bg`, `--color-danger-border`.
- **`--color-accent` vs `honey-*`**: use `var(--color-accent)` (or `bg-accent` / `text-accent`) for interactive/active state — it shifts per theme. Use `text-honey-500` etc. only for fixed brand marks.
- **Never use** `bg-workspace-*` in `hover:`/state utilities, `bg-white/N`, `bg-black/N`, or `var(--color-text-primary)` / `--color-bg-panel` / `--color-background` / `--color-text-tertiary` — they're dark-only or undefined and break light theme. Use `bg-hover` / `var(--color-hover)` instead.
- **Spacing**: stick to the three vertical tiers documented in `globals.css` (Compact `py-1`, Default `py-1.5`, Breathing `py-2.5`). No font sizes below `text-2xs` (12px).
- **Status pills**: render all status/priority badges through the shared `StatusChip` component (`components/common/StatusChip.tsx`) — don't hand-roll `bg-{color}-500/10 text-{color}-400` spans.
- **Page width**: list pages use `max-w-7xl`; detail and editor pages use `max-w-4xl`. A list→detail navigation should not jump widths.
- **Loading / empty states**: use `<PageLoader />` and `<EmptyState />` — don't hand-roll spinners. Detail pages must render a "not found" / error state, never `return null`.

## Unified chat components (Threads)

All chat surfaces — the Threads list + detail (`/threads`, `/threads/:id`, `/threads/mail/:mailId`), the floating ChatFab, and SwarmDetail's Coordination Broadcast — render via swarmcraft's `ChatMessageList` + `ChatInput` + `PermissionDialog` + `ChatBubble` from `swarmcraft/ui/embed`.

Sessions + mail conversations were consolidated into a single **Threads** concept: one list mixes interactive ACP sessions, async mail threads, and autonomous dispatch runs; the detail page adapts based on flavor. OpenHive converts its `SessionEvent[]` into swarmcraft's `ChatMessage[]` via `src/web/lib/chat/session-events.ts`; `enrich-user-turns.ts` + `useAgentLookup` decorate user messages with resolved openhive Agent identity.

## Navigation vocabulary

The sidebar is intentionally grouped by user mental model rather than route names:

- **Fleet**: Swarms, then Threads.
- **Work**: Specs → Jobs → Tasks → Changes, plus Schedules.
- **Library**: Memory, Skills, Teams, Repos, Learning.

The Work label **Jobs** maps to the existing `/dispatch` route and `Dispatch*.tsx` pages. Keep that route stable for compatibility unless adding a deliberate `/jobs` redirect.

## Chat (Unified across Sessions, Messages, Agent, SwarmDetail)

All four chat surfaces (Sessions trajectory, Messages conversation, Agent profile, SwarmDetail coordination) share a single contract defined in `swarmcraft/ui/embed` and consumed via `useChatChannel({ target, adapters, resolveCapabilities })`. Chat mode is determined by MAP capabilities published during agent registration, following the MAP `ParticipantCapabilities` schema.

### Capability → Mode Mapping

| MAP Capability | Chat Mode | Transport | Behavior |
|---|---|---|---|
| `protocols: ['acp']` (per-agent) | **ACP** | ACP stream via MAP server | Full streaming, bi-directional |
| `mail: { canJoin: true }` | **Mail** | `POST /sessions/:id/chat` or `/mail/conversations/:id/turns` | Async turns, 5s polling, optimistic echo |
| `messaging: { canReceive: true }` | **Inject** | MAP inject | Contract-supported; OpenHive doesn't currently expose the route so the adapter is omitted |
| None / offline | **Unavailable** | — | Read-only with specific reason |

Detection cascade: ACP → Mail → (Inject) → Unavailable. Adapters are probed in priority order; each adapter's `canHandle(target, caps)` decides whether it can serve the target.

### Agent Capability Declarations

Capabilities are declared **per-agent** at MAP registration, not per-swarm. When an agent registers on the hub via `map/agents/register`, it declares its own `ParticipantCapabilities`. The hub stores these per-agent on `MapInboundConnection.registeredAgents` and aggregates them (union semantics) into the swarm's `map_swarms.capabilities` record via `getAggregateCapabilities()`.

**cc-swarm** declares (connection-level): `messaging: { canSend, canReceive }`, `mail: { canCreate, canJoin, canViewHistory }` — gets Mail mode.

**macro-agent** declares per-agent capabilities via the lifecycle bridge:
- **Coordinators** (head managers): `protocols: ['acp']`, `acp: { version: '2024-10-07' }`, `messaging: { canReceive: true }` — gets ACP mode.
- **Workers**: `messaging: { canReceive: true }` only.
- **Connection-level** (sidecar): `messaging`, `mail`, `trajectory`, `tasks` — no ACP (ACP is agent-level).

ACP target resolution: The frontend reads `registered_agents` from `GET /map/swarms/:id` and finds the first agent with `protocols: ['acp']`. The backend (`POST /sessions/create-acp`) resolves via `findAcpAgent()` from the connection registry.

### Caller Sites

| Page | Target | Capability resolver | Adapter set |
|---|---|---|---|
| `pages/SessionDetail.tsx` | `SessionTarget` (sessionId + swarmId + optional resume) | `useSessionCapabilityResolver` (reads swarm + registered_agents) | `useOpenHiveAdapters` (ACP + Mail) |
| `pages/Conversation.tsx` | `ConversationTarget` | `useConversationCapabilityResolver` (mail-only gate on conversation.status) | `useOpenHiveAdapters` |
| `pages/SwarmDetail.tsx` (`ComposeMessageSection`) | `AgentTarget` (swarmId) | inline pass-through (always available) | `[createCoordinationChatAdapter]` |

All three surfaces render via a single component family from `swarmcraft/ui/embed`: `ChatMessageList` + `ChatInput` + `PermissionDialog` + `ChatBubble` + `ToolCallGroupBlock` + `MarkdownContent`. Trajectory-specific features (tool-call run grouping, "Load older" pagination, continuation headers, sticky-external permissions, markdown styling) are opt-in props on the same components rather than a separate component family.

`pages/Agent.tsx` (legacy social-layer profile page) and `pages/Agents.tsx` (directory) have been deleted along with the social layer; agent context lives on SwarmDetail's Registered Agents section.

### Chat Data Flow

```
User types in swarmcraft ChatInput
  → useChatChannel({ target, adapters, resolveCapabilities })
  → Capability resolver (useSessionCapabilityResolver / useConversationCapabilityResolver)
      reads useMapSwarm() / useMailConversation() and returns { acp?, mail?, inject? }
  → Adapter detection: first adapter.canHandle(target, caps) wins
  → ACP (createAcpAdapter): backed by openhive-acp-service.ts
    → POST /api/swarmcraft/acp/streams (targetAgent = peerMapId from registered_agents)
    → /initialize → /session (or /session/load for resume) → /prompt (body: { message })
    → prepareSubscription() buffers WS events that arrive before subscribe() attaches
    → Streaming via WS: acp.session.update → text chunk accumulation, tool calls,
      permission.request → swarmcraft PermissionDialog (sticky-external variant)
      → /streams/:id/permission
  → Mail (createMailAdapter):
    → SessionTarget: POST /sessions/:id/chat (lazy-creates linked conversation)
    → ConversationTarget: POST /mail/conversations/:id/turns
    → 5s polling via adapter.getMessages
  → Optimistic user echo: useChatChannel appends local-user-* message before adapter.send;
    rollback on send failure; replaced by server version when getMessages refreshes (mail)

For the Sessions trajectory tab specifically, trajectory events from
`useSessionEvents` are converted via `sessionEventsToChatMessages()` (in
`src/web/lib/chat/session-events.ts`) and merged with live `channel.messages`
using swarmcraft's `deduplicateChatMessages` helper before being passed to
`ChatMessageList` with `groupConsecutiveTools={true}`.
```

### Event Deduplication

Two dedup layers protect against duplicates:

1. **ACP WS delivery dedup** (`openhive-acp-service.ts` `isDuplicate`) — time-windowed Map keyed by full-update JSON fingerprint. MAP SDK sometimes delivers the same `session/update` 2×; within `DEDUP_WINDOW_MS` (200ms) the duplicate is silently dropped. Handles 1×/2×/N× delivery safely.
2. **Trajectory ↔ streaming merge dedup** (swarmcraft's `deduplicateChatMessages` in `swarmcraft/ui/embed`) — when SessionDetail merges `channel.messages` (live/streaming) with trajectory checkpoint events (converted to ChatMessages), a live message matching an existing trajectory message by `contentType:role:FNV-1a(content)` is suppressed. Full-content hash avoids false positives from agents sharing boilerplate prefaces.

### ACP Permission Handling

When an ACP agent requests tool approval, SwarmCraft emits `acp.permission.request` via WebSocket. The frontend renders Allow/Deny buttons above the chat input. Replies are sent via `POST /api/swarmcraft/acp/streams/:streamId/permission` with `{ requestId, reply: { outcome: 'approved' | 'denied' } }`. Permissions time out after 5 minutes on the server side.

### Multi-tab session sharing (Option 1B)

`/sessions/acp-connect` is idempotent per `(owner_agent_id, source_swarm_id, acp_target_agent_id)`. The first connect creates the ACP stream + session and persists `acpStreamId`, `sessionId`, `acp_target_agent_id` on the session resource metadata. Subsequent connects (additional browser tabs, same user, same target) hit `findLiveAcpSession` (`src/db/dal/syncable-resources.ts`), confirm the streamId is still in `acpStreamManager.streams`, and return the cached IDs without touching the manager. A per-key `inflightAcpConnects` Promise cache in `src/api/routes/sessions.ts` makes concurrent POSTs share one create — only the leader runs `createStream`, followers piggyback.

Cross-tab sync is automatic once both tabs subscribe to the same `(streamId, sessionId)`: every `acp.session.update` event fans out from SwarmCraft's `acp` topic → OpenHive's `global` channel via the bridge in `src/server.ts`. Late-joining tabs replay history through `loadSession`.

Two events were added to plumb this end-to-end:
- `acp.prompt.started` — emitted by `acp-manager` on every prompt with the prompt content. Sibling tabs synthesize a "user" `ChatMessage` so they see what the other tab typed; the sender suppresses its own broadcast via the per-stream `recentlySentByUs` set in `openhive-acp-service.ts` (TTL 5s) so its local optimistic echo isn't duplicated. Content fingerprinting via FNV-1a (`fnv1aHash`).
- `acp.permission.resolved` / `acp.question.resolved` — emitted when one tab answers a permission/question request. The `AdapterCallbacks` contract gained optional `onPermissionResolved?(requestId)` / `onQuestionResolved?(requestId)` (in `swarmcraft/ui/types/chat.ts`); `useChatChannel` filters the requestId out of pending lists, auto-dismissing the dialog on the other tab.

E2E tests: `src/__tests__/sessions/acp-connect-multitab.test.ts` covers reuse, race-mutex, cross-owner isolation, hub-restart fallthrough, metadata persistence. `src/__tests__/dal/find-live-acp-session.test.ts` covers the lookup helper. `src/__tests__/map/acp-ws-bridge.test.ts` covers the new event broadcasts (including the `topic === 'acp'` guard against duplicate fan-out).

### Per-turn agent identity

ChatHeader (`src/web/components/chat-fab/ChatFab.tsx`) renders `AgentAvatar` (boring-avatar from `swarmcraft/ui/embed`'s `generateAgentPalette`) with a state-coloured border + small status dot mirroring `AgentPortrait`. Subtitle reads `Coordinator · {swarm name}`. State dot pulses only when `state ∈ {active, busy}` AND `swarmStatus === 'online'`; if the swarm is unreachable the border + dot collapse to neutral grey regardless of last-known state.

Chat bubbles get the same identity via `decorateWithAgentIdentity` in `openhive-acp-service.ts` — every non-user message gets `senderName: agentName` and `agentIdentity: { name: agentName }` so `ChatBubble` renders the boring-avatar + name. The `agentName` is captured from `createStream(serverId, targetAgent, agentName)` for new sessions, and backfilled on resumed sessions via `setAcpStreamAgentName(streamId, name)` called from `useBackfillAcpAgentName` in `ChatPanel.tsx` (looks up the live name from `useMapSwarm`'s `registered_agents`). Decorate runs in `notifyMessages` at every emit so a late-resolving name re-paints prior bubbles.

### Key Files

- `src/web/lib/chat/resolvers.ts` — `useSessionCapabilityResolver` (reads swarm + registered_agents for peerMapId), `useConversationCapabilityResolver`, target constructors.
- `src/web/lib/chat/session-events.ts` — `sessionEventsToChatMessages()` lossless converter from OpenHive's `SessionEvent[]` to swarmcraft's `ChatMessage[]`. Pairs `tool_call` + `tool_result` by `toolCallId`.
- `src/web/adapters/openhive-adapters.ts` — `useOpenHiveAdapters()` builds `[createAcpAdapter, createMailAdapter]` against OpenHive endpoints (inject dropped — no backing route).
- `src/web/adapters/openhive-acp-service.ts` — AcpServiceLike: REST lifecycle + WS subscription + text-chunk accumulation + `prepareSubscription()` buffer flush for loadSession replay race.
- `references/swarmcraft/src/ui/hooks/useChatChannel.ts` — Target-based channel hook: probes adapters, wires callbacks into React state, manages subscription/polling lifecycle, optimistic user echo with rollback.
- `references/swarmcraft/src/ui/adapters/{mail,inject,acp,http}.ts` — Reusable adapter factories (ApiConfig-parameterized). Both OpenHive and SwarmCraft construct adapter sets from these.
- `references/swarmcraft/src/ui/components/chat/{AgentChat,ChatMessageList,ChatInput,PermissionDialog,QuestionDialog,ChatBubble,ToolCallGroupBlock,MarkdownContent}.tsx` — Channel-driven rendering primitives, all consumed directly by OpenHive.
- `references/swarmcraft/src/ui/utils/chat-events.ts` — `deduplicateChatMessages`, `groupMessagesForDisplay`, `formatTokens`, and other host-agnostic helpers.
- `references/swarmcraft/src/ui/embed.css` — ships `.swarmcraft-markdown` rules for chat-bubble markdown styling; imported once in Layout.
- `src/api/routes/session-chat.ts` — Backend endpoint: lazy conversation creation, auto-join, turn delivery via `mail/turn` JSON-RPC.
- `src/api/routes/sessions.ts` — `POST /sessions/create-acp` resolves ACP target agent via `findAcpAgent()` from per-agent capabilities on the live connection.
- `src/map/connection-registry.ts` — Inbound connection tracking, per-agent capability storage, `findAcpAgent()` for ACP target resolution, `getAggregateCapabilities()` for swarm-level capability union.
- `src/server.ts` — ACP event bridge: intercepts SwarmCraft WS broadcasts, forwards `acp.*` events from the `acp` topic (only) to OpenHive's `global` WS channel; `events`-topic broadcasts are skipped to avoid duplicate fan-out.

### ChatFab connect surface

`src/web/components/chat-fab/ChatFabStore.ts` exposes `connectAndOpen(swarmId, agentId, label?, peerMapId?, cwd?)`. The `peerMapId` is required when the caller has only the SwarmCraft-projected id (`oh-node-{swarmId}-{mapAgentId}`); the hub registry routes ACP by the raw `mapAgentId`. `cwd` is forwarded for hosted swarms whose agent process should open in the user-selected project directory. Dashboard and swarm roster entry points should call this shared helper instead of routing users through `/threads`.

`ChatBody` (`ChatFab.tsx`) reads `connecting` and `connectError` from the store. While connecting + no session: full-panel spinner with `Connecting to {label}...`. On error: red dismissable banner above the picker (`Couldn't open chat — {error}`). The dismiss action calls `clearSession` which also clears the error.

`AgentPortraitGrid` (in swarmcraft/ui) gates the Chat + Terminal action buttons on `selectedAgent.presence === 'online'` so users don't click into an inevitable failure on offline agents.

## Realtime invalidation

The frontend invalidation contract — which channels to subscribe, which event types invalidate which React Query keys — lives in `src/web/hooks/useRealtimeInvalidation.ts`. The HMR-safe WS client lives in `src/web/hooks/useWebSocket.ts`. Server-side broadcast helpers are documented in `src/realtime/CLAUDE.md`.

## Session attention (cockpit)

Attention state ("which threads need me?") is separated from query invalidation:

- **Store** — `src/web/stores/session-attention.ts` holds `AttentionItem`s with two kinds: `idle` (agent awaiting input; one per thread; cleared when the user views the thread) and `permission` (tool-approval pending; one per requestId; cleared only when resolved — viewing a thread does NOT clear it). Items are keyed by thread selection key (`session:<resourceId>`, `hosted-chat:<hostedSwarmId>`), with a `stream:<acpStreamId>` fallback for ACP permission events that arrive before the sessions cache can map the stream to a session.
- **Feeder** — `src/web/hooks/useGlobalAttention.ts`, mounted exactly once in `Layout`. Listens on `global` for `trajectory:sync` / `node_state_changed` (idle) and `acp.permission.request` / `acp.permission.resolved` (ACP permissions, mapped to sessions via `SessionListItem.acp_stream_id` from `/sessions/overview`), and subscribes one `hosted-chat:<id>` channel per running rpc-mode hosted swarm for codex `permission.request` / `permission.resolved` events. Owns the app-wide toasts (30s per-thread cooldown).
- **Hydration** — pending permissions are in-memory server-side, so `useGlobalAttention` also seeds the store once per mount from `GET /sessions/pending-attention` (reload correctness). The route (`src/api/routes/sessions.ts`) snapshots both stores: SwarmCraft's ACP `pendingPermissions` map (duck-typed read-only — no public accessor in the package; degrades to empty on shape change) joined to sessions via `findSessionByAcpStreamId`, and `SwarmManager.listPendingCodexPermissions()` for hosted codex prompts.
- **Consumers** — Threads sidebar rows (state chips with priority `approval` red > `input` amber > working-status chips; quiet states render no chip and rely on avatar border color; row click clears idle only), the SessionDetail header pill, the Threads nav badge in `Sidebar` (count of all attention items; red tone when any permission is pending, amber otherwise), and the `AttentionBell` queue panel (`src/web/components/attention/AttentionBell.tsx`, in the Threads sidebar header). `useSessionsRealtime` is invalidation-only and safe to mount on multiple pages.

Permission items carry reply-routing metadata (`streamId` for ACP → `POST /api/swarmcraft/acp/streams/:streamId/permission` via `replyAcpPermission` exported from `adapters/openhive-acp-service.ts`; `hostedSwarmId` for hosted → `POST /map/hosted/:id/chat/permission/:requestId` via `hostedChatService.replyPermission`). The AttentionBell panel uses these to Allow/Deny inline without mounting a chat channel; replies optimistically drop the item, with the `permission.resolved` WS event as the authoritative cross-tab cleanup. Idle items deep-link to their thread and clear on click.

## New-session picker on Threads

`src/web/components/threads/NewSessionMenu.tsx` (`NewSessionButton`, icon variant in the Threads sidebar header / block variant in the empty sidebar) opens a two-tab dialog so Threads is a launch surface, not just a list:

- **Connect** — online ACP agents grouped per swarm via `buildSwarmGroups` (shared with the ChatFab `SessionPicker`; mail-mode agents filtered out). Row click POSTs `/sessions/acp-connect` and navigates to `/threads/:sessionResourceId?streamId=…&sessionId=…` (SessionDetail consumes the resume params) instead of opening the floating panel. Lifecycle-capable swarms expose a "+" spawn-agent row (`SpawnAgentDialog`, auto-connect on spawn).
- **Spawn** — compact hosted-spawn form: Codex chat (codex/rpc, default) / Codex terminal / Claude Code, `WorkingDirectoryCombobox`, optional first prompt, auto-generated name; embeds the spawn preflight callout. Navigates to `/threads/hosted-chat/:id` (rpc) or `/threads/hosted-tui/:id` (tui). Full-fat options (repos, hives, credentials) stay in the Swarms `SpawnFormDialog`.

## Stop / cancel affordances

ACP surfaces get stop for free: swarmcraft's `ChatInput` renders a red stop button in place of Send whenever `channel.cancel` exists and `channel.status === 'streaming'` (the ACP adapter wires `cancel` → `POST /acp/streams/:id/cancel`, and the openhive ACP service flips to `streaming` on prompt). The hosted-chat adapter has **no** `cancel` and never reports `streaming` (turns report `ready`), so `HostedChat` implements its own stop: a second ref-counted `hostedChatService.subscribe` tracks the active turn id (`turn.started`/`turn.completed`), a stop strip renders above the composer while a turn is live, and stopping posts `POST /map/hosted/:id/chat/interrupt` via `interruptHostedTurn` (exported from `services/hosted-chat-service.ts`). Clean cancel — the session stays usable; the strip clears in every tab when the provider emits `turn.completed`.

## Day-zero onboarding surfaces

- **`FirstRunPanel`** (`components/onboarding/FirstRunPanel.tsx`) — three entry cards (spawn / connect / first spec). Self-gates via the exported `useIsFirstRun()`: renders only after BOTH `useHostedSwarms` + `useMapSwarms` settle with zero rows, so it never flashes on populated instances. Mounted on the Dashboard (both the stats branch and the SwarmCraft-embed branch) and in Threads' `EmptyDetail`. Callbacks (`onSpawn`/`onConnect`) open the dialogs where available; card falls back to a `/swarms` link when omitted.
- **`OnboardTokenPanel`** (`components/onboarding/OnboardTokenPanel.tsx`) — mints a 24h onboard token (`POST /admin/onboard-token`, scope `map:agents:spawn`) and renders copyable `export MAP_CREDENTIAL=…` + WS connect blocks. Requires admin authority (works in local/trusted-admin mode; errors point at the CLI). Embedded as the default tab of `ConnectFormDialog` (Swarms) and in settings' `ConnectivityCard`.
- **Spawn preflight** (`hooks/useApi.ts:useSpawnPreflight` + `components/swarm/SpawnPreflightCallout.tsx`) — `GET /map/hosted/spawn/preflight?kind&mode` on kind/mode selection in `SpawnFormDialog`; failed checks render as an amber callout and disable Spawn unless "attempt anyway" is ticked (state resets on kind/mode change).
- **Spec dead-end escape** — `SpecNew` with zero task graphs offers "Create default task graph" (`POST /map/hub-task-graph` → hub-owned `hub/default` resource, see `src/map/hub-task-graph.ts`), then auto-selects it.
