/**
 * Experiments REST routes (autonomation control plane).
 *
 * Operator routes (createAuthOrAdminKey): manage experiments + runs, read
 * candidates/events. Worker-write routes (per-run token): PATCH run, POST
 * events, POST finalize — authenticated by the launch-minted per-run token
 * ([D6] option C), with an admin-key override for operators/tests.
 *
 * The hub records the runner's reported telemetry; it never decides
 * keep/discard. Candidate rows are a projection (see src/experiments/ingest.ts).
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { createAuthOrAdminKey, createAdminAuth } from '../middleware/auth.js';
import * as dal from '../../db/dal/experiments.js';
import { mintRunToken, verifyRunToken } from '../../experiments/run-token.js';
import { ingestEvents, finalizeRun } from '../../experiments/ingest.js';
import { broadcastExperimentLifecycleEvent } from '../../realtime/experiment-events.js';
import { launchRun, cancelRunProcess } from '../../experiments/launcher.js';
import {
  CreateExperimentBodySchema,
  UpdateExperimentBodySchema,
  ListExperimentsQuerySchema,
  CreateRunBodySchema,
  UpdateRunBodySchema,
  AppendEventsBodySchema,
  EventsTailQuerySchema,
  FinalizeRunBodySchema,
} from '../schemas/experiments.js';
import type { Config } from '../../config.js';

function adminKeyMatches(header: unknown, configured: string | undefined): boolean {
  if (!configured || typeof header !== 'string' || header.length !== configured.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(header), Buffer.from(configured));
}

function badRequest(reply: FastifyReply, issues: { message: string }[]) {
  return reply
    .status(400)
    .send({ error: 'Bad Request', message: issues.map((i) => i.message).join('; ') });
}

export async function experimentsRoutes(
  fastify: FastifyInstance,
  options: { config: Config },
): Promise<void> {
  const authOrAdminKey = createAuthOrAdminKey(options.config);
  // launch/cancel spawn or kill OS processes — admin-only (operator override),
  // not any-authenticated-agent.
  const adminAuth = createAdminAuth(options.config);
  const adminKey = options.config.admin.key;

  /**
   * Worker-write auth: an admin key OR the run's per-run token (Bearer),
   * matched against `experiment_runs.worker_token_hash` for the `:runId` in the
   * path. Row-scoped — a worker can only write its own run.
   */
  async function workerRunAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (adminKeyMatches(request.headers['x-admin-key'], adminKey)) return;

    // A request with NO credential (no admin key, no Bearer token) is
    // unauthenticated → 401, answered before any run lookup so anonymous
    // callers can't probe run existence via 404/403.
    const authHeader = request.headers.authorization;
    const token =
      typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';
    if (!token) {
      return reply
        .status(401)
        .send({ error: 'Unauthorized', message: 'missing worker token' });
    }

    const params = request.params as { id?: string; runId?: string };
    if (!params.runId) {
      return reply.status(400).send({ error: 'Bad Request', message: 'missing runId' });
    }
    const run = dal.findRunById(params.runId);
    // Scope to the experiment in the path too, so the auth decision agrees with
    // the handler's resolveRun (no 200-after-auth-then-404 split).
    if (!run || (params.id && run.experiment_id !== params.id)) {
      return reply.status(404).send({ error: 'Not Found', message: 'run not found' });
    }
    if (!run.worker_token_hash || !verifyRunToken(token, run.worker_token_hash)) {
      return reply
        .status(403)
        .send({ error: 'Forbidden', message: 'invalid worker token for run' });
    }
  }

  // Resolve a run scoped to its experiment; 404 on mismatch/absence.
  function resolveRun(experimentId: string, runId: string): dal.ExperimentRun | null {
    const run = dal.findRunById(runId);
    if (!run || run.experiment_id !== experimentId) return null;
    return run;
  }

  // Strip the worker token hash from any run returned to a client.
  function publicRun(run: dal.ExperimentRun) {
    const { worker_token_hash: _omit, ...rest } = run;
    void _omit;
    return rest;
  }
  const publicRuns = (runs: dal.ExperimentRun[]) => runs.map(publicRun);

  const TERMINAL: ReadonlySet<dal.RunStatus> = new Set(['complete', 'failed', 'cancelled']);

  // ─────────────────────────────────────────────────────────────────────────
  // Experiments (operator)
  // ─────────────────────────────────────────────────────────────────────────

  fastify.post('/experiments', { preHandler: authOrAdminKey }, async (request, reply) => {
    const parsed = CreateExperimentBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const body = parsed.data;
    const initiator_id = request.agent?.id ?? 'admin';

    // Re-running the same locked config accumulates under one experiment (D2).
    const experiment = dal.upsertExperimentByContentHash({
      name: body.name,
      objective_metric: body.objective_metric,
      objective_direction: body.objective_direction,
      objective_min_delta: body.objective_min_delta,
      config: body.config,
      content_hash: body.content_hash ?? null,
      description: body.description ?? null,
      claims: body.claims ?? null,
      repo_resource_id: body.repo_resource_id ?? null,
      hive_id: body.hive_id,
      status: body.status,
      initiator_type: 'user',
      initiator_id,
    });

    return reply.status(201).send({ experiment });
  });

  fastify.get('/experiments', { preHandler: authOrAdminKey }, async (request, reply) => {
    const parsed = ListExperimentsQuerySchema.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    const { hive_id, status, limit, offset } = parsed.data;
    const result = dal.listExperiments({ hive_id, status, limit, offset });
    return reply.send({ data: result.data, total: result.total, limit, offset });
  });

  fastify.get<{ Params: { id: string } }>(
    '/experiments/:id',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const experiment = dal.findExperimentById(request.params.id);
      if (!experiment) {
        return reply.status(404).send({ error: 'Not Found', message: 'experiment not found' });
      }
      const runs = dal.listRunsForExperiment(experiment.id, { limit: 20 });
      return reply.send({ experiment, runs: publicRuns(runs.data), run_total: runs.total });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/experiments/:id',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const existing = dal.findExperimentById(request.params.id);
      if (!existing) {
        return reply.status(404).send({ error: 'Not Found', message: 'experiment not found' });
      }
      const parsed = UpdateExperimentBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error.issues);
      const updated = dal.updateExperiment(request.params.id, parsed.data);
      broadcastExperimentLifecycleEvent(request.params.id, {
        type: 'experiment.updated',
        data: { experiment_id: request.params.id, status: updated?.status },
      });
      return reply.send({ experiment: updated });
    },
  );

  for (const [action, status] of [
    ['pause', 'paused'],
    ['resume', 'active'],
    ['archive', 'archived'],
  ] as const) {
    fastify.post<{ Params: { id: string } }>(
      `/experiments/:id/${action}`,
      { preHandler: authOrAdminKey },
      async (request, reply) => {
        const updated = dal.updateExperiment(request.params.id, { status });
        if (!updated) {
          return reply
            .status(404)
            .send({ error: 'Not Found', message: 'experiment not found' });
        }
        broadcastExperimentLifecycleEvent(request.params.id, {
          type: 'experiment.updated',
          data: { experiment_id: request.params.id, status: updated.status },
        });
        return reply.send({ experiment: updated });
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Runs (operator)
  // ─────────────────────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    '/experiments/:id/runs',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const experiment = dal.findExperimentById(request.params.id);
      if (!experiment) {
        return reply.status(404).send({ error: 'Not Found', message: 'experiment not found' });
      }
      const parsed = CreateRunBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error.issues);
      const body = parsed.data;

      // Mint the per-run worker token; only the hash is stored (D6).
      const { token, hash } = mintRunToken();
      const run = dal.createRun({
        experiment_id: experiment.id,
        autonomation_run_id: body.autonomation_run_id,
        hosted_swarm_id: body.hosted_swarm_id,
        worker_token_hash: hash,
        content_hash: body.content_hash,
        env_fingerprint: body.env_fingerprint,
        repo_root: body.repo_root,
        experiment_branch: body.experiment_branch,
        experiment_worktree: body.experiment_worktree,
        start_point: body.start_point,
        initiator_type: 'user',
        initiator_id: request.agent?.id ?? 'admin',
      });

      broadcastExperimentLifecycleEvent(experiment.id, {
        type: 'experiment.run_started',
        data: { experiment_id: experiment.id, run_id: run.id, status: run.status },
      });

      // worker_token is returned ONCE; the hub keeps only its hash.
      return reply.status(201).send({ run: publicRun(run), worker_token: token });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/experiments/:id/runs',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const experiment = dal.findExperimentById(request.params.id);
      if (!experiment) {
        return reply.status(404).send({ error: 'Not Found', message: 'experiment not found' });
      }
      const result = dal.listRunsForExperiment(experiment.id, {});
      return reply.send({ data: publicRuns(result.data), total: result.total });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/experiments/:id/candidates',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const experiment = dal.findExperimentById(request.params.id);
      if (!experiment) {
        return reply.status(404).send({ error: 'Not Found', message: 'experiment not found' });
      }
      const promotedOnly = (request.query as { promoted?: string }).promoted === 'true';
      const data = dal.listCandidatesForExperiment(experiment.id, { promotedOnly });
      return reply.send({ data, total: data.length });
    },
  );

  fastify.get<{ Params: { id: string; runId: string } }>(
    '/experiments/:id/runs/:runId/events',
    { preHandler: authOrAdminKey },
    async (request, reply) => {
      const run = resolveRun(request.params.id, request.params.runId);
      if (!run) {
        return reply.status(404).send({ error: 'Not Found', message: 'run not found' });
      }
      const parsed = EventsTailQuerySchema.safeParse(request.query);
      if (!parsed.success) return badRequest(reply, parsed.error.issues);
      const data = dal.listEventsForRun(run.id, {
        afterSeq: parsed.data.after_seq,
        limit: parsed.data.limit,
      });
      return reply.send({ data, max_seq: dal.maxSeqForRun(run.id) });
    },
  );

  fastify.post<{ Params: { id: string; runId: string } }>(
    '/experiments/:id/runs/:runId/cancel',
    { preHandler: adminAuth },
    async (request, reply) => {
      const run = resolveRun(request.params.id, request.params.runId);
      if (!run) {
        return reply.status(404).send({ error: 'Not Found', message: 'run not found' });
      }
      cancelRunProcess(run.id); // kill the launched worker process, if any
      const updated = dal.updateRun(run.id, {
        status: 'cancelled',
        worker_token_hash: null, // §4.2: the token dies with the run
        finished_at: new Date().toISOString(),
      });
      if (!updated) {
        return reply.status(404).send({ error: 'Not Found', message: 'run not found' });
      }
      broadcastExperimentLifecycleEvent(request.params.id, {
        type: 'experiment.run_updated',
        data: { experiment_id: request.params.id, run_id: run.id, status: 'cancelled' },
      });
      return reply.send({ run: publicRun(updated) });
    },
  );

  fastify.post<{ Params: { id: string; runId: string } }>(
    '/experiments/:id/runs/:runId/launch',
    { preHandler: adminAuth },
    async (request, reply) => {
      const experiment = dal.findExperimentById(request.params.id);
      if (!experiment) {
        return reply.status(404).send({ error: 'Not Found', message: 'experiment not found' });
      }
      const run = resolveRun(request.params.id, request.params.runId);
      if (!run) {
        return reply.status(404).send({ error: 'Not Found', message: 'run not found' });
      }
      // Atomically claim the queued run so two concurrent launches can't both
      // spawn a worker; a lost race / already-launched run 409s.
      if (!dal.claimRunForLaunch(run.id)) {
        return reply
          .status(409)
          .send({ error: 'Conflict', message: 'run is not queued or already launched' });
      }
      try {
        const result = launchRun(experiment, dal.findRunById(run.id)!);
        const updated = dal.findRunById(run.id)!;
        broadcastExperimentLifecycleEvent(experiment.id, {
          type: 'experiment.run_started',
          data: { experiment_id: experiment.id, run_id: run.id, pid: result.pid },
        });
        return reply.send({ run: publicRun(updated), pid: result.pid });
      } catch (err) {
        dal.releaseRunLaunchClaim(request.params.runId); // spawn refused — release the claim
        return reply.status(400).send({ error: 'Bad Request', message: (err as Error).message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Worker-write routes (per-run token)
  // ─────────────────────────────────────────────────────────────────────────

  fastify.patch<{ Params: { id: string; runId: string } }>(
    '/experiments/:id/runs/:runId',
    { preHandler: workerRunAuth },
    async (request, reply) => {
      const run = resolveRun(request.params.id, request.params.runId);
      if (!run) {
        return reply.status(404).send({ error: 'Not Found', message: 'run not found' });
      }
      const parsed = UpdateRunBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error.issues);
      // Terminal transitions go through finalize/cancel (which clear the token);
      // a worker PATCH may only set non-terminal status.
      if (parsed.data.status && TERMINAL.has(parsed.data.status)) {
        return reply
          .status(409)
          .send({ error: 'Conflict', message: 'use finalize or cancel for terminal transitions' });
      }
      const updated = dal.updateRun(run.id, parsed.data);
      if (!updated) {
        return reply.status(404).send({ error: 'Not Found', message: 'run not found' });
      }
      broadcastExperimentLifecycleEvent(request.params.id, {
        type: 'experiment.run_updated',
        data: { experiment_id: request.params.id, run_id: run.id, status: updated.status },
      });
      return reply.send({ run: publicRun(updated) });
    },
  );

  fastify.post<{ Params: { id: string; runId: string } }>(
    '/experiments/:id/runs/:runId/events',
    { preHandler: workerRunAuth },
    async (request, reply) => {
      const run = resolveRun(request.params.id, request.params.runId);
      if (!run) {
        return reply.status(404).send({ error: 'Not Found', message: 'run not found' });
      }
      if (TERMINAL.has(run.status)) {
        return reply
          .status(409)
          .send({ error: 'Conflict', message: 'run is in a terminal state' });
      }
      const parsed = AppendEventsBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error.issues);
      const result = ingestEvents(run, parsed.data.events);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: { id: string; runId: string } }>(
    '/experiments/:id/runs/:runId/finalize',
    { preHandler: workerRunAuth },
    async (request, reply) => {
      const run = resolveRun(request.params.id, request.params.runId);
      if (!run) {
        return reply.status(404).send({ error: 'Not Found', message: 'run not found' });
      }
      if (TERMINAL.has(run.status)) {
        return reply
          .status(409)
          .send({ error: 'Conflict', message: 'run is in a terminal state' });
      }
      const parsed = FinalizeRunBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error.issues);
      const updated = finalizeRun(run, parsed.data);
      return reply.send({ run: publicRun(updated) });
    },
  );
}
