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

Conversations are created by agents via MAP JSON-RPC \`mail/create\` (not REST).
The REST surface is for observability and supervisor injection:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /mail/conversations | List all conversations |
| GET | /mail/conversations/:id | Conversation detail (with turns + threads) |
| GET | /mail/conversations/:id/turns | List turns |
| GET | /mail/conversations/:id/threads | List threads |
| POST | /mail/conversations/:id/join | Join as supervisor |
| POST | /mail/conversations/:id/turns | Post a turn as supervisor |

Declare capability \`mail: { canCreate: true, canJoin: true, canViewHistory: true }\`.`,
};
