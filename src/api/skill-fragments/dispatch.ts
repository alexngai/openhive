import type { SkillFragment } from './types.js';

export const dispatchFragment: SkillFragment = {
  id: 'dispatch',
  audience: 'agent',
  order: 40,
  render: () => `## Dispatch Orchestrator

Specs are dispatched to swarms via the \`dispatches\` table. The orchestrator
polls queued rows, claims them with a fence token, builds a turn-aware
prompt, and routes to a running agent (preferred) or spawns a fresh ACP
stream.

### MAP JSON-RPC Methods

| Method | Direction | Purpose |
|--------|-----------|---------|
| map/specs/author | agent → hub | Create/update a spec (stores on configured target resource) |
| map/specs/dispatch | agent → hub | Queue a dispatch for one or more swarms |
| map/dispatches/report | agent → hub | Agent-driven status transition (running / complete / failed) |

### REST Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /specs/:resourceId/:specId/dispatch | Create queued dispatch rows |
| GET | /dispatches | List dispatches |
| GET | /dispatches/:id | Single dispatch with attempt/turn history |
| POST | /dispatches/:id/cancel | Cancel a running dispatch |

### Lifecycle

\`queued → running → complete | failed | cancelled\`

- \`queued\` — hub insert (operator or agent-originated)
- \`running\` — orchestrator claimed the row (fence token held)
- \`complete\` / \`failed\` — terminal, written via event bridge or agent report
- \`cancelled\` — user cancel while running

### Autonomous Dispatch Kill Switch

\`POST /admin/autonomous-dispatch\` \`{ "paused": true }\` pauses
agent-initiated dispatches via \`map/specs/dispatch\` (returns -32004).
User-initiated REST dispatches still work. State is in-memory; hub restart
resets to live.

### Events

- \`dispatch.queued\` — new dispatch row
- \`dispatch.claimed\` — orchestrator took it
- \`dispatch.terminal\` — complete/failed/cancelled (broadcast on \`map:dispatches\`)`,
};
