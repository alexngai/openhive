/**
 * Zod schemas for the experiments REST surface (autonomation control plane).
 *
 * Operator routes (create/list/update experiments + runs) and worker-write
 * routes (PATCH run, POST events, POST finalize). Event ingestion accepts the
 * autonomation ExperimentEvent shape (camelCase) plus a worker-assigned `seq`;
 * the ingest layer maps it to the snake_case projection columns.
 */

import { z } from 'zod';

const objectiveDirection = z.enum(['increase', 'decrease']);
const experimentStatus = z.enum(['draft', 'active', 'paused', 'archived']);
const runStatus = z.enum(['queued', 'running', 'complete', 'failed', 'cancelled']);
const candidateStatus = z.enum([
  'baseline',
  'admitted',
  'keep',
  'discard',
  'crash',
  'no_candidate',
]);

// ============================================================================
// Experiments
// ============================================================================

export const CreateExperimentBodySchema = z.object({
  name: z.string().min(1),
  objective_metric: z.string().min(1),
  objective_direction: objectiveDirection,
  objective_min_delta: z.number().optional(),
  config: z.unknown().optional().default({}),
  content_hash: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  claims: z.unknown().optional(),
  repo_resource_id: z.string().nullable().optional(),
  hive_id: z.string().optional(),
  status: experimentStatus.optional(),
});
export type CreateExperimentBody = z.infer<typeof CreateExperimentBodySchema>;

export const UpdateExperimentBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  content_hash: z.string().min(1).nullable().optional(),
  objective_metric: z.string().min(1).optional(),
  objective_direction: objectiveDirection.optional(),
  objective_min_delta: z.number().optional(),
  claims: z.unknown().optional(),
  config: z.unknown().optional(),
  repo_resource_id: z.string().nullable().optional(),
  status: experimentStatus.optional(),
});
export type UpdateExperimentBody = z.infer<typeof UpdateExperimentBodySchema>;

export const ListExperimentsQuerySchema = z.object({
  hive_id: z.string().optional(),
  status: experimentStatus.optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 100 : Math.min(Math.max(Number(v) || 100, 1), 500))),
  offset: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 0 : Math.max(Number(v) || 0, 0))),
});
export type ListExperimentsQuery = z.infer<typeof ListExperimentsQuerySchema>;

// ============================================================================
// Runs
// ============================================================================

export const CreateRunBodySchema = z
  .object({
    autonomation_run_id: z.string().optional(),
    hosted_swarm_id: z.string().optional(),
    content_hash: z.string().min(1).optional(),
    env_fingerprint: z.unknown().optional(),
    repo_root: z.string().optional(),
    experiment_branch: z.string().optional(),
    experiment_worktree: z.string().optional(),
    start_point: z.string().optional(),
  })
  .default({});
export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;

/** Worker PATCH: tracker.start/finish metadata + status transitions. */
export const UpdateRunBodySchema = z.object({
  status: runStatus.optional(),
  autonomation_run_id: z.string().optional(),
  hosted_swarm_id: z.string().optional(),
  content_hash: z.string().min(1).nullable().optional(),
  env_fingerprint: z.unknown().optional(),
  repo_root: z.string().optional(),
  experiment_branch: z.string().optional(),
  experiment_worktree: z.string().optional(),
  start_point: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  stop_message: z.string().nullable().optional(),
  cycles: z.number().int().optional(),
  total_proposed: z.number().int().optional(),
  total_admitted: z.number().int().optional(),
  total_promoted: z.number().int().optional(),
  candidate_failures: z.number().int().optional(),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
});
export type UpdateRunBody = z.infer<typeof UpdateRunBodySchema>;

// ============================================================================
// Events (the autonomation ExperimentEvent firehose + a worker-assigned seq)
// ============================================================================

export const IngestEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    type: z.string().min(1),
    timestamp: z.string().optional(),
    cycleIndex: z.number().int().optional(),
    candidateId: z.string().optional(),
    proposer: z.string().optional(),
    metric: z.string().optional(),
    score: z.number().optional(),
    message: z.string().optional(),
    baseCommit: z.string().optional(),
    headCommit: z.string().optional(),
    changedPaths: z.array(z.string()).optional(),
    reason: z.string().optional(),
  })
  .passthrough(); // retain the rest of the raw event as the stored payload
export type IngestEvent = z.infer<typeof IngestEventSchema>;

export const AppendEventsBodySchema = z.object({
  events: z.array(IngestEventSchema).min(1).max(500),
});
export type AppendEventsBody = z.infer<typeof AppendEventsBodySchema>;

export const EventsTailQuerySchema = z.object({
  after_seq: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : Math.max(Number(v) || 0, 0))),
  limit: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 500 : Math.min(Math.max(Number(v) || 500, 1), 2000))),
});
export type EventsTailQuery = z.infer<typeof EventsTailQuerySchema>;

// ============================================================================
// Finalization (worker reads runWithControls() result + runner.lineage)
// ============================================================================

export const FinalizeCandidateSchema = z.object({
  candidate_ref: z.string().min(1),
  parent_candidate_ref: z.string().optional(),
  status: candidateStatus.optional(),
  cycle_index: z.number().int().optional(),
  proposer: z.string().optional(),
  base_commit: z.string().optional(),
  head_commit: z.string().optional(),
  changed_paths: z.array(z.string()).optional(),
  overlay: z.unknown().optional(),
  content_hash: z.string().optional(),
  score_train: z.number().optional(),
  score_held_out: z.number().optional(),
  scores: z.record(z.number()).optional(),
  promoted: z.boolean().optional(),
  rationale: z.string().optional(),
  failure_reason: z.string().optional(),
});
export type FinalizeCandidate = z.infer<typeof FinalizeCandidateSchema>;

export const FinalizeRunBodySchema = z.object({
  status: z.enum(['complete', 'failed']).optional().default('complete'),
  content_hash: z.string().min(1).nullable().optional(),
  claim_strength: z.unknown().optional(),
  env_fingerprint: z.unknown().optional(),
  stop_reason: z.string().nullable().optional(),
  stop_message: z.string().nullable().optional(),
  summary: z.unknown().optional(),
  cycles: z.number().int().optional(),
  total_proposed: z.number().int().optional(),
  total_admitted: z.number().int().optional(),
  total_promoted: z.number().int().optional(),
  candidate_failures: z.number().int().optional(),
  candidates: z.array(FinalizeCandidateSchema).optional(),
});
export type FinalizeRunBody = z.infer<typeof FinalizeRunBodySchema>;
