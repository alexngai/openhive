/**
 * Specs Routes
 *
 * Specs are surfaced as opentasks context nodes with `type: 'spec'` (per design
 * doc D2: docs/design/spec-to-swarm.md). Reads aggregate across every accessible
 * task resource — local opentasks daemons first, falling back to remote swarms
 * via MAP for federated graphs.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { resolveLocalPath } from './_resource-helpers.js';
import {
  daemonCreateSpec,
  daemonGetGraph,
  daemonGetNodeWithNeighbors,
  daemonUpdateSpec,
  resolveDaemonSocket,
  SPEC_METADATA_KIND,
  TaskDaemonError,
} from '../../map/task-daemon-client.js';
import { findSwarmForResource, remoteGetGraph } from '../../map/opentasks-remote.js';
import { broadcastToChannel } from '../../realtime/index.js';
import type { SyncableResource } from '../../types.js';
import type { Config } from '../../config.js';

const CreateSpecSchema = z.object({
  resource_id: z.string().min(1),
  title: z.string().min(1).max(500),
  content: z.string().max(50_000).optional(),
  priority: z.number().int().min(0).max(4).optional(),
});

const UpdateSpecSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    content: z.string().max(50_000).optional().nullable(),
    priority: z.number().int().min(0).max(4).optional().nullable(),
    archived: z.boolean().optional(),
    status: z.string().max(50).optional(),
  })
  .refine(
    (d) =>
      d.title !== undefined ||
      d.content !== undefined ||
      d.priority !== undefined ||
      d.archived !== undefined ||
      d.status !== undefined,
    { message: 'At least one field must be provided' },
  );

const PER_RESOURCE_LIMIT = 200;

/** Annotated spec returned to the client. */
interface Spec {
  id: string;
  resource_id: string;
  resource_name: string;
  swarm_id: string | null;
  swarm_name: string | null;
  title: string;
  content: string | null;
  status: string | null;
  priority: number | undefined;
  archived: boolean;
  created_at: string | null;
  updated_at: string | null;
  uri: string | null;
  source: 'local' | 'remote';
}

function isOpenTasksResource(r: SyncableResource): boolean {
  if (r.resource_type !== 'task') return false;
  const meta = r.metadata as Record<string, unknown> | null;
  return !!meta?.opentasks;
}

/**
 * A node counts as a spec if either:
 *   - its provider type is 'spec' (sudocode-sourced via the opentasks provider), or
 *   - it's a context node tagged with metadata.kind === 'spec' (user-authored
 *     through openhive — see daemonCreateSpec).
 */
function isSpecNode(node: Record<string, unknown>): boolean {
  if (node.type === 'spec') return true;
  if (node.type !== 'context') return false;
  const meta = node.metadata as Record<string, unknown> | undefined;
  return meta?.kind === SPEC_METADATA_KIND;
}

function normalizeNode(
  node: Record<string, unknown>,
  resource: SyncableResource,
  source: 'local' | 'remote',
  swarmInfo?: { id: string; name: string | null },
): Spec {
  return {
    id: String(node.id),
    resource_id: resource.id,
    resource_name: resource.name,
    swarm_id: swarmInfo?.id ?? null,
    swarm_name: swarmInfo?.name ?? null,
    title: (node.title as string) ?? '',
    content: ((node.content as string) ?? (node.description as string) ?? null) || null,
    status: (node.status as string) ?? null,
    priority: typeof node.priority === 'number' ? (node.priority as number) : undefined,
    archived: node.archived === true || node.archived === 1,
    created_at: (node.created_at as string) ?? (node.createdAt as string) ?? null,
    updated_at: (node.updated_at as string) ?? (node.updatedAt as string) ?? null,
    uri: (node.uri as string) ?? null,
    source,
  };
}

