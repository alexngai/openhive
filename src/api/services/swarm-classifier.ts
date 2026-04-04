/**
 * Swarm-Delegated Skill Classification
 *
 * Thin transport adapter: wraps SwarmAgentDelegate as an AgentBackend,
 * then runs skill-tree-indexer's TaskTemplate implementations via
 * agent-workspace's TaskRunner.
 *
 * Domain logic (prompts, schemas, output specs) is owned by skill-tree-indexer.
 * This module handles only: backend wiring, skill iteration, result persistence.
 */

import { TaskRunner, WorkspaceManager, type AgentBackend } from 'agent-workspace';
import type { SkillBank } from 'skill-tree';
import {
  classificationTemplate,
  relationshipTemplate,
  formatTaxonomyNode,
  type ClassificationInput,
  type RelationshipInput,
} from 'skill-tree-indexer';
import type { SwarmAgentDelegate } from '../../learning/swarm-agent-backend.js';

// ── Workspace Manager ─────────────────────────────────────────────────────────

const workspaceManager = new WorkspaceManager({
  prefix: 'openhive-classify',
});

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

// ── Backend Adapter ───────────────────────────────────────────────────────────

function createSwarmBackend(delegate: SwarmAgentDelegate): AgentBackend {
  return {
    spawn: async (config) => {
      const result = await delegate.execute(config.prompt, {
        cwd: config.cwd,
        systemContext: config.systemContext,
        timeoutMs: config.timeout,
      });
      return {
        success: result.success,
        output: result.output,
        structured: result.structured,
      };
    },
  };
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
  const taxonomyStr = taxonomyTree
    ? formatTaxonomyNode(taxonomyTree)
    : '(empty taxonomy - suggest initial categories)';

  const skills = options?.skillId
    ? allSkills.filter(s => s.id === options.skillId)
    : allSkills;

  const backend = createSwarmBackend(delegate);
  const runner = new TaskRunner(workspaceManager, backend);

  for (const skill of skills) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = skill as any;

    if (s.taxonomy?.primaryPath?.length > 0 && !options?.all) {
      result.skipped++;
      continue;
    }

    const input: ClassificationInput = {
      skill: {
        id: s.id,
        name: s.name || s.id,
        description: s.description || '',
        content: (s.instructions || s.description || '').substring(0, 2000),
      },
      taxonomy: taxonomyStr,
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const taskResult = await runner.run(classificationTemplate as any, input);
      const data = taskResult.output as {
        primaryPath: string[];
        secondaryPaths?: string[][];
        confidence?: number;
        suggestedTags?: string[];
      };

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
        ].filter((t: string, i: number, a: string[]) => a.indexOf(t) === i),
      });

      result.indexed++;
    } catch (err) {
      result.failed++;
      result.errors.push(`${s.name || s.id}: ${(err as Error).message}`);
    }
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

  const targetSkills = options?.skillId
    ? skills.filter(s => s.id === options.skillId)
    : skills;

  if (targetSkills.length === 0) return result;

  // Build candidate pairs using keyword overlap
  const pairs: [typeof skills[0], typeof skills[0]][] = [];

  for (const source of targetSkills) {
    const sourceKeywords = extractKeywords(source);
    for (const target of skills) {
      if (source.id === target.id) continue;
      if (source.id > target.id && !options?.skillId) continue;

      const targetKeywords = extractKeywords(target);
      const overlap = jaccardSimilarity(sourceKeywords, targetKeywords);
      if (overlap >= 0.3) {
        pairs.push([source, target]);
      }
    }
  }

  const limitedPairs = pairs.slice(0, 20);
  result.skipped = pairs.length - limitedPairs.length;

  const backend = createSwarmBackend(delegate);
  const runner = new TaskRunner(workspaceManager, backend);

  for (const [skill1, skill2] of limitedPairs) {
    const input: RelationshipInput = {
      skill1: {
        id: skill1.id,
        name: skill1.name || skill1.id,
        description: skill1.description || '',
        content: (skill1.instructions || '').substring(0, 500),
      },
      skill2: {
        id: skill2.id,
        name: skill2.name || skill2.id,
        description: skill2.description || '',
        content: (skill2.instructions || '').substring(0, 500),
      },
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const taskResult = await runner.run(relationshipTemplate as any, input);
      const data = taskResult.output as {
        hasRelationship: boolean;
        type?: string;
        strength?: number;
        reasoning?: string;
      };

      if (data.hasRelationship) {
        const relType = data.type || 'related';
        const strength = data.strength;

        const addRelationship = (skill: typeof skills[0], targetId: string) => {
          const existing = skill.relationships || [];
          if (!existing.some((r: { targetId: string }) => r.targetId === targetId)) {
            existing.push({ targetId, type: relType, strength, reasoning: data.reasoning });
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

  return result;
}

// ── Local Utilities ───────────────────────────────────────────────────────────

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
