/**
 * Idea-lab REST routes — load the checked-in idea-lab preset into dispatch
 * schedules at runtime.
 *
 *   POST /idea-lab/load     instantiate the preset → graph, ledger, objectives,
 *                           role schedules (idempotent; safe to re-run)
 *   GET  /idea-lab          status — the lab's role schedules
 *   POST /idea-lab/unload   pause the lab's role schedules (dormant, reversible)
 *
 * The preset (role prompts + cadences) is checked-in source
 * (`DEFAULT_IDEA_LAB_PACK`). A hub customizes it by editing that pack, or by
 * POSTing an override `pack` on load. Instance args — target swarms, git remote,
 * objectives — come in the load body: the idea-lab is a workload you load, not
 * hub configuration. A dedicated preset/instance system can be factored out
 * later; this is the minimal mechanism to load it into the dispatch scheduler.
 */

import { FastifyInstance } from 'fastify';
import { createAuthOrAdminKey } from '../middleware/auth.js';
import type { Config } from '../../config.js';
import { resolveDataDir } from '../../data-dir.js';
import * as schedulesDAL from '../../db/dal/schedules.js';
import {
  provisionIdeaLab,
  parseIdeaLabPack,
  DEFAULT_IDEA_LAB_PACK,
  IDEA_LAB_INITIATOR,
  type IdeaLabPack,
} from '../../idea-lab/index.js';

function labSchedules() {
  return schedulesDAL.listSchedules({ initiator_id: IDEA_LAB_INITIATOR, limit: 200 }).data;
}

function roleView(s: (ReturnType<typeof labSchedules>)[number]) {
  const p =
    typeof s.payload === 'string'
      ? (JSON.parse(s.payload) as Record<string, unknown>)
      : (s.payload as Record<string, unknown>);
  return {
    idealab_key: p.idealab_key,
    cron: s.cron,
    paused: !!s.paused,
    next_fires_at: s.next_fires_at,
    target_swarm_ids: p.target_swarm_ids,
  };
}

export async function ideaLabRoutes(
  fastify: FastifyInstance,
  options: { config: Config },
): Promise<void> {
  const authOrAdminKey = createAuthOrAdminKey(options.config);

  // ── POST /idea-lab/load — load the preset into dispatch schedules.
  fastify.post<{
    Body: {
      targetSwarmIds?: string[];
      gitRemote?: string;
      hiveId?: string;
      reconcile?: 'managed' | 'create-only';
      /** Optional full pack override; defaults to the checked-in preset. */
      pack?: unknown;
    };
  }>('/idea-lab/load', { preHandler: authOrAdminKey }, async (request, reply) => {
    const body = request.body ?? {};

    let pack: IdeaLabPack;
    try {
      pack = body.pack !== undefined ? parseIdeaLabPack(body.pack) : DEFAULT_IDEA_LAB_PACK;
    } catch (err) {
      return reply.status(422).send({
        error: 'VALIDATION_ERROR',
        message: `invalid pack: ${(err as Error).message}`,
      });
    }
    if (body.reconcile && body.reconcile !== 'managed' && body.reconcile !== 'create-only') {
      return reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'reconcile must be "managed" or "create-only"' });
    }

    const summary = await provisionIdeaLab({
      dataDir: resolveDataDir(),
      pack,
      hiveId: typeof body.hiveId === 'string' ? body.hiveId : undefined,
      targetSwarmIds: Array.isArray(body.targetSwarmIds) ? body.targetSwarmIds : [],
      gitRemote: typeof body.gitRemote === 'string' ? body.gitRemote : undefined,
      reconcile: body.reconcile,
    });

    // deferred = no owner agent yet; caller may retry once an agent exists.
    return reply.status(summary.deferred ? 202 : 200).send(summary);
  });

  // ── GET /idea-lab — status.
  fastify.get('/idea-lab', { preHandler: authOrAdminKey }, async (_request, reply) => {
    const schedules = labSchedules();
    return reply.send({
      loaded: schedules.length > 0,
      paused: schedules.length > 0 && schedules.every((s) => !!s.paused),
      roles: schedules.map(roleView),
    });
  });

  // ── POST /idea-lab/unload — pause the lab's role schedules (reversible).
  fastify.post('/idea-lab/unload', { preHandler: authOrAdminKey }, async (_request, reply) => {
    const schedules = labSchedules();
    let paused = 0;
    for (const s of schedules) {
      if (!s.paused) {
        schedulesDAL.pauseSchedule(s.id, 'idea-lab: unloaded');
        paused++;
      }
    }
    return reply.send({ paused, total: schedules.length });
  });
}
