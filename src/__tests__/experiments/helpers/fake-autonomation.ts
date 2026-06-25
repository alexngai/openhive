/**
 * Shared fakes for the autonomation worker surface — extracted verbatim from
 * `worker.test.ts` so both the worker unit tests and the flow e2e test exercise
 * the same deployment-path / inline-config fakes.
 *
 * `fakeAutonomation()` — the deployment-path fake module: drives live events
 * through the injected observer during `runWithControls`, exposes a lineage, and
 * returns a result with a `plan.lock.contentHash` + a `claimStrength`.
 *
 * `fakeAutonomationConfig()` — the inline (lightweight) config-path fake: builds a
 * runner from an inline config object, drives the injected observers, and returns
 * NO `deploymentRun` (→ content_hash null, no lineage subtree).
 */

import type {
  AutonomationExperimentModule,
  AutonomationExperimentConfigModule,
} from '../../../experiments/worker/run-experiment-worker.js';

// A faked autonomation/experiment module — drives the observer with live events
// during runWithControls, exposes a lineage, and returns a result with a lock.
export function fakeAutonomation(
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
export function fakeAutonomationConfig(): AutonomationExperimentConfigModule {
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
