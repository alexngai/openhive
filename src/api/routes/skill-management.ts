/**
 * Skill Management Routes
 *
 * Provides skill CRUD, import/export/bootstrap, and loadout management.
 * All operations delegate to the skill-tree library — OpenHive is a thin
 * API layer; skill-tree's filesystem storage is the source of truth.
 */
import { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import {
  createSkillBank,
  createAgentsParser,
  builtInProfiles,
  type SkillBank,
  type SkillGraphServer,
  type LoadoutCriteria,
  type LoadoutState,
} from 'skill-tree';
import { authMiddleware } from '../middleware/auth.js';
import { resolveResourceAndPath } from './_resource-helpers.js';
import { broadcastToChannel } from '../../realtime/index.js';
import type { Config } from '../../config.js';

// ============================================================================
// Serving Layer Cache (mirrors minimemCache pattern in resource-content.ts)
// ============================================================================

interface CachedServingLayer {
  bank: SkillBank;
  server: SkillGraphServer;
  timer: ReturnType<typeof setTimeout>;
}

const servingLayerCache = new Map<string, CachedServingLayer>();
const SERVING_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function evictServingLayer(resourceId: string): void {
  const cached = servingLayerCache.get(resourceId);
  if (cached) {
    cached.bank.shutdown().catch(() => {});
    clearTimeout(cached.timer);
    servingLayerCache.delete(resourceId);
  }
}

async function getServingLayer(resourceId: string, localPath: string): Promise<{ bank: SkillBank; server: SkillGraphServer }> {
  const cached = servingLayerCache.get(resourceId);
  if (cached) {
    clearTimeout(cached.timer);
    cached.timer = setTimeout(() => evictServingLayer(resourceId), SERVING_CACHE_TTL);
    return { bank: cached.bank, server: cached.server };
  }

  const bank = createSkillBank({ storage: { basePath: localPath } });
  await bank.initialize();
  const { server } = await bank.createServingLayer();

  const timer = setTimeout(() => evictServingLayer(resourceId), SERVING_CACHE_TTL);
  servingLayerCache.set(resourceId, { bank, server, timer });
  return { bank, server };
}

// ============================================================================
// Indexer Cache
// ============================================================================

interface CachedIndexer {
  bank: SkillBank;
  indexer: InstanceType<typeof import('skill-tree').IndexerService>;
  timer: ReturnType<typeof setTimeout>;
}

const indexerCache = new Map<string, CachedIndexer>();
const INDEXER_CACHE_TTL = 10 * 60 * 1000;

function evictIndexer(resourceId: string): void {
  const cached = indexerCache.get(resourceId);
  if (cached) {
    cached.bank.shutdown().catch(() => {});
    clearTimeout(cached.timer);
    indexerCache.delete(resourceId);
  }
}

async function getIndexer(resourceId: string, localPath: string) {
  const cached = indexerCache.get(resourceId);
  if (cached) {
    clearTimeout(cached.timer);
    cached.timer = setTimeout(() => evictIndexer(resourceId), INDEXER_CACHE_TTL);
    return { bank: cached.bank, indexer: cached.indexer };
  }

  const { IndexerService } = await import('skill-tree');
  const scraperModules = await import('skill-tree-indexer');

  const bank = createSkillBank({ storage: { basePath: localPath } });
  await bank.initialize();

  const cacheDir = join(tmpdir(), 'openhive-scraper', resourceId);
  const databasePath = join(cacheDir, 'skills.db');

  const indexer = new IndexerService({
    githubToken: process.env.GITHUB_TOKEN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    scraperModules,
    cacheDir,
    databasePath,
  }, bank);
  await indexer.initialize();

  const timer = setTimeout(() => evictIndexer(resourceId), INDEXER_CACHE_TTL);
  indexerCache.set(resourceId, { bank, indexer, timer });
  return { bank, indexer };
}

// ============================================================================
// Serialization Helpers
// ============================================================================

function serializeLoadoutState(state: LoadoutState) {
  return {
    available: Array.from(state.available.entries()).map(([id, skill]) => ({
      id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags || [],
      status: skill.status || null,
      expanded: state.expanded.has(id),
    })),
    expanded: Array.from(state.expanded),
    pending: Array.from(state.pending),
    source: state.source,
    updatedAt: state.updatedAt.toISOString(),
  };
}

// ============================================================================
// Zod Schemas
// ============================================================================

const SaveSkillSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().default(''),
  problem: z.string().default(''),
  solution: z.string().default(''),
  verification: z.string().default(''),
  tags: z.array(z.string()).default([]),
  status: z.enum(['active', 'draft', 'deprecated', 'experimental']).default('draft'),
  triggerConditions: z.array(z.object({
    type: z.enum(['error', 'pattern', 'context', 'keyword']),
    value: z.string(),
    description: z.string().optional(),
  })).default([]),
  examples: z.array(z.object({
    scenario: z.string(),
    before: z.string().optional(),
    after: z.string().optional(),
  })).default([]),
  author: z.string().optional(),
  version: z.string().default('1.0.0'),
}).passthrough();

