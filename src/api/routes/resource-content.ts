import { FastifyInstance } from 'fastify';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { z } from 'zod';
import { parseFrontmatter } from 'minimem/session';
import { listMemoryFiles } from 'minimem/internal';
import { createSkillBank, discoverSkills } from 'skill-tree';
import { authMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { OpenHiveOpenTasksClient } from '../../opentasks-client/index.js';
import { getSyncOrchestrator } from '../../sync/sync-orchestrator.js';
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
// Path Helpers
// ============================================================================

const REMOTE_URL_PREFIXES = ['http', 'git://', 'ssh://'];

function resolveLocalPath(resource: SyncableResource): string | null {
  if (resource.local_path) {
    return resolve(resource.local_path);
  }

  // ls-remote/mirror resources must go through ensureContent() to clone properly
  if (resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror') {
    return null;
  }

  const url = resource.git_remote_url;
  for (const prefix of REMOTE_URL_PREFIXES) {
    if (url.startsWith(prefix)) return null;
  }
  return resolve(url);
}

function isPathWithin(filePath: string, baseDir: string): boolean {
  const resolved = resolve(filePath);
  const base = resolve(baseDir);
  return resolved === base || resolved.startsWith(base + '/');
}

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
  async function resolveResourceAndPath(
    request: { params: { id: string }; agent?: { id: string } },
    reply: { status: (code: number) => { send: (body: unknown) => unknown } }
  ): Promise<{ resource: SyncableResource; localPath: string; isCloned: boolean } | null> {
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

    // Trigger lazy clone (ls-remote) or verify eager clone (mirror)
    if (!localPath && (resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror')) {
      try {
        const contentPath = await getSyncOrchestrator().ensureContent(resource);
        if (contentPath) localPath = contentPath;
      } catch { /* clone failed */ }
    }

    if (!localPath) {
      reply.status(400).send({ error: 'Bad Request', message: 'Resource does not point to a local filesystem path' });
      return null;
    }
    if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
      reply.status(404).send({ error: 'Not Found', message: 'Resource path does not exist on the filesystem' });
      return null;
    }

    return { resource, localPath, isCloned: resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror' };
  }

  // ============================================================================
  // Memory Bank Endpoints (powered by minimem)
  // ============================================================================

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

    const skills = allSkills.map((skill: { id: string; name?: string; version?: string; status?: string; description?: string; tags?: string[]; author?: string }) => ({
      id: skill.id,
      name: skill.name || null,
      version: skill.version || null,
      status: skill.status || null,
      description: skill.description || null,
      tags: skill.tags,
      author: skill.author || null,
      path: pathMap.get(skill.id) || join('.skilltree', 'skills', skill.id, 'SKILL.md'),
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
      tags: skill.tags, author: skill.author || null,
      instructions: skill.instructions || null, related: skill.related || [], raw,
    });
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
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    const client = new OpenHiveOpenTasksClient(localPath);
    await client.connectDaemon();
    try {
      const summary = await client.getGraphSummary();
      return reply.send({ ...summary, daemon_connected: client.connected });
    } finally {
      client.disconnect();
    }
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: number };
  }>('/resources/:id/content/opentasks/ready', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    const limit = Math.min(Math.max(request.query.limit || 50, 1), 200);
    const client = new OpenHiveOpenTasksClient(localPath);
    await client.connectDaemon();
    try {
      const ready = await client.getReady({ limit });
      return reply.send({ items: ready, total: ready.length, daemon_connected: client.connected });
    } finally {
      client.disconnect();
    }
  });

  fastify.get<{
    Params: { id: string };
    Querystring: { status?: string; limit?: number; offset?: number };
  }>('/resources/:id/content/opentasks/tasks', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    const client = new OpenHiveOpenTasksClient(localPath);
    const connected = await client.connectDaemon();
    try {
      if (!connected) {
        const summary = await client.getGraphSummary();
        return reply.send({ daemon_connected: false, message: 'Daemon not running; returning summary only', task_counts: summary.task_counts });
      }

      const result = await client.queryNodes({
        type: 'task', status: request.query.status, archived: false,
        limit: Math.min(Math.max(request.query.limit || 50, 1), 200),
        offset: request.query.offset || 0,
      });

      return reply.send({ items: result?.items || [], daemon_connected: true });
    } finally {
      client.disconnect();
    }
  });

  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/status', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    const client = new OpenHiveOpenTasksClient(localPath);
    const daemonRunning = await client.isDaemonRunning();
    const graphPath = join(localPath, 'graph.jsonl');
    const graphExists = existsSync(graphPath);
    const graphModified = graphExists ? statSync(graphPath).mtime.toISOString() : null;

    return reply.send({ daemon_running: daemonRunning, graph_file_exists: graphExists, graph_last_modified: graphModified, socket_path: join(localPath, 'daemon.sock') });
  });

  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/graph', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    const graphPath = join(localPath, 'graph.jsonl');
    if (!existsSync(graphPath)) return reply.send({ nodes: [], edges: [] });

    const content = readFileSync(graphPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const edges: Record<string, unknown>[] = [];
    const nodeMap = new Map<string, Record<string, unknown>>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.from_id && obj.to_id) edges.push(obj);
        else if (obj.id) {
          const existing = nodeMap.get(obj.id);
          nodeMap.set(obj.id, existing ? { ...existing, ...obj } : obj);
        }
      } catch { /* skip malformed */ }
    }

    return reply.send({ nodes: [...nodeMap.values()], edges });
  });

  // OpenTasks mutations

  const CreateTaskNodeSchema = z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    status: z.string().optional(),
    priority: z.number().int().min(0).max(10).optional(),
    metadata: z.record(z.unknown()).optional(),
  });

  const UpdateTaskStatusSchema = z.object({
    status: z.string().min(1),
    result: z.record(z.unknown()).optional(),
    error: z.string().optional(),
  });

  fastify.post<{
    Params: { id: string };
  }>('/resources/:id/content/opentasks/tasks', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

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
      const task = await createFn(socketPath, { title: body.title, description: body.description, status: body.status || 'open', priority: body.priority });
      try { const { getMapTaskStore } = await import('../../map/task-store.js'); getMapTaskStore().emit({ type: 'task.created', data: { task: { id: task.id, title: task.title, status: task.status } } }, 'rest-api'); } catch { /* best effort */ }
      return reply.status(201).send({ node_id: task.id, status: task.status });
    } catch (err) {
      if (err instanceof DaemonErr && err.code === 'DAEMON_NOT_RUNNING') return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon is not running for this resource' });
      throw err;
    }
  });

  // PATCH — Update task status via daemon
  fastify.patch<{
    Params: { id: string; nodeId: string };
  }>('/resources/:id/content/opentasks/tasks/:nodeId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;
    if (!validateOpenTasksResource(resource, reply)) return;

    let body;
    try { body = UpdateTaskStatusSchema.parse(request.body); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'Invalid request body', details: error.errors });
      throw error;
    }

    const { daemonUpdateTask: updateFn, resolveDaemonSocket: resolveSocket, TaskDaemonError: DaemonErr } = await import('../../map/task-daemon-client.js');
    const socketPath = resolveSocket(localPath);
    try {
      await updateFn(socketPath, request.params.nodeId, { status: body.status });
      try { const { getMapTaskStore } = await import('../../map/task-store.js'); getMapTaskStore().emit({ type: 'task.status', data: { taskId: request.params.nodeId, current: body.status } }, 'rest-api'); } catch { /* best effort */ }
      return reply.send({ node_id: request.params.nodeId, previous_status: null, new_status: body.status });
    } catch (err) {
      if (err instanceof DaemonErr && err.code === 'DAEMON_NOT_RUNNING') return reply.status(503).send({ error: 'Service Unavailable', message: 'OpenTasks daemon is not running for this resource' });
      throw err;
    }
  });
}
