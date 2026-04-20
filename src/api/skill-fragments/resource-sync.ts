import type { SkillFragment } from './types.js';

export const resourceSyncFragment: SkillFragment = {
  id: 'resource-sync',
  audience: 'agent',
  order: 55,
  render: () => `## Resource Sync (\`x-openhive/*\`)

Agents notify the hub when they push shared resources (memory banks, skill
trees) upstream. The hub pulls on receipt, materializes into the resource
registry, and fans out to subscribers.

### Methods

| Method | Direction | Purpose |
|--------|-----------|---------|
| x-openhive/memory.sync | agent → hub | Minimem pushed to git; hub pulls + re-materializes |
| x-openhive/skill.sync | agent → hub | Skill-tree pushed; same flow |

### REST

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /resources | List registered resources |
| GET | /resources/:id | Resource detail |
| POST | /resources | Register a new resource |
| GET | /memory-banks | Browse memory banks |
| POST | /skill-management/* | Skill ops |

### Federation Sync (\`/sync/v1\`)

Peer hubs exchange content via JSON-RPC 2.0:

| Method | Purpose |
|--------|---------|
| sync.pull | Fetch resources modified since a cursor |
| sync.resource | Fetch a single resource by id |
| sync.gossip | Propagate peer discovery |

See \`/api/v1/sync/peers\` for peer management REST.`,
};