async function fetchSpecsForResource(
  resource: SyncableResource,
  includeArchived: boolean,
): Promise<Spec[]> {
  const localPath = resolveLocalPath(resource);

  // Local daemon first. We use `daemonGetGraph` (not `daemonQueryNodes`)
  // because the daemon's query endpoint strips `metadata` even with
  // verbose=true — and we need metadata to find user-authored specs marked
  // with `metadata.kind === 'spec'`. Sudocode-provider-emitted specs come
  // through with `type === 'spec'` and don't need the marker.
  if (localPath) {
    try {
      const socketPath = resolveDaemonSocket(localPath);
      const graph = await daemonGetGraph(socketPath, localPath, { includeArchived });
      const items = graph.nodes.filter((n) => isSpecNode(n));
      return items.slice(0, PER_RESOURCE_LIMIT).map((n) => normalizeNode(n, resource, 'local'));
    } catch (err) {
      if (!(err instanceof TaskDaemonError && err.code === 'DAEMON_NOT_RUNNING')) throw err;
      // fall through to remote
    }
  }

  // Remote swarm — pull the whole graph and filter the same way.
  const swarmId = findSwarmForResource(resource);
  if (!swarmId) return [];

  const remoteGraph = await remoteGetGraph(swarmId);
  if (!remoteGraph) return [];

  let swarmName: string | null = null;
  try {
    const { findSwarmById } = await import('../../db/dal/map.js');
    const swarm = findSwarmById(swarmId);
    swarmName = swarm?.name ?? null;
  } catch {
    /* non-critical */
  }

  const items = remoteGraph.nodes
    .filter((n) => isSpecNode(n as Record<string, unknown>))
    .filter((n) => includeArchived || !((n as Record<string, unknown>).archived === true || (n as Record<string, unknown>).archived === 1));
  return items
    .slice(0, PER_RESOURCE_LIMIT)
    .map((n) => normalizeNode(n as Record<string, unknown>, resource, 'remote', { id: swarmId, name: swarmName }));
}

/**
 * Categorize a node by its opentasks `type` for the detail view's grouped panels.
 */
function nodeKind(node: Record<string, unknown>): 'task' | 'context' | 'feedback' | 'spec' | 'issue' | 'other' {
  const t = node.type as string | undefined;
  if (t === 'task' || t === 'context' || t === 'feedback' || t === 'spec' || t === 'issue') return t;
  return 'other';
}

