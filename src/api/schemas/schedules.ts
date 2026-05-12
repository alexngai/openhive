/**
 * Zod schemas for the schedules REST + MAP surfaces.
 *
 * Shared between REST handlers (PR 3) and MAP handlers (PR 4) so the wire
 * shape can't drift between transports.
 */

import { z } from 'zod';
import { isValidCron } from 'swarm-dispatch';

// ============================================================================
// Payload shape (mirrors src/scheduler/payload-types.ts at the Zod layer)
// ============================================================================

export const SpecRefSchema = z.object({
  resource_id: z.string().min(1),
  spec_id: z.string().min(1),
});

export const ScheduleLifecycleHintsSchema = z.object({
  acp: z.enum(['fresh', 'reuse']).optional(),
  mail: z.enum(['fresh', 'reuse']).optional(),
});

export const FallbackSpawnSchema = z.object({
  adapter: z.enum(['openswarm', 'claude-code', 'codex']),
  cleanup_on_terminal: z.boolean().optional().default(true),
});

// ── Discriminated union: dispatch_spec | dispatch_prompt ─────────────
// `dispatch_spec` keeps `kind` optional for backward compat with
// schedules created before the discriminator existed (they never wrote
// `kind`). `dispatch_prompt` requires the literal so the union can
// distinguish.

const DispatchSpecPayloadSchema = z.object({
  kind: z.literal('dispatch_spec').optional(),
  spec_ref: SpecRefSchema,
  target_swarm_ids: z.array(z.string().min(1)).min(1),
  prompt_override: z.string().optional(),
  lifecycle: ScheduleLifecycleHintsSchema.optional(),
  loadout_ref: z.string().optional(),
  fallback_spawn: FallbackSpawnSchema.optional(),
});

const DispatchPromptPayloadSchema = z.object({
  kind: z.literal('dispatch_prompt'),
  prompt: z.string().min(1),
  target_swarm_ids: z.array(z.string().min(1)).min(1),
  lifecycle: ScheduleLifecycleHintsSchema.optional(),
  loadout_ref: z.string().optional(),
  fallback_spawn: FallbackSpawnSchema.optional(),
});

export const OpenHiveSchedulePayloadSchema = z.union([
  // Try dispatch_prompt first since it requires the literal `kind`; any
  // payload that doesn't match falls through to dispatch_spec (which
  // accepts the legacy no-`kind` shape too).
  DispatchPromptPayloadSchema,
  DispatchSpecPayloadSchema,
]);

// ============================================================================
// Policy
// ============================================================================

export const SchedulePolicySchema = z.object({
  catchUp: z.enum(['skip', 'fire-once', 'fire-all']).default('fire-once'),
  skipIfRunning: z.boolean().default(false),
});

export type SchedulePolicyInput = z.infer<typeof SchedulePolicySchema>;

// ============================================================================
// Create / update
// ============================================================================

const CronExpr = z
  .string()
  .min(1)
  .refine(isValidCron, { message: 'invalid cron expression' });

export const CreateScheduleBodySchema = z.object({
  cron: CronExpr,
  timezone: z.string().optional(),
  payload: OpenHiveSchedulePayloadSchema,
  policy: SchedulePolicySchema.partial().optional(),
  paused: z.boolean().optional().default(false),
  /**
   * Hive scoping. Optional in v1 — defaults to empty string. Tightening
   * (require + cross-hive enforcement) can land as a follow-up once the
   * dispatch primitives wire hive scoping end-to-end.
   */
  hive_id: z.string().optional().default(''),
});

export type CreateScheduleBody = z.infer<typeof CreateScheduleBodySchema>;

export const UpdateScheduleBodySchema = z.object({
  cron: CronExpr.optional(),
  timezone: z.string().nullable().optional(),
  /**
   * Full replace, no deep merge. To remove an optional field, send the
   * payload without it. (Per design doc decision: deep-merge surprises
   * are worse than verbose updates.)
   */
  payload: OpenHiveSchedulePayloadSchema.optional(),
  policy: SchedulePolicySchema.partial().optional(),
});

export type UpdateScheduleBody = z.infer<typeof UpdateScheduleBodySchema>;

// ============================================================================
// List query
// ============================================================================

export const ListSchedulesQuerySchema = z.object({
  hive_id: z.string().optional(),
  initiator_id: z.string().optional(),
  paused: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 50 : Math.min(Math.max(Number(v) || 50, 1), 200))),
  offset: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 0 : Math.max(Number(v) || 0, 0))),
});

export type ListSchedulesQuery = z.infer<typeof ListSchedulesQuerySchema>;
