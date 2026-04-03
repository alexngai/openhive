/**
 * Swarm-Delegated Skill Classification
 *
 * Dispatches skill classification and relationship detection tasks to a
 * connected swarm agent via SwarmAgentDelegate, instead of requiring a
 * direct Anthropic API key. Uses agent-workspace for structured I/O and
 * output validation. Reuses the same prompt templates as the
 * skill-tree-indexer's SkillClassifier.
 */

import { z } from 'zod';
import { WorkspaceManager } from 'agent-workspace';
import type { WorkspaceHandle } from 'agent-workspace';
import type { SkillBank } from 'skill-tree';
import type { SwarmAgentDelegate } from '../../learning/swarm-agent-backend.js';

// ── Workspace Manager (shared, auto-cleans old workspaces) ────────────────────

const workspaceManager = new WorkspaceManager({
  prefix: 'openhive-classify',
});

// ── Output Schemas ────────────────────────────────────────────────────────────

const ClassificationOutputSchema = z.object({
  primaryPath: z.array(z.string()).min(1),
  secondaryPaths: z.array(z.array(z.string())).optional().default([]),
  confidence: z.number().min(0).max(1).optional().default(0.8),
  reasoning: z.string().optional().default('No reasoning provided'),
  suggestedNewCategories: z.array(z.object({
    path: z.array(z.string()),
    reasoning: z.string(),
  })).optional(),
  relationships: z.array(z.object({
    skillSlug: z.string(),
    type: z.string(),
    reasoning: z.string(),
  })).optional(),
  suggestedTags: z.array(z.string()).optional().default([]),
});

const RelationshipOutputSchema = z.object({
  hasRelationship: z.boolean(),
  type: z.enum(['depends_on', 'extends', 'alternative', 'related']).optional(),
  strength: z.number().min(0).max(1).optional().default(0.7),
  reasoning: z.string().optional().default(''),
});

// ── Prompt Templates ──────────────────────────────────────────────────────────
// Mirrors scraper/src/indexer/classifier.ts CLASSIFICATION_PROMPT

const CLASSIFICATION_PROMPT = `You are an expert at organizing software development skills into a hierarchical taxonomy.

Given a skill definition, classify it into the most appropriate category path(s).

## Skill to Classify

Name: {{name}}
Description: {{description}}

Content (first 2000 chars):
{{content}}

## Current Taxonomy
{{taxonomy}}

## Instructions

1. Determine the PRIMARY category path where this skill best fits
2. Optionally suggest SECONDARY paths if the skill fits multiple categories
3. If no existing category fits well, suggest a NEW category with reasoning
4. Identify any potential relationships to other skills based on the content

## Category Guidelines

Use these top-level categories:
- Development (programming, frameworks, testing)
- Infrastructure (cloud, DevOps, containers)
- AI-ML (machine learning, LLMs, data science)
- Productivity (automation, workflows, tools)
- Communication (messaging, email, social)
- Data (databases, analytics, visualization)
- Security (auth, encryption, scanning)
- Integration (APIs, webhooks, connectors)

Create subcategories as needed (2-4 levels deep).

## Response Format

Write your response as a JSON file to output/classification.json:

{
  "primaryPath": ["Category", "Subcategory", "SubSubcategory"],
  "secondaryPaths": [["AltCategory", "AltSub"]],
  "confidence": 0.85,
  "reasoning": "This skill is primarily about X because...",
  "suggestedNewCategories": [
    {
      "path": ["New", "Category"],
      "reasoning": "Why this category should exist"
    }
  ],
  "relationships": [
    {
      "skillSlug": "related-skill-name",
      "type": "extends",
      "reasoning": "How they relate"
    }
  ],
  "suggestedTags": ["tag1", "tag2", "tag3"]
}`;

// Mirrors scraper/src/indexer/relationships.ts AI_RELATIONSHIP_PROMPT

const AI_RELATIONSHIP_PROMPT = `Analyze the relationship between these two skills and determine if they are related.

## Skill 1: {{skill1_name}}
{{skill1_description}}

Content (first 500 chars):
{{skill1_content}}

## Skill 2: {{skill2_name}}
{{skill2_description}}

Content (first 500 chars):
{{skill2_content}}

## Instructions
Determine if these skills have a meaningful relationship. If they do, classify the relationship type.

Relationship types:
- depends_on: Skill 1 requires Skill 2 to function
- extends: Skill 1 builds upon or enhances Skill 2
- alternative: Skill 1 can be used instead of Skill 2
- related: Skills work well together or share common concepts

Write your response as a JSON file to output/relationship.json:
{
  "hasRelationship": true/false,
  "type": "depends_on" | "extends" | "alternative" | "related",
  "strength": 0.0-1.0,
  "reasoning": "Brief explanation of the relationship"
}

If no meaningful relationship exists, set hasRelationship to false.`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface TaxonomyNode {
  name: string;
  skillCount: number;
  children: TaxonomyNode[];
}

