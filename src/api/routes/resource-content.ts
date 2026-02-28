import { FastifyInstance } from 'fastify';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative, extname } from 'node:path';
import { parseFrontmatter } from 'minimem/session';
import { listMemoryFiles } from 'minimem/internal';
import { FilesystemStorageAdapter, discoverSkills } from 'skill-tree';
import { authMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { OpenHiveOpenTasksClient } from '../../opentasks/index.js';
import type { SyncableResource } from '../../types.js';
import type { Config } from '../../config.js';

// ============================================================================
// Helpers
// ============================================================================

const REMOTE_URL_PREFIXES = ['http', 'git://', 'ssh://'];

/**
 * Determine whether a resource's git_remote_url points to a local filesystem path.
 * Returns the resolved absolute path, or null if the URL is a remote.
 */
function resolveLocalPath(resource: SyncableResource): string | null {
  const url = resource.git_remote_url;
  for (const prefix of REMOTE_URL_PREFIXES) {
    if (url.startsWith(prefix)) {
      return null;
    }
  }
  return resolve(url);
}

/**
 * Validate that a resolved file path is safely within the given base directory.
 * Prevents directory traversal attacks.
 */
function isPathWithin(filePath: string, baseDir: string): boolean {
  const resolved = resolve(filePath);
  const base = resolve(baseDir);
  return resolved === base || resolved.startsWith(base + '/');
}

/**
 * Validate a user-supplied relative path parameter:
 * - Must not contain `..` segments
 * - Must not be absolute
 * - Must resolve within the base directory
 * - Must point to a .md file
 */
function validateRelativePath(pathParam: string, baseDir: string): string | null {
  if (!pathParam || pathParam.includes('..') || resolve(pathParam) === pathParam) {
    return null;
  }
  const fullPath = join(baseDir, pathParam);
  if (!isPathWithin(fullPath, baseDir)) {
    return null;
  }
  if (extname(fullPath).toLowerCase() !== '.md') {
    return null;
  }
  return fullPath;
}

// ============================================================================
// Route Registration
// ============================================================================

export async function resourceContentRoutes(
  fastify: FastifyInstance,
  _options: { config: Config }
): Promise<void> {

  // ============================================================================
  // Shared preHandler: resolve resource, check access, resolve local path
  // ============================================================================

  async function resolveResourceAndPath(
    request: { params: { id: string }; agent?: { id: string } },
    reply: { status: (code: number) => { send: (body: unknown) => unknown } }
  ): Promise<{ resource: SyncableResource; localPath: string } | null> {
    const resource = resourcesDAL.findResourceById(request.params.id);

    if (!resource) {
      reply.status(404).send({
        error: 'Not Found',
        message: 'Resource not found',
      });
      return null;
    }

    if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
      reply.status(403).send({
        error: 'Forbidden',
        message: 'You do not have access to this resource',
      });
      return null;
    }

    const localPath = resolveLocalPath(resource);

    if (!localPath) {
      reply.status(400).send({
        error: 'Bad Request',
        message: 'Resource does not point to a local filesystem path',
      });
      return null;
    }

    if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
      reply.status(404).send({
        error: 'Not Found',
        message: 'Resource path does not exist on the filesystem',
      });
      return null;
    }

    return { resource, localPath };
  }

  // ============================================================================
  // Memory Bank Endpoints (powered by minimem)
  // ============================================================================

  // 1. List all memory files
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/files', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'This endpoint is only available for memory_bank resources',
      });
    }

    const memoryFiles = await listMemoryFiles(localPath);

    const files = memoryFiles.map((filePath) => {
      const stat = statSync(filePath);
      return {
        path: relative(localPath, filePath),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    });

    return reply.send({ files });
  });

  // 2. Read a single memory file
  fastify.get<{
    Params: { id: string };
    Querystring: { path?: string };
  }>('/resources/:id/content/file', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'This endpoint is only available for memory_bank resources',
      });
    }

    const pathParam = request.query.path;
    if (!pathParam) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Query parameter "path" is required',
      });
    }

    const fullPath = validateRelativePath(pathParam, localPath);
    if (!fullPath) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Invalid file path. Path must be relative, within the resource directory, and point to a .md file.',
      });
    }

    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'File not found',
      });
    }

    const content = readFileSync(fullPath, 'utf-8');
    const stat = statSync(fullPath);
    const { frontmatter, body } = parseFrontmatter(content);

    return reply.send({
      path: relative(localPath, fullPath),
      frontmatter: frontmatter ?? null,
      body,
      size: stat.size,
    });
  });

  // 3. Search across memory files
  fastify.get<{
    Params: { id: string };
    Querystring: { q?: string; limit?: number };
  }>('/resources/:id/content/search', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'This endpoint is only available for memory_bank resources',
      });
    }

    const query = request.query.q;
    if (!query || query.trim().length === 0) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Query parameter "q" is required',
      });
    }

    const limit = Math.min(Math.max(request.query.limit || 20, 1), 100);
    const queryLower = query.toLowerCase();
    const memoryFiles = await listMemoryFiles(localPath);

    const results: Array<{
      path: string;
      line: number;
      snippet: string;
      score: number;
    }> = [];

    for (const filePath of memoryFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const relPath = relative(localPath, filePath);

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          // Build a context snippet: the matching line plus up to 1 line before/after
          const snippetLines: string[] = [];
          if (i > 0) snippetLines.push(lines[i - 1]);
          snippetLines.push(lines[i]);
          if (i < lines.length - 1) snippetLines.push(lines[i + 1]);

          // Simple relevance score: count occurrences in the line
          const occurrences = lines[i].toLowerCase().split(queryLower).length - 1;

          results.push({
            path: relPath,
            line: i + 1,
            snippet: snippetLines.join('\n'),
            score: occurrences,
          });
        }
      }
    }

    // Sort by score descending, then by file path and line number
    results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);

    const total = results.length;
    const trimmed = results.slice(0, limit);

    return reply.send({ results: trimmed, total });
  });

  // ============================================================================
  // Knowledge-Aware Endpoints (cognitive-core compatible)
  // ============================================================================

  // 3b. Knowledge search — filter by domain, entity, type, confidence
  fastify.get<{
    Params: { id: string };
    Querystring: {
      q?: string;
      domain?: string;
      entity?: string;
      type?: string;
      min_confidence?: number;
      limit?: number;
    };
  }>('/resources/:id/content/knowledge', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'This endpoint is only available for memory_bank resources',
      });
    }

    const { q, domain, entity, type: knowledgeType, min_confidence } = request.query;
    const limit = Math.min(Math.max(request.query.limit || 50, 1), 200);

    const memoryFiles = await listMemoryFiles(localPath);
    const results: Array<{
      path: string;
      frontmatter: Record<string, unknown> | null;
      snippet: string;
      knowledge_type: string | null;
    }> = [];

    for (const filePath of memoryFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      const relPath = relative(localPath, filePath);

      // Apply knowledge filters
      if (knowledgeType && frontmatter?.type !== knowledgeType) continue;

      if (domain) {
        const domains = frontmatter?.domain;
        if (!Array.isArray(domains) || !domains.some(
          (d: string) => d.toLowerCase() === domain.toLowerCase()
        )) continue;
      }

      if (entity) {
        const entities = frontmatter?.entities;
        if (!Array.isArray(entities) || !entities.some(
          (e: string) => e.toLowerCase() === entity.toLowerCase()
        )) continue;
      }

      if (min_confidence !== undefined) {
        const conf = frontmatter?.confidence;
        if (typeof conf !== 'number' || conf < min_confidence) continue;
      }

      // Apply text query filter (on body content)
      if (q && q.trim().length > 0) {
        const qLower = q.toLowerCase();
        if (!body.toLowerCase().includes(qLower) && !content.toLowerCase().includes(qLower)) continue;
      }

      // Build snippet from first non-empty body lines
      const snippetLines = body.split('\n').filter(l => l.trim().length > 0).slice(0, 3);

      results.push({
        path: relPath,
        frontmatter: frontmatter ?? null,
        snippet: snippetLines.join('\n'),
        knowledge_type: (frontmatter?.type as string) ?? null,
      });
    }

    // Sort by confidence descending (knowledge notes first), then path
    results.sort((a, b) => {
      const confA = (a.frontmatter?.confidence as number) ?? -1;
      const confB = (b.frontmatter?.confidence as number) ?? -1;
      return confB - confA || a.path.localeCompare(b.path);
    });

    return reply.send({
      results: results.slice(0, limit),
      total: results.length,
    });
  });

  // 3c. Knowledge graph traversal — follow links from a note
  fastify.get<{
    Params: { id: string };
    Querystring: {
      note_id: string;
      direction?: string;
      relation?: string;
      depth?: number;
    };
  }>('/resources/:id/content/knowledge/graph', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'memory_bank') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'This endpoint is only available for memory_bank resources',
      });
    }

    const { note_id, direction = 'outgoing', relation } = request.query;
    const maxDepth = Math.min(Math.max(request.query.depth || 1, 1), 5);

    if (!note_id) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Query parameter "note_id" is required',
      });
    }

    // Build a knowledge index: id -> { path, frontmatter, links }
    const memoryFiles = await listMemoryFiles(localPath);
    const noteIndex = new Map<string, {
      path: string;
      frontmatter: Record<string, unknown>;
      links: Array<{ target: string; relation: string; layer?: string }>;
    }>();
    // Reverse index for incoming links: target_id -> source_id[]
    const reverseLinks = new Map<string, string[]>();

    for (const filePath of memoryFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const { frontmatter } = parseFrontmatter(content);
      if (!frontmatter?.id) continue;

      const noteId = frontmatter.id as string;
      const links = Array.isArray(frontmatter.links)
        ? (frontmatter.links as Array<{ target: string; relation: string; layer?: string }>)
        : [];

      noteIndex.set(noteId, {
        path: relative(localPath, filePath),
        frontmatter,
        links,
      });

      for (const link of links) {
        if (!reverseLinks.has(link.target)) reverseLinks.set(link.target, []);
        reverseLinks.get(link.target)!.push(noteId);
      }
    }

    // BFS traversal
    const visited = new Set<string>();
    const edges: Array<{
      from: string;
      to: string;
      relation: string;
      layer?: string;
      depth: number;
    }> = [];

    let frontier = [note_id];
    visited.add(note_id);

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (const currentId of frontier) {
        if (direction === 'outgoing' || direction === 'both') {
          const note = noteIndex.get(currentId);
          if (note) {
            for (const link of note.links) {
              if (relation && link.relation !== relation) continue;
              edges.push({ from: currentId, to: link.target, relation: link.relation, layer: link.layer, depth });
              if (!visited.has(link.target)) {
                visited.add(link.target);
                nextFrontier.push(link.target);
              }
            }
          }
        }

        if (direction === 'incoming' || direction === 'both') {
          const incomingIds = reverseLinks.get(currentId) || [];
          for (const sourceId of incomingIds) {
            const sourceNote = noteIndex.get(sourceId);
            if (!sourceNote) continue;
            for (const link of sourceNote.links) {
              if (link.target !== currentId) continue;
              if (relation && link.relation !== relation) continue;
              edges.push({ from: sourceId, to: currentId, relation: link.relation, layer: link.layer, depth });
              if (!visited.has(sourceId)) {
                visited.add(sourceId);
                nextFrontier.push(sourceId);
              }
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    // Build nodes for all visited IDs
    const nodes: Array<{
      id: string;
      path: string | null;
      type: string | null;
      confidence: number | null;
    }> = [];

    for (const visitedId of visited) {
      const note = noteIndex.get(visitedId);
      nodes.push({
        id: visitedId,
        path: note?.path ?? null,
        type: (note?.frontmatter?.type as string) ?? null,
        confidence: (note?.frontmatter?.confidence as number) ?? null,
      });
    }

    return reply.send({ root: note_id, nodes, edges });
  });

  // ============================================================================
  // Skill Content Endpoints (powered by skill-tree)
  // ============================================================================

  // 4. List all skills
  fastify.get<{
    Params: { id: string };
  }>('/resources/:id/content/skills', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'This endpoint is only available for skill resources',
      });
    }

    const adapter = new FilesystemStorageAdapter({ basePath: localPath });
    await adapter.initialize();
    const allSkills = await adapter.listSkills();

    // Get file paths via discovery for the path field
    const discovered = await discoverSkills(localPath);
    const pathMap = new Map(discovered.map(d => [d.id, relative(localPath, d.filePath)]));

    const skills = allSkills.map(skill => ({
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

  // 5. Get full skill content
  fastify.get<{
    Params: { id: string; skillId: string };
  }>('/resources/:id/content/skills/:skillId', { preHandler: authMiddleware }, async (request, reply) => {
    const ctx = await resolveResourceAndPath(request, reply);
    if (!ctx) return;
    const { resource, localPath } = ctx;

    if (resource.resource_type !== 'skill') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'This endpoint is only available for skill resources',
      });
    }

    const { skillId } = request.params;

    // Validate skill ID: must be a simple directory name, no path traversal
    if (!skillId || skillId.includes('..') || skillId.includes('/') || skillId.includes('\\')) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Invalid skill ID',
      });
    }

    const adapter = new FilesystemStorageAdapter({ basePath: localPath });
    await adapter.initialize();
    const skill = await adapter.getSkill(skillId);

    if (!skill) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Skill "${skillId}" not found`,
      });
    }

    // Read raw content for the `raw` field
    const discovered = await discoverSkills(localPath);
    const location = discovered.find(d => d.id === skillId);
    const raw = location ? readFileSync(location.filePath, 'utf-8') : '';

    return reply.send({
      id: skill.id,
      name: skill.name || null,
      version: skill.version || null,
      status: skill.status || null,
      description: skill.description || null,
      tags: skill.tags,
      author: skill.author || null,
      problem: skill.problem || null,
      triggerConditions: skill.triggerConditions,
      solution: skill.solution || null,
      verification: skill.verification || null,
      examples: skill.examples,
      notes: skill.notes || null,
      raw,
    });
  });

  // ============================================================================
  // OpenTasks Content Endpoints
  // ============================================================================

  /** Validate that a resource is an OpenTasks task resource */
  function validateOpenTasksResource(
    resource: SyncableResource,
    reply: { status: (code: number) => { send: (body: unknown) => unknown } }
  ): boolean {
    const meta = resource.metadata as Record<string, unknown> | null;
    if (resource.resource_type !== 'task' || !meta?.opentasks) {
      reply.status(400).send({
        error: 'Bad Request',
        message: 'This endpoint is only available for OpenTasks task resources',
      });
      return false;
    }
    return true;
  }

  // 6. OpenTasks graph summary
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

  // 7. OpenTasks ready tasks (unblocked, open)
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

  // 8. OpenTasks task listing
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
        // Fallback: return summary from JSONL
        const summary = await client.getGraphSummary();
        return reply.send({
          daemon_connected: false,
          message: 'Daemon not running; returning summary only',
          task_counts: summary.task_counts,
        });
      }

      const result = await client.queryNodes({
        type: 'task',
        status: request.query.status,
        archived: false,
        limit: Math.min(Math.max(request.query.limit || 50, 1), 200),
        offset: request.query.offset || 0,
      });

      return reply.send({
        items: result?.items || [],
        daemon_connected: true,
      });
    } finally {
      client.disconnect();
    }
  });

  // 9. OpenTasks daemon status
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

    return reply.send({
      daemon_running: daemonRunning,
      graph_file_exists: graphExists,
      graph_last_modified: graphModified,
      socket_path: join(localPath, 'daemon.sock'),
    });
  });
}
