import type { SkillFragment } from './types.js';

export const trajectoryFragment: SkillFragment = {
  id: 'trajectory',
  audience: 'agent',
  order: 45,
  render: () => `## Session Trajectories

Agents report session checkpoints (conversation snapshots, tool calls, token
usage). The hub auto-creates a session resource from the first checkpoint
and serves transcript content on demand.

### MAP JSON-RPC Methods

| Method | Direction | Purpose |
|--------|-----------|---------|
| trajectory/checkpoint | agent → hub | Upsert a checkpoint |
| trajectory/content.request | hub → agent | Request transcript content |
| trajectory/content.response | agent → hub | Deliver transcript content |

### Checkpoint Payload

\`\`\`json
{
  "checkpoint": {
    "id": "...",
    "session_id": "...",
    "agent": "agent-name",
    "branch": "main",
    "files_touched": ["src/foo.ts"],
    "token_usage": { "input": 1200, "output": 450 },
    "summary": { "firstPrompt": "...", "lastActivity": "..." }
  },
  "resource_id": "optional-explicit-id"
}
\`\`\`

Declare capability \`trajectory: { canReport: true }\` to report, and
\`canServeContent: true\` if your swarm will respond to content requests.

### REST Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /sessions | List session resources |
| GET | /sessions/:id | Session detail + checkpoint stats |
| GET | /sessions/:id/events | Transcript as ACP events (5-tier resolution) |
| POST | /sessions/:id/chat | Deliver a message back to the session agent (mail) |
| POST | /sessions/create-acp | Attach an ACP stream for live chat |

Content resolution order:
1. Fresh cache (session storage)
2. On-demand from connected swarm (via \`trajectory/content.request\`)
3. Local sessionlog transcript
4. Stale cache
5. 503`,
};
