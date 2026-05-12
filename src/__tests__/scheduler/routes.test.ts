/**
 * Schedules REST routes — integration tests against a minimal Fastify app.
 *
 * Verifies the 7 endpoint contracts:
 *   GET    /schedules
 *   POST   /schedules                (cap + initial next_fires_at + cron validation)
 *   GET    /schedules/:id            (includes recent fires)
 *   PATCH  /schedules/:id            (cron change → recompute)
 *   DELETE /schedules/:id
 *   POST   /schedules/:id/pause
 *   POST   /schedules/:id/resume     (recompute next_fires_at)
 *
 * Uses the admin-key auth bypass for test simplicity. Initiator captured
 * as 'admin' when no agent identity is present.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { schedulesRoutes } from '../../api/routes/schedules.js';
import * as schedulesDAL from '../../db/dal/schedules.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { Config } from '../../config.js';

const TEST_ROOT = testRoot('scheduler-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'scheduler-routes.db');
const ADMIN_KEY = 'test-admin-key';

const testConfig: Pick<Config, 'admin' | 'scheduler'> = {
  admin: { key: ADMIN_KEY, createOnStartup: false, trustLocalMode: false },
  scheduler: {
    tickIntervalMs: 60_000,
    maxConcurrentFires: 10,
    maxSchedulesPerAgent: 3, // small cap so we can exercise 429
  },
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(schedulesRoutes, { config: testConfig as Config });
  await app.ready();
  return app;
}

const adminHeaders = { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' };
// DELETE requests don't carry a body — Fastify rejects content-type:json without one.
const adminHeadersBodyless = { 'x-admin-key': ADMIN_KEY };

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    cron: '0 * * * *',
    payload: {
      spec_ref: { resource_id: 'res_test', spec_id: 'spec_test' },
      target_swarm_ids: ['swarm_a'],
    },
    ...overrides,
  };
}

beforeAll(() => {
  cleanTestRoot(TEST_ROOT);
  initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec('DELETE FROM schedules');
  db.exec('DELETE FROM dispatches');
});

describe('POST /schedules', () => {
  it('creates a schedule and computes next_fires_at', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody(),
      });
      expect(res.statusCode).toBe(201);
      const { schedule } = res.json() as { schedule: schedulesDAL.OpenHiveSchedule };
      expect(schedule.id).toMatch(/^sch_/);
      expect(schedule.cron).toBe('0 * * * *');
      expect(schedule.next_fires_at).not.toBeNull();
      expect(new Date(schedule.next_fires_at!).getTime()).toBeGreaterThan(Date.now());
      expect(schedule.policy).toEqual({ catchUp: 'fire-once', skipIfRunning: false });
      expect(schedule.initiator_type).toBe('user');
      expect(schedule.initiator_id).toBe('admin'); // admin-key auth path
    } finally {
      await app.close();
    }
  });

  it('rejects invalid cron (400)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody({ cron: 'not a cron' }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects missing target_swarm_ids (400)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: {
          cron: '0 * * * *',
          payload: { spec_ref: { resource_id: 'r', spec_id: 's' } },
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('enforces per-user cap (429)', async () => {
    const app = await buildApp();
    try {
      // cap=3 per testConfig
      for (let i = 0; i < 3; i++) {
        const r = await app.inject({
          method: 'POST',
          url: '/schedules',
          headers: adminHeaders,
          payload: validCreateBody(),
        });
        expect(r.statusCode).toBe(201);
      }
      const overflow = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody(),
      });
      expect(overflow.statusCode).toBe(429);
      expect(overflow.json()).toMatchObject({ error: 'Too Many Requests' });
    } finally {
      await app.close();
    }
  });

  it('rejects unauthenticated request (401)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: { 'content-type': 'application/json' },
        payload: validCreateBody(),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('GET /schedules', () => {
  it('lists schedules with default pagination', async () => {
    const app = await buildApp();
    try {
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: 'POST',
          url: '/schedules',
          headers: adminHeaders,
          payload: validCreateBody(),
        });
      }
      const res = await app.inject({
        method: 'GET',
        url: '/schedules',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: unknown[]; total: number };
      expect(body.total).toBe(2);
      expect(body.data).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('filters by paused', async () => {
    const app = await buildApp();
    try {
      const r1 = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody(),
      });
      const id1 = (r1.json() as { schedule: { id: string } }).schedule.id;
      await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody(),
      });
      await app.inject({
        method: 'POST',
        url: `/schedules/${id1}/pause`,
        headers: adminHeaders,
        payload: {},
      });

      const pausedList = await app.inject({
        method: 'GET',
        url: '/schedules?paused=true',
        headers: adminHeaders,
      });
      const activeList = await app.inject({
        method: 'GET',
        url: '/schedules?paused=false',
        headers: adminHeaders,
      });
      expect((pausedList.json() as { total: number }).total).toBe(1);
      expect((activeList.json() as { total: number }).total).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('GET /schedules/:id', () => {
  it('returns schedule with empty fires array', async () => {
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody(),
      });
      const id = (create.json() as { schedule: { id: string } }).schedule.id;

      const res = await app.inject({
        method: 'GET',
        url: `/schedules/${id}`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { schedule: { id: string }; fires: unknown[]; fire_total: number };
      expect(body.schedule.id).toBe(id);
      expect(body.fires).toEqual([]);
      expect(body.fire_total).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for unknown id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/schedules/sch_missing',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('PATCH /schedules/:id', () => {
  it('updates cron and recomputes next_fires_at from now', async () => {
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody({ cron: '0 * * * *' }),
      });
      const original = (create.json() as { schedule: schedulesDAL.OpenHiveSchedule }).schedule;

      // Wait a beat so "from now" diverges from create time.
      await new Promise((r) => setTimeout(r, 10));

      const patch = await app.inject({
        method: 'PATCH',
        url: `/schedules/${original.id}`,
        headers: adminHeaders,
        payload: { cron: '*/5 * * * *' }, // every 5 minutes
      });
      expect(patch.statusCode).toBe(200);
      const updated = (patch.json() as { schedule: schedulesDAL.OpenHiveSchedule }).schedule;
      expect(updated.cron).toBe('*/5 * * * *');
      expect(updated.next_fires_at).not.toBeNull();
      // Different cadence → almost certainly different next_fires_at.
      expect(updated.next_fires_at).not.toBe(original.next_fires_at);
    } finally {
      await app.close();
    }
  });

  it('rejects invalid cron on update (400)', async () => {
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody(),
      });
      const id = (create.json() as { schedule: { id: string } }).schedule.id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/schedules/${id}`,
        headers: adminHeaders,
        payload: { cron: 'garbage' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for unknown id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/schedules/sch_missing',
        headers: adminHeaders,
        payload: { cron: '0 * * * *' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('DELETE /schedules/:id', () => {
  it('removes the schedule', async () => {
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody(),
      });
      const id = (create.json() as { schedule: { id: string } }).schedule.id;

      const del = await app.inject({
        method: 'DELETE',
        url: `/schedules/${id}`,
        headers: adminHeadersBodyless,
      });
      expect(del.statusCode).toBe(200);
      expect(schedulesDAL.findScheduleById(id)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns 404 for unknown id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/schedules/sch_missing',
        headers: adminHeadersBodyless,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('GET /schedules/cron-preview', () => {
  it('returns next N fire times for a valid cron', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/schedules/cron-preview?expr=' + encodeURIComponent('0 * * * *') + '&count=3',
        headers: adminHeadersBodyless,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { fires: string[]; timezone: string };
      expect(body.fires).toHaveLength(3);
      expect(body.timezone).toBe('UTC');
      // Each fire is a valid ISO timestamp strictly increasing.
      const t0 = new Date(body.fires[0]).getTime();
      const t1 = new Date(body.fires[1]).getTime();
      const t2 = new Date(body.fires[2]).getTime();
      expect(t0).toBeGreaterThan(Date.now() - 1000);
      expect(t1).toBeGreaterThan(t0);
      expect(t2).toBeGreaterThan(t1);
    } finally {
      await app.close();
    }
  });

  it('caps count at 20', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/schedules/cron-preview?expr=' + encodeURIComponent('* * * * *') + '&count=100',
        headers: adminHeadersBodyless,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { fires: string[] };
      expect(body.fires).toHaveLength(20);
    } finally {
      await app.close();
    }
  });

  it('rejects missing expr (400)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/schedules/cron-preview',
        headers: adminHeadersBodyless,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects invalid cron (400)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/schedules/cron-preview?expr=garbage',
        headers: adminHeadersBodyless,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('respects timezone', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url:
          '/schedules/cron-preview?expr=' +
          encodeURIComponent('0 9 * * *') +
          '&count=1&timezone=' +
          encodeURIComponent('America/Los_Angeles'),
        headers: adminHeadersBodyless,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { fires: string[]; timezone: string };
      expect(body.timezone).toBe('America/Los_Angeles');
      expect(body.fires).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe('pause / resume', () => {
  it('pause sets paused=true with optional reason', async () => {
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody(),
      });
      const id = (create.json() as { schedule: { id: string } }).schedule.id;

      const pause = await app.inject({
        method: 'POST',
        url: `/schedules/${id}/pause`,
        headers: adminHeaders,
        payload: { reason: 'maintenance' },
      });
      expect(pause.statusCode).toBe(200);
      const body = pause.json() as { schedule: schedulesDAL.OpenHiveSchedule };
      expect(body.schedule.paused).toBe(true);
      expect(body.schedule.pause_reason).toBe('maintenance');
    } finally {
      await app.close();
    }
  });

  it('resume sets paused=false and recomputes next_fires_at', async () => {
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: 'POST',
        url: '/schedules',
        headers: adminHeaders,
        payload: validCreateBody(),
      });
      const original = (create.json() as { schedule: schedulesDAL.OpenHiveSchedule }).schedule;

      await app.inject({
        method: 'POST',
        url: `/schedules/${original.id}/pause`,
        headers: adminHeaders,
        payload: {},
      });

      // Wait a beat to ensure recompute produces a fresh next_fires_at.
      await new Promise((r) => setTimeout(r, 10));

      const resume = await app.inject({
        method: 'POST',
        url: `/schedules/${original.id}/resume`,
        headers: adminHeaders,
        payload: {},
      });
      expect(resume.statusCode).toBe(200);
      const body = resume.json() as { schedule: schedulesDAL.OpenHiveSchedule };
      expect(body.schedule.paused).toBe(false);
      expect(body.schedule.pause_reason).toBeNull();
      expect(body.schedule.next_fires_at).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('pause returns 404 for unknown id', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/schedules/sch_missing/pause',
        headers: adminHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
