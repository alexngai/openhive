import { FastifyInstance } from 'fastify';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { z } from 'zod';
import { parseFrontmatter } from 'minimem/session';
import { listMemoryFiles } from 'minimem/internal';
import { createSkillBank, discoverSkills } from 'skill-tree';
import { authMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { getSyncOrchestrator } from '../../sync/sync-orchestrator.js';
import {
  resolveResourceAndPath as resolveResourceAndPathShared,
  resolveLocalPath,
  isPathWithin,
} from './_resource-helpers.js';
import type { SyncableResource } from '../../types.js';
import type { Config } from '../../config.js';

// ============================================================================
// Minimem Instance Cache
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _MinimemClass: any = null;
function loadMinimemSync() {
  if (!_MinimemClass) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('minimem');
      _MinimemClass = mod.Minimem;
    } catch {
      // minimem not available — endpoints fall back to file-based operations
    }
  }
  return _MinimemClass;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const minimemCache = new Map<string, { instance: any; timer: ReturnType<typeof setTimeout> }>();
const MINIMEM_CACHE_TTL = 5 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getMinimemInstance(memoryDir: string, options?: { needsSync?: boolean }): Promise<any> {
  const cached = minimemCache.get(memoryDir);
  if (cached) {
    clearTimeout(cached.timer);
    cached.timer = setTimeout(() => evictMinimem(memoryDir), MINIMEM_CACHE_TTL);
    return cached.instance;
  }

  const Minimem = loadMinimemSync();
  if (!Minimem) throw new Error('minimem not available');
  const instance = await Minimem.create({
    memoryDir,
    embedding: { provider: 'none' },
  });

  // Cloned resources need sync() to build the index from markdown files.
  // Local resources skip this — the agent's minimem maintains the index.
  if (options?.needsSync) {
    await instance.sync();
  }

  const timer = setTimeout(() => evictMinimem(memoryDir), MINIMEM_CACHE_TTL);
  minimemCache.set(memoryDir, { instance, timer });
  return instance;
}

/** Evict a cached Minimem instance (on TTL expiry or sync events). */
export function evictMinimem(memoryDir: string): void {
  const cached = minimemCache.get(memoryDir);
  if (cached) {
    cached.instance.close().catch(() => {});
    clearTimeout(cached.timer);
    minimemCache.delete(memoryDir);
  }
}

// ============================================================================
// Path Helpers (delegates to shared module)
// ============================================================================

function validateRelativePath(pathParam: string, baseDir: string): string | null {
  if (!pathParam || pathParam.includes('..') || resolve(pathParam) === pathParam) return null;
  const fullPath = join(baseDir, pathParam);
  if (!isPathWithin(fullPath, baseDir)) return null;
  if (extname(fullPath).toLowerCase() !== '.md') return null;
  return fullPath;
}

// ============================================================================
// Route Registration
// ============================================================================