interface ClassifyResult {
  indexed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

interface RelationshipResult {
  detected: number;
  skipped: number;
  errors: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTaxonomy(node: TaxonomyNode, indent = 0): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  if (node.name !== 'Root') {
    const count = node.skillCount > 0 ? ` (${node.skillCount} skills)` : '';
    lines.push(`${prefix}- ${node.name}${count}`);
  }

  for (const child of node.children) {
    lines.push(formatTaxonomy(child, indent + 1));
  }

  return lines.join('\n') || '(empty taxonomy - suggest initial categories)';
}

/**
 * Extract first JSON object from text, handling markdown fences and surrounding prose.
 * Used as fallback when the agent writes to stdout instead of output/.
 */
function extractJSON(text: string): unknown {
  let clean = text.trim();

  // Strip markdown code fences
  if (clean.startsWith('```')) {
    clean = clean.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  // Try direct parse first
  try {
    return JSON.parse(clean);
  } catch { /* fall through */ }

  // Extract first { ... } block
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch { /* fall through */ }
  }

  throw new Error(`Could not extract JSON from response: ${text.slice(0, 200)}`);
}

/**
 * Read validated output from workspace, falling back to parsing the delegate response text.
 */
async function readOutput<T>(
  handle: WorkspaceHandle,
  fileName: string,
  schema: z.ZodType<T>,
  responseText: string,
): Promise<T> {
  // Try reading from workspace output/ first
  try {
    const data = await handle.readJson('output', fileName, { schema });
    return data;
  } catch { /* file not written — fall back to response text */ }

  // Fall back to parsing the delegate's text response
  const raw = extractJSON(responseText);
  return schema.parse(raw);
}

// ── Classification ────────────────────────────────────────────────────────────

export async function classifyViaSwarm(
  delegate: SwarmAgentDelegate,
  bank: SkillBank,
  taxonomyTree: TaxonomyNode | null,
  options?: { skillId?: string; all?: boolean },
): Promise<ClassifyResult> {
  const result: ClassifyResult = { indexed: 0, skipped: 0, failed: 0, errors: [] };
  const allSkills = await bank.listSkills();
  const taxonomyStr = taxonomyTree ? formatTaxonomy(taxonomyTree) : '(empty taxonomy - suggest initial categories)';

  const skills = options?.skillId
    ? allSkills.filter(s => s.id === options.skillId)
    : allSkills;

  // Create a workspace for this classification batch
  const handle = await workspaceManager.create('skill-classification');

  try {
    for (const skill of skills) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = skill as any;

      // Skip already classified unless forced
      if (s.taxonomy?.primaryPath?.length > 0 && !options?.all) {
        result.skipped++;
        continue;
      }

      // Write skill data to input/
      await handle.writeJson('input', 'skill.json', {
        id: s.id,
        name: s.name || s.id,
        description: s.description || '',
        content: (s.instructions || s.description || '').substring(0, 2000),
      });
      await handle.writeRaw('input', 'taxonomy.txt', taxonomyStr);

      const prompt = CLASSIFICATION_PROMPT
        .replace('{{name}}', s.name || s.id)
        .replace('{{description}}', s.description || '')
        .replace('{{content}}', (s.instructions || s.description || '').substring(0, 2000))
        .replace('{{taxonomy}}', taxonomyStr);

      try {
        const response = await delegate.execute(prompt, {
          cwd: handle.path,
          systemContext: 'You are a skill classification agent. Write your JSON response to output/classification.json. If you cannot write files, respond with ONLY valid JSON.',
        });

        if (!response.success) {
          result.failed++;
          result.errors.push(`${s.name || s.id}: ${response.output || 'Agent execution failed'}`);
          continue;
        }

        const data = await readOutput(
          handle,
          'classification.json',
          ClassificationOutputSchema,
          response.output,
        );

        // Write classification back to skill
        await bank.saveSkill({
          ...s,
          taxonomy: {
            primaryPath: data.primaryPath,
            secondaryPaths: data.secondaryPaths,
            confidence: data.confidence,
          },
          tags: [
            ...(s.tags || []),
            ...(data.suggestedTags || []),
          ].filter((t: string, i: number, a: string[]) => a.indexOf(t) === i), // dedupe
        });

        result.indexed++;
      } catch (err) {
        result.failed++;
        result.errors.push(`${s.name || s.id}: ${(err as Error).message}`);
      }
    }
  } finally {
    await workspaceManager.cleanup(handle);
  }

