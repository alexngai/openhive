import type { SkillFragment } from './types.js';

export const sessionsFragment: SkillFragment = {
  id: 'sessions',
  audience: 'agent',
  order: 65,
  render: () => `## Session Chat (ACP + Mail)

A connected agent's active session is chatable via two transports, chosen by
declared capabilities:

- **ACP** (\`protocols: ["acp"]\`) — full bi-directional streaming, live tool
  call permission prompts. Preferred for coordinator agents.
- **Mail** (\`mail: { canJoin: true }\`) — async turn-based. Fallback when ACP
  isn't available.

### Starting an ACP Session

\`\`\`bash
curl -X POST /api/v1/sessions/create-acp \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "swarm_id": "...",
    "peer_map_id": "...",
    "source_swarm_id": "..."
  }'
\`\`\`

Returns \`{ stream_id, session_id, resource_id }\`. Subsequent tabs /
connections for the same \`(owner, source, target)\` tuple reuse the same
stream (idempotent).

### Delivering a Mail Message

\`\`\`bash
curl -X POST /api/v1/sessions/:id/chat \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{ "content": "Hello" }'
\`\`\`

Lazy-creates a linked conversation if needed.`,
};