export async function resourceContentRoutes(
  fastify: FastifyInstance,
  _options: { config: Config }
): Promise<void> {

  // Shared preHandler: resolve resource → check access → resolve local path
  const resolveResourceAndPath = resolveResourceAndPathShared;

  /**
   * Resolve resource with optional local path — for opentasks endpoints that
   * can fall back to remote queries when the graph isn't local.
   */
  async function resolveResourceForOpenTasks(
    request: { params: { id: string }; agent?: { id: string } },
    reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  ): Promise<{ resource: SyncableResource; localPath: string | null } | null> {
    const resource = resourcesDAL.findResourceById(request.params.id);
    if (!resource) {
      reply.status(404).send({ error: 'Not Found', message: 'Resource not found' });
      return null;
    }
    if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
      reply.status(403).send({ error: 'Forbidden', message: 'You do not have access to this resource' });
      return null;
    }

    let localPath = resolveLocalPath(resource);
    if (!localPath && (resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror')) {
      try {
        const contentPath = await getSyncOrchestrator().ensureContent(resource);
        if (contentPath) localPath = contentPath;
      } catch { /* clone failed */ }
    }

    if (localPath && (!existsSync(localPath) || !statSync(localPath).isDirectory())) {
      // For OpenTasks resources, initialize the directory (equivalent to `opentasks init`)
      const meta = resource.metadata as Record<string, unknown> | null;
      if (resource.resource_type === 'task' && meta?.opentasks) {
        try {
          const { ensureInitialized } = await import('../../map/task-daemon-lifecycle.js');
          const extraConfig = meta.opentasks_config as Record<string, unknown> | undefined;
          ensureInitialized(localPath, extraConfig);
        } catch {
          localPath = null;
        }
      } else {
        localPath = null;
      }
    }

    return { resource, localPath };
  }

  // ============================================================================
  // Memory Bank Endpoints (powered by minimem)
  // ============================================================================

  // Timeline entries — parsed from daily logs and knowledge notes
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: number; type?: string; domain?: string };
  }>('/resources/:id/content/entries', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for memory_bank resources' });
    }

    const limit = Math.min(Math.max(request.query.limit || 100, 1), 500);
    const typeFilter = request.query.type;
    const domainFilter = request.query.domain;
    const memoryFiles = await listMemoryFiles(localPath);

    interface Entry {
      path: string;
      timestamp: string;
      type: string | null;
      agentId: string | null;
      body: string;
      frontmatter: Record<string, unknown> | null;
      domains: string[];
      entities: string[];
      confidence: number | null;
      knowledgeId: string | null;
    }

    const entries: Entry[] = [];

    for (const filePath of memoryFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const relPath = relative(localPath, filePath);
      const { frontmatter, body } = parseFrontmatter(content);

      // Knowledge notes (have id in frontmatter) → single entry
      if (frontmatter?.id) {
        const domains = Array.isArray(frontmatter.domain) ? frontmatter.domain as string[] : [];
        const entitiesList = Array.isArray(frontmatter.entities) ? frontmatter.entities as string[] : [];
        const entryType = (frontmatter.type as string) || 'note';
        const agentId = (frontmatter.source as Record<string, unknown>)?.agentId as string | null ?? null;
        const timestamp = (frontmatter.created as string) || (frontmatter.updated as string) || '';

        if (typeFilter && entryType !== typeFilter) continue;
        if (domainFilter && !domains.some(d => d.toLowerCase() === domainFilter.toLowerCase())) continue;

        entries.push({
          path: relPath,
          timestamp,
          type: entryType,
          agentId,
          body: body.trim(),
          frontmatter,
          domains,
          entities: entitiesList,
          confidence: (frontmatter.confidence as number) ?? null,
          knowledgeId: frontmatter.id as string,
        });
        continue;
      }

      // Daily logs — split by ### headings
      const dateMatch = relPath.match(/(\d{4}-\d{2}-\d{2})/);
      const fileDate = dateMatch ? dateMatch[1] : '';

      const sections = body.split(/^### /m).filter(s => s.trim());
      for (const section of sections) {
        const lines = section.split('\n');
        const heading = lines[0]?.trim() || '';
        const sectionBody = lines.slice(1).join('\n').trim();
        if (!sectionBody) continue;

        // Parse timestamp from heading (e.g., "2026-03-26 14:32")
        const timeMatch = heading.match(/(\d{4}-\d{2}-\d{2})?\s*(\d{1,2}:\d{2})/);
        let timestamp = '';
        if (timeMatch) {
          const date = timeMatch[1] || fileDate;
          const time = timeMatch[2];
          timestamp = date && time ? `${date}T${time}:00Z` : '';
        } else if (fileDate) {
          timestamp = `${fileDate}T00:00:00Z`;
        }

        // Parse type from <!-- type: X --> comment
        const typeMatch = sectionBody.match(/<!--\s*type:\s*(\w+)\s*-->/);
        const entryType = typeMatch ? typeMatch[1] : 'note';
        const cleanBody = sectionBody.replace(/<!--\s*type:\s*\w+\s*-->\n?/, '').trim();

        if (typeFilter && entryType !== typeFilter) continue;

        entries.push({
          path: relPath,
          timestamp,
          type: entryType,
          agentId: null,
          body: cleanBody,
          frontmatter: null,
          domains: [],
          entities: [],
          confidence: null,
          knowledgeId: null,
        });
      }

      // Files without ### sections — single entry for the whole file
      if (sections.length === 0 && body.trim() && relPath !== 'MEMORY.md') {
        entries.push({
          path: relPath,
          timestamp: fileDate ? `${fileDate}T00:00:00Z` : '',
          type: 'note',
          agentId: null,
          body: body.trim(),
          frontmatter: null,
          domains: [],
          entities: [],
          confidence: null,
          knowledgeId: null,
        });
      }
    }

    // Sort by timestamp descending
    entries.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });

    return reply.send({ entries: entries.slice(0, limit) });
  });

  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/files', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for memory_bank resources' });
    }

    const memoryFiles = await listMemoryFiles(localPath);
    const files = memoryFiles.map((filePath) => {
      const stat = statSync(filePath);
      return { path: relative(localPath, filePath), size: stat.size, modified: stat.mtime.toISOString() };
    });

    return reply.send({ files });
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { path?: string };
  }>('/resources/:id/content/file', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for memory_bank resources' });
    }

    const pathParam = request.query.path;
    if (!pathParam) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Query parameter "path" is required' });
    }

    const fullPath = validateRelativePath(pathParam, localPath);
    if (!fullPath) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Invalid file path. Path must be relative, within the resource directory, and point to a .md file.' });
    }

    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return reply.status(404).send({ error: 'Not Found', message: 'File not found' });
    }

    const content = readFileSync(fullPath, 'utf-8');
    const stat = statSync(fullPath);
    const { frontmatter, body } = parseFrontmatter(content);

    return reply.send({ path: relative(localPath, fullPath), frontmatter: frontmatter ?? null, body, size: stat.size });
  });

  // Search — delegates to minimem's BM25 index, falls back to substring
  fastify.get<{
    Params: { id: string };
    Querystring: { q?: string; limit?: number };
  }>('/resources/:id/content/search', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath, isCloned } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for memory_bank resources' });
    }

    const query = request.query.q;
    if (!query || query.trim().length === 0) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Query parameter "q" is required' });
    }

    const limit = Math.min(Math.max(request.query.limit || 20, 1), 100);

    try {
      const mem = await getMinimemInstance(localPath, { needsSync: isCloned });
      const searchResults = await mem.search(query, { maxResults: limit, minScore: 0.1 });

      const results = searchResults.map((r: { path: string; startLine: number; endLine: number; score: number; snippet: string; heading?: string }) => ({
        path: r.path.startsWith('/') ? relative(localPath, r.path) : r.path,
        line: r.startLine,
        end_line: r.endLine,
        snippet: r.snippet,
        score: r.score,
        heading: r.heading ?? null,
      }));

      return reply.send({ results, total: results.length, engine: 'minimem' });
    } catch {
      // Fallback: substring search
      const queryLower = query.toLowerCase();
      const memoryFiles = await listMemoryFiles(localPath);
      const results: Array<{ path: string; line: number; snippet: string; score: number }> = [];

      for (const filePath of memoryFiles) {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const relPath = relative(localPath, filePath);

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            const snippetLines: string[] = [];
            if (i > 0) snippetLines.push(lines[i - 1]);
            snippetLines.push(lines[i]);
            if (i < lines.length - 1) snippetLines.push(lines[i + 1]);
            results.push({ path: relPath, line: i + 1, snippet: snippetLines.join('\n'), score: lines[i].toLowerCase().split(queryLower).length - 1 });
          }
        }
      }

      results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
      return reply.send({ results: results.slice(0, limit), total: results.length, engine: 'fallback' });
    }
  });

  // ============================================================================
  // Knowledge Endpoints (powered by minimem knowledge APIs)
  // ============================================================================

  // Knowledge search — query + filter delegates to minimem; filter-only scans frontmatter
  fastify.get<{
    Params: { id: string };
    Querystring: { q?: string; domain?: string; entity?: string; type?: string; min_confidence?: number; limit?: number };
  }>('/resources/:id/content/knowledge', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath, isCloned } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for memory_bank resources' });
    }

    const { q, domain, entity, type: knowledgeType, min_confidence } = request.query;
    const limit = Math.min(Math.max(request.query.limit || 50, 1), 200);

    // With a text query, delegate to minimem's indexed knowledgeSearch
    if (q && q.trim().length > 0) {
      try {
        const mem = await getMinimemInstance(localPath, { needsSync: isCloned });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const searchResults: any[] = await mem.knowledgeSearch(q, {
          domain: domain ? [domain] : undefined,
          entities: entity ? [entity] : undefined,
          knowledgeType: knowledgeType || undefined,
          minConfidence: min_confidence,
          maxResults: limit,
        });

        const results = searchResults.map((r: { path: string; snippet: string; score: number }) => {
          const content = readFileSync(join(localPath, r.path), 'utf-8');
          const { frontmatter } = parseFrontmatter(content);
          return {
            path: r.path,
            frontmatter: frontmatter ?? null,
            snippet: r.snippet,
            score: r.score,
            knowledge_type: (frontmatter?.type as string) ?? null,
          };
        });

        return reply.send({ results, total: results.length, engine: 'minimem' });
      } catch {
        // Fall through to frontmatter scan
      }
    }

    // Filter-only (no text query) or minimem unavailable: scan frontmatter
    const memoryFiles = await listMemoryFiles(localPath);
    const results: Array<{ path: string; frontmatter: Record<string, unknown> | null; snippet: string; knowledge_type: string | null }> = [];

    for (const filePath of memoryFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      if (!frontmatter?.id) continue;

      const relPath = relative(localPath, filePath);
      if (knowledgeType && frontmatter.type !== knowledgeType) continue;
      if (domain) {
        const domains = frontmatter.domain;
        if (!Array.isArray(domains) || !domains.some((d: string) => d.toLowerCase() === domain.toLowerCase())) continue;
      }
      if (entity) {
        const entities = frontmatter.entities;
        if (!Array.isArray(entities) || !entities.some((e: string) => e.toLowerCase() === entity.toLowerCase())) continue;
      }
      if (min_confidence !== undefined) {
        const conf = frontmatter.confidence;
        if (typeof conf !== 'number' || conf < min_confidence) continue;
      }

      const snippetLines = body.split('\n').filter(l => l.trim().length > 0).slice(0, 3);
      results.push({ path: relPath, frontmatter: frontmatter ?? null, snippet: snippetLines.join('\n'), knowledge_type: (frontmatter.type as string) ?? null });
    }

    results.sort((a, b) => {
      const confA = (a.frontmatter?.confidence as number) ?? -1;
      const confB = (b.frontmatter?.confidence as number) ?? -1;
      return confB - confA || a.path.localeCompare(b.path);
    });

    return reply.send({ results: results.slice(0, limit), total: results.length });
  });

  // Knowledge graph — delegates to minimem's getGraphNeighbors
  fastify.get<{
    Params: { id: string };
    Querystring: { note_id: string; relation?: string; depth?: number };
  }>('/resources/:id/content/knowledge/graph', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath, isCloned } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for memory_bank resources' });
    }

    const { note_id, relation } = request.query;
    const maxDepth = Math.min(Math.max(request.query.depth || 1, 1), 5);

    if (!note_id) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Query parameter "note_id" is required' });
    }

    try {
      const mem = await getMinimemInstance(localPath, { needsSync: isCloned });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const neighbors: any[] = await mem.getGraphNeighbors(note_id, maxDepth);

      const nodeIds = new Set<string>([note_id]);
      const edges: Array<{ from: string; to: string; relation: string; layer?: string; depth: number }> = [];
      const visitedEdges = new Set<string>();

      for (const neighbor of neighbors) {
        const link = neighbor.link;
        if (relation && link.relation !== relation) continue;
        const edgeKey = `${link.fromId}→${link.toId}:${link.relation}`;
        if (!visitedEdges.has(edgeKey)) {
          visitedEdges.add(edgeKey);
          nodeIds.add(neighbor.id);
          edges.push({ from: link.fromId, to: link.toId, relation: link.relation, layer: link.layer, depth: neighbor.depth });
        }
      }

      // Build node metadata from frontmatter
      const idToFile = new Map<string, string>();
      const memoryFiles = await listMemoryFiles(localPath);
      for (const filePath of memoryFiles) {
        const content = readFileSync(filePath, 'utf-8');
        const { frontmatter } = parseFrontmatter(content);
        if (frontmatter?.id) idToFile.set(frontmatter.id as string, filePath);
      }

      const nodes = [...nodeIds].map(id => {
        const filePath = idToFile.get(id);
        if (!filePath) return { id, path: null, type: null, confidence: null };
        const { frontmatter } = parseFrontmatter(readFileSync(filePath, 'utf-8'));
        return { id, path: relative(localPath, filePath), type: (frontmatter?.type as string) ?? null, confidence: (frontmatter?.confidence as number) ?? null };
      });

      return reply.send({ root: note_id, nodes, edges });
    } catch {
      return reply.send({ root: note_id, nodes: [{ id: note_id, path: null, type: null, confidence: null }], edges: [] });
    }
  });

  // ============================================================================
  // Skill Content Endpoints (powered by skill-tree)
  // ============================================================================

  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/skills', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const adapter = createSkillBank({ storage: { basePath: localPath } });
    await adapter.initialize();
    const allSkills = await adapter.listSkills();

    const discovered = await discoverSkills(localPath);
    const pathMap = new Map(discovered.map(d => [d.id, relative(localPath, d.filePath)]));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skills = allSkills.map((skill: any) => ({
      id: skill.id,
      name: skill.name || null,
      version: skill.version || null,
      status: skill.status || null,
      description: skill.description || null,
      tags: skill.tags || [],
      author: skill.author || null,
      path: pathMap.get(skill.id) || join('.skilltree', 'skills', skill.id, 'SKILL.md'),
      related: skill.related || [],
      relationships: skill.relationships || [],
      taxonomy: skill.taxonomy || null,
      namespace: skill.namespace || null,
      parentVersion: skill.parentVersion || null,
      derivedFrom: skill.derivedFrom || [],
      forks: skill.forks || [],
    }));

    return reply.send({ skills });
  });

  fastify.get<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/content/skills/:skillId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    if (!skillId || skillId.includes('..') || skillId.includes('/') || skillId.includes('\\')) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Invalid skill ID' });
    }

    const adapter = createSkillBank({ storage: { basePath: localPath } });
    await adapter.initialize();
    const skill = await adapter.getSkill(skillId);

    if (!skill) {
      return reply.status(404).send({ error: 'Not Found', message: `Skill "${skillId}" not found` });
    }

    const discovered = await discoverSkills(localPath);
    const location = discovered.find(d => d.id === skillId);
    const raw = location ? readFileSync(location.filePath, 'utf-8') : '';

    return reply.send({
      id: skill.id, name: skill.name || null, version: skill.version || null,
      status: skill.status || null, description: skill.description || null,
      tags: skill.tags || [], author: skill.author || null,
      instructions: skill.instructions || null, related: skill.related || [],
      relationships: skill.relationships || [],
      taxonomy: skill.taxonomy || null,
      namespace: skill.namespace || null,
      parentVersion: skill.parentVersion || null,
      derivedFrom: skill.derivedFrom || [],
      forks: skill.forks || [],
      metrics: skill.metrics || null,
      serving: skill.serving || null,
      raw,
    });
  });

  // Skill search
  fastify.get<{
    Params: { id: string };
    Querystring: { q: string; limit?: number };
  }>('/resources/:id/content/skills/search', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const query = request.query.q;
    if (!query || query.trim().length === 0) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Query parameter "q" is required' });
    }

    const limit = Math.min(Math.max(request.query.limit || 20, 1), 100);
    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const results = await bank.searchSkills(query);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const skills = results.slice(0, limit).map((skill: any) => ({
        id: skill.id,
        name: skill.name || null,
        version: skill.version || null,
        status: skill.status || null,
        description: skill.description || null,
        tags: skill.tags || [],
        score: skill._score ?? null,
      }));
      return reply.send({ results: skills, total: results.length });
    } finally {
      await bank.shutdown();
    }
  });

  // Skill version history
  fastify.get<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/content/skills/:skillId/versions', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    if (!skillId || skillId.includes('..') || skillId.includes('/')) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Invalid skill ID' });
    }

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const history = await bank.getVersionHistory(skillId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const versions = (history || []).map((v: any) => ({
        version: v.version,
        changelog: v.changelog || null,
        createdAt: v.skill?.createdAt || v.createdAt || null,
        status: v.skill?.status || null,
      }));
      return reply.send({ skillId, versions });
    } finally {
      await bank.shutdown();
    }
  });

  // Skill lineage (version tree + forks)
  fastify.get<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/content/skills/:skillId/lineage', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const { skillId } = request.params;
    if (!skillId || skillId.includes('..') || skillId.includes('/')) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Invalid skill ID' });
    }

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const lineage = await bank.getLineage(skillId);
      return reply.send(lineage || { rootId: skillId, versions: [], forks: [] });
    } finally {
      await bank.shutdown();
    }
  });

  // Skill relationship graph — all skills with their relationships
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/skills/graph', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const allSkills = await bank.listSkills();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodes = allSkills.map((s: any) => ({
        id: s.id,
        name: s.name || s.id,
        status: s.status || 'draft',
        version: s.version || null,
        tags: s.tags || [],
        taxonomy: s.taxonomy || null,
        description: s.description || null,
      }));

      // Build edges from relationships + related + derivedFrom/forks
      const edges: Array<{ from: string; to: string; type: string; confidence?: number }> = [];
      const skillIds = new Set(allSkills.map((s: { id: string }) => s.id));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const skill of allSkills as any[]) {
        if (skill.relationships) {
          for (const rel of skill.relationships) {
            if (rel.targetId && skillIds.has(rel.targetId)) {
              edges.push({ from: skill.id, to: rel.targetId, type: rel.type, confidence: rel.confidence });
            }
          }
        }
        if (skill.related) {
          for (const relId of skill.related) {
            if (skillIds.has(relId)) {
              edges.push({ from: skill.id, to: relId, type: 'related' });
            }
          }
        }
        if (skill.derivedFrom) {
          for (const parentId of skill.derivedFrom) {
            if (skillIds.has(parentId)) {
              edges.push({ from: parentId, to: skill.id, type: 'derived_from' });
            }
          }
        }
        if (skill.forks) {
          for (const forkId of skill.forks) {
            if (skillIds.has(forkId)) {
              edges.push({ from: skill.id, to: forkId, type: 'fork' });
            }
          }
        }
      }

      return reply.send({ nodes, edges });
    } finally {
      await bank.shutdown();
    }
  });

  // Skill bank stats
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/skills/stats', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for skill resources' });
    }

    const bank = createSkillBank({ storage: { basePath: localPath } });
    await bank.initialize();

    try {
      const stats = await bank.getStats();
      return reply.send(stats);
    } finally {
      await bank.shutdown();
    }
  });

  // ============================================================================
  // OpenTasks Content Endpoints
  // ============================================================================

  function validateOpenTasksResource(
    resource: SyncableResource,
    reply: { status: (code: number) => { send: (body: unknown) => unknown } }
  ): boolean {
    const meta = resource.metadata as Record<string, unknown> | null;
    if (resource.resource_type !== 'task' || !meta?.opentasks) {
      reply.status(400).send({ error: 'Bad Request', message: 'This endpoint is only available for OpenTasks task resources' });
      return false;
    }
    return true;
  }

  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/summary', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceForOpenTasks(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    // Local daemon path
    if (localPath) {
      const { daemonGetSummary, resolveDaemonSocket, TaskDaemonError } = await import('../../map/task-daemon-client.js');
      const socketPath = resolveDaemonSocket(localPath);
      try {
        return reply.send(await daemonGetSummary(socketPath, localPath));
      } catch (err) {
        if (!(err instanceof TaskDaemonError && err.code === 'DAEMON_NOT_RUNNING')) throw err;
        // Fall through to remote
      }
    }

    // Remote swarm path
    const { findSwarmForResource, remoteGetSummary } = await import('../../map/opentasks-remote.js');
    const { getInbound } = await import('../../map/connection-registry.js');
    const swarmId = findSwarmForResource(resource);
    if (swarmId) {
      const summary = await remoteGetSummary(swarmId);
      if (summary) {
        // Enrich with remote location info from live connection + DB
        const conn = getInbound(swarmId);
        if (conn) {
          let swarmName: string | undefined;
          try {
            const { findSwarmById } = await import('../../db/dal/map.js');
            const swarm = findSwarmById(swarmId);
            swarmName = swarm?.name ?? undefined;
          } catch { /* non-critical */ }

          (summary as Record<string, unknown>).remote_info = {
            swarm_id: swarmId,
            swarm_name: swarmName,
            swarm_path: conn.defaultTaskGraph?.path,
            connected_at: conn.connectedAt,
          };
        }
        return reply.send(summary);
      }
    }

    return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon could not be started and no connected swarm is available' });
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: number };
  }>('/resources/:id/content/opentasks/ready', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceForOpenTasks(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (!localPath) {
      return reply.send({ items: [], daemon_connected: false, message: 'Resource path not available locally' });
    }

    const limit = Math.min(Math.max(request.query.limit || 50, 1), 200);
    const { daemonGetReady, resolveDaemonSocket, TaskDaemonError } = await import('../../map/task-daemon-client.js');
    const socketPath = resolveDaemonSocket(localPath);
    try {
      const ready = await daemonGetReady(socketPath, limit, localPath);
      return reply.send(ready);
    } catch (err) {
      if (err instanceof TaskDaemonError && err.code === 'DAEMON_NOT_RUNNING') {
        return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon could not be started for this resource' });
      }
      throw err;
    }
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { status?: string; limit?: number; offset?: number };
  }>('/resources/:id/content/opentasks/tasks', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceForOpenTasks(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (!localPath) {
      return reply.send({ items: [], daemon_connected: false, message: 'Resource path not available locally' });
    }

    const { daemonQueryNodes, daemonGetSummary, resolveDaemonSocket, TaskDaemonError } = await import('../../map/task-daemon-client.js');
    const socketPath = resolveDaemonSocket(localPath);
    try {
      const result = await daemonQueryNodes(socketPath, {
        type: 'task', status: request.query.status, archived: false,
        limit: Math.min(Math.max(request.query.limit || 50, 1), 200),
        offset: request.query.offset || 0,
      }, localPath);

      return reply.send({ items: result.items || [], daemon_connected: true });
    } catch (err) {
      if (err instanceof TaskDaemonError && err.code === 'DAEMON_NOT_RUNNING') {
        return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon could not be started for this resource' });
      }
      throw err;
    }
  });

  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/status', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceForOpenTasks(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (!localPath) {
      return reply.send({ daemon_connected: false, running: false, message: 'Resource path not available locally' });
    }

    const { daemonGetStatus, resolveDaemonSocket } = await import('../../map/task-daemon-client.js');
    const socketPath = resolveDaemonSocket(localPath);
    const status = await daemonGetStatus(socketPath, localPath);
    return reply.send(status);
  });

  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/graph', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceForOpenTasks(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    // Local daemon path
    if (localPath) {
      const { daemonGetGraph, resolveDaemonSocket, TaskDaemonError } = await import('../../map/task-daemon-client.js');
      const socketPath = resolveDaemonSocket(localPath);
      try {
        return reply.send(await daemonGetGraph(socketPath, localPath));
      } catch (err) {
        if (!(err instanceof TaskDaemonError && err.code === 'DAEMON_NOT_RUNNING')) throw err;
        // Fall through to remote
      }
    }

    // Remote swarm path
    const { findSwarmForResource, remoteGetGraph } = await import('../../map/opentasks-remote.js');
    const swarmId = findSwarmForResource(resource);
    if (swarmId) {
      const graph = await remoteGetGraph(swarmId);
      if (graph) return reply.send(graph);
    }

    return reply.send({ nodes: [], edges: [] });
  });

  // OpenTasks mutations

  /** Check if a resource is read-only (ls-remote/mirror without git sync enabled) */
  function isReadOnlyResource(resource: SyncableResource): boolean {
    if (resource.sync_strategy !== 'ls-remote' && resource.sync_strategy !== 'mirror') return false;
    const meta = resource.metadata as Record<string, unknown> | null;
    const otConfig = meta?.opentasks_config as Record<string, unknown> | undefined;
    const gitSync = otConfig?.sync as Record<string, unknown> | undefined;
    return !gitSync?.git || !(gitSync.git as Record<string, unknown>).enabled;
  }

  const CreateTaskNodeSchema = z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    status: z.string().optional(),
    priority: z.number().int().min(0).max(10).optional(),
    assignee: z.string().max(200).optional().nullable(),
    metadata: z.record(z.unknown()).optional(),
  });

  const UpdateTaskSchema = z.object({
    status: z.string().min(1).optional(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(5000).optional().nullable(),
    priority: z.number().int().min(0).max(10).optional(),
    assignee: z.string().max(200).optional().nullable(),
    result: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  }).refine(data => data.status || data.title !== undefined || data.description !== undefined || data.priority !== undefined || data.assignee !== undefined, {
    message: 'At least one field (status, title, description, priority, or assignee) is required',
  });

  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/tasks', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (isReadOnlyResource(resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'This task graph is read-only. Enable git sync in advanced settings to allow edits.' });
    }

    let body;
    try { body = CreateTaskNodeSchema.parse(request.body); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors });
      throw error;
    }

    // Route through the OpenTasks daemon for persistence
    const { daemonCreateTask: createFn, resolveDaemonSocket: resolveSocket, TaskDaemonError: DaemonErr } = await import('../../map/task-daemon-client.js');
    const socketPath = resolveSocket(localPath);
    try {
      const task = await createFn(socketPath, { title: body.title, description: body.description, status: body.status || 'open', priority: body.priority, assignee: body.assignee ?? undefined }, localPath);
      try { const { broadcastToChannel } = await import('../../realtime/index.js'); broadcastToChannel('map:tasks', { type: 'task.created', data: { task: { id: task.id, title: task.title, status: task.status } } }); } catch { /* best effort */ }
      return reply.status(201).send({ node_id: task.id, status: task.status });
    } catch (err) {
      if (err instanceof DaemonErr && err.code === 'DAEMON_NOT_RUNNING') return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon is not running for this resource' });
      throw err;
    }
  });
  fastify.patch<{
    Params: { id: string; nodeId: string };
  }>('/resources/:id/content/opentasks/tasks/:nodeId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (isReadOnlyResource(resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'This task graph is read-only. Enable git sync in advanced settings to allow edits.' });
    }

    let body;
    try { body = UpdateTaskSchema.parse(request.body); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors });
      throw error;
    }

    const { daemonUpdateTask: updateFn, resolveDaemonSocket: resolveSocket, TaskDaemonError: DaemonErr } = await import('../../map/task-daemon-client.js');
    const socketPath = resolveSocket(localPath);
    try {
      await updateFn(socketPath, request.params.nodeId, {
        status: body.status,
        title: body.title,
        description: body.description ?? undefined,
        assignee: body.assignee,
      }, localPath);
      if (body.status) {
        try { const { broadcastToChannel } = await import('../../realtime/index.js'); broadcastToChannel('map:tasks', { type: 'task.status', data: { taskId: request.params.nodeId, current: body.status } }); } catch { /* best effort */ }
      }
      return reply.send({ node_id: request.params.nodeId, previous_status: null, new_status: body.status ?? null });
    } catch (err) {
      if (err instanceof DaemonErr && err.code === 'DAEMON_NOT_RUNNING') return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon is not running for this resource' });
      throw err;
    }
  });

  // Delete task node
  fastify.delete<{
    Params: { id: string; nodeId: string };
    Querystring: { hard?: string };
  }>('/resources/:id/content/opentasks/tasks/:nodeId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (isReadOnlyResource(resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'This task graph is read-only.' });
    }

    const hard = request.query.hard === 'true';
    const { daemonDeleteTask, resolveDaemonSocket, TaskDaemonError: DaemonErr } = await import('../../map/task-daemon-client.js');
    const socketPath = resolveDaemonSocket(localPath);
    try {
      await daemonDeleteTask(socketPath, request.params.nodeId, { hard }, localPath);
      try { const { broadcastToChannel } = await import('../../realtime/index.js'); broadcastToChannel('map:tasks', { type: 'task.deleted', data: { taskId: request.params.nodeId, hard } }); } catch { /* best effort */ }
      return reply.send({ deleted: true, node_id: request.params.nodeId, hard });
    } catch (err) {
      if (err instanceof DaemonErr && err.code === 'DAEMON_NOT_RUNNING') return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon is not running for this resource' });
      throw err;
    }
  });

  // ============================================================================
  // Task Link Endpoints (dependency management)
  // ============================================================================

  const CreateLinkSchema = z.object({
    targetId: z.string().min(1),
    type: z.enum(['blocks', 'depends-on', 'related', 'parent-of', 'implements', 'references']),
    metadata: z.record(z.unknown()).optional(),
  });

  // Create a link from nodeId to targetId
  fastify.post<{
    Params: { id: string; nodeId: string };
  }>('/resources/:id/content/opentasks/tasks/:nodeId/links', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (isReadOnlyResource(resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'This task graph is read-only.' });
    }

    let body;
    try { body = CreateLinkSchema.parse(request.body); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors });
      throw error;
    }

    const { daemonCreateLink, resolveDaemonSocket, TaskDaemonError: DaemonErr } = await import('../../map/task-daemon-client.js');
    const socketPath = resolveDaemonSocket(localPath);
    try {
      const result = await daemonCreateLink(socketPath, {
        fromId: request.params.nodeId,
        toId: body.targetId,
        type: body.type,
        metadata: body.metadata,
      }, localPath);
      try { const { broadcastToChannel } = await import('../../realtime/index.js'); broadcastToChannel('map:tasks', { type: 'task.linked', data: { fromId: request.params.nodeId, toId: body.targetId, edgeType: body.type } }); } catch { /* best effort */ }
      return reply.status(201).send({ edge_id: result.edgeId, from_id: request.params.nodeId, to_id: body.targetId, type: body.type });
    } catch (err) {
      if (err instanceof DaemonErr && err.code === 'DAEMON_NOT_RUNNING') return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon is not running' });
      throw err;
    }
  });

  // Remove a link from nodeId to targetId
  fastify.delete<{
    Params: { id: string; nodeId: string; targetId: string };
    Querystring: { type?: string };
  }>('/resources/:id/content/opentasks/tasks/:nodeId/links/:targetId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (isReadOnlyResource(resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'This task graph is read-only.' });
    }

    const edgeType = request.query.type || 'blocks';
    const { daemonRemoveLink, resolveDaemonSocket, TaskDaemonError: DaemonErr } = await import('../../map/task-daemon-client.js');
    const socketPath = resolveDaemonSocket(localPath);
    try {
      await daemonRemoveLink(socketPath, {
        fromId: request.params.nodeId,
        toId: request.params.targetId,
        type: edgeType,
      }, localPath);
      try { const { broadcastToChannel } = await import('../../realtime/index.js'); broadcastToChannel('map:tasks', { type: 'task.unlinked', data: { fromId: request.params.nodeId, toId: request.params.targetId, edgeType } }); } catch { /* best effort */ }
      return reply.send({ removed: true });
    } catch (err) {
      if (err instanceof DaemonErr && err.code === 'DAEMON_NOT_RUNNING') return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon is not running' });
      throw err;
    }
  });

  // ============================================================================
  // Git Sync Endpoints (for ls-remote/mirror task resources)
  // ============================================================================

  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/git-status', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    const { getGitSyncStatus } = await import('../../sync/git-content.js');
    try {
      const status = await getGitSyncStatus(localPath);
      return reply.send(status);
    } catch {
      return reply.send({ hasUncommittedChanges: false, unpushedCommits: 0, localHead: null, remoteHead: null });
    }
  });

  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/git-commit', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (isReadOnlyResource(resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Git sync is not enabled for this resource' });
    }

    const { commitChanges } = await import('../../sync/git-content.js');
    const hash = await commitChanges(localPath);
    return reply.send({ committed: hash !== null, hash });
  });

  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/git-push', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    if (isReadOnlyResource(resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Git sync is not enabled for this resource' });
    }

    const { commitChanges, pushToRemote } = await import('../../sync/git-content.js');
    // Commit first if there are uncommitted changes
    await commitChanges(localPath, 'Update task graph');
    await pushToRemote(localPath);
    return reply.send({ pushed: true });
  });
}
