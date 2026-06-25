/**
 * Experiment worker — tracker/finalization client against the real hub API, and
 * the worker orchestration with a faked autonomation module (no autonomation
 * runtime needed). `fetch` is routed to the in-process Fastify app via inject.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { experimentsRoutes } from '../../api/routes/experiments.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { OpenHiveExperimentTracker } from '../../experiments/worker/openhive-tracker.js';
import { HubClient } from '../../experiments/worker/hub-client.js';
import {
  runExperimentWorker,
  type AutonomationExperimentModule,
  type AutonomationExperimentConfigModule,
} from '../../experiments/worker/run-experiment-worker.js';

const TEST_ROOT = testRoot('experiments-worker');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'experiments-worker.db');
const ADMIN_KEY = 'test-admin-key-worker';
const HUB = 'http://hub';

let app: FastifyInstance;
const ADMIN = { 'x-admin-key': ADMIN_KEY };

function injectFetch(a: FastifyInstance): typeof fetch {
  return (async (input: unknown, init?: { method?: string; headers?: unknown; body?: string }) => {
    const urlStr = typeof input === 'string' ? input : String(input);
    const u = new URL(urlStr);
    const res = await a.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: u.pathname + u.search,
      headers: init?.headers as Record<string, string>,
      payload: init?.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(res.payload, {
      status: res.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const FETCH = () => injectFetch(app);

beforeAll(async () => {
  cleanTestRoot(TEST_ROOT);
  initDatabase(TEST_DB_PATH);
  app = Fastify({ logger: false });
  const config: Config = ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
  });
  await app.register(async (api) => api.register(experimentsRoutes, { config }), {
    prefix: '/api/v1',
  });
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

async function makeExperimentAndRun(): Promise<{ experimentId: string; runId: string; token: string }> {
  const exp = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/experiments',
      headers: ADMIN,
      payload: {
        name: 'w',
        objective_metric: 'eval.score',
        objective_direction: 'increase',
        config: {},
      },
    })
  ).json().experiment;
  const run = (
    await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs`,
      headers: ADMIN,
      payload: {},
    })
  ).json();
  return { experimentId: exp.id, runId: run.run.id, token: run.worker_token };
}

const getRun = async (experimentId: string, runId: string) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${experimentId}/runs`,
      headers: ADMIN,
    })
  ).json().data.find((r: { id: string }) => r.id === runId);

const getCandidates = async (experimentId: string) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/v1/experiments/${experimentId}/candidates`,
      headers: ADMIN,
    })
  ).json().data as Array<Record<string, unknown>>;

describe('OpenHiveExperimentTracker + HubClient', () => {
  it('start marks the run running; batched log flushes events + projects candidates', async () => {
    const { experimentId, runId, token } = await makeExperimentAndRun();
    const tracker = new OpenHiveExperimentTracker({
      hubUrl: HUB,
      apiKey: token,
      experimentId,
      runId,
      batchSize: 2,
      fetchImpl: FETCH(),
    });

    await tracker.start({
      runId: 'arun_1',
      repoRoot: '/t',
      experimentBranch: 'b',
      experimentWorktree: 'w',
      startPoint: 'sp',
    });
    expect((await getRun(experimentId, runId)).status).toBe('running');
    expect((await getRun(experimentId, runId)).autonomation_run_id).toBe('arun_1');

    await tracker.log({ type: 'candidate_admitted', candidateId: 'c1', runId: 'arun_1', timestamp: '', message: 'a' } as never);
    await tracker.log({ type: 'promotion_keep', candidateId: 'c1', runId: 'arun_1', timestamp: '', message: 'k' } as never); // batch=2 → auto-flush

    const cands = await getCandidates(experimentId);
    expect(cands).toHaveLength(1);
    expect(cands[0].candidate_ref).toBe('c1');
    expect(cands[0].status).toBe('keep');
  });

  it('failurePolicy: warn swallows a bad-token flush, fail throws', async () => {
    const { experimentId, runId } = await makeExperimentAndRun();
    const warned: string[] = [];
    const warnTracker = new OpenHiveExperimentTracker({
      hubUrl: HUB,
      apiKey: 'ohw_wrong',
      experimentId,
      runId,
      batchSize: 1,
      failurePolicy: 'warn',
      fetchImpl: FETCH(),
      warn: (m) => warned.push(m),
    });
    await expect(
      warnTracker.log({ type: 'cycle_start', runId: 'x', timestamp: '', message: '' } as never),
    ).resolves.toBeUndefined();
    expect(warned.length).toBe(1);

    const failTracker = new OpenHiveExperimentTracker({
      hubUrl: HUB,
      apiKey: 'ohw_wrong',
      experimentId,
      runId,
      batchSize: 1,
      failurePolicy: 'fail',
      fetchImpl: FETCH(),
    });
    await expect(
      failTracker.log({ type: 'cycle_start', runId: 'x', timestamp: '', message: '' } as never),
    ).rejects.toThrow();
  });

  it('HubClient.finalize completes the run with score cards', async () => {
    const { experimentId, runId, token } = await makeExperimentAndRun();
    const client = new HubClient({ hubUrl: HUB, apiKey: token, experimentId, runId, fetchImpl: FETCH() });
    await client.finalize({
      content_hash: 'sha256:lock',
      claim_strength: { strength: 'capability' },
      candidates: [{ candidate_ref: 'c1', status: 'keep', score_train: 0.9, score_held_out: 0.8, promoted: true }],
    });
    const run = await getRun(experimentId, runId);
    expect(run.status).toBe('complete');
    expect(run.content_hash).toBe('sha256:lock');
    const cands = await getCandidates(experimentId);
    expect(cands[0].score_held_out).toBe(0.8);
  });

  it('flush restores the batch on failure — no events lost, no seq gap', async () => {
    const { experimentId, runId, token } = await makeExperimentAndRun();
    const real = injectFetch(app);
    let eventCalls = 0;
    const flaky: typeof fetch = (async (url: unknown, init?: unknown) => {
      if (String(url).includes('/events')) {
        eventCalls++;
        if (eventCalls === 1) throw new Error('network blip');
      }
      return (real as (u: unknown, i?: unknown) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const tracker = new OpenHiveExperimentTracker({
      hubUrl: HUB,
      apiKey: token,
      experimentId,
      runId,
      batchSize: 2,
      failurePolicy: 'warn',
      fetchImpl: flaky,
      warn: () => {},
    });
    await tracker.log({ type: 'candidate_admitted', candidateId: 'c1', runId: 'a', timestamp: '', message: '' } as never);
    await tracker.log({ type: 'promotion_keep', candidateId: 'c1', runId: 'a', timestamp: '', message: '' } as never); // batch=2 → flush fails → restore

    const tail = async () =>
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/experiments/${experimentId}/runs/${runId}/events`,
          headers: ADMIN,
        })
      ).json().data as Array<{ seq: number }>;

    expect(await tail()).toHaveLength(0); // first flush failed; events restored, not delivered
    await tracker.flush(); // retry succeeds
    expect((await tail()).map((e) => e.seq)).toEqual([0, 1]); // both delivered, contiguous — no gap
  });

  it('a flush failure does not leak the worker token', async () => {
    const { experimentId, runId } = await makeExperimentAndRun();
    const secret = 'ohw_supersecrettoken000000000000';
    const warned: string[] = [];
    const tracker = new OpenHiveExperimentTracker({
      hubUrl: HUB,
      apiKey: secret, // wrong token → 403
      experimentId,
      runId,
      batchSize: 1,
      failurePolicy: 'warn',
      fetchImpl: FETCH(),
      warn: (m) => warned.push(m),
    });
    await tracker.log({ type: 'cycle_start', runId: 'x', timestamp: '', message: '' } as never);
    expect(warned.length).toBe(1);
    expect(warned[0]).not.toContain(secret);
  });
});

// A faked autonomation/experiment module — drives the observer with live events
// during runWithControls, exposes a lineage, and returns a result with a lock.
function fakeAutonomation(
  opts: { failed?: boolean; throwInRun?: boolean; throwInLineage?: boolean } = {},
): AutonomationExperimentModule {
  let observers: Array<{ onEvent?: (ev: unknown) => Promise<void> }> = [];
  return {
    async createExperimentRunnerFromDeployment(o: Record<string, unknown>) {
      observers = (o.observers as typeof observers) ?? [];
      return {
        runner: {
          async initializeBaseline() {},
          async runWithControls() {
            if (opts.throwInRun) throw new Error('loop exploded');
            const emit = async (ev: Record<string, unknown>) => {
              for (const obs of observers) await obs.onEvent?.(ev);
            };
            await emit({ type: 'experiment_start', runId: 'arun_fake', repoRoot: '/t', experimentBranch: 'b', experimentWorktree: 'w', startPoint: 'sp', message: 's' });
            await emit({ type: 'candidate_admitted', candidateId: 'c1', cycleIndex: 1, message: 'a' });
            await emit({ type: 'promotion_keep', candidateId: 'c1', metric: 'eval.score', score: 0.72, message: 'k' });
            await emit({ type: 'experiment_complete', message: 'd', cycles: 1, proposed: 1, admitted: 1, totalPromoted: 1 });
            return {
              failed: Boolean(opts.failed),
              stopReason: 'cycle-budget',
              cycles: [1],
              totalProposed: 1,
              totalAdmitted: 1,
              totalPromoted: 1,
              candidateFailures: 0,
              claimStrength: { strength: 'capability', label: 'capability lift' },
            };
          },
          lineage: {
            async bySubtree() {
              if (opts.throwInLineage) throw new Error('lineage broke');
              return [{ candidateId: 'c1', card: { value: 0.85 }, gateCard: { value: 0.72 }, promoted: true, parents: [] }];
            },
          },
        },
        plan: { lock: { contentHash: 'sha256:fakelock' } },
        substrate: { id: 'app' },
      };
    },
    experimentTrackerObserver(o: { trackers: unknown[] }) {
      const trackers = o.trackers as Array<{
        start?: (m: unknown) => Promise<void>;
        log?: (e: unknown) => Promise<void>;
        finish?: (s: unknown) => Promise<void>;
      }>;
      return {
        async onEvent(ev: Record<string, unknown>) {
          for (const t of trackers) {
            if (ev.type === 'experiment_start') {
              await t.start?.({
                runId: ev.runId,
                repoRoot: ev.repoRoot,
                experimentBranch: ev.experimentBranch,
                experimentWorktree: ev.experimentWorktree,
                startPoint: ev.startPoint,
              });
            }
            await t.log?.(ev);
            if (ev.type === 'experiment_complete') {
              await t.finish?.({ runId: 'arun_fake', repoRoot: '', experimentBranch: '', experimentWorktree: '', cycles: 1, totalProposed: 1, totalAdmitted: 1, totalPromoted: 1 });
            }
          }
        },
      };
    },
    scoreFromCard(card: unknown) {
      return (card as { value?: number } | undefined)?.value;
    },
  };
}

// A faked autonomation/experiment-config module (the lightweight path). Builds a
// runner from an inline config object, drives the injected observers, and returns
// NO `deploymentRun` (→ content_hash null, no lineage subtree).
function fakeAutonomationConfig(): AutonomationExperimentConfigModule {
  let observers: Array<{ onEvent?: (ev: unknown) => Promise<void> }> = [];
  return {
    async createExperimentRunnerFromConfigObject(_raw, _base, opts) {
      observers = (opts?.observers as typeof observers) ?? [];
      return {
        runner: {
          async initializeBaseline() {},
          async runWithControls() {
            const emit = async (ev: Record<string, unknown>) => {
              for (const obs of observers) await obs.onEvent?.(ev);
            };
            await emit({ type: 'experiment_start', runId: 'arun_cfg', repoRoot: '/t', experimentBranch: 'b', experimentWorktree: 'w', startPoint: 'sp', message: 's' });
            await emit({ type: 'candidate_admitted', candidateId: 'c1', cycleIndex: 1, message: 'a' });
            await emit({ type: 'promotion_keep', candidateId: 'c1', metric: 'eval.score', score: 0.6, message: 'k' });
            await emit({ type: 'experiment_complete', message: 'd', cycles: 1, proposed: 1, admitted: 1, totalPromoted: 1 });
            return { failed: false, stopReason: 'cycle-budget', cycles: [1], totalProposed: 1, totalAdmitted: 1, totalPromoted: 1, candidateFailures: 0 };
          },
          lineage: { async bySubtree() { return []; } },
        },
        // no deploymentRun → content_hash null, subtree undefined (lightweight)
      };
    },
  };
}

describe('runExperimentWorker (orchestration, faked autonomation)', () => {
  it('lightweight inline-config path: builds via the config module; content_hash + score cards degrade to null', async () => {
    const { experimentId, runId, token } = await makeExperimentAndRun();
    const result = await runExperimentWorker({
      hubUrl: HUB,
      apiKey: token,
      experimentId,
      runId,
      config: { repoRoot: '/t', objective: { metric: 'eval.score', direction: 'increase' } },
      configBaseDir: '/t',
      objectiveMetric: 'eval.score',
      fetchImpl: FETCH(),
      loadAutonomation: async () => fakeAutonomation(), // for experimentTrackerObserver
      loadAutonomationConfig: async () => fakeAutonomationConfig(),
    });
    expect(result.status).toBe('complete');

    const run = await getRun(experimentId, runId);
    expect(run.status).toBe('complete');
    expect(run.content_hash).toBeNull(); // no deployment lock on the lightweight path

    // live events still streamed (4) and projected a candidate; but no finalization
    // score cards (subtree undefined → lineage extraction skipped).
    const events = (
      await app.inject({ method: 'GET', url: `/api/v1/experiments/${experimentId}/runs/${runId}/events`, headers: ADMIN })
    ).json().data as unknown[];
    expect(events.length).toBe(4);
    const cands = await getCandidates(experimentId);
    expect(cands[0].candidate_ref).toBe('c1');
    expect(cands[0].status).toBe('keep');
    expect(cands[0].score_train).toBeNull();
    expect(cands[0].score_held_out).toBeNull();
  });

  it('runs the loop, streams live events, and posts the finalization (lock + claim + seesaw)', async () => {
    const { experimentId, runId, token } = await makeExperimentAndRun();
    const result = await runExperimentWorker({
      hubUrl: HUB,
      apiKey: token,
      experimentId,
      runId,
      deploymentPath: 'd.yaml',
      runPath: 'r.yaml',
      objectiveMetric: 'eval.score',
      fetchImpl: FETCH(),
      loadAutonomation: async () => fakeAutonomation(),
    });
    expect(result).toEqual({ status: 'complete', stopReason: 'cycle-budget', failed: false });

    const run = await getRun(experimentId, runId);
    expect(run.status).toBe('complete');
    expect(run.content_hash).toBe('sha256:fakelock');
    expect(run.claim_strength).toEqual({ strength: 'capability', label: 'capability lift' });

    // live events landed
    const events = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/experiments/${experimentId}/runs/${runId}/events`,
        headers: ADMIN,
      })
    ).json().data as unknown[];
    expect(events.length).toBe(4);

    // candidate: status from live promotion_keep, score cards from the finalization lineage snapshot
    const cands = await getCandidates(experimentId);
    expect(cands[0].candidate_ref).toBe('c1');
    expect(cands[0].status).toBe('keep');
    expect(cands[0].score_train).toBe(0.85);
    expect(cands[0].score_held_out).toBe(0.72);
    expect(cands[0].promoted).toBe(true);
  });

  it('a failed loop result finalizes the run as failed', async () => {
    const { experimentId, runId, token } = await makeExperimentAndRun();
    const result = await runExperimentWorker({
      hubUrl: HUB,
      apiKey: token,
      experimentId,
      runId,
      deploymentPath: 'd.yaml',
      runPath: 'r.yaml',
      objectiveMetric: 'eval.score',
      fetchImpl: FETCH(),
      loadAutonomation: async () => fakeAutonomation({ failed: true }),
    });
    expect(result.failed).toBe(true);
    expect((await getRun(experimentId, runId)).status).toBe('failed');
  });

  it('a setup failure (autonomation load) finalizes the run as failed and rethrows', async () => {
    const { experimentId, runId, token } = await makeExperimentAndRun();
    await expect(
      runExperimentWorker({
        hubUrl: HUB,
        apiKey: token,
        experimentId,
        runId,
        deploymentPath: 'd.yaml',
        runPath: 'r.yaml',
        objectiveMetric: 'eval.score',
        fetchImpl: FETCH(),
        loadAutonomation: async () => {
          throw new Error('Cannot find package autonomation');
        },
      }),
    ).rejects.toThrow(/autonomation/);
    // the run is finalized 'failed' (not left stuck 'running')
    expect((await getRun(experimentId, runId)).status).toBe('failed');
  });

  it('a thrown optimization loop finalizes the run failed with stop_reason=error', async () => {
    const { experimentId, runId, token } = await makeExperimentAndRun();
    const result = await runExperimentWorker({
      hubUrl: HUB,
      apiKey: token,
      experimentId,
      runId,
      deploymentPath: 'd.yaml',
      runPath: 'r.yaml',
      objectiveMetric: 'eval.score',
      fetchImpl: FETCH(),
      loadAutonomation: async () => fakeAutonomation({ throwInRun: true }),
    });
    expect(result.failed).toBe(true);
    const run = await getRun(experimentId, runId);
    expect(run.status).toBe('failed');
    expect(run.stop_reason).toBe('error');
    expect(run.stop_message).toBe('loop exploded');
  });

  it('a lineage-extraction failure still finalizes (best-effort seesaw)', async () => {
    const { experimentId, runId, token } = await makeExperimentAndRun();
    const result = await runExperimentWorker({
      hubUrl: HUB,
      apiKey: token,
      experimentId,
      runId,
      deploymentPath: 'd.yaml',
      runPath: 'r.yaml',
      objectiveMetric: 'eval.score',
      fetchImpl: FETCH(),
      loadAutonomation: async () => fakeAutonomation({ throwInLineage: true }),
    });
    expect(result.status).toBe('complete');
    const run = await getRun(experimentId, runId);
    expect(run.status).toBe('complete');
    expect(run.content_hash).toBe('sha256:fakelock'); // run-level finalization still landed
    // candidate still projected from live events; just no score cards
    const cands = await getCandidates(experimentId);
    expect(cands[0].status).toBe('keep');
    expect(cands[0].score_train).toBeNull();
  });
});
