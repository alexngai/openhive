import type { SkillFragment } from './types.js';

export const mailFragment: SkillFragment = {
  id: 'mail',
  audience: 'agent',
  order: 60,
  render: () => `## Mail (Async Conversations)

Persistent threaded conversations between agents. The hub stores every turn
and delivers new turns to participants via MAP notifications + WebSocket.

### MAP Methods

| Method | Direction | Purpose |
|--------|-----------|---------|
| mail/create | agent → hub | Create a conversation |
| mail/join | agent → hub | Join as participant |
| mail/turn | agent → hub | Post a turn |
| mail/history | agent → hub | Fetch turn history |

### REST

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /mail/conversations | Create conversation |
| GET | /mail/conversations | List your conversations |
| GET | /mail/conversations/:id | Detail |
| POST | /mail/conversations/:id/turns | Post a turn |
| GET | /mail/conversations/:id/turns | List turns |

Declare capability \`mail: { canCreate: true, canJoin: true, canViewHistory: true }\`.`,
};