const CreateVersionSchema = z.object({
  updates: z.record(z.unknown()),
  changelog: z.string().optional(),
  bumpType: z.enum(['major', 'minor', 'patch']).optional(),
});

const ForkSkillSchema = z.object({
  newId: z.string().optional(),
  newName: z.string().optional(),
  modifications: z.record(z.unknown()).optional(),
});

const RollbackSchema = z.object({
  toVersion: z.string(),
});

const ImportSchema = z.object({
  format: z.enum(['json', 'agents-md', 'indexer']).optional(),
  content: z.union([z.string(), z.array(z.unknown()), z.record(z.unknown())]),
});

const CompileLoadoutSchema = z.object({
  // Profile-based
  profile: z.string().optional(),
  // Task-based
  taskDescription: z.string().optional(),
  // Criteria-based (when neither profile nor taskDescription)
  tags: z.array(z.string()).optional(),
  tagsAll: z.array(z.string()).optional(),
  status: z.array(z.enum(['active', 'draft', 'deprecated', 'experimental'])).optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  maxSkills: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
  priorityOrder: z.enum(['relevance', 'usage', 'successRate', 'recent']).optional(),
}).passthrough();

// ============================================================================
// Route Registration
// ============================================================================

export async function skillManagementRoutes(
  fastify: FastifyInstance,
  _options: { config: Config },
): Promise<void> {

  /** Broadcast skill mutation event for realtime invalidation */
  function notifySkillChange(resourceId: string): void {
    broadcastToChannel(`resource:skill:${resourceId}`, {
      type: 'skill:sync',
      data: { resourceId },
    });
    // Evict loadout cache on mutation so it picks up changes
    evictServingLayer(resourceId);
  }

  // ============================================================================
  // Skill CRUD
  // ============================================================================

  // Create a new skill
  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/skills', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const body = SaveSkillSchema.parse(request.body);
    const skill = {
      ...body,
      id: body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    };

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await bank.saveSkill(skill as any);
      notifySkillChange(resource.id);
      return reply.status(201).send({ id: skill.id, created: true });
    } finally {
      await bank.shutdown();
    }
  });

  // Update an existing skill
  fastify.put<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/skills/:skillId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    const body = SaveSkillSchema.partial().parse(request.body);

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const existing = await bank.getSkill(skillId);
      if (!existing) {
        return reply.status(404).send({ error: 'Not Found', message: `Skill "${skillId}" not found` });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await bank.saveSkill({ ...existing, ...body, id: skillId } as any);
      notifySkillChange(resource.id);
      return reply.send({ id: skillId, updated: true });
    } finally {
      await bank.shutdown();
    }
  });

  // Delete a skill
  fastify.delete<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/skills/:skillId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const deleted = await bank.deleteSkill(skillId);
      if (!deleted) {
        return reply.status(404).send({ error: 'Not Found', message: `Skill "${skillId}" not found` });
      }
      notifySkillChange(resource.id);
      return reply.status(204).send();
    } finally {
      await bank.shutdown();
    }
  });

  // Deprecate a skill
  fastify.post<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/skills/:skillId/deprecate', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const skill = await bank.deprecateSkill(skillId);
      notifySkillChange(resource.id);
      return reply.send({ id: skillId, status: skill.status });
    } finally {
      await bank.shutdown();
    }
  });

  // Create a new version of a skill
  fastify.post<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/skills/:skillId/versions', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    const body = CreateVersionSchema.parse(request.body);

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const skill = await bank.createVersion(skillId, body.updates as any, {
        changelog: body.changelog,
        bumpType: body.bumpType,
      });
      notifySkillChange(resource.id);
      return reply.status(201).send({ id: skill.id, version: skill.version });
    } finally {
      await bank.shutdown();
    }
  });

  // Fork a skill
  fastify.post<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/skills/:skillId/fork', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    const body = ForkSkillSchema.parse(request.body);

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const forked = await bank.forkSkill(skillId, body as any);
      notifySkillChange(resource.id);
      return reply.status(201).send({ id: forked.id, version: forked.version, forkedFrom: skillId });
    } finally {
      await bank.shutdown();
    }
  });

  // Rollback a skill to a previous version
  fastify.post<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/skills/:skillId/rollback', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    const body = RollbackSchema.parse(request.body);

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const skill = await bank.rollbackSkill(skillId, body.toVersion);
      notifySkillChange(resource.id);
      return reply.send({ id: skill.id, version: skill.version, rolledBackTo: body.toVersion });
    } finally {
      await bank.shutdown();
    }
  });

  // ============================================================================
  // Import / Export / Bootstrap
  // ============================================================================

  // Unified import endpoint with auto-format detection
  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/skills/import', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const body = ImportSchema.parse(request.body);
    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      let format = body.format;
      const content = body.content;

      // Auto-detect format if not specified
      if (!format) {
        if (typeof content === 'string') {
          // Check if it looks like AGENTS.md (markdown with skill sections)
          if (content.includes('## ') && (content.includes('Problem') || content.includes('Solution') || content.includes('<skill'))) {
            format = 'agents-md';
          } else {
            // Try parsing as JSON
            try {
              const parsed = JSON.parse(content);
              if (Array.isArray(parsed)) {
                // Check if it looks like indexer format
                format = parsed[0]?.sourceRepo || parsed[0]?.scrapedAt ? 'indexer' : 'json';
              } else if (parsed.skills && Array.isArray(parsed.skills)) {
                format = parsed.exportedAt ? 'indexer' : 'json';
              } else {
                format = 'json';
              }
            } catch {
              format = 'agents-md'; // fallback: treat as markdown
            }
          }
        } else if (Array.isArray(content)) {
          format = 'json';
        } else {
          format = 'json';
        }
      }

      let result: { imported: number; failed: number; warnings?: string[] };

      switch (format) {
        case 'json': {
          // Direct skill array import
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let skills: any[];
          if (typeof content === 'string') {
            const parsed = JSON.parse(content);
            skills = Array.isArray(parsed) ? parsed : parsed.skills || [parsed];
          } else if (Array.isArray(content)) {
            skills = content;
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            skills = [(content as any).skills ? (content as any).skills : content];
            if (Array.isArray(skills[0])) skills = skills[0];
          }
          result = await bank.importSkills(skills);
          break;
        }

        case 'agents-md': {
          // Parse AGENTS.md content and import each skill
          if (typeof content !== 'string') {
            return reply.status(400).send({ error: 'Bad Request', message: 'AGENTS.md content must be a string' });
          }
          const parser = createAgentsParser();
          const parsed = parser.parse(content);
          let imported = 0;
          let failed = 0;
          for (const parsedSkill of parsed.skills) {
            try {
              const skill = parser.toSkill(parsedSkill);
              await bank.saveSkill(skill);
              imported++;
            } catch {
              failed++;
            }
          }
          result = { imported, failed, warnings: parsed.warnings };
          break;
        }

        case 'indexer': {
          // Parse indexer export and convert to skill-tree format
          if (typeof content !== 'string') {
            return reply.status(400).send({ error: 'Bad Request', message: 'Indexer export content must be a JSON string' });
          }
          // Parse the indexer export — the skills have a different shape
          // (sourceRepo, sourcePath, scrapedAt, etc.) so we convert them
          const indexerData = JSON.parse(content);
          const rawSkills = Array.isArray(indexerData) ? indexerData : indexerData.skills || [];

          // Convert indexer skills to skill-tree format
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const converted = rawSkills.map((s: any) => ({
            id: s.id || s.slug || s.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            name: s.displayName || s.name,
            description: s.description || '',
            problem: s.problem || '',
            solution: s.solution || s.content || '',
            verification: s.verification || '',
            version: s.version || '1.0.0',
            tags: s.tags || [],
            status: s.status === 'indexed' ? 'active' : 'draft',
            author: s.author || '',
            triggerConditions: [],
            examples: [],
            source: s.sourceUrl ? { type: 'imported', location: s.sourceUrl, importedAt: new Date().toISOString() } : undefined,
            taxonomy: s.primaryPath ? { primaryPath: s.primaryPath, secondaryPaths: s.secondaryPaths, confidence: s.confidence } : undefined,
          }));

          result = await bank.importSkills(converted);
          if (indexerData.stats) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (result as any).sourceStats = indexerData.stats;
          }
          break;
        }

        default:
          return reply.status(400).send({ error: 'Bad Request', message: `Unknown format: ${format}` });
      }

      notifySkillChange(resource.id);
      return reply.send({ format, ...result });
    } finally {
      await bank.shutdown();
    }
  });

  // Export all skills
  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/skills/export', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const skills = await bank.exportAll();
      const stats = await bank.getStats();
      return reply.send({ skills, stats });
    } finally {
      await bank.shutdown();
    }
  });

  // Bootstrap a new skill bank (.skilltree/ directory)
  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/skills/bootstrap', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const skilltreeDir = join(localPath, '.skilltree');
    const skillsDir = join(skilltreeDir, 'skills');
    const alreadyExists = existsSync(skilltreeDir);

    if (!alreadyExists) {
      mkdirSync(skillsDir, { recursive: true });
    }

    // Initialize the bank (creates cache, validates structure)
    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();
    await bank.shutdown();

    notifySkillChange(resource.id);
    return reply.send({ initialized: true, alreadyExisted: alreadyExists, path: skilltreeDir });
  });

  // ============================================================================
  // Loadout Management
  // ============================================================================

  // List available profiles
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/loadout/profiles', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { server } = await getServingLayer(resource.id, localPath);
    const profileNames = server.getProfiles();

    const profiles = profileNames.map(name => ({
      name,
      builtIn: !!builtInProfiles[name],
      criteria: builtInProfiles[name] || null,
    }));

    return reply.send({ profiles });
  });

  // Compile a loadout (from profile, task, or criteria)
  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/loadout/compile', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const body = CompileLoadoutSchema.parse(request.body);
    const { server } = await getServingLayer(resource.id, localPath);

    let state: LoadoutState;

    if (body.profile) {
      state = await server.setLoadoutFromProfile(body.profile);
    } else if (body.taskDescription) {
      state = await server.setLoadoutForTask(body.taskDescription);
    } else {
      // Build criteria from body fields
      const { profile: _p, taskDescription: _t, ...criteria } = body;
      state = await server.setLoadout(criteria as LoadoutCriteria);
    }

    return reply.send(serializeLoadoutState(state));
  });

  // Get current loadout state
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/loadout', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { server } = await getServingLayer(resource.id, localPath);
    return reply.send(serializeLoadoutState(server.getState()));
  });

  // Expand a skill in the loadout
  fastify.post<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/loadout/expand/:skillId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    const { server } = await getServingLayer(resource.id, localPath);
    const expanded = server.expandSkill(skillId);

    return reply.send({ skillId, expanded });
  });

  // Collapse a skill in the loadout
  fastify.post<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/loadout/collapse/:skillId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    const { server } = await getServingLayer(resource.id, localPath);
    const collapsed = server.collapseSkill(skillId);

    return reply.send({ skillId, collapsed });
  });

  // Render loadout as system prompt
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/loadout/render', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { server } = await getServingLayer(resource.id, localPath);
    const content = server.renderSystemPrompt();
    const estimatedTokens = server.estimateTokens();

    return reply.send({ content, estimatedTokens });
  });

  // Reset/clear loadout
  fastify.delete<{
    Params: { id: string };
  }>('/resources/:id/loadout', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    evictServingLayer(resource.id);
    return reply.status(204).send();
  });

  // ============================================================================
  // Indexer / Scraper
  // ============================================================================

  const ScrapeSourceSchema = z.object({
    type: z.enum(['awesome-list', 'repository']),
    url: z.string().url(),
  });

  const ScrapeSchema = z.object({
    sources: z.array(ScrapeSourceSchema).min(1),
    force: z.boolean().optional(),
  });

  const ScrapeAndIndexSchema = z.object({
    sources: z.array(ScrapeSourceSchema).min(1),
    force: z.boolean().optional(),
    autoClassify: z.boolean().optional(),
    detectRelationships: z.boolean().optional(),
    importAll: z.boolean().optional(),
  });

  const ClassifySchema = z.object({
    skillId: z.string().optional(),
    all: z.boolean().optional(),
  });

  const RelationshipsSchema = z.object({
    skillId: z.string().optional(),
  });

  // Check indexer availability
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/indexer/status', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { indexer } = await getIndexer(resource.id, localPath);
    return reply.send({
      available: indexer.isAvailable(),
      degraded: indexer.isDegradedMode(),
      hasGithubToken: !!process.env.GITHUB_TOKEN,
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    });
  });

  // Scrape skills from sources
  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/indexer/scrape', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const body = ScrapeSchema.parse(request.body);
    const { indexer } = await getIndexer(resource.id, localPath);

    if (!indexer.isAvailable()) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Scraper modules not available. Build the scraper first.' });
    }

    const result = await indexer.scrape(body.sources as { type: 'awesome-list' | 'repository'; url: string }[], { force: body.force });
    notifySkillChange(resource.id);
    return reply.send(result);
  });

  // Scrape and index in one step
  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/indexer/scrape-and-index', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const body = ScrapeAndIndexSchema.parse(request.body);
    const { indexer } = await getIndexer(resource.id, localPath);

    if (!indexer.isAvailable()) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Scraper modules not available. Build the scraper first.' });
    }

    const result = await indexer.scrapeAndIndex(body.sources as { type: 'awesome-list' | 'repository'; url: string }[], {
      force: body.force,
      autoClassify: body.autoClassify,
      detectRelationships: body.detectRelationships,
      importAll: body.importAll,
    });
    notifySkillChange(resource.id);
    return reply.send(result);
  });

  // Classify skills with AI
  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/indexer/classify', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const body = ClassifySchema.parse(request.body);
    const { indexer } = await getIndexer(resource.id, localPath);

    const result = await indexer.classify(body);
    notifySkillChange(resource.id);
    return reply.send(result);
  });

  // Detect relationships between skills
  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/indexer/relationships', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const body = RelationshipsSchema.parse(request.body);
    const { indexer } = await getIndexer(resource.id, localPath);

    const result = await indexer.detectRelationships(body);
    notifySkillChange(resource.id);
    return reply.send(result);
  });

  // Get indexer stats
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/indexer/stats', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { indexer } = await getIndexer(resource.id, localPath);
    const stats = await indexer.getStats();
    return reply.send(stats);
  });

  // Get taxonomy tree
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/indexer/taxonomy', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { indexer } = await getIndexer(resource.id, localPath);
    const tree = await indexer.getTaxonomyTree();
    return reply.send(tree);
  });
}