export async function specsRoutes(
  fastify: FastifyInstance,
  _options: { config: Config },
): Promise<void> {
  /**
   * GET /specs
   *
   * Lists specs across all accessible task resources (those with
   * `metadata.opentasks: true`). Aggregates from local daemons and remote
   * swarms. Returns flat list sorted by updated_at desc.
   */
  fastify.get<{
    Querystring: {
      limit?: number;
      offset?: number;
      include_archived?: string;
      resource_id?: string;
    };
  }>('/specs', { preHandler: authMiddleware }, async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const includeArchived = request.query.include_archived === 'true';

    // Gather candidate resources. If the caller asked for a specific resource,
    // narrow to that; otherwise list everything they can access.
    let resources: SyncableResource[];
    if (request.query.resource_id) {
      const r = resourcesDAL.findResourceById(request.query.resource_id);
      if (!r) return reply.status(404).send({ error: 'Not Found', message: 'Resource not found' });
      if (!resourcesDAL.canAccessResource(request.agent!.id, r)) {
        return reply.status(403).send({ error: 'Forbidden', message: 'No access to resource' });
      }
      if (!isOpenTasksResource(r)) {
        return reply
          .status(400)
          .send({ error: 'Bad Request', message: 'Resource is not an OpenTasks task graph' });
      }
      resources = [r];
    } else {
      const result = resourcesDAL.listAccessibleResources({
        agentId: request.agent!.id,
        resourceType: 'task',
        limit: 200,
        offset: 0,
      });
      resources = result.data.filter(isOpenTasksResource);
    }

    // Fetch in parallel; tolerate per-resource failures
    const fetchResults = await Promise.allSettled(
      resources.map((r) => fetchSpecsForResource(r, includeArchived)),
    );

    const errors: Array<{ resource_id: string; message: string }> = [];
    const allSpecs: Spec[] = [];
    fetchResults.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        allSpecs.push(...res.value);
      } else {
        errors.push({
          resource_id: resources[i]!.id,
          message: res.reason instanceof Error ? res.reason.message : String(res.reason),
        });
      }
    });

    // Dedupe by `${resource_id}:${id}` (defensive — local + remote shouldn't both return for same resource)
    const seen = new Set<string>();
    const deduped = allSpecs.filter((s) => {
      const key = `${s.resource_id}:${s.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by updated_at desc, falling back to created_at
    deduped.sort((a, b) => {
      const aTime = a.updated_at || a.created_at || '';
      const bTime = b.updated_at || b.created_at || '';
      return bTime.localeCompare(aTime);
    });

    const total = deduped.length;
    const page = deduped.slice(offset, offset + limit);

    return reply.send({
      data: page,
      total,
      limit,
      offset,
      errors: errors.length > 0 ? errors : undefined,
    });
  });

  /**
   * GET /specs/:resourceId/:specId
   *
   * Returns a single spec node plus its 1-hop neighbors grouped by kind
   * (linked tasks, contexts, feedback). Local daemon first, then MAP fallback.
   */
  fastify.get<{
    Params: { resourceId: string; specId: string };
  }>('/specs/:resourceId/:specId', { preHandler: authMiddleware }, async (request, reply) => {
    const { resourceId, specId } = request.params;
    const resource = resourcesDAL.findResourceById(resourceId);
    if (!resource) {
      return reply.status(404).send({ error: 'Not Found', message: 'Resource not found' });
    }
    if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'No access to resource' });
    }
    if (!isOpenTasksResource(resource)) {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: 'Resource is not an OpenTasks task graph' });
    }

    const localPath = resolveLocalPath(resource);
    let node: Record<string, unknown> | null = null;
    let neighbors: Record<string, unknown>[] = [];
    let edges: Array<{ from_id: string; to_id: string; type: string }> = [];
    let source: 'local' | 'remote' = 'local';
    let swarmInfo: { id: string; name: string | null } | undefined;

    if (localPath) {
      try {
        const socketPath = resolveDaemonSocket(localPath);
        const result = await daemonGetNodeWithNeighbors(socketPath, specId, localPath);
        node = result.node;
        neighbors = result.neighbors;
        edges = result.edges;
      } catch (err) {
        if (!(err instanceof TaskDaemonError && err.code === 'DAEMON_NOT_RUNNING')) throw err;
      }
    }

    // Remote fallback: pull the whole graph (existing pattern), filter to this spec + neighbors
    if (!node) {
      const swarmId = findSwarmForResource(resource);
      if (swarmId) {
        const graph = await remoteGetGraph(swarmId);
        if (graph) {
          source = 'remote';
          const remoteNode = graph.nodes.find((n) => n.id === specId);
          if (remoteNode) {
            node = remoteNode;
            const neighborIds = new Set<string>();
            const filteredEdges: typeof edges = [];
            for (const e of graph.edges as Array<Record<string, unknown>>) {
              const fromId = String(e.from_id);
              const toId = String(e.to_id);
              if (fromId === specId || toId === specId) {
                filteredEdges.push({ from_id: fromId, to_id: toId, type: String(e.type) });
                if (fromId !== specId) neighborIds.add(fromId);
                if (toId !== specId) neighborIds.add(toId);
              }
            }
            neighbors = graph.nodes.filter((n) => neighborIds.has(String(n.id)));
            edges = filteredEdges;

            try {
              const { findSwarmById } = await import('../../db/dal/map.js');
              const swarm = findSwarmById(swarmId);
              swarmInfo = { id: swarmId, name: swarm?.name ?? null };
            } catch {
              /* non-critical */
            }
          }
        }
      }
    }

    if (!node) {
      return reply.status(404).send({ error: 'Not Found', message: 'Spec not found' });
    }
    if (!isSpecNode(node)) {
      return reply
        .status(404)
        .send({ error: 'Not Found', message: 'Node exists but is not a spec' });
    }

    // Group neighbors by kind so the UI can render them in panels.
    // Context nodes that are themselves specs (kind=spec) go into `specs`,
    // not the generic context bucket.
    const linked = {
      tasks: [] as Record<string, unknown>[],
      contexts: [] as Record<string, unknown>[],
      feedback: [] as Record<string, unknown>[],
      specs: [] as Record<string, unknown>[],
      issues: [] as Record<string, unknown>[],
      other: [] as Record<string, unknown>[],
    };
    for (const n of neighbors) {
      if (isSpecNode(n)) {
        linked.specs.push(n);
        continue;
      }
      const kind = nodeKind(n);
      if (kind === 'task') linked.tasks.push(n);
      else if (kind === 'context') linked.contexts.push(n);
      else if (kind === 'feedback') linked.feedback.push(n);
      else if (kind === 'spec') linked.specs.push(n);
      else if (kind === 'issue') linked.issues.push(n);
      else linked.other.push(n);
    }

    return reply.send({
      spec: normalizeNode(node, resource, source, swarmInfo),
      raw: node,
      linked,
      edges,
    });
  });

  /**
   * POST /specs
   *
   * Creates a new spec node in the target task resource's opentasks graph.
   * Requires a local daemon (write path) — remote create-via-MAP is deferred
   * to a future PR alongside the equivalent for tasks.
   */
  fastify.post('/specs', { preHandler: authMiddleware }, async (request, reply) => {
    let body: z.infer<typeof CreateSpecSchema>;
    try {
      body = CreateSpecSchema.parse(request.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(422).send({ error: 'VALIDATION_ERROR', details: err.errors });
      }
      throw err;
    }

    const resource = resourcesDAL.findResourceById(body.resource_id);
    if (!resource) return reply.status(404).send({ error: 'Not Found', message: 'Resource not found' });
    if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'No access to resource' });
    }
    if (!isOpenTasksResource(resource)) {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: 'Resource is not an OpenTasks task graph' });
    }

    const localPath = resolveLocalPath(resource);
    if (!localPath) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Spec creation requires a local opentasks daemon. Remote-write via MAP is not yet supported.',
      });
    }

    try {
      const node = await daemonCreateSpec(
        resolveDaemonSocket(localPath),
        { title: body.title, content: body.content, priority: body.priority },
        localPath,
      );
      const normalized = normalizeNode(node, resource, 'local');

      try {
        broadcastToChannel('map:tasks', {
          type: 'spec.created',
          data: {
            spec: { id: normalized.id, title: normalized.title },
            resource_id: resource.id,
            initiator: { type: 'user', id: request.agent!.id },
          },
        });
      } catch {
        /* best effort */
      }

      return reply.status(201).send({ spec: normalized });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'Internal Error', message: msg });
    }
  });

  /**
   * PATCH /specs/:resourceId/:specId
   *
   * Updates a spec node. Edits commit straight through to opentasks per D10.
   */
  fastify.patch<{
    Params: { resourceId: string; specId: string };
  }>('/specs/:resourceId/:specId', { preHandler: authMiddleware }, async (request, reply) => {
    let body: z.infer<typeof UpdateSpecSchema>;
    try {
      body = UpdateSpecSchema.parse(request.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.status(422).send({ error: 'VALIDATION_ERROR', details: err.errors });
      }
      throw err;
    }

    const { resourceId, specId } = request.params;
    const resource = resourcesDAL.findResourceById(resourceId);
    if (!resource) return reply.status(404).send({ error: 'Not Found', message: 'Resource not found' });
    if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
      return reply.status(403).send({ error: 'Forbidden', message: 'No access to resource' });
    }
    if (!isOpenTasksResource(resource)) {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: 'Resource is not an OpenTasks task graph' });
    }

    const localPath = resolveLocalPath(resource);
    if (!localPath) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Spec update requires a local opentasks daemon. Remote-write via MAP is not yet supported.',
      });
    }

    const updates: Parameters<typeof daemonUpdateSpec>[2] = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.content !== undefined) updates.content = body.content ?? '';
    if (body.priority !== undefined && body.priority !== null) updates.priority = body.priority;
    if (body.archived !== undefined) updates.archived = body.archived;
    if (body.status !== undefined) updates.status = body.status;

    try {
      const node = await daemonUpdateSpec(
        resolveDaemonSocket(localPath),
        specId,
        updates,
        localPath,
      );
      const normalized = normalizeNode(node, resource, 'local');

      try {
        broadcastToChannel('map:tasks', {
          type: 'spec.updated',
          data: {
            spec: { id: normalized.id, title: normalized.title, archived: normalized.archived },
            resource_id: resource.id,
            initiator: { type: 'user', id: request.agent!.id },
          },
        });
      } catch {
        /* best effort */
      }

      return reply.send({ spec: normalized });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'Internal Error', message: msg });
    }
  });
}
