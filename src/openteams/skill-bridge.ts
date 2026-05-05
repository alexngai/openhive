/**
 * Skill bridge — translates an openteams `SkillsConfig` into a skill-tree
 * compilation, returning a MaterializedSkills artifact.
 *
 * Bridge mapping (mirrors claude-code-swarm's mergeOpenteamsSkillsIntoCriteria
 * to keep both sides isomorphic):
 *
 *   SkillsConfig.profile      → server.setLoadoutFromProfile(profile)
 *   SkillsConfig.include      → criteria.include  (when no profile)
 *   SkillsConfig.exclude      → criteria.exclude
 *   SkillsConfig.max_tokens   → criteria.maxTokens
 *
 * The skill-bank binding is consumer-side and lives outside openteams'
 * abstraction — see readSkillBankRef in resolver.ts for the canonical
 * extraction (loadout.raw.openhive.skillBankRef → team_template.metadata
 * .defaultSkillBankRef). The bridge takes the resolved id explicitly so
 * the binding policy stays in the resolver, not openteams.
 *
 * If both profile and include/exclude are set, profile wins for v1 — the
 * existing skill-management routes already make that choice. Layered
 * profile+filter compilation can land later if a use case appears.
 *
 * Failure modes degrade rather than fail:
 *   - Missing skill bank resource → returns null
 *   - Profile name not found      → returns null + warns
 *   - SkillsConfig with no skill-bearing fields → returns null
 */

import type { LoadoutCriteria } from 'skill-tree';
import type { SkillsConfig, MaterializedSkills } from './types.js';
import { getServingLayerByResourceId } from '../skill-tree/serving.js';

export interface CompileSkillsContext {
  /** Resource id of the team_template (or loadout) requesting compilation.
   *  Used solely for logging context. */
  ownerContextId?: string;
  /** Skill bank resource id to compile against. Resolved by the caller
   *  from the consumer extension namespace + team-level fallback; null
   *  when no binding is available, in which case compilation is skipped. */
  skillBankRef?: string | null;
}

/**
 * Compile an openteams SkillsConfig into a rendered skill bundle.
 * Returns null when nothing can be compiled (no skill bank, no
 * skill-bearing fields, or compilation failed in a recoverable way).
 */
export async function compileSkillsForLoadout(
  skillsConfig: SkillsConfig | undefined,
  context: CompileSkillsContext = {},
): Promise<MaterializedSkills | null> {
  if (!skillsConfig) return null;

  const skillBankRef = context.skillBankRef ?? null;
  if (!skillBankRef) return null;

  // Skill-bearing input gating — without one of these fields, there's
  // nothing for skill-tree to compile.
  const hasProfile = Boolean(skillsConfig.profile);
  const hasIncludeOrExclude =
    (skillsConfig.include && skillsConfig.include.length > 0) ||
    (skillsConfig.exclude && skillsConfig.exclude.length > 0);
  if (!hasProfile && !hasIncludeOrExclude) return null;

  let serving;
  try {
    serving = await getServingLayerByResourceId(skillBankRef);
  } catch {
    // Resource missing or unreadable — treat as recoverable.
    return null;
  }
  const { server } = serving;

  try {
    if (hasProfile) {
      try {
        await server.setLoadoutFromProfile(skillsConfig.profile!);
      } catch {
        // Profile not found in this skill bank.
        return null;
      }
    } else {
      const criteria: LoadoutCriteria = {};
      if (skillsConfig.include?.length) criteria.include = [...skillsConfig.include];
      if (skillsConfig.exclude?.length) criteria.exclude = [...skillsConfig.exclude];
      if (typeof skillsConfig.max_tokens === 'number') {
        criteria.maxTokens = skillsConfig.max_tokens;
      }
      await server.setLoadout(criteria);
    }

    const rendered = await server.renderSystemPrompt();
    const estimatedTokens = server.estimateTokens();
    const state = server.getState();
    const items = Array.from(state.available.entries()).map(([id, skill]) => ({
      id,
      name: skill.name,
      version: skill.version,
    }));

    return {
      rendered,
      estimatedTokens,
      skillBankResourceId: skillBankRef,
      // skillBankVersion is not exposed by skill-tree's serving layer yet;
      // wire in once a stable identifier is available.
      items,
    };
  } catch {
    return null;
  }
}
