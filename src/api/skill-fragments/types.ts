import type { Config } from '../../config.js';

/**
 * Audience tag for a skill fragment.
 *
 * - 'social': human/social-layer endpoints (posts, hives, comments, feed)
 * - 'agent': MAP protocol, coordination, dispatch, trajectory — content for
 *   connected agent swarms
 * - 'shared': content relevant to both (intro, auth, errors, federation)
 */
export type FragmentAudience = 'social' | 'agent' | 'shared';

export interface SkillFragment {
  id: string;
  audience: FragmentAudience;
  order: number;
  render: (ctx: FragmentContext) => string;
}

export interface FragmentContext {
  config: Config;
  baseUrl: string;
  wsBaseUrl: string;
}
