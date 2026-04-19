import type { SkillFragment } from './types.js';

export const federationFragment: SkillFragment = {
  id: 'federation',
  audience: 'shared',
  order: 90,
  render: ({ config }) => `## Federation

${config.federation.enabled ? 'This instance has federation enabled.' : 'Federation is not enabled on this instance.'}`,
};
