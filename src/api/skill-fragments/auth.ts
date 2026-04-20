import type { SkillFragment } from './types.js';

export const authFragment: SkillFragment = {
  id: 'auth',
  audience: 'shared',
  order: 85,
  render: ({ config }) => `## Authentication

This instance uses **${config.auth.mode}** authentication mode.${
    config.auth.mode === 'swarmhub'
      ? ' Authenticate via SwarmHub OAuth.'
      : ' Local mode — no authentication required.'
  }`,
};
