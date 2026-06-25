/**
 * Experiment runner worker orchestration.
 *
 * Dynamically imports the optional `autonomation` package, builds a runner from
 * a deployment config (`createExperimentRunnerFromDeployment` — the exported,
 * file-path-driven path that yields a real `content_hash` + claims gate), wires
 * the OpenHive tracker for live events, runs the loop, then POSTs the
 * finalization payload (content_hash + claim_strength + lineage score cards
 * the event stream can't carry).
 *
 * autonomation is loaded via a dynamic import so the hub never pulls it at
 * runtime — only this worker does, and only when actually running. The loose
 * local types keep this file free of any autonomation import.
 */

import { OpenHiveExperimentTracker } from './openhive-tracker.js';
import { HubClient, type FinalizePayload, type FinalizeCandidatePayload } from './hub-client.js';

// ── Loose structural shapes of the autonomation surface we use ──────────────

interface AutonomationRunResult {
  failed?: boolean;
  stopReason?: string;
  stopMessage?: string;
  cycles?: unknown[];
  totalProposed?: number;
  totalAdmitted?: number;
  totalPromoted?: number;
  candidateFailures?: number;
  claimStrength?: unknown;
}

interface AutonomationLineageEntry {
  candidateId: string;
  card?: unknown;
  gateCard?: unknown;
  promoted?: boolean;
  parents?: string[];
}

interface AutonomationRunner {
  initializeBaseline(): Promise<unknown>;
  runWithControls(controls: Record<string, unknown>): Promise<AutonomationRunResult>;
  lineage?: { bySubtree(subtree: string): Promise<AutonomationLineageEntry[]> };
}

interface AutonomationDeploymentRunner {
  runner: AutonomationRunner;
  plan?: { lock?: { contentHash?: string } };
  substrate?: { id?: string };
}

export interface AutonomationExperimentModule {
  createExperimentRunnerFromDeployment(
    opts: Record<string, unknown>,
  ): Promise<AutonomationDeploymentRunner>;
  experimentTrackerObserver(opts: { trackers: unknown[]; failurePolicy?: string }): unknown;
  scoreFromCard(card: unknown, metric: string, aggregate: string): number | undefined;
}

// The lightweight (non-deployment) path: `autonomation/experiment-config`. Builds
// a runner from an inline DOMAIN config object, observers injected. Its return
// nests any deployment runner under `deploymentRun` (undefined for a pure
// non-deployment config), so content_hash / substrate live there when present.
interface AutonomationConfigRunner {
  runner: AutonomationRunner;
  deploymentRun?: {
    plan?: { lock?: { contentHash?: string } };
    substrate?: { id?: string };
  };
}

export interface AutonomationExperimentConfigModule {
  createExperimentRunnerFromConfigObject(
    raw: unknown,
    base: string,
    opts?: { observers?: unknown[]; journal?: unknown },
  ): Promise<AutonomationConfigRunner>;
}

export interface RunExperimentWorkerOptions {
  hubUrl: string;
  apiKey: string; // per-run worker token
  experimentId: string;
  runId: string;
  // Deployment path (the verifiable, content-hash-locked path). Mutually
  // exclusive with `config` (the lightweight inline-config path).
  deploymentPath?: string;
  runPath?: string;
  // Lightweight path: an inline autonomation DOMAIN config object. When set, the
  // worker builds the runner via `autonomation/experiment-config` and content_hash
  // / held-out scores degrade to null (no deployment lock / claims gate).
  config?: unknown;
  /** Base dir for resolving relative paths in `config` (defaults to cwd). */
  configBaseDir?: string;
  /** Objective metric id used to extract scalar scores from lineage cards. */
  objectiveMetric: string;
  objectiveAggregate?: 'mean' | 'sum' | 'min' | 'max';
  controls?: Record<string, unknown>; // autonomation ExperimentRunControls
  envFingerprint?: unknown;
  fetchImpl?: typeof fetch;
  /** Test seam — override the autonomation deployment-module loader. */
  loadAutonomation?: () => Promise<AutonomationExperimentModule>;
  /** Test seam — override the autonomation experiment-config-module loader. */
  loadAutonomationConfig?: () => Promise<AutonomationExperimentConfigModule>;
}

export interface RunExperimentWorkerResult {
  status: 'complete' | 'failed';
  stopReason?: string;
  failed: boolean;
}

async function defaultLoadAutonomation(): Promise<AutonomationExperimentModule> {
  try {
    return (await import('autonomation/experiment')) as unknown as AutonomationExperimentModule;
  } catch (err) {
    throw new Error(
      'The `openhive experiment-worker` requires the optional `autonomation` package. ' +
        'Install it to manage experiments (it is an optional peer dependency). ' +
        `Underlying import error: ${(err as Error).message}`,
    );
  }
}

async function defaultLoadAutonomationConfig(): Promise<AutonomationExperimentConfigModule> {
  try {
    return (await import(
      'autonomation/experiment-config'
    )) as unknown as AutonomationExperimentConfigModule;
  } catch (err) {
    throw new Error(
      'The `openhive experiment-worker` lightweight (inline-config) path requires the ' +
        'optional `autonomation` package. Install it to manage experiments. ' +
        `Underlying import error: ${(err as Error).message}`,
    );
  }
}

