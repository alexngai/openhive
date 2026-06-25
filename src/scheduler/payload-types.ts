/**
 * OpenHive schedule payload contract.
 *
 * The library's `Schedule.payload` is `unknown` — OpenHive narrows here.
 * REST + MAP create handlers validate incoming bodies against this shape
 * via Zod (`src/api/schemas/schedules.ts`); the fire handler narrows by
 * structural guard at fire time.
 *
 * The payload tells the fire handler what to do when the schedule fires.
 * Discriminated union by `kind` so the schedule isn't tied to spec-based
 * dispatch:
 *
 *   - `dispatch_spec`  — the original. Look up a spec, dispatch it. The
 *                        `kind` field is OPTIONAL here for backward
 *                        compatibility with schedules created before the
 *                        discriminator existed.
 *   - `dispatch_prompt` — ad-hoc goal. No spec required. The agent gets
 *                        the prompt verbatim and decides what to do. Many
 *                        future use cases (poll-then-dispatch, review
 *                        incoming cascades, daily standup) reduce to this
 *                        pattern via agent-driven composition.
 *
 * Adding a new kind (e.g., `webhook`, `event_emit`) means adding a member
 * to this union + a branch in the fire handler. No schema migration.
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

export type FallbackSpawnAdapter = 'openswarm' | 'claude-code' | 'codex';

/**
 * Auto-spawn fallback policy. When ALL configured `target_swarm_ids` are
 * offline at fire time AND this is set, the fire handler spawns a fresh
 * hosted swarm and dispatches the fire's work to it. Per-fire ephemeral
 * by default — the spawned swarm is stopped when its dispatch reaches
 * a terminal state.
 *
 * Semantics chosen for v1 (see design discussion):
 *   - Per-fire ephemeral (not persistent or idle-timed)
 *   - Fallback-if-all-offline (NOT skip-online-partials)
 *   - Single spawn per fire (not one-per-offline-target)
 *   - Cleanup on dispatch terminal (default on; can opt out)
 */
export interface FallbackSpawn {
  adapter: FallbackSpawnAdapter;
  /** Default true — stop the spawned swarm when its dispatch terminates. */
  cleanup_on_terminal?: boolean;
}

/**
 * Spec-based dispatch (original payload shape). `kind` is optional for
 * backward compatibility — schedules predating the discriminator never
 * wrote one.
 */
export interface DispatchSpecPayload {
  kind?: 'dispatch_spec';
  spec_ref: SpecRef;
  target_swarm_ids: string[];
  prompt_override?: string;
  lifecycle?: ScheduleLifecycleHints;
  loadout_ref?: string;
  fallback_spawn?: FallbackSpawn;
}

/**
 * Ad-hoc prompt dispatch. The schedule has no spec dependency — the
 * agent gets the prompt verbatim and decides. Used for goal-driven
 * scheduled work where encoding a spec is overkill (or impossible).
 */
export interface DispatchPromptPayload {
  kind: 'dispatch_prompt';
  prompt: string;
  target_swarm_ids: string[];
  lifecycle?: ScheduleLifecycleHints;
  loadout_ref?: string;
  fallback_spawn?: FallbackSpawn;
}

/**
 * Recurring experiment run (autonomation control plane). No spec / target
 * swarms — the fire handler resolves the experiment, creates a `queued` run,
 * and launches the runner worker. See `src/experiments/`.
 */
export interface ExperimentScheduleRunControls {
  cycles?: number;
  budgetSeconds?: number;
  stopAfterNoPromotion?: number;
}

export interface ExperimentRunPayload {
  kind: 'experiment';
  experiment_ref: string; // experiments.id
  run_controls?: ExperimentScheduleRunControls;
}

export type OpenHiveSchedulePayload =
  | DispatchSpecPayload
  | DispatchPromptPayload
  | ExperimentRunPayload;

/**
 * The discriminated-union resolver. Old payloads (no `kind` field) are
 * treated as `dispatch_spec`. Use this rather than reading
 * `payload.kind` directly so backward compat is enforced consistently.
 */
export function getPayloadKind(
  payload: OpenHiveSchedulePayload,
): 'dispatch_spec' | 'dispatch_prompt' | 'experiment' {
  if ('kind' in payload && payload.kind === 'dispatch_prompt') {
    return 'dispatch_prompt';
  }
  if ('kind' in payload && payload.kind === 'experiment') {
    return 'experiment';
  }
  return 'dispatch_spec';
}

/**
 * Structural validation for fire-time use. The REST/MAP create handlers
 * do Zod validation; this is a defense-in-depth check before we expand
 * a fan-out into dispatch rows.
 */
export function isValidPayload(p: unknown): p is OpenHiveSchedulePayload {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;

  // Discriminate first — the experiment kind has no target_swarm_ids.
  const kind = typeof o.kind === 'string' ? o.kind : 'dispatch_spec';

  if (kind === 'experiment') {
    return typeof o.experiment_ref === 'string' && o.experiment_ref.length > 0;
  }

  // Dispatch kinds: target_swarm_ids array, non-empty, all strings.
  if (!Array.isArray(o.target_swarm_ids)) return false;
  if (o.target_swarm_ids.length === 0) return false;
  if (!o.target_swarm_ids.every((s) => typeof s === 'string')) return false;

  if (kind === 'dispatch_prompt') {
    return typeof o.prompt === 'string' && o.prompt.length > 0;
  }

  // dispatch_spec (default) — require spec_ref.
  if (!o.spec_ref || typeof o.spec_ref !== 'object') return false;
  const spec = o.spec_ref as Record<string, unknown>;
  if (typeof spec.resource_id !== 'string' || typeof spec.spec_id !== 'string')
    return false;
  return true;
}