  return result;
}

// ── Relationship Detection ────────────────────────────────────────────────────

export async function detectRelationshipsViaSwarm(
  delegate: SwarmAgentDelegate,
  bank: SkillBank,
  options?: { skillId?: string },
): Promise<RelationshipResult> {
  const result: RelationshipResult = { detected: 0, skipped: 0, errors: [] };
  const allSkills = await bank.listSkills();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skills = allSkills as any[];

  // If a specific skill is given, only check pairs involving it
  const targetSkills = options?.skillId
    ? skills.filter(s => s.id === options.skillId)
    : skills;

  if (targetSkills.length === 0) return result;

  // Build candidate pairs using keyword overlap (avoid O(n^2) swarm calls)
  const pairs: [typeof skills[0], typeof skills[0]][] = [];

  for (const source of targetSkills) {
    const sourceKeywords = extractKeywords(source);
    for (const target of skills) {
      if (source.id === target.id) continue;
      if (source.id > target.id && !options?.skillId) continue; // dedupe unordered pairs

      const targetKeywords = extractKeywords(target);
      const overlap = jaccardSimilarity(sourceKeywords, targetKeywords);
      if (overlap >= 0.3) {
        pairs.push([source, target]);
      }
    }
  }

  // Limit to top 20 pairs by similarity to avoid excessive swarm calls
  const limitedPairs = pairs.slice(0, 20);
  result.skipped = pairs.length - limitedPairs.length;

  // Create a workspace for this relationship batch
  const handle = await workspaceManager.create('skill-relationships');

  try {
    for (const [skill1, skill2] of limitedPairs) {
      // Write pair data to input/
      await handle.writeJson('input', 'pair.json', {
        skill1: { id: skill1.id, name: skill1.name, description: skill1.description },
        skill2: { id: skill2.id, name: skill2.name, description: skill2.description },
      });

      const prompt = AI_RELATIONSHIP_PROMPT
        .replace('{{skill1_name}}', skill1.name || skill1.id)
        .replace('{{skill1_description}}', skill1.description || '')
        .replace('{{skill1_content}}', (skill1.instructions || '').substring(0, 500))
        .replace('{{skill2_name}}', skill2.name || skill2.id)
        .replace('{{skill2_description}}', skill2.description || '')
        .replace('{{skill2_content}}', (skill2.instructions || '').substring(0, 500));

      try {
        const response = await delegate.execute(prompt, {
          cwd: handle.path,
          systemContext: 'You are a skill relationship analyst. Write your JSON response to output/relationship.json. If you cannot write files, respond with ONLY valid JSON.',
        });

        if (!response.success) {
          result.errors.push(`${skill1.id} ↔ ${skill2.id}: Agent failed`);
          continue;
        }

        const data = await readOutput(
          handle,
          'relationship.json',
          RelationshipOutputSchema,
          response.output,
        );

        if (data.hasRelationship) {
          const relType = data.type || 'related';
          const strength = data.strength;

          const addRelationship = (skill: typeof skills[0], targetId: string) => {
            const existing = skill.relationships || [];
            if (!existing.some((r: { targetId: string }) => r.targetId === targetId)) {
              existing.push({
                targetId,
                type: relType,
                strength,
                reasoning: data.reasoning,
              });
              return { ...skill, relationships: existing };
            }
            return null;
          };

          const updated1 = addRelationship(skill1, skill2.id);
          const updated2 = addRelationship(skill2, skill1.id);

          if (updated1) await bank.saveSkill(updated1);
          if (updated2) await bank.saveSkill(updated2);

          result.detected++;
        }
      } catch (err) {
        result.errors.push(`${skill1.id} ↔ ${skill2.id}: ${(err as Error).message}`);
      }
    }
  } finally {
    await workspaceManager.cleanup(handle);
  }

  return result;
}

function extractKeywords(skill: { name?: string; description?: string; tags?: string[] }): Set<string> {
  const text = `${skill.name || ''} ${skill.description || ''} ${(skill.tags || []).join(' ')}`.toLowerCase();
  const words = text.split(/[\s/\-_.,;:()[\]{}]+/).filter(w => w.length > 2);
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}
