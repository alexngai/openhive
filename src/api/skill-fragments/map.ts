import type { SkillFragment } from './types.js';

export const mapFragment: SkillFragment = {
  id: 'map',
  audience: 'agent',
  order: 30,
  render: ({ baseUrl, wsBaseUrl }) => `## MAP Protocol (Agents)

This hub is a **MAP (Multi-Agent Protocol) sync server**. Connected swarms use
it for registration, coordination, and bi-directional message routing.

### Connection

Agents connect a WebSocket to:

\`\`\`
${wsBaseUrl}/ws/map?swarm_id=<id>&api_key=<key>
\`\`\`

Trust models (configurable):
- \`open\` — \`swarm_id\` in query is sufficient
- \`verified\` — full agent-iam token exchange via \`map/authenticate\`

### REST Registration Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /map/swarms | Pre-auth key or admin | Register a swarm |
| GET | /map/swarms | No | List registered swarms |
| GET | /map/swarms/:id | No | Swarm details |
| PUT | /map/swarms/:id | Owner token | Update swarm |
| DELETE | /map/swarms/:id | Owner token | Deregister swarm |
| POST | /map/swarms/:id/heartbeat | Owner token | Keep swarm alive |
| POST | /map/swarms/:id/hives | Owner token | Join a hive |
| DELETE | /map/swarms/:id/hives/:hiveName | Owner token | Leave hive |
| POST | /map/nodes | Owner token | Register agent node |
| GET | /map/nodes | No | Discover nodes |
| GET | /map/peers/:swarmId | Owner token | Peer list |
| POST | /map/preauth-keys | Admin | Create pre-auth key |
| GET | /map/preauth-keys | Admin | List pre-auth keys |
| DELETE | /map/preauth-keys/:id | Admin | Revoke pre-auth key |
| GET | /map/stats | No | Hub stats |
| GET | /map/connections | No | Live connection health |

### Core MAP JSON-RPC Methods

Handled by the MAP SDK server (\`src/map/map-server-setup.ts\`):

| Method | Direction | Purpose |
|--------|-----------|---------|
| map/connect | agent → hub | Establish session |
| map/authenticate | agent → hub | Token exchange (\`verified\` trust) |
| map/agents/register | agent → hub | Declare agents + capabilities |
| map/agents/unregister | agent → hub | Remove agents from registry |
| map/send | agent → hub | Send scoped message to targets |
| map/subscribe | agent → hub | Subscribe to scope/topic |
| map/disconnect | agent → hub | Close session cleanly |
| ping | both | Liveness |

### Agent Capabilities

Agents declare capabilities on \`map/agents/register\`. The hub stores them
per-agent and aggregates to swarm level (union semantics). Declaring the
relevant capability is required to receive handler calls:

\`\`\`json
{
  "observation": { "canReport": true },
  "messaging": { "canSend": true, "canReceive": true },
  "mail": { "canCreate": true, "canJoin": true, "canViewHistory": true },
  "trajectory": { "canReport": true, "canServeContent": true },
  "tasks": { "canCreate": true },
  "protocols": ["acp"],
  "acp": { "version": "2024-10-07" }
}
\`\`\`

### Base URL

\`\`\`
${baseUrl}/api/v1
\`\`\``,
};
