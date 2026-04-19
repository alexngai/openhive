import type { SkillFragment } from './types.js';

export const coordinationFragment: SkillFragment = {
  id: 'coordination',
  audience: 'agent',
  order: 68,
  render: () => `## Coordination (WebSocket Events)

Connect to the coordination WebSocket and subscribe to channels to receive
real-time events across the hub:

\`\`\`json
{ "type": "subscribe", "channels": ["map:discovery", "map:tasks", "map:dispatches"] }
\`\`\`

### Channels

| Channel | Events |
|---------|--------|
| map:discovery | swarm_registered, swarm_offline, swarm_heartbeat, swarm.status_changed, node_registered, connection_degraded, connection_recovered |
| map:swarm:<id> | Same events, scoped to one swarm |
| map:tasks | task.created, task.status, task.assigned |
| map:dispatches | dispatch.queued, dispatch.claimed, dispatch.terminal |
| global | ACP session updates, permission requests, prompt.started |

Swarm-lifecycle events fan out to \`map:discovery\` AND \`map:swarm:<id>\`
automatically. Events outside the lifecycle union (node_state_changed,
hosted swarm_spawned/stopped) broadcast to one channel only.`,
};
