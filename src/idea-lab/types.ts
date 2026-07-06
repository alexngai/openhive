/**
 * Idea-lab pack schema.
 *
 * The idea-lab is "config + prompts on existing endpoints", not new infra.
 * A *pack* is the checked-in, Zod-validated declaration of everything the
 * lab needs provisioned: the OpenTasks graph that holds ideas, the ledger
 * memory bank, the seed objectives (pinned north-stars), and the recurring
 * role schedules that drive the loop.
 *
 * The pack is the single reviewable source of truth — editing a role prompt
 * or a cadence is a clean diff against this + the `roles/*.ts` prompt files.
 * `provision.ts` applies a pack idempotently at boot (reconcile-by-key), so
 * re-install / restart converges to the same state instead of duplicating.
 */

import { z } from 'zod';

const KEY = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'key must be kebab-case (a-z, 0-9, hyphen)');

/**
 * A seed objective — a pinned "north-star" the anchored tier of the loop
 * must advance. Materialized as a spec node in the lab graph, keyed by
 * `objective:<key>` in spec metadata for idempotent reconcile.
 */
export const IdeaLabObjectiveSchema = z.object({
  key: KEY,
  title: z.string().min(1).max(200),
  /** Free-form body (the objective's framing / success criteria). */
  content: z.string().max(50_000).optional(),
  /** OpenTasks priority 0–4; higher = more important. */
  priority: z.number().int().min(0).max(4).optional(),
});

/**
 * A recurring role. Materialized as a `dispatch_prompt` schedule, keyed by
 * `role:<key>` inside the schedule payload for idempotent reconcile. The
 * `prompt` is passed verbatim to the agent at fire time.
 */
export const IdeaLabRoleSchema = z.object({
  key: KEY,
  /** Standard 5-field cron expression (validated at provision time). */
  cron: z.string().min(1),
  /** The role instruction, passed verbatim to the agent on fire. */
  prompt: z.string().min(1),
  timezone: z.string().optional(),
  /** Provision the schedule paused (operator resumes when ready). */
  paused: z.boolean().optional(),
});

export const IdeaLabPackSchema = z
  .object({
    /** Bump when the pack's managed fields change; informational. */
    version: z.number().int().min(1),
    /** The OpenTasks graph resource that holds ideas/objectives. */
    graph: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
    }),
    /** The durable ledger (tried / killed / shipped) memory bank. */
    ledger: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
    }),
    objectives: z.array(IdeaLabObjectiveSchema).default([]),
    roles: z.array(IdeaLabRoleSchema).min(1),
  })
  .superRefine((pack, ctx) => {
    const seen = (label: string, keys: string[]) => {
      const set = new Set<string>();
      for (const k of keys) {
        if (set.has(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate ${label} key: ${k}`,
            path: [label + 's'],
          });
        }
        set.add(k);
      }
    };
    seen('objective', pack.objectives.map((o) => o.key));
    seen('role', pack.roles.map((r) => r.key));
  });

export type IdeaLabObjective = z.infer<typeof IdeaLabObjectiveSchema>;
export type IdeaLabRole = z.infer<typeof IdeaLabRoleSchema>;
export type IdeaLabPack = z.infer<typeof IdeaLabPackSchema>;

/** Parse + validate an untrusted pack (throws ZodError on failure). */
export function parseIdeaLabPack(input: unknown): IdeaLabPack {
  return IdeaLabPackSchema.parse(input);
}

/** Stable reconcile keys stamped into spec metadata / schedule payloads. */
export const objectiveKey = (key: string): string => `objective:${key}`;
export const roleKey = (key: string): string => `role:${key}`;
