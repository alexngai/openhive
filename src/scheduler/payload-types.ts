/**
 * OpenHive schedule payload contract.
 *
 * The library's Schedule.payload is `unknown` — OpenHive narrows here. Every
 * REST/MAP create handler validates incoming bodies against this shape via
 * the Zod schema (src/api/schemas/schedules.ts, PR 3); the fire handler
 * narrows by structural cast at fire time.
 *
 * The payload tells the fire handler what dispatches to create when the
 * schedule fires:
 *   - which spec to dispatch
 *   - which swarms to fan out to
 *   - optional lifecycle hints / loadout binding / prompt override
 */

export interface SpecRef {
  resource_id: string;
  spec_id: string;
}

export type AcpLifecycle = 'fresh' | 'reuse';
export type MailLifecycle = 'fresh' | 'reuse';

export interface ScheduleLifecycleHints {
  acp?: AcpLifecycle;
  mail?: MailLifecycle;
}

export interface OpenHiveSchedulePayload {
  spec_ref: SpecRef;
  /** Fan-out: each schedule fire creates one dispatch per target. */
  target_swarm_ids: string[];
  prompt_override?: string;
  lifecycle?: ScheduleLifecycleHints;
  loadout_ref?: string;
}

/**
 * Structural validation for fire-time use. The REST/MAP create handlers do
 * Zod validation; this is a defense-in-depth check before we expand a
 * fan-out into dispatch rows.
 */
export function isValidPayload(p: unknown): p is OpenHiveSchedulePayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (!o.spec_ref || typeof o.spec_ref !== 'object') return false;
  const spec = o.spec_ref as Record<string, unknown>;
  if (typeof spec.resource_id !== 'string' || typeof spec.spec_id !== 'string')
    return false;
  if (!Array.isArray(o.target_swarm_ids)) return false;
  if (o.target_swarm_ids.length === 0) return false;
  if (!o.target_swarm_ids.every((s) => typeof s === 'string')) return false;
  return true;
}
