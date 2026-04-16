/**
 * Dispatches Routes
 *
 * Read-side endpoints for the Stream 2 dispatch primitive. POST and cancel
 * land in subsequent PRs (PR 1b for create, PR 2 for cancel + agent reports).
 *
 * Visibility (v1): any authenticated agent can list and inspect any dispatch.
 * The hub isn't isolated; if you can reach it you can see what's flowing.
 * Per-dispatch ACL can layer on once a real use case demands it.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { broadcastToChannel } from '../../realtime/index.js';
import { findSwarmById } from '../../db/dal/map.js';
import { findAcpAgentInfo } from '../../map/connection-registry.js';
import { buildDispatchSeedPrompt, fetchSpecForDispatch } from './specs.js';
import type {
  DispatchInitiatorType,
  DispatchStatus,
  ListDispatchesOptions,
} from '../../db/dal/dispatches.js';
import type { Config } from '../../config.js';

const VALID_STATUSES: DispatchStatus[] = ['queued', 'running', 'complete', 'failed', 'cancelled'];
const VALID_INITIATORS: DispatchInitiatorType[] = ['user', 'agent'];

function parseStatusParam(raw: string | undefined): DispatchStatus[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is DispatchStatus => (VALID_STATUSES as string[]).includes(s));
  return parts.length > 0 ? parts : undefined;
}

export async function dispatchesRoutes(
  fastify: FastifyInstance,
  _options: { config: Config },
): Promise<void> {
  /**
   * GET /dispatches
   *
   * Lists dispatches with optional filters. Sorted by created_at desc.
   */
  fastify.get<{
    Querystring: {
      status?: string;
      target_swarm_id?: string;
      spec_resource_id?: string;
      spec_id?: string;
      initiator_id?: string;
      initiator_type?: string;
      limit?: number;
      offset?: number;
    };
  }>('/dispatches', { preHandler: authMiddleware }, async (request, reply) => {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(request.query.offset) || 0, 0);

    const opts: ListDispatchesOptions = { limit, offset };
    const status = parseStatusParam(request.query.status);
    if (status) opts.status = status;
    if (request.query.target_swarm_id) opts.target_swarm_id = request.query.target_swarm_id;
    if (request.query.spec_resource_id) opts.spec_resource_id = request.query.spec_resource_id;
    if (request.query.spec_id) opts.spec_id = request.query.spec_id;
    if (request.query.initiator_id) opts.initiator_id = request.query.initiator_id;
    if (
      request.query.initiator_type &&
      (VALID_INITIATORS as string[]).includes(request.query.initiator_type)
    ) {
      opts.initiator_type = request.query.initiator_type as DispatchInitiatorType;
    }

    const result = dispatchesDAL.listDispatches(opts);

    return reply.send({ data: result.data, total: result.total, limit, offset });
  });

  /**
   * GET /dispatches/:id
   */
  fastify.get<{
    Params: { id: string };
  }>('/dispatches/:id', { preHandler: authMiddleware }, async (request, reply) => {
    const dispatch = dispatchesDAL.findDispatchById(request.params.id);
    if (!dispatch) {
      return reply.status(404).send({ error: 'Not Found', message: 'Dispatch not found' });
    }
    return reply.send({ dispatch });
  });

  /**
   * POST /dispatches/:id/cancel
   *
   * Marks a dispatch as cancelled (D14). v1 does NOT proactively notify the
   * target swarm to stop work — that requires the agent feedback contract from
   * D11 to be in place on the receiver side. Once the contract matures we can
   * layer a `map/dispatches/cancel` notification in.
   *
   * Open to any authenticated agent (per D9). The operation is idempotent
   * relative to terminal states — cancelling a complete/failed/cancelled
   * dispatch returns 409.
   */
  fastify.post<{
    Params: { id: string };
  }>('/dispatches/:id/cancel', { preHandler: authMiddleware }, async (request, reply) => {
    const existing = dispatchesDAL.findDispatchById(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: 'Not Found', message: 'Dispatch not found' });
    }
    if (existing.status === 'cancelled') {
      return reply.status(200).send({ dispatch: existing });
    }
    if (existing.status === 'complete' || existing.status === 'failed') {
      return reply.status(409).send({
        error: 'Conflict',
        message: `Dispatch is already ${existing.status}; cannot cancel`,
      });
    }

    const cancelled = dispatchesDAL.cancelDispatch(request.params.id);
    if (!cancelled) {
      return reply.status(500).send({ error: 'Internal Error', message: 'Cancel failed' });
    }

    try {
      broadcastToChannel('map:dispatches', {
        type: 'dispatch.cancelled',
        data: {
          dispatch: { id: cancelled.id, status: cancelled.status },
          spec_ref: {
            resource_id: cancelled.spec_resource_id,
            spec_id: cancelled.spec_id,
            captured_at: cancelled.spec_captured_at,
          },
          target_swarm_id: cancelled.target_swarm_id,
          initiator: { type: cancelled.initiator_type, id: cancelled.initiator_id },
          cancelled_by: { type: 'user', id: request.agent!.id },
        },
      });
    } catch {
      /* best effort */
    }

    return reply.send({ dispatch: cancelled });
  });

  /**
   * POST /dispatches/:id/bootstrap
   *
   * Hub-side session bootstrap (Stream 2 follow-up). Opens an ACP stream to
   * the target swarm, creates a session, sends the seed prompt as the first
   * user message, and flips the dispatch to `running` with the session
   * recorded. Best effort — if SwarmCraft's acpStreamManager isn't loaded or
   * the swarm has no ACP-capable agent, returns 503 with a clear reason and
   * the dispatch stays at `queued` (the seed prompt remains accessible by
   * other means for manual handoff).
   *
   * Mail bootstrap is intentionally deferred — the mail conversation
   * primitive doesn't yet have a "seed-with-prompt" entry that maps cleanly
   * here. Punt until a use case asks for it.
   */
  fastify.post<{
    Params: { id: string };
  }>('/dispatches/:id/bootstrap', { preHandler: authMiddleware }, async (request, reply) => {
    const dispatch = dispatchesDAL.findDispatchById(request.params.id);
    if (!dispatch) {
      return reply.status(404).send({ error: 'Not Found', message: 'Dispatch not found' });
    }
    if (dispatch.status !== 'queued') {
      return reply.status(409).send({
        error: 'Conflict',
        message: `Dispatch is ${dispatch.status}; only queued dispatches can be bootstrapped`,
      });
    }

    // SwarmCraft availability check
    const sc = (fastify as unknown as { swarmcraft?: { acpStreamManager?: unknown } }).swarmcraft;
    const acpStreamManager = sc?.acpStreamManager as
      | {
          listStreams: () => Array<{ serverId: string; streamId: string; isClosed: boolean }>;
          closeStream: (id: string) => Promise<void>;
          createStream: (serverId: string, agentId: string) => Promise<{ streamId: string }>;
          initialize: (streamId: string) => Promise<unknown>;
          newSession: (
            streamId: string,
            input: { cwd: string; mcpServers: unknown[] },
          ) => Promise<{ sessionId: string }>;
          prompt: (
            streamId: string,
            input: { sessionId: string; prompt: Array<{ type: string; text?: string }> },
          ) => Promise<unknown>;
        }
      | undefined;
    if (!acpStreamManager) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'SwarmCraft ACP not available on this hub. Drive the swarm manually with the seed prompt.',
      });
    }

    // Find ACP-capable agent on the target swarm
    const acpAgent = findAcpAgentInfo(dispatch.target_swarm_id);
    if (!acpAgent) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: `No ACP-capable agent connected on swarm ${dispatch.target_swarm_id}`,
      });
    }

    // Rebuild seed prompt from the spec (same shape as POST /specs/.../dispatch)
    const fetched = await fetchSpecForDispatch(
      dispatch.spec_resource_id,
      dispatch.spec_id,
      request.agent!.id,
    );
    if (!fetched.ok) {
      return reply
        .status(fetched.statusCode)
        .send({ error: fetched.error, message: fetched.message });
    }
    const { node, neighbors } = fetched.data;
    const linkedTasks = neighbors
      .filter((n) => n.type === 'task')
      .map((n) => ({
        id: String(n.id),
        title: typeof n.title === 'string' ? (n.title as string) : undefined,
        status: typeof n.status === 'string' ? (n.status as string) : undefined,
      }));
    const seedPrompt = buildDispatchSeedPrompt({
      dispatchId: dispatch.id,
      resourceId: dispatch.spec_resource_id,
      specId: dispatch.spec_id,
      capturedAt: dispatch.spec_captured_at,
      title: (node.title as string) ?? '',
      content: (node.content as string) ?? '',
      linkedTasks,
      promptOverride: dispatch.prompt_override,
    });

    // Resolve cwd from swarm metadata if available — matches /sessions/acp-connect
    const swarm = findSwarmById(dispatch.target_swarm_id);
    const swarmMeta = (swarm?.metadata ?? {}) as Record<string, unknown>;
    const cwd =
      (typeof swarmMeta.cwd === 'string' ? swarmMeta.cwd : undefined) ??
      (typeof swarmMeta.projectPath === 'string' ? swarmMeta.projectPath : undefined) ??
      '.';

    let sessionResourceId: string | undefined;
    let acpSessionId: string | undefined;
    let acpStreamId: string | undefined;

    try {
      // Defensively close any existing streams to this swarm — same reason as
      // in /sessions/acp-connect (subscription iterator interference).
      const existing = acpStreamManager
        .listStreams()
        .filter((s) => s.serverId === dispatch.target_swarm_id && !s.isClosed);
      for (const s of existing) {
        try {
          await acpStreamManager.closeStream(s.streamId);
        } catch {
          /* best effort */
        }
      }

      const stream = await acpStreamManager.createStream(
        dispatch.target_swarm_id,
        acpAgent.targetId,
      );
      acpStreamId = stream.streamId;
      await acpStreamManager.initialize(stream.streamId);
      const sessionResult = await acpStreamManager.newSession(stream.streamId, {
        cwd,
        mcpServers: [],
      });
      acpSessionId = sessionResult.sessionId;

      // Create a session resource so the new session shows up in /sessions
      const projectFromPath = cwd.split('/').filter(Boolean).pop() ?? '';
      const isBadProject = !projectFromPath || projectFromPath === '.' || projectFromPath === '..';
      const shortId = acpSessionId.slice(-8);
      const project = isBadProject ? 'dispatch' : projectFromPath;
      const displayName = `${project} [${shortId}]`;
      const remoteUrl = `map://session/${acpSessionId}`;
      const { resource: sessionResource } = resourcesDAL.upsertDiscoveredResource({
        resource_type: 'session',
        name: displayName,
        description: `ACP session for dispatch ${dispatch.id} (spec ${dispatch.spec_id})`,
        git_remote_url: remoteUrl,
        owner_agent_id: request.agent!.id,
        scope: 'manual',
        metadata: {
          project,
          projectPath: cwd,
          sessionId: acpSessionId,
          source_swarm_id: dispatch.target_swarm_id,
          acpStreamId: stream.streamId,
          dispatch_id: dispatch.id,
        },
      });
      sessionResourceId = sessionResource.id;

      // Send the seed prompt as the first user message
      await acpStreamManager.prompt(stream.streamId, {
        sessionId: acpSessionId,
        prompt: [{ type: 'text', text: seedPrompt }],
      });

      // Persist + flip status
      dispatchesDAL.setDispatchSessionIds(dispatch.id, [sessionResourceId]);
      const updated = dispatchesDAL.updateDispatchStatus(dispatch.id, 'running');

      try {
        broadcastToChannel('map:dispatches', {
          type: 'dispatch.status_changed',
          data: {
            dispatch: { id: dispatch.id, status: 'running' },
            spec_ref: {
              resource_id: dispatch.spec_resource_id,
              spec_id: dispatch.spec_id,
              captured_at: dispatch.spec_captured_at,
            },
            target_swarm_id: dispatch.target_swarm_id,
            initiator: { type: dispatch.initiator_type, id: dispatch.initiator_id },
            bootstrap: {
              session_resource_id: sessionResourceId,
              acp_session_id: acpSessionId,
              acp_stream_id: stream.streamId,
            },
          },
        });
      } catch {
        /* best effort */
      }

      return reply.send({
        dispatch: updated,
        bootstrap: {
          session_resource_id: sessionResourceId,
          acp_session_id: acpSessionId,
          acp_stream_id: acpStreamId,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({
        error: 'Bootstrap failed',
        message: msg,
        // The dispatch row stays at queued. The caller can retry, fall back
        // to manual driving, or cancel.
      });
    }
  });
}
