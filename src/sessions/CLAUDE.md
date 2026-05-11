# src/sessions — session storage + trajectory architecture

Agent sessions (from Claude Code via sessionlog + cc-swarm) produce trajectory data visible in the OpenHive UI. This directory owns session storage adapters; the MAP-protocol trajectory handler lives in `src/map/trajectory-handler.ts` (the entry point for incoming checkpoints), and the chat UI lives in `src/web/`.

## Data Flow

```
Claude Code session → sessionlog hooks track state
  → cc-swarm buildTrajectoryCheckpoint() (wire format: agent, files_touched, token_usage, branch, project, firstPrompt)
  → sidecar callExtension("trajectory/checkpoint") via MAP
  → OpenHive trajectory handler: auto-create session resource, store checkpoint, enrich swarm name
  → Frontend: /sessions page shows sessions with project name + first prompt as description
```

## Content Serving (Trajectory Tab)

```
GET /sessions/:id/events → 5-tier resolution:
  1. Fresh cache (session storage, storage.backend = 'local')
  2. On-demand from connected swarm (MAP trajectory/content.request notification)
  3. Local sessionlog transcript (same machine: .git/sessionlog-sessions/ → transcriptPath)
  4. Stale cache (file on disk, metadata invalidated by new checkpoint)
  5. 503 Service Unavailable
```

Content is converted via Claude JSONL adapter → ACP events (user messages, assistant responses, tool calls, thinking blocks). Non-conversation entries (progress, file-history-snapshot) are aggregated into compact inline badges.

## Key Files

- `src/map/trajectory-handler.ts` — Handles `trajectory/checkpoint` requests, auto-creates session resources with enriched names (project + branch), stores checkpoints, invalidates content cache, enriches swarm records
- `src/map/trajectory-content.ts` — On-demand content fetcher: sends `trajectory/content.request` to connected swarms, handles responses, capability-gated
- `src/map/trajectory-types.ts` — Method set and request/response types
- `src/sessions/adapters/claude.ts` — Converts Claude Code JSONL transcripts to ACP events, aggregates non-content entries, pairs tool results with tool calls
- `src/api/routes/sessions.ts` — `/sessions/:id/events` endpoint with 5-tier content resolution, caching to session storage
- `src/api/routes/session-chat.ts` — `POST /sessions/:id/chat` endpoint for bi-directional session chat (lazy conversation creation + mail turn delivery)
- `src/db/dal/trajectory-checkpoints.ts` — Checkpoint CRUD and stats aggregation
- `src/web/pages/Sessions.tsx` — Session list with enriched names
- `src/web/pages/SessionDetail.tsx` — Trajectory tab wiring swarmcraft's `ChatMessageList` + `ChatInput` + `PermissionDialog`, checkpoints tab, learning tab
- Chat contract (in `swarmcraft/ui/embed`): `useChatChannel`, `ChatTarget`, `ChatAdapter`, `ChatCapabilities` — unified across Sessions, Messages, Agent, SwarmDetail. See `src/web/CLAUDE.md` for the full chat surface.

## Configuration

```javascript
// openhive.config.js
{
  sessions: {
    type: 'local',        // 'local' | 's3' | 'none' (disable caching)
    path: '/custom/path', // default: <dataDir>/data/sessions
  }
}
```

## MAP SDK Extensions Used

- `trajectory/checkpoint` — Agent → hub checkpoint storage (registered as MAPServer additionalHandler)
- `trajectory/content.request` — Hub → agent content request (raw JSON-RPC notification via `onNotification`)
- `trajectory/content.response` — Agent → hub content delivery (raw JSON-RPC notification via `sendNotification`)
- Per-agent capabilities (declared via `map/agents/register`): `trajectory.canReport`, `trajectory.canServeContent`, `protocols: ['acp']`, `acp: { version }`. The hub aggregates per-agent capabilities into the swarm record via `getAggregateCapabilities()`.
