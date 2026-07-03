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
  setHubBaseUrl,
  setLauncherSpawnForTest,
} from '../../experiments/launcher.js';

const TEST_ROOT = testRoot('experiments-launcher');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'experiments-launcher.db');
const ADMIN_KEY = 'test-admin-key-launcher';
const ADMIN = { 'x-admin-key': ADMIN_KEY };

let app: FastifyInstance;

// A fake child process — captures exit/error listeners, no real OS process.
function fakeChild(pid = 4242): ChildProcess {
  const exitCbs: Array<() => void> = [];
  const errorCbs: Array<(e: Error) => void> = [];
  return {
    pid,
    unref() {},
    on(ev: string, cb: (e?: Error) => void) {
      if (ev === 'exit') exitCbs.push(cb as () => void);
      if (ev === 'error') errorCbs.push(cb as (e: Error) => void);
      return this;
    },
    // expose for the test to fire exit / error
    __fireExit: () => exitCbs.forEach((c) => c()),
    __fireError: (e: Error) => errorCbs.forEach((c) => c(e)),
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

function makeInlineExperiment() {
  return dal.createExperiment({
    name: 'inline me',
    objective_metric: 'eval.score',
    objective_direction: 'increase',
    config: { inline: { repoRoot: '/repo', objective: { metric: 'eval.score', direction: 'increase' } } },
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
    killSpy.mockRestore();
  });

  it('cancelRunProcess falls back to the persisted proc marker when untracked', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    // Simulate a launched-then-restarted hub: marker persisted, registry empty.
    dal.updateRun(run.id, { hosted_swarm_id: 'proc:4242' });
    expect(isRunProcessTracked(run.id)).toBe(false);
    expect(cancelRunProcess(run.id)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('cancelRunProcess returns false for an untracked run with no marker', () => {
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    expect(cancelRunProcess(run.id)).toBe(false);
  });

  it('drops invalid run controls (negative / zero / non-integer)', () => {
    const spy = spawnSpy();
    setLauncherSpawnForTest(spy.fn);
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    launchRun(exp, run, { spawn: spy.fn }, { cycles: -3, budgetSeconds: 0 });
    const argv = spy.calls[0].argv;
    expect(argv).not.toContain('--cycles');
    expect(argv).not.toContain('--budget-seconds');
  });

  it('forwards valid run controls to the worker argv', () => {
    const spy = spawnSpy();
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    launchRun(exp, run, { spawn: spy.fn }, { cycles: 5, budgetSeconds: 120 });
    const argv = spy.calls[0].argv;
    expect(argv).toEqual(expect.arrayContaining(['--cycles', '5', '--budget-seconds', '120']));
  });

  it('a spawn error finalizes the run failed', () => {
    let captured: ChildProcess | undefined;
    const spawnFn = ((_cmd: string, _argv: string[], _opts: unknown) => {
      captured = fakeChild(7000);
      return captured;
    }) as never;
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    launchRun(exp, run, { spawn: spawnFn });
    (captured as unknown as { __fireError: (e: Error) => void }).__fireError(
      new Error('ENOENT'),
    );
    const after = dal.findRunById(run.id)!;
    expect(after.status).toBe('failed');
    expect(after.stop_reason).toBe('spawn-error');
    expect(isRunProcessTracked(run.id)).toBe(false);
  });

  it('launchRun dials the hub base URL set by setHubBaseUrl', () => {
    const spy = spawnSpy();
    setHubBaseUrl('http://127.0.0.1:65000');
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    launchRun(exp, run, { spawn: spy.fn });
    const argv = spy.calls[0].argv;
    const i = argv.indexOf('--hub-url');
    expect(argv[i + 1]).toBe('http://127.0.0.1:65000');
    setHubBaseUrl('http://127.0.0.1'); // reset module state
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

  it('rejects a double-launch of the same run (409)', async () => {
    setLauncherSpawnForTest(spawnSpy().fn);
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.id}/launch`,
      headers: ADMIN,
    });
    expect(first.statusCode).toBe(200);
    // second launch — still 'queued' but already has a process marker → 409
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.id}/launch`,
      headers: ADMIN,
    });
    expect(second.statusCode).toBe(409);
  });

  it('rejects launch without the admin key (admin-only)', async () => {
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.id}/launch`,
    });
    expect([401, 403]).toContain(res.statusCode);
    // and the run was not claimed/launched
    expect(dal.findRunById(run.id)!.hosted_swarm_id).toBeNull();
  });

  it('rejects cancel without the admin key (admin-only)', async () => {
    const exp = makeDeploymentExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/experiments/${exp.id}/runs/${run.id}/cancel`,
    });
    expect([401, 403]).toContain(res.statusCode);
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
    dal.updateExperiment(exp.id, { status: 'active' });
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

  it('skips a draft experiment (returns null, no run)', () => {
    setLauncherSpawnForTest(spawnSpy().fn);
    const exp = makeDeploymentExperiment();
    expect(runScheduledExperiment({ experiment_ref: exp.id }, 'sch_1')).toBeNull();
    expect(dal.listRunsForExperiment(exp.id).total).toBe(0);
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

describe('launcher — lightweight inline-config path', () => {
  it('passes the inline config via env (not argv) + --config-base; no --deployment/--run', () => {
    const spy = spawnSpy();
    const exp = makeInlineExperiment();
    const run = dal.createRun({ experiment_id: exp.id });
    launchRun(exp, run, { spawn: spy.fn, hubUrl: 'http://127.0.0.1:7799' });
    const call = spy.calls[0];
    // config travels in env, never argv
    expect(call.env.OPENHIVE_EXPERIMENT_CONFIG).toBeDefined();
    expect(JSON.parse(call.env.OPENHIVE_EXPERIMENT_CONFIG).repoRoot).toBe('/repo');
    expect(call.argv).not.toContain('--deployment');
    expect(call.argv).not.toContain('--run');
    // base derived from the inline config's repoRoot
    expect(call.argv).toEqual(expect.arrayContaining(['--config-base', '/repo']));
    // worker token still in env (not argv)
    expect(call.env.OPENHIVE_WORKER_TOKEN).toBeDefined();
    expect(call.argv).not.toContain(call.env.OPENHIVE_WORKER_TOKEN);
  });

  it('throws when the config provides neither deployment nor inline', () => {
    const spy = spawnSpy();
    const exp = dal.createExperiment({
      name: 'empty',
      objective_metric: 'eval.score',
      objective_direction: 'increase',
      config: {},
    });
    const run = dal.createRun({ experiment_id: exp.id });
    expect(() => launchRun(exp, run, { spawn: spy.fn })).toThrow(/EXACTLY ONE/);
  });

  it('throws when the config provides BOTH deployment and inline', () => {
    const spy = spawnSpy();
    const exp = dal.createExperiment({
      name: 'both',
      objective_metric: 'eval.score',
      objective_direction: 'increase',
      config: {
        deployment: { deploymentPath: '/d', runPath: '/r' },
        inline: { repoRoot: '/x' },
      },
    });
    const run = dal.createRun({ experiment_id: exp.id });
    expect(() => launchRun(exp, run, { spawn: spy.fn })).toThrow(/EXACTLY ONE/);
  });
});
