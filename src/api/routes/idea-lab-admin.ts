/**
 * Idea-lab admin routes — the full lab setup, driven from the Settings UI.
 *
 *   POST /admin/idea-lab/setup     provision the whole lab (git-synced graph,
 *                                  objectives, role schedules) via
 *                                  provisionIdeaLab — idempotent, safe to re-run
 *   GET  /admin/idea-lab           status — the loaded role schedules
 *   POST /admin/idea-lab/teardown  pause the role schedules (soft, reversible)
 *
 * A slim admin-scoped surface over the tested `provisionIdeaLab` orchestration:
 * the existing schedules/specs endpoints can't carry what a lab needs (spec
 * metadata, a schedule marker) or provision a git-synced graph, so the lab gets
 * this one setup action rather than five hand-wired steps. See
 * src/idea-lab/CLAUDE.md.
 */

import { FastifyInstance } from 'fastify';
import { createAdminAuth } from '../middleware/auth.js';
import type { Config } from '../../config.js';
import { resolveDataDir } from '../../data-dir.js';
import * as schedulesDAL from '../../db/dal/schedules.js';
import {
  provisionIdeaLab,
  parseIdeaLabPack,
  DEFAULT_IDEA_LAB_PACK,
  IDEA_LAB_INITIATOR,
  type IdeaLabObjective,
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

function slug(title: string, i: number): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || `objective-${i + 1}`;
}

/** Map UI-supplied objectives ({title, content?, priority?}) into pack objectives. */
function toObjectives(input: unknown): IdeaLabObjective[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: IdeaLabObjective[] = [];
  input.forEach((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) return;
    let key = slug(title, i);
    while (seen.has(key)) key = `${key}-${i}`;
    seen.add(key);
    out.push({
      key,
      title,
      content: typeof o.content === 'string' && o.content.trim() ? o.content.trim() : undefined,
      priority: typeof o.priority === 'number' ? o.priority : undefined,
    });
  });
  return out;
}

export async function ideaLabAdminRoutes(
  fastify: FastifyInstance,
  options: { config: Config },
): Promise<void> {
  const adminAuth = createAdminAuth(options.config);

  fastify.post<{
    Body: {
      targetSwarmIds?: string[];
      gitRemote?: string;
      hiveId?: string;
      reconcile?: 'managed' | 'create-only';
      objectives?: Array<{ title: string; content?: string; priority?: number }>;
      /** Optional full pack override; defaults to the checked-in preset. */
      pack?: unknown;
    };
  }>('/admin/idea-lab/setup', { preHandler: adminAuth }, async (request, reply) => {
    const body = request.body ?? {};

    // Start from the override pack or the checked-in preset, then splice in
    // any UI-supplied objectives (validating the whole thing once).
    let pack;
    try {
      const base = body.pack !== undefined ? parseIdeaLabPack(body.pack) : DEFAULT_IDEA_LAB_PACK;
      const objectives = toObjectives(body.objectives);
      pack = objectives.length > 0 ? parseIdeaLabPack({ ...base, objectives }) : base;
    } catch (err) {
      return reply
        .status(422)
        .send({ error: 'VALIDATION_ERROR', message: `invalid pack: ${(err as Error).message}` });
    }
    if (body.reconcile && body.reconcile !== 'managed' && body.reconcile !== 'create-only') {
      return reply
        .status(422)
        .send({ error: 'VALIDATION_ERROR', message: 'reconcile must be "managed" or "create-only"' });
    }

    const summary = await provisionIdeaLab({
      dataDir: resolveDataDir(),
      pack,
      hiveId: typeof body.hiveId === 'string' ? body.hiveId : undefined,
      targetSwarmIds: Array.isArray(body.targetSwarmIds) ? body.targetSwarmIds : [],
      gitRemote: typeof body.gitRemote === 'string' && body.gitRemote.trim() ? body.gitRemote.trim() : undefined,
      reconcile: body.reconcile,
    });

    return reply.status(summary.deferred ? 202 : 200).send(summary);
  });

  fastify.get('/admin/idea-lab', { preHandler: adminAuth }, async (_request, reply) => {
    const schedules = labSchedules();
    return reply.send({
      loaded: schedules.length > 0,
      paused: schedules.length > 0 && schedules.every((s) => !!s.paused),
      roles: schedules.map(roleView),
    });
  });

  fastify.post('/admin/idea-lab/teardown', { preHandler: adminAuth }, async (_request, reply) => {
    const schedules = labSchedules();
    let paused = 0;
    for (const s of schedules) {
      if (!s.paused) {
        schedulesDAL.pauseSchedule(s.id, 'idea-lab: torn down');
        paused++;
      }
    }
    return reply.send({ paused, total: schedules.length });
  });
}
