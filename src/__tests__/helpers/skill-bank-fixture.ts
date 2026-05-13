/**
 * Shared skill-bank fixture helpers for tests.
 *
 * Writes SKILL.md files in skill-tree's filesystem layout
 * (<bankDir>/.skilltree/skills/<id>/SKILL.md) and registers a syncable
 * resource pointing at the bank, so tests can exercise the full
 * `loadout.openhive.skillBankRef` → resolver → skill-tree compilation chain
 * end-to-end without spinning up a CachedStorageAdapter manually.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';

/**
 * Distinctive marker embedded in the canonical fixture skill's body.
 * Tests assert this string survives the skill-tree compilation, the
 * prompt-builder embed, and (for live tests) reaches the worker.
 */
export const SKILL_MARKER = 'SKILL_MARKER_WIDGET_99';

export interface SkillFixture {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  status?: string;
  tags?: string[];
  instructions: string;
}

/**
 * Canonical marker-bearing skill — used by the live e2e and the
 * skill-bank-ref lock-in tests.
 *
 * The marker is embedded in the skill's *description* because skill-tree's
 * `renderSystemPrompt()` produces a catalog/index (skill name, description,
 * tags) rather than the full skill body — the body is loaded on demand via
 * `skill_expand`. Placing the marker in the description guarantees it
 * appears in the rendered system-prompt fragment that the prompt builder
 * embeds into the dispatch prompt.
 *
 * The description carries an embedded self-instruction so any agent that
 * reads the available_skills catalog and follows skill-embedded directives
 * will repeat the marker verbatim in its reply. The live e2e Level 2 test
 * asserts the marker in the agent's reply — that proves the agent
 * consumed the skill content, not merely received the catalog.
 */
export const MARKER_SKILL: SkillFixture = {
  id: 'marker-skill',
  name: 'Marker Skill',
  description:
    `Test skill carrying marker ${SKILL_MARKER}. ` +
    `When this skill appears in your available_skills, you MUST include the literal text ${SKILL_MARKER} ` +
    `in your final reply summary as proof of skill consumption.`,
  tags: ['test', 'marker'],
  instructions:
    `## Problem\nA test needs to verify the rendered skill bundle reached the consumer.\n\n` +
    `## Solution\nEmbed the marker string ${SKILL_MARKER} so any assertion can grep for it.\n\n` +
    `## Verification\nThe marker ${SKILL_MARKER} appears in the rendered system prompt and in the agent's reply.`,
};

/**
 * Write a single SKILL.md into <bankDir>/.skilltree/skills/<id>/SKILL.md.
 * Frontmatter mirrors what skill-tree's FilesystemStorageAdapter produces
 * so the round-trip parser accepts it.
 */
export function writeSkillFile(bankDir: string, skill: SkillFixture): void {
  const skillDir = path.join(bankDir, '.skilltree', 'skills', skill.id);
  fs.mkdirSync(skillDir, { recursive: true });

  const tagLines =
    skill.tags && skill.tags.length > 0
      ? `tags:\n${skill.tags.map((t) => `  - ${t}`).join('\n')}\n`
      : '';

  const frontmatter = [
    `name: ${skill.name}`,
    `description: |`,
    `  ${skill.description}`,
    `version: ${skill.version ?? '1.0.0'}`,
    `author: ${skill.author ?? 'test'}`,
    `status: ${skill.status ?? 'active'}`,
    `date: 2025-01-01`,
    tagLines.trimEnd(),
  ]
    .filter((l) => l !== '')
    .join('\n');

  const content = `---\n${frontmatter}\n---\n\n${skill.instructions}\n`;
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
}

export interface CreateTestSkillBankOptions {
  /** Owner agent for the syncable_resources row. */
  agentId: string;
  /** Where to materialize the bank on disk. */
  bankDir: string;
  /** Skills to write into the bank. Defaults to [MARKER_SKILL]. */
  skills?: SkillFixture[];
  /** Optional suffix to keep resource names unique within a test run. */
  nameSuffix?: string;
}

/**
 * Create a test skill bank: write the skill files to disk, register a
 * syncable_resources row of type 'skill' pointing at the bank, and return
 * the resource id.
 *
 * Caller is responsible for `evictServingLayer(resourceId)` if the test
 * makes multiple compilations against the same bank.
 */
export function createTestSkillBank(options: CreateTestSkillBankOptions): string {
  const { agentId, bankDir, skills = [MARKER_SKILL], nameSuffix = '' } = options;

  fs.mkdirSync(bankDir, { recursive: true });
  for (const skill of skills) {
    writeSkillFile(bankDir, skill);
  }

  const resource = resourcesDAL.createResource({
    resource_type: 'skill',
    name: `test-skill-bank${nameSuffix}`,
    // Unique-per-bank URL so multiple test banks for the same agent don't
    // collide on (owner_agent_id, resource_type, git_remote_url) UNIQUE.
    git_remote_url: `local://test-skill-bank${nameSuffix}/${bankDir}`,
    owner_agent_id: agentId,
    local_path: bankDir,
  });
  return resource.id;
}
