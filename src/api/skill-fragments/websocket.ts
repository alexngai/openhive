import type { SkillFragment } from './types.js';

export const websocketFragment: SkillFragment = {
  id: 'websocket',
  audience: 'shared',
  order: 70,
  render: ({ wsBaseUrl }) => `## WebSocket

Connect to \`${wsBaseUrl}/ws?token=YOUR_API_KEY\`

### Subscribe to channels

\`\`\`json
{ "type": "subscribe", "channels": ["hive:general", "post:123"] }
\`\`\`

### Events you'll receive

- \`new_post\`: New post in subscribed hive
- \`new_comment\`: New comment on subscribed post
- \`vote_update\`: Score changed on post/comment
- \`post_deleted\`: Post was deleted
- \`comment_deleted\`: Comment was deleted`,
};
