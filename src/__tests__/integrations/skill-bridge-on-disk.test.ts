/**
 * Skill bridge on-disk integration test.
 *
 * Replaces the spy-based coverage in dispatch-multi-turn.test.ts with a real
 * end-to-end chain that uses skill-tree's actual filesystem storage adapter.
 *
 * What this proves (that the spy-based test cannot):
 *   - skill-tree's CachedStorageAdapter initialises correctly from a tmpdir
 *   - The SKILL.md frontmatter format is parsed without drift
 *   - setLoadoutFromProfile / setLoadout / renderSystemPrompt produce real output
 *   - token estimation runs against real content
 *   - The rendered string propagates through compileSkillsForLoadout correctly
 *   - The prompt builder places skills.rendered before the spec body (ordering)
 *
 * Cases covered:
 *   1. profile path — setLoadoutFromProfile against a named built-in profile
 *   2. include/exclude path — setLoadout with explicit id lists
 *   3. profile wins when both profile and include are set
 *   4. max_tokens carries through the criteria
 *   5. unknown profile → compileSkillsForLoadout returns null (not throw)
 *   6. non-existent resource id → compileSkillsForLoadout returns null
 *   7. empty skill bank (no skills on disk) → graceful null or empty render
 *
 * Infrastructure:
 *   - real skill bank written to a per-test tmpdir
 *   - real syncable_resources row via createResource DAL
 *   - getServingLayerByResourceId is NOT mocked — the real implementation runs
 *   - evictServingLayer called after each test so the cache does not bleed
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { compileSkillsForLoadout } from '../../openteams/skill-bridge.js';
import { evictServingLayer } from '../../skill-tree/serving.js';
import { openHivePromptBuilder } from '../../dispatch/prompt.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { SkillsConfig, MaterializedSkills } from '../../openteams/types.js';
import type { DispatchTask } from 'swarm-dispatch';
import type { MaterializedLoadout } from '../../openteams/types.js';

// ============================================================================
// Fixture helpers
// ============================================================================

/**
 * Write a minimal SKILL.md into a tmpdir using skill-tree's exact filesystem
 * layout:
 *   <bankDir>/.skilltree/skills/<id>/SKILL.md
 *
 * The frontmatter matches what FilesystemStorageAdapter.buildFrontmatter()
 * produces so the round-trip parser accepts it.
 */
function writeSkillFile(
  bankDir: string,
  skill: {
    id: string;
    name: string;
    description: string;
    version?: string;
    author?: string;
    status?: string;
    tags?: string[];
    instructions: string;
  },
): void {
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

/** Create a real syncable_resources row pointing at bankDir. */
function createSkillResource(agentId: string, bankDir: string, nameSuffix = ''): string {
  const resource = resourcesDAL.createResource({
    resource_type: 'skill',
    name: `test-skill-bank${nameSuffix}`,
    git_remote_url: '',
    owner_agent_id: agentId,
    local_path: bankDir,
  });
  return resource.id;
}

// ============================================================================
// Test setup
// ============================================================================

const TEST_ROOT = testRoot('skill-bridge-on-disk');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'skill-bridge.db');

let agentId: string;

// One security-tagged skill and one general skill for filter tests.
const SECURITY_SKILL = {
  id: 'owasp-top-10',
  name: 'OWASP Top 10',
  description: 'Address the most critical web application security risks.',
  tags: ['security', 'owasp'],
  instructions:
    '## Problem\nMissing security controls expose applications to the OWASP Top 10 risks.\n\n## Solution\nApply input validation, output encoding, and use parameterised queries.\n\n## Verification\nRun OWASP ZAP against the endpoint and confirm no critical findings.',
};

const GENERAL_SKILL = {
  id: 'clean-code',
  name: 'Clean Code',
  description: 'Write readable, maintainable code.',
  tags: ['quality', 'refactoring'],
  instructions:
    '## Problem\nCode that is hard to read leads to bugs and slow iteration.\n\n## Solution\nUse meaningful names, keep functions small, and favour explicitness.\n\n## Verification\nCode review passes without style comments.',
};

