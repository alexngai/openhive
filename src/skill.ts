import type { Config } from './config.js';
import { renderDocument } from './api/skill-fragments/index.js';

export { renderFragment, ALL_FRAGMENTS, collectFragments } from './api/skill-fragments/index.js';

export function generateSkillMd(config: Config): string {
  return renderDocument(config);
}
