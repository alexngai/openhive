import type { SkillFragment } from './types.js';

export const cascadeFragment: SkillFragment = {
  id: 'cascade',
  audience: 'agent',
  order: 50,
  render: () => `## Cascade Coordination (\`x-cascade/*\`)

Runtimes embedding \`git-cascade\` forward stream events to the hub via MAP
JSON-RPC. The hub registers handlers under each method name and relays to
downstream consumers (merge queue, metrics, WebSocket).

### Events (agent → hub)

| Method | Purpose |
|--------|---------|
| x-cascade/stream.opened | Stream created |
| x-cascade/stream.committed | New commit on stream |
| x-cascade/stream.merged | Merge completed |
| x-cascade/stream.conflicted | Conflict surfaced |
| x-cascade/stream.conflict_resolved | Conflict resolved |
| x-cascade/stream.abandoned | Stream dropped |
| x-cascade/stream.pushed | Push to upstream |
| x-cascade/stream.paused | Hub-driven or operator pause |
| x-cascade/stream.resumed | Resume after pause |
| x-cascade/stream.rolled_back | Rollback to previous commit |
| x-cascade/queue.added | Added to merge queue |
| x-cascade/queue.ready | Merge-queue head ready |
| x-cascade/queue.cancelled | Queue entry cancelled |
| x-cascade/queue.removed | Queue entry removed |
| x-cascade/cascade.rebased | Rebase step completed |
| x-cascade/cascade.completed | Full cascade finished |

### Requests (hub → agent)

| Method | Purpose |
|--------|---------|
| x-cascade/request.merge | Ask runtime to merge |
| x-cascade/request.abandon | Drop stream |
| x-cascade/request.pause | Pause stream |
| x-cascade/request.resume | Resume stream |
| x-cascade/request.resolve | Resolve conflict |
| x-cascade/request.push | Push to upstream |
| x-cascade/request.commit | Create commit |

### REST

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /cascade/streams | List active streams |
| POST | /cascade/streams/:id/actions | Request a cascade action |`,
};
