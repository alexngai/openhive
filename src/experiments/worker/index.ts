/**
 * Experiment runner worker — the OpenHive-side process that embeds
 * autonomation's runner and reports to the hub ingest API.
 *
 * autonomation is an OPTIONAL peer dependency: the tracker imports its types
 * type-only (erased at build), and the orchestration dynamically imports the
 * runtime. The hub never loads autonomation; only `openhive experiment-worker`
 * does, and only when it runs.
 */

export { OpenHiveExperimentTracker } from './openhive-tracker.js';
export type { OpenHiveExperimentTrackerOptions } from './openhive-tracker.js';
export { HubClient } from './hub-client.js';
export type {
  HubClientOptions,
  FinalizePayload,
  FinalizeCandidatePayload,
} from './hub-client.js';
export { runExperimentWorker } from './run-experiment-worker.js';
export type {
  RunExperimentWorkerOptions,
  RunExperimentWorkerResult,
  AutonomationExperimentModule,
} from './run-experiment-worker.js';
