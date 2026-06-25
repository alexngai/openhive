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

interface ExperimentLaunchConfig {
  deployment?: { deploymentPath?: string; runPath?: string };
  /** Inline autonomation DOMAIN config — the lightweight (non-deployment) path. */
  inline?: Record<string, unknown>;
  /** Base dir for resolving relative paths in `inline` (defaults to its repoRoot). */
  configBaseDir?: string;
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

// The hub base URL the worker dials. Set by the server AFTER `listen` so it
// reflects the actual BOUND port (the server may auto-increment on EADDRINUSE),
// not just the configured one. Defaults to loopback with no port until set.
let hubBaseUrl = 'http://127.0.0.1';

export function setHubBaseUrl(url: string): void {
  hubBaseUrl = url;
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
export interface LaunchControls {
  cycles?: number;
  budgetSeconds?: number;
}

export function launchRun(
  experiment: dal.Experiment,
  run: dal.ExperimentRun,
  deps: LauncherDeps = {},
  controls?: LaunchControls,
): LaunchResult {
  const spawn = deps.spawn ?? defaultSpawn;
  const cliEntry = deps.cliEntry ?? process.argv[1];
  const execPath = deps.execPath ?? process.execPath;
  const hubUrl = deps.hubUrl ?? hubBaseUrl;

  const config = (experiment.config ?? {}) as ExperimentLaunchConfig;
  const dep = config.deployment;
  const hasDeployment = Boolean(dep?.deploymentPath && dep?.runPath);
  const hasInline = config.inline != null;
  if (hasDeployment === hasInline) {
    throw new Error(
      'launchRun: experiment.config must provide EXACTLY ONE of ' +
        'deployment.{deploymentPath,runPath} (deployment path) or `inline` (lightweight config)',
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
    '--metric',
    experiment.objective_metric,
  ];
  const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENHIVE_WORKER_TOKEN: token };
  if (hasDeployment) {
    argv.push('--deployment', dep!.deploymentPath!, '--run', dep!.runPath!);
  } else {
    // Lightweight inline config — passed via env (not argv): it can be large, and
    // argv is visible in `ps`.
    childEnv.OPENHIVE_EXPERIMENT_CONFIG = JSON.stringify(config.inline);
    const base = config.configBaseDir ?? (config.inline as { repoRoot?: string }).repoRoot;
    if (base) argv.push('--config-base', base);
  }
  if (typeof controls?.cycles === 'number' && Number.isInteger(controls.cycles) && controls.cycles > 0) {
    argv.push('--cycles', String(controls.cycles));
  }
  if (
    typeof controls?.budgetSeconds === 'number' &&
    Number.isFinite(controls.budgetSeconds) &&
    controls.budgetSeconds > 0
  ) {
    argv.push('--budget-seconds', String(controls.budgetSeconds));
  }

  const child = spawn(execPath, argv, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: childEnv,
  });
  child.unref();

  runProcesses.set(run.id, child);
  child.on('exit', () => {
    if (runProcesses.get(run.id) === child) runProcesses.delete(run.id);
  });
  child.on('error', (err) => {
    // Spawn failure — the worker will never self-report; finalize the run failed.
    if (runProcesses.get(run.id) === child) runProcesses.delete(run.id);
    dal.updateRun(run.id, {
      status: 'failed',
      stop_reason: 'spawn-error',
      stop_message: (err as Error).message,
      finished_at: new Date().toISOString(),
    });
  });

  const marker = `proc:${child.pid ?? 'unknown'}`;
  dal.updateRun(run.id, { hosted_swarm_id: marker });
  return { pid: child.pid, hosted_marker: marker };
}

/**
 * Kill a launched worker process group. Returns true if a kill was attempted.
 * Falls back to the stored `proc:<pid>` marker when the process isn't tracked
 * in this hub instance (e.g. after a restart), so cancel still works.
 */
export function cancelRunProcess(runId: string): boolean {
  const child = runProcesses.get(runId);
  if (child) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM'); // negative pid → the detached group
    } catch {
      /* already gone */
    }
    runProcesses.delete(runId);
    return true;
  }
  // Not tracked here — best-effort kill via the persisted marker.
  const marker = dal.findRunById(runId)?.hosted_swarm_id;
  const m = typeof marker === 'string' ? marker.match(/^proc:(\d+)$/) : null;
  if (m) {
    const pid = Number(m[1]);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(-pid, 'SIGTERM');
        return true;
      } catch {
        /* already gone */
      }
    }
  }
  return false;
}

/** Whether a live worker process is tracked for this run (in this hub process). */
export function isRunProcessTracked(runId: string): boolean {
  return runProcesses.has(runId);
}

export interface ScheduledExperimentPayload {
  experiment_ref: string;
  run_controls?: LaunchControls;
}

/**
 * Fire a scheduled experiment: resolve the experiment, create a `queued` run,
 * and launch the worker. Returns the new run id, or null if the experiment is
 * missing or not active (paused/archived experiments are skipped). On a launch
 * failure the run is finalized `failed` and the error rethrown (the scheduler
 * fire handler logs it).
 */
export function runScheduledExperiment(
  payload: ScheduledExperimentPayload,
  scheduleId: string,
  deps: LauncherDeps = {},
): { runId: string } | null {
  const experiment = dal.findExperimentById(payload.experiment_ref);
  if (!experiment) return null;
  if (experiment.status === 'paused' || experiment.status === 'archived') return null;

  const run = dal.createRun({
    experiment_id: experiment.id,
    initiator_type: 'schedule',
    initiator_id: `schedule:${scheduleId}`,
  });
  try {
    launchRun(experiment, run, deps, payload.run_controls);
  } catch (err) {
    dal.updateRun(run.id, {
      status: 'failed',
      stop_reason: 'launch-error',
      stop_message: (err as Error).message,
      finished_at: new Date().toISOString(),
    });
    throw err;
  }
  return { runId: run.id };
}