beforeAll(async () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  initDatabase(TEST_DB_PATH);
  const { agent } = await agentsDAL.createAgent({ name: 'skill-bridge-test-agent' });
  agentId = agent.id;
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

beforeEach(() => {
  // Wipe resources between tests so each test gets a fresh resource id.
  const db = getDatabase();
  db.prepare('DELETE FROM syncable_resources').run();
  // Re-register the agent subscription that gets cleaned up with resources.
});

afterEach(async () => {
  // Evict any cached serving layers so the next test starts fresh.
  // We don't have the resource ids here, so we rely on short TTL + the
  // beforeEach wipe preventing any cross-test reuse.
});

// ============================================================================
// Helper: build a minimal DispatchTask so we can test prompt ordering.
// ============================================================================
function makeDispatchTask(
  materializedLoadout: MaterializedLoadout,
  specBody = 'The actual spec content goes here.',
): DispatchTask {
  return {
    id: 'dispatch-skill-test',
    title: 'Test dispatch',
    content: specBody,
    metadata: { materializedLoadout },
  } as unknown as DispatchTask;
}

// ============================================================================
// Case 1: profile path — built-in 'security' profile
// ============================================================================

describe('skill-bridge-on-disk integration', () => {
  it('case 1 — profile path: security profile loads security-tagged skills from disk', async () => {
    const bankDir = path.join(TEST_ROOT, 'bank-case-1');
    writeSkillFile(bankDir, SECURITY_SKILL);
    writeSkillFile(bankDir, GENERAL_SKILL);

    const resourceId = createSkillResource(agentId, bankDir, '-case-1');

    const skillsConfig: SkillsConfig = { profile: 'security' };
    const result = await compileSkillsForLoadout(skillsConfig, {
      skillBankRef: resourceId,
    });

    expect(result).not.toBeNull();
    const ms = result as MaterializedSkills;

    // Rendered output is non-empty and contains skills_system XML.
    expect(ms.rendered.length).toBeGreaterThan(0);
    expect(ms.rendered).toContain('<skills_system>');

    // The security skill should appear; the general skill should not (security
    // profile uses tagsAll: ['security'] which filters by that tag).
    expect(ms.rendered).toContain('OWASP Top 10');

    // Token estimate > 0.
    expect(ms.estimatedTokens).toBeGreaterThan(0);

    // items lists the compiled skill(s).
    expect(ms.items.length).toBeGreaterThan(0);
    const ids = ms.items.map((i) => i.id);
    expect(ids).toContain('owasp-top-10');
    expect(ids).not.toContain('clean-code');

    // skillBankResourceId matches.
    expect(ms.skillBankResourceId).toBe(resourceId);

    evictServingLayer(resourceId);
  });

  // ==========================================================================
  // Case 2: include/exclude path
  // ==========================================================================

  it('case 2 — include/exclude path: explicit include pulls target skill; exclude removes it', async () => {
    const bankDir = path.join(TEST_ROOT, 'bank-case-2');
    writeSkillFile(bankDir, SECURITY_SKILL);
    writeSkillFile(bankDir, GENERAL_SKILL);

    const resourceId = createSkillResource(agentId, bankDir, '-case-2');

    // include is a presence guarantee: owasp-top-10 must appear in the result.
    // Without additional filters, other active skills also appear.
    const includeOnly: SkillsConfig = { include: ['owasp-top-10'] };
    const result = await compileSkillsForLoadout(includeOnly, {
      skillBankRef: resourceId,
    });

    expect(result).not.toBeNull();
    const ms = result as MaterializedSkills;
    expect(ms.items.map((i) => i.id)).toContain('owasp-top-10');
    expect(ms.rendered).toContain('OWASP Top 10');

    // Now exclude owasp-top-10 — only clean-code should remain.
    const excludeOwasp: SkillsConfig = { exclude: ['owasp-top-10'] };
    const result2 = await compileSkillsForLoadout(excludeOwasp, {
      skillBankRef: resourceId,
    });

    expect(result2).not.toBeNull();
    const ms2 = result2 as MaterializedSkills;
    expect(ms2.items.map((i) => i.id)).not.toContain('owasp-top-10');
    expect(ms2.items.map((i) => i.id)).toContain('clean-code');

    evictServingLayer(resourceId);
  });

  // ==========================================================================
  // Case 3: profile wins when both profile and include are set
  // ==========================================================================

  it('case 3 — profile wins when both profile and include are specified', async () => {
    const bankDir = path.join(TEST_ROOT, 'bank-case-3');
    writeSkillFile(bankDir, SECURITY_SKILL);
    writeSkillFile(bankDir, GENERAL_SKILL);

    const resourceId = createSkillResource(agentId, bankDir, '-case-3');

    // Both set: profile='security' (should win) + include=['clean-code'].
    const both: SkillsConfig = { profile: 'security', include: ['clean-code'] };
    const result = await compileSkillsForLoadout(both, {
      skillBankRef: resourceId,
    });

    // Profile wins → setLoadoutFromProfile('security') is called.
    // security profile uses tagsAll: ['security'], so only owasp-top-10 matches.
    expect(result).not.toBeNull();
    const ms = result as MaterializedSkills;
    const ids = ms.items.map((i) => i.id);
    expect(ids).toContain('owasp-top-10');
    // clean-code is NOT included — the profile path, not include/exclude path, ran.
    expect(ids).not.toContain('clean-code');

    evictServingLayer(resourceId);
  });

  // ==========================================================================
  // Case 4: max_tokens carries through criteria
  // ==========================================================================

  it('case 4 — max_tokens: skill budget is respected when include path is used', async () => {
    const bankDir = path.join(TEST_ROOT, 'bank-case-4');

    // Write 5 small skills to test token budget.
    for (let i = 0; i < 5; i++) {
      writeSkillFile(bankDir, {
        id: `budget-skill-${i}`,
        name: `Budget Skill ${i}`,
        description: `Skill number ${i} for token budget testing.`,
        tags: ['budget'],
        instructions: `## Problem\nProblem ${i}.\n\n## Solution\nSolution ${i}.\n\n## Verification\nVerify ${i}.`,
      });
    }

    const resourceId = createSkillResource(agentId, bankDir, '-case-4');

    // Very tight token budget — should compile fewer skills than the total.
    // A single skill above is ~50 tokens; budget of 80 should get exactly 1.
    const tightBudget: SkillsConfig = { include: ['budget-skill-0', 'budget-skill-1', 'budget-skill-2', 'budget-skill-3', 'budget-skill-4'], max_tokens: 80 };
    const result = await compileSkillsForLoadout(tightBudget, {
      skillBankRef: resourceId,
    });

    expect(result).not.toBeNull();
    const ms = result as MaterializedSkills;

    // With a tight budget, fewer than all 5 skills should appear.
    expect(ms.items.length).toBeLessThan(5);
    expect(ms.estimatedTokens).toBeGreaterThan(0);

    evictServingLayer(resourceId);
  });

  // ==========================================================================
  // Case 5: unknown profile → returns null, not throw
  // ==========================================================================

  it('case 5 — unknown profile: compileSkillsForLoadout returns null gracefully', async () => {
    const bankDir = path.join(TEST_ROOT, 'bank-case-5');
    writeSkillFile(bankDir, SECURITY_SKILL);

    const resourceId = createSkillResource(agentId, bankDir, '-case-5');

    const unknownProfile: SkillsConfig = { profile: 'this-profile-does-not-exist-anywhere' };
    const result = await compileSkillsForLoadout(unknownProfile, {
      skillBankRef: resourceId,
    });

    // Bridge catches the "Profile not found" error and returns null.
    expect(result).toBeNull();

    evictServingLayer(resourceId);
  });

  // ==========================================================================
  // Case 6: non-existent resource id → returns null
  // ==========================================================================

  it('case 6 — missing resource: compileSkillsForLoadout returns null when resource id does not exist', async () => {
    const skillsConfig: SkillsConfig = { profile: 'security' };
    const result = await compileSkillsForLoadout(skillsConfig, {
      skillBankRef: 'res_does_not_exist_xyz',
    });

    expect(result).toBeNull();
  });

  // ==========================================================================
  // Case 7: empty skill bank (no skill files on disk)
  // ==========================================================================

  it('case 7 — empty skill bank: compileSkillsForLoadout handles bank with no skills', async () => {
    const bankDir = path.join(TEST_ROOT, 'bank-case-7');
    // Create the .skilltree/skills directory but write no skill files.
    fs.mkdirSync(path.join(bankDir, '.skilltree', 'skills'), { recursive: true });

    const resourceId = createSkillResource(agentId, bankDir, '-case-7');

    // Use include path with an id that doesn't exist — should compile an empty set.
    const skillsConfig: SkillsConfig = { include: ['nonexistent-skill'] };
    const result = await compileSkillsForLoadout(skillsConfig, {
      skillBankRef: resourceId,
    });

    // Either null (if bridge treats empty render as failure) or a valid empty result.
    if (result !== null) {
      // Rendered may be a skills_system wrapper with no skills inside — that's fine.
      expect(result.rendered).toBeDefined();
      expect(result.items).toHaveLength(0);
    } else {
      // null is also acceptable for an entirely empty bank.
      expect(result).toBeNull();
    }

    evictServingLayer(resourceId);
  });

  // ==========================================================================
  // Prompt ordering: skills.rendered appears before spec body
  // ==========================================================================

  it('prompt ordering: skills.rendered is placed before the spec body in a first-run prompt', async () => {
    const bankDir = path.join(TEST_ROOT, 'bank-ordering');
    writeSkillFile(bankDir, SECURITY_SKILL);

    const resourceId = createSkillResource(agentId, bankDir, '-ordering');

    const skillsConfig: SkillsConfig = { profile: 'security' };
    const compiled = await compileSkillsForLoadout(skillsConfig, {
      skillBankRef: resourceId,
    });

    expect(compiled).not.toBeNull();

    // Build a MaterializedLoadout carrying the compiled skills.
    const loadout: MaterializedLoadout = {
      capabilities: [],
      mcpScope: [],
      mcpProviders: [],
      permissions: { allow: [], deny: [], ask: [] },
      promptAddendum: '## Role addendum',
      skills: compiled,
      unresolvedRefs: [],
      materializedAt: new Date().toISOString(),
    };

    const task = makeDispatchTask(loadout, 'The actual spec content goes here.');
    const prompt = openHivePromptBuilder(task, {
      attempt: 1,
      turnCount: 0,
      role: 'security-reviewer',
    }) as string;

    // skills.rendered must come before the spec body.
    const skillsIdx = prompt.indexOf('<skills_system>');
    const bodyIdx = prompt.indexOf('The actual spec content goes here.');

    expect(skillsIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(skillsIdx);

    // Addendum appears after the spec body.
    const addendumIdx = prompt.indexOf('## Role addendum');
    expect(addendumIdx).toBeGreaterThan(bodyIdx);

    // Role line appears at the end.
    expect(prompt).toContain('Role: security-reviewer');
    const roleIdx = prompt.indexOf('Role: security-reviewer');
    expect(roleIdx).toBeGreaterThan(addendumIdx);

    evictServingLayer(resourceId);
  });

  // ==========================================================================
  // No skill bank ref → returns null without touching skill-tree
  // ==========================================================================

  it('no skillBankRef: compileSkillsForLoadout returns null immediately when ref is null', async () => {
    const skillsConfig: SkillsConfig = { profile: 'security' };
    const result = await compileSkillsForLoadout(skillsConfig, {
      skillBankRef: null,
    });
    expect(result).toBeNull();
  });

  it('no skillsConfig: compileSkillsForLoadout returns null when config is undefined', async () => {
    const result = await compileSkillsForLoadout(undefined, {
      skillBankRef: 'res_some_ref',
    });
    expect(result).toBeNull();
  });

  it('empty skillsConfig (no profile, no include/exclude): compileSkillsForLoadout returns null', async () => {
    const bankDir = path.join(TEST_ROOT, 'bank-empty-config');
    writeSkillFile(bankDir, SECURITY_SKILL);

    const resourceId = createSkillResource(agentId, bankDir, '-empty-config');

    // Neither profile nor include/exclude — bridge gates early.
    const skillsConfig: SkillsConfig = {};
    const result = await compileSkillsForLoadout(skillsConfig, {
      skillBankRef: resourceId,
    });
    expect(result).toBeNull();

    evictServingLayer(resourceId);
  });
});
