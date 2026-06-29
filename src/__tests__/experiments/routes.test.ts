/**
 * Experiments REST routes — HTTP-level coverage via fastify inject.
 *
 * Operator CRUD + content-hash upsert; per-run worker-token auth (valid /
 * wrong / cross-run / admin override); event ingest projection; finalization
 * (run lock + claim + score cards); event tail.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { experimentsRoutes } from '../../api/routes/experiments.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('experiments-routes');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'experiments-routes.db');
const ADMIN_KEY = 'test-admin-key-experiments';

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test OpenHive', description: 'Test' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
}

let app: FastifyInstance;
const ADMIN = { 'x-admin-key': ADMIN_KEY };

beforeAll(async () => {
  cleanTestRoot(TEST_ROOT);
  initDatabase(TEST_DB_PATH);
  app = Fastify({ logger: false });
  await app.register(
    async (api) => {
      await api.register(experimentsRoutes, { config: createTestConfig() });
    },
    { prefix: '/api/v1' },
  );
});

afterAll(async () => {
  await app.close();
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec('DELETE FROM experiment_events');
  db.exec('DELETE FROM experiment_candidates');
  db.exec('DELETE FROM experiment_runs');
  db.exec('DELETE FROM experiments');
});

async function createExperiment(overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/experiments',
    headers: ADMIN,
    payload: {
      name: 'optimize x',
      objective_metric: 'eval.score',
      objective_direction: 'increase',
      config: { evolver: { kind: 'claude-code' } },
      ...overrides,
    },
  });
  return res;
}

async function createRun(experimentId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/experiments/${experimentId}/runs`,
    headers: ADMIN,
    payload: {},
  });
  return res;
}

describe('experiments routes — operator', () => {
  it('POST /experiments creates and returns 201 (exploratory, null content_hash)', async () => {
    const res = await createExperiment();
    expect(res.statusCode).toBe(201);
    const { experiment } = res.json();
    expect(experiment.id).toMatch(/^exp_/);
    expect(experiment.content_hash).toBeNull();
    expect(experiment.status).toBe('draft');
  });

  it('POST /experiments with the same content_hash returns the same experiment (D2)', async () => {
    const a = (await createExperiment({ content_hash: 'sha256:lock' })).json().experiment;
    const b = (
      await createExperiment({ content_hash: 'sha256:lock', name: 'relabel' })
    ).json().experiment;
    expect(b.id).toBe(a.id);
    const list = await app.inject({ method: 'GET', url: '/api/v1/experiments', headers: ADMIN });
    expect(list.json().total).toBe(1);
  });

  it('POST /experiments rejects an invalid body (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/experiments',
      headers: ADMIN,
      payload: { name: 'x', objective_direction: 'sideways' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /experiments/:id returns the experiment + runs; 404 for unknown', async () => {
    const exp = (await createExperiment()).json().experiment;
    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${exp.id}`,
      headers: ADMIN,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().experiment.id).toBe(exp.id);
    expect(Array.isArray(ok.json().runs)).toBe(true);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/experiments/exp_missing',
      headers: ADMIN,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('pause / resume / archive transition status', async () => {
    const exp = (await createExperiment()).json().experiment;
    for (const [action, status] of [
      ['pause', 'paused'],
      ['resume', 'active'],
      ['archive', 'archived'],
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/experiments/${exp.id}/${action}`,
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().experiment.status).toBe(status);
    }
  });

  it('requires auth (401 without admin key or token)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/experiments' });
    expect(res.statusCode).toBe(401);
  });
});

describe('experiments routes — run + worker auth', () => {
  it('POST /runs mints a worker token, returns it once, and never leaks the hash', async () => {
    const exp = (await createExperiment()).json().experiment;
    const res = await createRun(exp.id);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.run.id).toMatch(/^exrun_/);
    expect(body.worker_token).toMatch(/^ohw_/);
    expect(body.run.worker_token_hash).toBeUndefined(); // sanitized
  });

  it('worker routes accept the run token, reject a wrong token and a cross-run token', async () => {
    const exp = (await createExperiment()).json().experiment;
    const runA = (await createRun(exp.id)).json();
    const runB = (await createRun(exp.id)).json();

    const patch = (token: string, runId: string) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/experiments/${exp.id}/runs/${runId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { status: 'running' },
      });

    // correct token
    expect((await patch(runA.worker_token, runA.run.id)).statusCode).toBe(200);
    // wrong token
    expect((await patch('ohw_wrong', runA.run.id)).statusCode).toBe(403);
    // run B's token used on run A → 403 (row-scoped)
    expect((await patch(runB.worker_token, runA.run.id)).statusCode).toBe(403);
    // admin key override
    const adminPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/experiments/${exp.id}/runs/${runA.run.id}`,
      headers: ADMIN,
      payload: { status: 'running' },
    });
    expect(adminPatch.statusCode).toBe(200);
  });

  it('PATCH run updates status + JSON metadata', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}`,
      headers: { authorization: `Bearer ${run.worker_token}` },
      payload: {
        status: 'running',
        autonomation_run_id: 'arun_1',
        env_fingerprint: { host: 'box-1' },
        cycles: 3,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.status).toBe('running');
    expect(res.json().run.env_fingerprint).toEqual({ host: 'box-1' });
    expect(res.json().run.cycles).toBe(3);
  });

  it('GET /runs/:runId returns the run; 404 unknown run + 404 cross-experiment', async () => {
    const expA = (await createExperiment()).json().experiment;
    const expB = (await createExperiment({ content_hash: 'sha256:rundetail-b' })).json()
      .experiment;
    const run = (await createRun(expA.id)).json();

    // happy path: the run is returned and the hash is stripped
    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${expA.id}/runs/${run.run.id}`,
      headers: ADMIN,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().run.id).toBe(run.run.id);
    expect(ok.json().run.experiment_id).toBe(expA.id);
    expect(ok.json().run.worker_token_hash).toBeUndefined();

    // unknown run → 404
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${expA.id}/runs/exrun_nope`,
      headers: ADMIN,
    });
    expect(missing.statusCode).toBe(404);

    // run A under experiment B's path → 404 (scoped to experiment)
    const mismatch = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${expB.id}/runs/${run.run.id}`,
      headers: ADMIN,
    });
    expect(mismatch.statusCode).toBe(404);
  });

  it('POST /runs/cancel marks the run cancelled', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/cancel`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.status).toBe('cancelled');
  });
});

describe('experiments routes — event ingest + tail', () => {
  it('POST events projects candidates, advances the incumbent, and is idempotent', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    const auth = { authorization: `Bearer ${run.worker_token}` };

    const post = (events: unknown[]) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events`,
        headers: auth,
        payload: { events },
      });

    const res = await post([
      { seq: 0, type: 'experiment_start', message: 'go' },
      { seq: 1, type: 'candidate_admitted', candidateId: 'c1', cycleIndex: 1, baseCommit: 'aaa', headCommit: 'bbb', changedPaths: ['p.txt'] },
      { seq: 2, type: 'promotion_keep', candidateId: 'c1', metric: 'eval.score', score: 0.7 },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(3);

    // candidate projected + promoted; incumbent set
    const cands = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${exp.id}/candidates`,
      headers: ADMIN,
    });
    expect(cands.json().total).toBe(1);
    expect(cands.json().data[0].candidate_ref).toBe('c1');
    expect(cands.json().data[0].status).toBe('keep');
    expect(cands.json().data[0].promoted).toBe(true);
    expect(cands.json().data[0].changed_paths).toEqual(['p.txt']);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${exp.id}`,
      headers: ADMIN,
    });
    expect(detail.json().experiment.incumbent_candidate_id).toBe(cands.json().data[0].id);

    // idempotent re-POST of the same seqs
    const retry = await post([
      { seq: 1, type: 'candidate_admitted', candidateId: 'c1' },
      { seq: 2, type: 'promotion_keep', candidateId: 'c1' },
    ]);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().applied).toBe(0);

    // A duplicate seq with a conflicting body must not re-project from the
    // retried request. The stored event row remains the source of truth.
    const conflictingRetry = await post([
      { seq: 2, type: 'promotion_discard', candidateId: 'c1', reason: 'late duplicate' },
    ]);
    expect(conflictingRetry.statusCode).toBe(200);
    expect(conflictingRetry.json().applied).toBe(0);

    const afterRetry = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${exp.id}/candidates`,
      headers: ADMIN,
    });
    expect(afterRetry.json().data[0].status).toBe('keep');
    expect(afterRetry.json().data[0].promoted).toBe(true);

    const tail = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events`,
      headers: ADMIN,
    });
    expect(tail.json().data).toHaveLength(3); // no duplicates
    expect(tail.json().max_seq).toBe(2);
    expect(tail.json().data.map((e: { seq: number }) => e.seq)).toEqual([0, 1, 2]);
    expect(tail.json().data[2].type).toBe('promotion_keep');
  });

  it('GET events tail respects after_seq', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events`,
      headers: { authorization: `Bearer ${run.worker_token}` },
      payload: {
        events: [0, 1, 2].map((seq) => ({ seq, type: 'cycle_start' })),
      },
    });
    const tail = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events?after_seq=0`,
      headers: ADMIN,
    });
    expect(tail.json().data.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
  });
});

describe('experiments routes — finalize', () => {
  it('POST finalize writes the run lock/claim, score cards, incumbent, and back-fills the experiment content_hash', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    const auth = { authorization: `Bearer ${run.worker_token}` };

    // a candidate first seen via events (admitted), no scores yet
    await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events`,
      headers: auth,
      payload: { events: [{ seq: 0, type: 'candidate_admitted', candidateId: 'c1' }] },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/finalize`,
      headers: auth,
      payload: {
        content_hash: 'sha256:locked',
        claim_strength: { strength: 'capability', label: 'capability lift' },
        stop_reason: 'cycle-budget',
        cycles: 5,
        total_promoted: 1,
        candidates: [
          {
            candidate_ref: 'c1',
            score_train: 0.9,
            score_held_out: 0.81,
            promoted: true,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.status).toBe('complete');
    expect(res.json().run.content_hash).toBe('sha256:locked');
    expect(res.json().run.claim_strength).toEqual({
      strength: 'capability',
      label: 'capability lift',
    });
    expect(res.json().run.worker_token_hash).toBeUndefined();

    // score cards (the seesaw) landed on the candidate; status preserved from events
    const cands = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/experiments/${exp.id}/candidates`,
        headers: ADMIN,
      })
    ).json();
    expect(cands.data[0].score_train).toBe(0.9);
    expect(cands.data[0].score_held_out).toBe(0.81);
    expect(cands.data[0].status).toBe('admitted'); // not clobbered by finalize (no status sent)
    expect(cands.data[0].promoted).toBe(true);

    // experiment content_hash back-filled from the run lock
    const detail = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/experiments/${exp.id}`,
        headers: ADMIN,
      })
    ).json();
    expect(detail.experiment.content_hash).toBe('sha256:locked');
    expect(detail.experiment.incumbent_candidate_id).toBe(cands.data[0].id);
  });
});

describe('experiments routes — review hardening', () => {
  it('worker token dies on finalize — a later write with the used token 403s', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    const auth = { authorization: `Bearer ${run.worker_token}` };

    const fin = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/finalize`,
      headers: auth,
      payload: { content_hash: 'sha256:done' },
    });
    expect(fin.statusCode).toBe(200);

    // token is now cleared (worker_token_hash null) → 403 on any further write
    const after = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events`,
      headers: auth,
      payload: { events: [{ seq: 9, type: 'cycle_start' }] },
    });
    expect(after.statusCode).toBe(403);
  });

  it('terminal-state guard: events/finalize on a cancelled run → 409 (via admin)', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/cancel`,
      headers: ADMIN,
    });
    const ev = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events`,
      headers: ADMIN,
      payload: { events: [{ seq: 0, type: 'cycle_start' }] },
    });
    expect(ev.statusCode).toBe(409);
    const fin = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/finalize`,
      headers: ADMIN,
      payload: {},
    });
    expect(fin.statusCode).toBe(409);
  });

  it('worker auth: 401 when no credential, 404 unknown run, 404 run/experiment mismatch', async () => {
    const expA = (await createExperiment()).json().experiment;
    const expB = (await createExperiment({ content_hash: 'sha256:b' })).json().experiment;
    const runA = (await createRun(expA.id)).json();

    // no credential at all → 401
    const anon = await app.inject({
      method: 'PATCH',
      url: `/api/v1/experiments/${expA.id}/runs/${runA.run.id}`,
      payload: { status: 'running' },
    });
    expect(anon.statusCode).toBe(401);

    // empty Bearer → 401
    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/v1/experiments/${expA.id}/runs/${runA.run.id}`,
      headers: { authorization: 'Bearer ' },
      payload: { status: 'running' },
    });
    expect(empty.statusCode).toBe(401);

    // unknown run (admin) → 404
    const unknown = await app.inject({
      method: 'PATCH',
      url: `/api/v1/experiments/${expA.id}/runs/exrun_nope`,
      headers: ADMIN,
      payload: { status: 'running' },
    });
    expect(unknown.statusCode).toBe(404);

    // runA's token used under experiment B's path → 404 (scoped to experiment)
    const mismatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/experiments/${expB.id}/runs/${runA.run.id}`,
      headers: { authorization: `Bearer ${runA.worker_token}` },
      payload: { status: 'running' },
    });
    expect(mismatch.statusCode).toBe(404);
  });

  it('event projection variety: rejected→discard, promotion_discard→not promoted, non-candidate→no row', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events`,
      headers: { authorization: `Bearer ${run.worker_token}` },
      payload: {
        events: [
          { seq: 0, type: 'cycle_start' }, // no candidateId → no candidate row
          { seq: 1, type: 'candidate_rejected', candidateId: 'cr', reason: 'admission failed' },
          { seq: 2, type: 'promotion_discard', candidateId: 'cd' },
        ],
      },
    });
    const data = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/experiments/${exp.id}/candidates`,
        headers: ADMIN,
      })
    ).json().data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2); // cycle_start created no candidate
    const cr = data.find((c) => c.candidate_ref === 'cr')!;
    expect(cr.status).toBe('discard');
    expect(cr.failure_reason).toBe('admission failed');
    expect(cr.promoted).toBe(false);
    const cd = data.find((c) => c.candidate_ref === 'cd')!;
    expect(cd.promoted).toBe(false);
  });

  it('finalize creates a never-before-seen candidate and resolves the parent lineage edge', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/finalize`,
      headers: { authorization: `Bearer ${run.worker_token}` },
      payload: {
        candidates: [
          { candidate_ref: 'base', status: 'baseline', score_held_out: 0.5 },
          { candidate_ref: 'c1', parent_candidate_ref: 'base', promoted: true, score_held_out: 0.7 },
          { candidate_ref: 'orphan', parent_candidate_ref: 'ghost' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const data = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/experiments/${exp.id}/candidates`,
        headers: ADMIN,
      })
    ).json().data as Array<Record<string, string>>;
    const byRef = Object.fromEntries(data.map((c) => [c.candidate_ref, c]));
    expect(byRef.base.status).toBe('baseline');
    expect(byRef.c1.parent_candidate_id).toBe(byRef.base.id); // resolved to hub id
    expect(byRef.c1.status).toBe('keep'); // derived from promoted on insert
    expect(byRef.orphan.parent_candidate_id).toBeNull(); // unknown parent → null
  });

  it('content_hash back-fill collision is swallowed; the colliding experiment is untouched', async () => {
    const x = (await createExperiment({ content_hash: 'sha256:shared' })).json().experiment;
    const y = (await createExperiment()).json().experiment; // exploratory, null hash
    const run = (await createRun(y.id)).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${y.id}/runs/${run.run.id}/finalize`,
      headers: { authorization: `Bearer ${run.worker_token}` },
      payload: { content_hash: 'sha256:shared' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.content_hash).toBe('sha256:shared'); // on the run
    const yDetail = (
      await app.inject({ method: 'GET', url: `/api/v1/experiments/${y.id}`, headers: ADMIN })
    ).json();
    expect(yDetail.experiment.content_hash).toBeNull(); // back-fill collided → stays null
    const xDetail = (
      await app.inject({ method: 'GET', url: `/api/v1/experiments/${x.id}`, headers: ADMIN })
    ).json();
    expect(xDetail.experiment.content_hash).toBe('sha256:shared'); // untouched
  });

  it('event batch bounds: >500 → 400, empty → 400', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    const auth = { authorization: `Bearer ${run.worker_token}` };
    const tooMany = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events`,
      headers: auth,
      payload: { events: Array.from({ length: 501 }, (_, i) => ({ seq: i, type: 'cycle_start' })) },
    });
    expect(tooMany.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}/events`,
      headers: auth,
      payload: { events: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('no run-returning endpoint leaks worker_token_hash', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}`,
      headers: { authorization: `Bearer ${run.worker_token}` },
      payload: { status: 'running' },
    });
    expect(patch.json().run.worker_token_hash).toBeUndefined();
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${exp.id}/runs`,
      headers: ADMIN,
    });
    expect(list.json().data[0].worker_token_hash).toBeUndefined();
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${exp.id}`,
      headers: ADMIN,
    });
    expect(detail.json().runs[0].worker_token_hash).toBeUndefined();
  });

  it('worker PATCH may not set a terminal status (409 — use finalize/cancel)', async () => {
    const exp = (await createExperiment()).json().experiment;
    const run = (await createRun(exp.id)).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}`,
      headers: { authorization: `Bearer ${run.worker_token}` },
      payload: { status: 'complete' },
    });
    expect(res.statusCode).toBe(409);
    // a non-terminal PATCH still works
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/experiments/${exp.id}/runs/${run.run.id}`,
      headers: { authorization: `Bearer ${run.worker_token}` },
      payload: { status: 'running' },
    });
    expect(ok.statusCode).toBe(200);
  });
});
