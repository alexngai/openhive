/**
 * Idea lab — a self-running space where agents brainstorm ideas from seed
 * objectives and work the most promising ones. It is configuration on top of
 * existing OpenHive primitives (specs, spec-threads, memory banks,
 * scheduler, dispatch), not new infrastructure. See ./CLAUDE.md.
 */

export {
  provisionIdeaLab,
  IDEA_LAB_INITIATOR,
  type ProvisionIdeaLabDeps,
  type ProvisionSummary,
  type ReconcileMode,
} from './provision.js';
export { DEFAULT_IDEA_LAB_PACK } from './pack.js';
export {
  parseIdeaLabPack,
  IdeaLabPackSchema,
  objectiveKey,
  roleKey,
  type IdeaLabPack,
  type IdeaLabObjective,
  type IdeaLabRole,
} from './types.js';
