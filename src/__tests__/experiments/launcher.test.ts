/**
 * Experiment launcher — process-host unit tests (injected spawn, no real
 * processes) + the launch route.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import type { ChildProcess } from 'node:child_process';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { experimentsRoutes } from '../../api/routes/experiments.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import * as dal from '../../db/dal/experiments.js';
import {
  launchRun,
  cancelRunProcess,
  isRunProcessTracked,
  runScheduledExperiment,
  setLauncherSpawnForTest,
} from '../../experiments/launcher.js';

const TEST_ROOT = testRoot('experiments-launcher');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'experiments-launcher.db');
const ADMIN_KEY = 'test-admin-key-launcher';
const ADMIN = { 'x-admin-key': ADMIN_KEY };

let app: FastifyInstance;

// A fake child process — captures exit listeners, no real OS process.
function fakeChild(pid = 4242): ChildProcess {
  const exitCbs: Array<() => void> = [];
  return {
    pid,
    unref() {},
    on(ev: string, cb: () => void) {
      if (ev === 'exit') exitCbs.push(cb);
      return this;
    },
    // expose for the test to fire exit
    __fireExit: () => exitCbs.forEach((c) => c()),
  } as unknown as ChildProcess;
}

// A spawn spy capturing args, returning fake children.
function spawnSpy() {
  const calls: Array<{ cmd: string; argv: string[]; env: Record<string, string> }> = [];
  let nextPid = 1000;
  const fn = ((cmd: string, argv: string[], opts: { env: Record<string, string> }) => {
    calls.push({ cmd, argv, env: opts.env });
    return fakeChild(++nextPid);
  }) as never;
  return { fn, calls };
}

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
    port: 7799,
  });
  await app.register(async (api) => api.register(experimentsRoutes, { config }), {
    prefix: '/api/v1',
  });
});

afterAll(async () => {
  setLauncherSpawnForTest(null);
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
  setLauncherSpawnForTest(null);
});

function makeDeploymentExperiment() {
  return dal.createExperiment({
    name: 'launch me',
    objective_metric: 'eval.score',
    objective_direction: 'increase',
    config: { deployment: { deploymentPath: '/cfg/dep.yaml', runPath: '/cfg/run.yaml' } },
  });
}

describe('launcher — launchRun / cancelRunProcess', () => {
  it('spawns the worker with token-in-env (not argv) and records the run', () => {
    const spy = spawnSpy();
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });

    const res = launchRun(exp, run, { spawn: spy.fn, hubUrl: 'http://127.0.0.1:7799' });
    expect(res.pid).toBeGreaterThan(0);
    expect(isRunProcessTracked(run.id)).toBe(true);

    const call = spy.calls[0];
    expect(call.argv).toEqual(
      expect.arrayContaining([
        'experiment-worker',
        '--hub-url',
        'http://127.0.0.1:7799',
        '--experiment-id',
        exp.id,
        '--run-id',
        run.id,
        '--deployment',
        '/cfg/dep.yaml',
        '--run',
        '/cfg/run.yaml',
        '--metric',
        'eval.score',
      ]),
    );
    // token only in env, never in argv
    expect(call.env.OPENHIVE_WORKER_TOKEN).toMatch(/^ohw_/);
    expect(call.argv.join(' ')).not.toContain(call.env.OPENHIVE_WORKER_TOKEN);

    // run got a re-minted token hash + a process marker
    const after = dal.findRunById(run.id)!;
    expect(after.worker_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(after.hosted_swarm_id).toBe(`proc:${res.pid}`);
  });

  it('throws when the experiment has no deployment config', () => {
    const exp = dal.createExperiment({
      name: 'lightweight',
      objective_metric: 'eval.score',
      objective_direction: 'increase',
      config: {},
    });
    const run = dal.createRun({ experiment_id: exp.id });
    expect(() => launchRun(exp, run, { spawn: spawnSpy().fn })).toThrow(/deployment/);
  });

  it('cancelRunProcess kills the group and clears the registry', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    const res = launchRun(exp, run, { spawn: spawnSpy().fn });

    expect(cancelRunProcess(run.id)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-(res.pid as number), 'SIGTERM');
    expect(isRunProcessTracked(run.id)).toBe(false);
    expect(cancelRunProcess(run.id)).toBe(false); // idempotent
    killSpy.mockRestore();
  });
});

describe('launcher — POST /runs/:runId/launch route', () => {
  it('launches a queued run; 409 for a non-queued run', async () => {
    const spy = spawnSpy();
    setLauncherSpawnForTest(spy.fn);

    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.id}/launch`,
      headers: ADMIN,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pid).toBeGreaterThan(0);
    expect(ok.json().run.worker_token_hash).toBeUndefined(); // sanitized
    expect(spy.calls.length).toBe(1);

    // mark it running, then a second launch is rejected (not queued)
    dal.updateRun(run.id, { status: 'running' });
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.id}/launch`,
      headers: ADMIN,
    });
    expect(again.statusCode).toBe(409);
  });

  it('400 when the experiment has no deployment config', async () => {
    setLauncherSpawnForTest(spawnSpy().fn);
    const exp = dal.createExperiment({
      name: 'lw',
      objective_metric: 'eval.score',
      objective_direction: 'increase',
      config: {},
    });
    const run = dal.createRun({ experiment_id: exp.id });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.id}/launch`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(400);
  });

  it('cancel kills the launched process', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    setLauncherSpawnForTest(spawnSpy().fn);
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.id}/launch`,
      headers: ADMIN,
    });
    expect(isRunProcessTracked(run.id)).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.id}/cancel`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.status).toBe('cancelled');
    expect(isRunProcessTracked(run.id)).toBe(false);
    expect(killSpy).toHaveBeenCalled();
    killSpy.mockRestore();
  });
});

describe('launcher — runScheduledExperiment', () => {
  it('resolves the experiment, creates a queued run, and launches it with controls', () => {
    const spy = spawnSpy();
    setLauncherSpawnForTest(spy.fn);
    const exp = makeDeploymentExperiment();
    const res = runScheduledExperiment(
      { experiment_ref: exp.id, run_controls: { cycles: 7 } },
      'sch_1',
    );
    expect(res?.runId).toMatch(/^exrun_/);
    const run = dal.findRunById(res!.runId)!;
    expect(run.initiator_type).toBe('schedule');
    expect(run.initiator_id).toBe('schedule:sch_1');
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0].argv).toEqual(expect.arrayContaining(['--cycles', '7']));
  });

  it('skips a paused experiment (returns null, no run)', () => {
    setLauncherSpawnForTest(spawnSpy().fn);
    const exp = makeDeploymentExperiment();
    dal.updateExperiment(exp.id, { status: 'paused' });
    expect(runScheduledExperiment({ experiment_ref: exp.id }, 'sch_1')).toBeNull();
    expect(dal.listRunsForExperiment(exp.id).total).toBe(0);
  });

  it('returns null for a missing experiment', () => {
    expect(runScheduledExperiment({ experiment_ref: 'exp_missing' }, 'sch_1')).toBeNull();
  });
});
