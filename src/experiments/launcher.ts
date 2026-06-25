/**
 * Experiment run launcher — a dedicated process-host for the runner worker.
 *
 * Spawns `openhive experiment-worker` as a detached child process, injecting a
 * freshly-minted per-run token via the environment (never argv, so it isn't
 * visible in `ps`). The worker self-reports to the hub API (PATCH/events/
 * finalize), so the launcher only owns spawn + track + cancel — no health
 * polling. A generic seam (`LauncherDeps.spawn`) keeps it testable without
 * spawning real processes, and lets a hosted-swarm-backed host slot in later.
 *
 * The worker currently runs the DEPLOYMENT path (it needs
 * `experiment.config.deployment.{deploymentPath,runPath}`); the lightweight
 * path lands once autonomation exports a config→runner factory.
 */

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import * as dal from '../db/dal/experiments.js';
import { mintRunToken } from './run-token.js';

export interface LauncherDeps {
  spawn?: typeof nodeSpawn;
  /** Path to the openhive CLI entry. Defaults to the running process's entry. */
  cliEntry?: string;
  /** Node binary. Defaults to the running node. */
  execPath?: string;
  /** Hub base URL the worker dials. Defaults to loopback on the given port. */
  hubUrl?: string;
}

interface DeploymentConfig {
  deployment?: { deploymentPath?: string; runPath?: string };
}

// run_id → the live worker process (in-memory; lost on hub restart, where the
// worker self-finalizes or is reconciled).
const runProcesses = new Map<string, ChildProcess>();

// Default spawn (overridable in tests so the launch route can be exercised
// without spawning a real worker process).
let defaultSpawn: typeof nodeSpawn = nodeSpawn;

/** Test seam — override the spawn used when `launchRun` is called without `deps.spawn`. */
export function setLauncherSpawnForTest(fn: typeof nodeSpawn | null): void {
  defaultSpawn = fn ?? nodeSpawn;
}

export interface LaunchResult {
  pid?: number;
  hosted_marker: string;
}

/**
 * Mint a fresh per-run token, persist its hash on the run, and spawn the worker
 * with the token in the environment. Returns the process marker recorded on the
 * run. Throws if the experiment has no deployment config (lightweight path
 * pending the autonomation factory).
 */
export function launchRun(
  experiment: dal.Experiment,
  run: dal.ExperimentRun,
  deps: LauncherDeps = {},
): LaunchResult {
  const spawn = deps.spawn ?? defaultSpawn;
  const cliEntry = deps.cliEntry ?? process.argv[1];
  const execPath = deps.execPath ?? process.execPath;
  const hubUrl = deps.hubUrl ?? 'http://127.0.0.1';

  const config = (experiment.config ?? {}) as DeploymentConfig;
  const dep = config.deployment;
  if (!dep?.deploymentPath || !dep?.runPath) {
    throw new Error(
      'launchRun: experiment.config.deployment.{deploymentPath,runPath} is required ' +
        '(deployment path; the lightweight path is pending the autonomation config→runner factory)',
    );
  }

  // Re-mint the per-run token at launch (the create-time plaintext is not
  // recoverable — only its hash is stored). Inject via env, not argv.
  const { token, hash } = mintRunToken();
  dal.updateRun(run.id, { worker_token_hash: hash });

  const argv = [
    cliEntry,
    'experiment-worker',
    '--hub-url',
    hubUrl,
    '--experiment-id',
    experiment.id,
    '--run-id',
    run.id,
    '--deployment',
    dep.deploymentPath,
    '--run',
    dep.runPath,
    '--metric',
    experiment.objective_metric,
  ];

  const child = spawn(execPath, argv, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, OPENHIVE_WORKER_TOKEN: token },
  });
  child.unref();

  runProcesses.set(run.id, child);
  child.on('exit', () => {
    if (runProcesses.get(run.id) === child) runProcesses.delete(run.id);
  });

  const marker = `proc:${child.pid ?? 'unknown'}`;
  dal.updateRun(run.id, { hosted_swarm_id: marker });
  return { pid: child.pid, hosted_marker: marker };
}

/** Kill a launched worker process group. Returns true if one was tracked. */
export function cancelRunProcess(runId: string): boolean {
  const child = runProcesses.get(runId);
  if (!child) return false;
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM'); // negative pid → the detached group
  } catch {
    /* already gone */
  }
  runProcesses.delete(runId);
  return true;
}

/** Whether a live worker process is tracked for this run (in this hub process). */
export function isRunProcessTracked(runId: string): boolean {
  return runProcesses.has(runId);
}
