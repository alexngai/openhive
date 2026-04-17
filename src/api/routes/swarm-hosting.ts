/**
 * Swarm Hosting API Routes
 *
 * REST API for spawning, managing, and monitoring OpenSwarm instances
 * hosted by this OpenHive instance.
 *
 * Routes:
 *   POST   /map/hosted/spawn         - Spawn a new hosted swarm
 *   GET    /map/hosted               - List hosted swarms
 *   GET    /map/hosted/:id           - Get hosted swarm details
 *   POST   /map/hosted/:id/stop      - Stop a hosted swarm
 *   POST   /map/hosted/:id/restart   - Restart a hosted swarm
 *   DELETE /map/hosted/:id           - Remove a stopped/failed hosted swarm
 *   GET    /map/hosted/:id/logs      - Get logs from a hosted swarm
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { SwarmHostingError } from '../../swarm/manager.js';
import * as dal from '../../swarm/dal.js';
import * as mapDal from '../../db/dal/map.js';
import type { SwarmManager } from '../../swarm/manager.js';
import type { Config } from '../../config.js';

// ============================================================================
// Zod Schemas
// ============================================================================

const WorkspaceRepoSchema = z.object({
  url: z.string().min(1).max(2000),
  branch: z.string().max(200).optional(),
  path: z.string().max(500).optional(),
  depth: z.number().int().positive().optional(),
});

const WorkspaceSchema = z.object({
  repos: z.array(WorkspaceRepoSchema).min(1).max(10),
});

const BootstrapSchema = z.object({
  coordinator: z.boolean().optional(),
  cwd: z.string().max(2000).optional(),
});

const SpawnSwarmSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  adapter: z.string().max(100).optional(),
  adapter_config: z.record(z.unknown()).optional(),
  hive: z.string().max(100).optional(),
  provider: z.enum(['local', 'local-sandboxed', 'docker', 'fly', 'ssh', 'k8s']).optional(),
  metadata: z.record(z.unknown()).optional(),
  credential_overrides: z.record(z.string(), z.string()).optional(),
  workspace: WorkspaceSchema.optional(),
  bootstrap: BootstrapSchema.optional(),
});

// ============================================================================
// Error Handler
// ============================================================================

function handleSwarmError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof SwarmHostingError) {
    const statusMap: Record<string, number> = {
      MAX_SWARMS_REACHED: 429,
      PROVIDER_NOT_AVAILABLE: 400,
      NO_PORTS_AVAILABLE: 503,
      HIVE_NOT_FOUND: 404,
      PREAUTH_KEY_FAILED: 500,
      WORKSPACE_SETUP_FAILED: 500,
      SPAWN_FAILED: 500,
      NOT_FOUND: 404,
      NOT_OWNER: 403,
      RESTART_NOT_SUPPORTED: 400,
      RESTART_FAILED: 500,
    };
    return reply.status(statusMap[error.code] || 500).send({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof z.ZodError) {
    return reply.status(422).send({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request body',
      details: error.errors,
    });
  }
  throw error;
}

// ============================================================================
// Route Registration
// ============================================================================

export async function swarmHostingRoutes(
  fastify: FastifyInstance,
  _opts: { config: Config }
): Promise<void> {
  // Helper to get the SwarmManager from the fastify instance
  function getManager(request: FastifyRequest): SwarmManager {
    const manager = (request.server as unknown as { swarmManager?: SwarmManager }).swarmManager;
    if (!manager) {
      throw new SwarmHostingError(
        'PROVIDER_NOT_AVAILABLE',
        'Swarm hosting is not enabled. Set swarmHosting.enabled = true in config.'
      );
    }
    return manager;
  }

  // POST /map/hosted/spawn — Spawn a new hosted swarm
  fastify.post('/map/hosted/spawn', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const manager = getManager(request);
      const body = SpawnSwarmSchema.parse(request.body);
      const hosted = await manager.spawn(request.agent!.id, body);

      return reply.status(201).send({
        id: hosted.id,
        name: hosted.config?.name ?? hosted.id,
        swarm_id: hosted.swarm_id,
        provider: hosted.provider,
        state: hosted.state,
        endpoint: hosted.endpoint,
        assigned_port: hosted.assigned_port,
        created_at: hosted.created_at,
      });
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // GET /map/known-project-paths — Distinct project paths recorded across
  // swarms (metadata.projectPath) and hosted-swarm bootstrap configs
  // (config.bootstrap.cwd). Used by the Spawn Swarm dialog's project
  // directory autocomplete so users can pick a previously-used path.
  // Cheap lookup; no auth required beyond the standard middleware.
  fastify.get('/map/known-project-paths', {
    preHandler: [authMiddleware],
  }, async (_request, reply) => {
    const fromSwarms = mapDal.listKnownProjectPaths(50);
    const fromHosted = dal.listKnownBootstrapCwds(50);
    // Dedupe + cap. Hosted bootstrap entries typically reflect more recent
    // user intent (the user explicitly typed the path), so they win order
    // ties when iteration order matters for "first match" UX.
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const p of [...fromHosted, ...fromSwarms]) {
      if (seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
      if (paths.length >= 50) break;
    }
    return reply.send({ paths });
  });

  // GET /map/hosted — List hosted swarms
  fastify.get<{
    Querystring: {
      state?: string;
      provider?: string;
      mine?: string;
      limit?: string;
      offset?: string;
    };
  }>('/map/hosted', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { state, provider, mine, limit, offset } = request.query;

    const result = dal.listHostedSwarms({
      state: state as never,
      provider: provider as never,
      spawned_by: mine === 'true' ? request.agent!.id : undefined,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    // Strip sensitive fields from config
    const data = result.data.map((h) => ({
      id: h.id,
      name: h.config?.name ?? h.id,
      swarm_id: h.swarm_id,
      provider: h.provider,
      state: h.state,
      pid: h.pid,
      assigned_port: h.assigned_port,
      endpoint: h.endpoint,
      error: h.error,
      spawned_by: h.spawned_by,
      created_at: h.created_at,
      updated_at: h.updated_at,
    }));

    return reply.send({ data, total: result.total });
  });

  // GET /map/hosted/:id — Get hosted swarm details
  fastify.get<{ Params: { id: string } }>('/map/hosted/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const hosted = dal.findHostedSwarmById(request.params.id);
    if (!hosted) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Hosted swarm not found' });
    }

    return reply.send({
      id: hosted.id,
      name: hosted.config?.name ?? hosted.id,
      swarm_id: hosted.swarm_id,
      provider: hosted.provider,
      state: hosted.state,
      pid: hosted.pid,
      container_id: hosted.container_id,
      assigned_port: hosted.assigned_port,
      endpoint: hosted.endpoint,
      error: hosted.error,
      spawned_by: hosted.spawned_by,
      created_at: hosted.created_at,
      updated_at: hosted.updated_at,
    });
  });

  // POST /map/hosted/:id/stop — Stop a hosted swarm
  fastify.post<{ Params: { id: string } }>('/map/hosted/:id/stop', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const manager = getManager(request);
      const hosted = await manager.stop(request.params.id, request.agent!.id);

      // SwarmCraft's outbound MAP client to this swarm's MAP server still holds
      // a now-dead WebSocket (the openswarm process just exited). Without
      // explicit disconnect, a subsequent spawn against this swarm (after
      // restart or a fresh spawn reusing the same swarm_id) would try to use
      // the stale client and fail with "Connection closed". Force disconnect
      // so the next connect opens a fresh client.
      if (hosted.swarm_id) {
        const sc = (fastify as any).swarmcraft;
        try {
          await sc?.mapClientManager?.disconnect?.(hosted.swarm_id);
        } catch { /* best-effort */ }
      }

      return reply.send({
        id: hosted.id,
        state: hosted.state,
        message: 'Swarm stopped successfully',
      });
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // POST /map/hosted/:id/restart — Restart a hosted swarm
  fastify.post<{ Params: { id: string } }>('/map/hosted/:id/restart', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const manager = getManager(request);

      // Drop any stale MAP client BEFORE re-provisioning. restart() may be a
      // hot bounce (same process) or a cold-start (process recreated); in
      // either case, the old client's socket may be dead. Disconnect first,
      // then let swarmcraft's bridge auto-connect on the spawned event.
      const existing = dal.findHostedSwarmById(request.params.id);
      if (existing?.swarm_id) {
        const sc = (fastify as any).swarmcraft;
        try {
          await sc?.mapClientManager?.disconnect?.(existing.swarm_id);
        } catch { /* best-effort */ }
      }

      const hosted = await manager.restart(request.params.id, request.agent!.id);

      // Trigger swarmcraft to reconnect its outbound MAP client. Its bridge
      // only auto-connects on swarm_registered (first-time registration), not
      // on restart of an existing swarm — so without this, post-restart spawn
      // calls would 503 ("MAP client not connected"). Use the same URL shape
      // the bridge uses (port+2 + /map path).
      if (hosted.swarm_id && hosted.endpoint) {
        const sc = (fastify as any).swarmcraft;
        try {
          const basePort = parseInt(new URL(hosted.endpoint).port, 10);
          if (Number.isFinite(basePort) && sc?.mapClientManager?.connect) {
            await sc.mapClientManager.connect({
              id: hosted.swarm_id,
              name: hosted.config?.name ?? hosted.id,
              url: `ws://127.0.0.1:${basePort + 2}/map`,
              auth: { method: 'none' },
              skipSubscription: true,
            });
          }
        } catch { /* best-effort; next action will surface the error */ }
      }

      return reply.send({
        id: hosted.id,
        state: hosted.state,
        endpoint: hosted.endpoint,
        message: 'Swarm restarted successfully',
      });
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // DELETE /map/hosted/:id — Remove a stopped/failed hosted swarm record
  fastify.delete<{ Params: { id: string } }>('/map/hosted/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const hosted = dal.findHostedSwarmById(request.params.id);
    if (!hosted) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Hosted swarm not found' });
    }
    if (hosted.spawned_by !== request.agent!.id) {
      return reply.status(403).send({ error: 'NOT_OWNER', message: 'You did not spawn this swarm' });
    }
    if (hosted.state !== 'stopped' && hosted.state !== 'failed') {
      return reply.status(409).send({
        error: 'INVALID_STATE',
        message: `Cannot remove a swarm in "${hosted.state}" state. Stop it first.`,
      });
    }

    dal.deleteHostedSwarm(hosted.id);
    return reply.status(204).send();
  });

  // GET /map/hosted/:id/logs — Get logs from a hosted swarm
  fastify.get<{
    Params: { id: string };
    Querystring: { lines?: string };
  }>('/map/hosted/:id/logs', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const manager = getManager(request);
      const lines = request.query.lines ? parseInt(request.query.lines, 10) : undefined;
      const logs = await manager.getLogs(request.params.id, request.agent!.id, { lines });

      return reply.type('text/plain').send(logs);
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // GET /map/hosted/:id/terminal-info — Get terminal command for connecting TUI to a swarm
  fastify.get<{ Params: { id: string } }>('/map/hosted/:id/terminal-info', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const hosted = dal.findHostedSwarmById(request.params.id);
    if (!hosted) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Hosted swarm not found' });
    }
    if (hosted.state !== 'running') {
      return reply.status(409).send({ error: 'NOT_RUNNING', message: 'Swarm is not running' });
    }

    const baseEndpoint = hosted.endpoint || `ws://127.0.0.1:${hosted.assigned_port}`;
    // The TUI connects to /map for the MAP protocol. It internally derives /acp from /map.
    // The stored endpoint often omits the path, so ensure it's present.
    const mapEndpoint = baseEndpoint.endsWith('/map') ? baseEndpoint : `${baseEndpoint}/map`;

    try {
      const { resolveOpenSwarmTuiBinary } = await import('../../terminal/resolve-tui.js');
      const binaryPath = resolveOpenSwarmTuiBinary();

      console.log('[terminal-info] swarm=%s endpoint=%s binary=%s', request.params.id, mapEndpoint, binaryPath ?? 'NOT_FOUND');

      return reply.send({
        available: !!binaryPath,
        command: binaryPath,
        args: binaryPath ? ['--url', mapEndpoint, '--auto-connect'] : [],
        endpoint: mapEndpoint,
      });
    } catch (err) {
      console.warn('[terminal-info] resolve failed for swarm=%s:', request.params.id, err);
      return reply.send({
        available: false,
        command: null,
        args: [],
        endpoint: mapEndpoint,
      });
    }
  });
}
