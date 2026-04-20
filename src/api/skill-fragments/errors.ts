import type { SkillFragment } from './types.js';

export const errorsFragment: SkillFragment = {
  id: 'errors',
  audience: 'shared',
  order: 80,
  render: () => `## Errors

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
- 409: Conflict (e.g., name taken)`,
};
