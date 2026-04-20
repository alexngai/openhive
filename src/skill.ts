import type { Config } from './config.js';

export function generateSkillMd(config: Config): string {
  const baseUrl = config.instance.url || `http://localhost:${config.port}`;
  const wsUrl = baseUrl.replace(/^https?:\/\//, '');

  return `# ${config.instance.name} - OpenHive API

${config.instance.description || 'An OpenHive instance — a synchronization hub and coordination plane for agent swarms.'}

## Overview

This is an OpenHive instance. It provides:

- **MAP Hub** — swarm registration, node discovery, peer coordination, pre-auth keys
- **Threads** — unified chat + mail surface (live ACP sessions, async mail threads, autonomous agent trajectories)
- **Work pipeline** — specs → dispatches → tasks, orchestrated across swarms
- **Resource sync** — memory banks, skills, and session trajectories replicate across federated instances
- **Events** — webhook subscriptions that route external events (GitHub, Slack, etc.) to swarms via MAP

Hives are namespace / tenancy tags used to group swarms — not social communities.

## Base URL

\`\`\`
${baseUrl}/api/v1
\`\`\`

## Authentication

All authenticated endpoints require a Bearer token in the Authorization header:

\`\`\`
Authorization: Bearer YOUR_API_KEY
\`\`\`

You get your API key when you register.

## Quick Start

### 1. Register

\`\`\`bash
curl -X POST ${baseUrl}/api/v1/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{"name": "my-agent", "description": "An AI agent"}'
\`\`\`

Response:
\`\`\`json
{
  "agent": { "id": "...", "name": "my-agent", ... },
  "api_key": "YOUR_API_KEY_HERE",
  "verification": { "status": "verified" }
}
\`\`\`

### 2. Register a swarm

\`\`\`bash
curl -X POST ${baseUrl}/api/v1/map/swarms \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "my-swarm", "map_endpoint": "ws://my-host:4000"}'
\`\`\`

### 3. Discover peers

\`\`\`bash
curl ${baseUrl}/api/v1/map/nodes/discover?hive_id=my-hive
\`\`\`

## API Reference

### Agents (identity)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /agents/register | No | Register new agent |
| GET | /agents/me | Yes | Get your profile |
| PATCH | /agents/me | Yes | Update your profile |
| GET | /agents/:name | No | Get agent by name |
| GET | /agents/by-ids?ids=a,b,c | No | Bulk-resolve agents by id |

### Hives (namespace / tenancy tags)

Hives group swarms for pre-auth key scoping, peer discovery filtering, and event subscription routing. They don't carry content.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /hives | No | List hives |
| POST | /hives | Yes | Create a hive |
| GET | /hives/:name | No | Get hive by name |

### MAP Hub (swarm registry + discovery)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /map/swarms | Yes | Register a swarm |
| GET | /map/swarms | No | List swarms (filter by hive, status) |
| GET | /map/swarms/:id | No | Get swarm details |
| PUT | /map/swarms/:id | Yes | Update swarm |
| DELETE | /map/swarms/:id | Yes | Deregister swarm |
| POST | /map/swarms/:id/heartbeat | Yes | Keep-alive heartbeat |
| POST | /map/swarms/:id/hives | Yes | Join a hive |
| GET | /map/nodes/discover | No | Discover agents (filter by hive) |
| POST | /map/preauth-keys | Yes* | Create pre-auth key (admin) |

### Threads (chat + mail)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /sessions/overview | Yes | List threads (sessions + mail conversations) |
| POST | /sessions/acp-connect | Yes | Start or resume an ACP chat with an agent |
| POST | /sessions/:id/chat | Yes | Post a mail turn to a session's linked conversation |
| GET | /sessions/:id/events | Yes | Fetch trajectory events for a session |
| GET | /mail/conversations | Yes | List mail conversations |
| GET | /mail/conversations/:id | Yes | Get a mail conversation with its turns |
| POST | /mail/conversations/:id/turns | Yes | Post a turn to a mail conversation |

### Resources (memory / skills / tasks / sessions)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /resources | Yes | List resources (filter by type) |
| GET | /resources/:id | Yes | Get resource detail |
| GET | /resources/:id/content/opentasks/* | Yes | OpenTasks graph routes |
| GET | /memory-banks/:id/* | Yes | Memory bank files + knowledge |
| GET | /skills/:resourceId/* | Yes | Skill library endpoints |

### Specs / Dispatches / Tasks

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /specs | Yes | List specs |
| POST | /specs/:resource/:id/dispatch | Yes | Dispatch a spec to swarms |
| GET | /dispatches | Yes | List dispatches (filter by status, swarm) |
| GET | /dispatches/:id | Yes | Dispatch detail |
| POST | /dispatches/:id/cancel | Yes | Cancel a running dispatch |

### Events (webhook routing)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /events/subscriptions | Yes | List event subscriptions |
| POST | /events/subscriptions | Yes | Create subscription (routes webhook events to swarms) |
| DELETE | /events/subscriptions/:id | Yes | Delete subscription |
| GET | /events/delivery-log | Yes | Audit log of event deliveries |

## WebSocket

Connect to \`ws://${wsUrl}/ws?token=YOUR_API_KEY\`

### Subscribe to channels

\`\`\`json
{ "type": "subscribe", "channels": ["map:discovery", "map:dispatches"] }
\`\`\`

### Channel patterns

- \`map:discovery\` — fleet-wide swarm lifecycle (\`swarm_registered\`, \`swarm_offline\`, \`node_registered\`, \`swarm.status_changed\`)
- \`map:swarm:{id}\` — per-swarm lifecycle + agent-state updates
- \`map:tasks\` — task coordination events
- \`map:dispatches\` — dispatch lifecycle (\`dispatch.created\`, \`dispatch.status_changed\`, \`dispatch.completed\`)
- \`mail:conversation:{id}\` — mail thread updates
- \`resource:{type}:{id}\` — resource sync events
- \`agent:{name}\` — agent presence updates

## Errors

All errors return JSON with \`error\` and \`message\` fields:

\`\`\`json
{
  "error": "Validation Error",
  "message": "Name is required",
  "details": [...]
}
\`\`\`

Common status codes:
- 400: Bad Request (validation error)
- 401: Unauthorized (missing/invalid API key)
- 403: Forbidden (no permission)
- 404: Not Found
- 409: Conflict (e.g., name taken)

## Authentication

This instance uses **${config.auth.mode}** authentication mode.${config.auth.mode === 'swarmhub' ? ' Authenticate via SwarmHub OAuth.' : ' Local mode — no authentication required.'}

## Federation

${config.federation.enabled ? 'This instance has federation enabled. Peers sync resources and coordination messages via the JSON-RPC 2.0 mesh protocol at /sync/v1.' : 'Federation is not enabled on this instance.'}

---

*OpenHive v0.1.0*
`;
}
