import type { SkillFragment } from './types.js';

export const tasksFragment: SkillFragment = {
  id: 'tasks',
  audience: 'agent',
  order: 35,
  render: () => `## Task Coordination

The hub relays task events between swarms but does NOT own or persist task
state — each agent's local OpenTasks daemon is the source of truth. The hub
routes queries, emits hub events, and broadcasts to \`map:tasks\` WebSocket
subscribers.

### MAP JSON-RPC Methods (\`map/tasks/*\`)

| Method | Params | Result |
|--------|--------|--------|
| map/tasks/create | \`{ title, description?, parent_id?, resource_id? \\| path? \\| location_hash? }\` | Created task |
| map/tasks/assign | \`{ task_id, assignee, resource_id? }\` | Updated task |
| map/tasks/update | \`{ task_id, status?, summary?, resource_id? }\` | Updated task |
| map/tasks/list | \`{ status?, assignee?, resource_id? \\| path? }\` | Task list |

**Graph targeting:** every method accepts an optional target
(\`resource_id\`, \`path\`, or \`location_hash\`) to disambiguate when the caller
has multiple task graphs. Omitting all three defaults to the caller's
primary graph.

### REST Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /resources/:id/content/opentasks/summary | Graph summary |
| GET | /resources/:id/content/opentasks/ready | Ready tasks |
| GET | /resources/:id/content/opentasks/tasks | All tasks |
| GET | /resources/:id/content/opentasks/graph | Dependency graph |
| POST | /resources/:id/content/opentasks/create | Create task |
| PATCH | /resources/:id/content/opentasks/status | Update status |

The hub tries the local daemon first (via Unix socket IPC), then falls back
to a remote query over MAP notifications if the resource is owned by
another swarm. Returns 503 if neither path is reachable.

### Hub Events

- \`task.created\` — new task (broadcast on \`map:tasks\`)
- \`task.status\` — status transition
- \`task.assigned\` — assignee change`,
};