export async function runExperimentWorker(
  opts: RunExperimentWorkerOptions,
): Promise<RunExperimentWorkerResult> {
  const clientOpts = {
    hubUrl: opts.hubUrl,
    apiKey: opts.apiKey,
    experimentId: opts.experimentId,
    runId: opts.runId,
    fetchImpl: opts.fetchImpl,
  };
  const tracker = new OpenHiveExperimentTracker(clientOpts);
  const client = new HubClient(clientOpts);

  // Setup: load the optional autonomation runtime + build the runner. A failure
  // here (missing package, bad deployment, baseline error) finalizes the run as
  // 'failed' so it isn't left stuck 'running', then propagates.
  let auto!: AutonomationExperimentModule;
  let runner!: AutonomationRunner;
  // content_hash + lineage subtree are resolved per path: the deployment path
  // yields them from the plan lock / substrate; the lightweight path nests any
  // deployment runner under `deploymentRun` (else both stay null/undefined).
  let contentHash: string | null = null;
  let subtree: string | undefined;
  try {
    auto = await (opts.loadAutonomation ?? defaultLoadAutonomation)();
    const observer = auto.experimentTrackerObserver({ trackers: [tracker], failurePolicy: 'warn' });
    if (opts.config !== undefined) {
      // Lightweight path: an inline domain config (no deployment lock / claims gate).
      const autoConfig = await (opts.loadAutonomationConfig ?? defaultLoadAutonomationConfig)();
      const built = await autoConfig.createExperimentRunnerFromConfigObject(
        opts.config,
        opts.configBaseDir ?? process.cwd(),
        { observers: [observer] },
      );
      runner = built.runner;
      contentHash = built.deploymentRun?.plan?.lock?.contentHash ?? null;
      subtree = built.deploymentRun?.substrate?.id;
    } else {
      // Deployment path: the verifiable, content-hash-locked runner.
      const built = await auto.createExperimentRunnerFromDeployment({
        deploymentPath: opts.deploymentPath,
        runPath: opts.runPath,
        observers: [observer],
      });
      runner = built.runner;
      contentHash = built.plan?.lock?.contentHash ?? null;
      subtree = built.substrate?.id;
    }
    await runner.initializeBaseline();
  } catch (setupErr) {
    await client
      .finalize({
        status: 'failed',
        stop_reason: 'setup-error',
        stop_message: (setupErr as Error).message,
      })
      .catch(() => {});
    throw setupErr;
  }

  // The optimization loop. A throw here is a completed-with-failure run (not a
  // worker crash) — finalize it 'failed' below rather than rethrowing.
  let result: AutonomationRunResult | undefined;
  let failed = false;
  let errMessage: string | undefined;
  try {
    result = await runner.runWithControls(opts.controls ?? {});
    failed = Boolean(result?.failed);
  } catch (err) {
    failed = true;
    errMessage = (err as Error).message;
  } finally {
    // Flush any live events that didn't reach the batch threshold.
    await tracker.flush();
  }

  // Finalization — the verifiability channel the tracker can't carry. On the
  // lightweight path `contentHash` is null (no deployment lock).
  const aggregate = opts.objectiveAggregate ?? 'mean';
  let candidates: FinalizeCandidatePayload[] = [];
  try {
    candidates = await extractCandidates(runner, subtree, auto, opts.objectiveMetric, aggregate);
  } catch (err) {
    // Best-effort: live promotion events already projected the candidate rows;
    // the train/held-out seesaw is the enhancement.
    console.warn(
      `OpenHive worker: lineage extraction failed (candidates still projected from events): ${
        (err as Error).message
      }`,
    );
  }

  const status: 'complete' | 'failed' = failed ? 'failed' : 'complete';
  const payload: FinalizePayload = {
    status,
    content_hash: contentHash,
    claim_strength: result?.claimStrength,
    env_fingerprint: opts.envFingerprint,
    stop_reason: errMessage ? 'error' : result?.stopReason ?? null,
    stop_message: errMessage ?? result?.stopMessage ?? null,
    summary: result,
    cycles: result?.cycles?.length,
    total_proposed: result?.totalProposed,
    total_admitted: result?.totalAdmitted,
    total_promoted: result?.totalPromoted,
    candidate_failures: result?.candidateFailures,
    candidates: candidates.length ? candidates : undefined,
  };
  await client.finalize(payload);

  return { status, stopReason: payload.stop_reason ?? undefined, failed };
}

/** Best-effort per-candidate score-card extraction from the runner's lineage. */
async function extractCandidates(
  runner: AutonomationRunner,
  subtree: string | undefined,
  auto: AutonomationExperimentModule,
  metric: string,
  aggregate: string,
): Promise<FinalizeCandidatePayload[]> {
  const lineage = runner.lineage;
  if (!subtree || !lineage?.bySubtree) return [];

  const entries = await lineage.bySubtree(subtree);
  return entries.map((e) => {
    const out: FinalizeCandidatePayload = {
      candidate_ref: e.candidateId,
      promoted: Boolean(e.promoted),
    };
    if (Array.isArray(e.parents) && e.parents.length) out.parent_candidate_ref = e.parents[0];
    const train = e.card ? auto.scoreFromCard(e.card, metric, aggregate) : undefined;
    const heldOut = e.gateCard ? auto.scoreFromCard(e.gateCard, metric, aggregate) : undefined;
    if (typeof train === 'number') out.score_train = train;
    if (typeof heldOut === 'number') out.score_held_out = heldOut;
    return out;
  });
}
