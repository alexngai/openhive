/**
 * Cascade close-policy resolver.
 *
 * Pure function, no I/O. Resolves which action (if any) the hub should take
 * when a cascade stream merges against an opentasks task. The hub is a
 * relay/join layer by default — this resolver ensures automation only
 * activates when something explicitly opted in at one of three scopes:
 *
 *   per-task   — `task.metadata.close_policy` on the syncable_resources row
 *   per-swarm  — `capabilities.cascade.autoCloseOnMerge` declared at MAP register
 *   per-hub    — `config.cascade.defaultClosePolicy` in openhive.config
 *
 * Most-specific scope wins. Default at every scope is `'manual'` — no action.
 */

export type ClosePolicy = 'manual' | 'on_merge';

export interface PolicyInputs {
  /** Task resource metadata blob (from syncable_resources.metadata). */
  taskMetadata?: Record<string, unknown> | null;
  /** Aggregate capabilities for the owning swarm (from connection registry). */
  swarmCapabilities?: Record<string, unknown> | null;
  /** Hub-wide default (from config.cascade.defaultClosePolicy). */
  hubConfig: { defaultClosePolicy: ClosePolicy };
}

/**
 * Resolve the effective close policy for a merge-bound task.
 *
 * Precedence (most-specific first):
 *   1. `taskMetadata.close_policy` if set to a valid ClosePolicy
 *   2. `swarmCapabilities.cascade.autoCloseOnMerge` (explicit true|false)
 *   3. `hubConfig.defaultClosePolicy`
 *
 * Invalid values at any scope fall through to the next. Never throws.
 */
export function resolveClosePolicy(inputs: PolicyInputs): ClosePolicy {
  const taskScope = extractTaskPolicy(inputs.taskMetadata);
  if (taskScope !== undefined) return taskScope;

  const swarmScope = extractSwarmPolicy(inputs.swarmCapabilities);
  if (swarmScope !== undefined) return swarmScope;

  return inputs.hubConfig.defaultClosePolicy;
}

function extractTaskPolicy(
  metadata: Record<string, unknown> | null | undefined,
): ClosePolicy | undefined {
  if (!metadata) return undefined;
  const raw = metadata.close_policy;
  if (raw === 'manual' || raw === 'on_merge') return raw;
  return undefined;
}

function extractSwarmPolicy(
  capabilities: Record<string, unknown> | null | undefined,
): ClosePolicy | undefined {
  if (!capabilities) return undefined;
  const cascade = capabilities.cascade;
  if (!cascade || typeof cascade !== 'object') return undefined;
  const flag = (cascade as Record<string, unknown>).autoCloseOnMerge;
  if (flag === true) return 'on_merge';
  if (flag === false) return 'manual';
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review policy (QC station Q2 — docs/design/cascade-review-verdicts.md §4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `none`     — verdicts recordable/surfaced, nothing gated (fleet default).
 * `advisory` — verdicts surface on UI affordances, nothing withheld.
 * `required` — hub-initiated landing actions need a current-head HUMAN
 *              `approved` verdict ([D3]). Agent verdicts never satisfy it.
 */
export type ReviewPolicy = 'none' | 'advisory' | 'required';

export interface ReviewPolicyInputs {
  /** Task resource metadata blob (from syncable_resources.metadata). */
  taskMetadata?: Record<string, unknown> | null;
  /** Aggregate capabilities for the owning swarm (from connection registry). */
  swarmCapabilities?: Record<string, unknown> | null;
  /** Hub-wide default (from config.cascade.defaultReviewPolicy). */
  hubConfig: { defaultReviewPolicy: ReviewPolicy };
}

const REVIEW_POLICY_VALUES: readonly ReviewPolicy[] = ['none', 'advisory', 'required'];

function isReviewPolicy(raw: unknown): raw is ReviewPolicy {
  return REVIEW_POLICY_VALUES.includes(raw as ReviewPolicy);
}

/**
 * Resolve the effective review policy for a cascade stream. Same three-scope
 * chain as `resolveClosePolicy`, most-specific first:
 *
 *   1. `taskMetadata.review_policy`
 *   2. `swarmCapabilities.cascade.reviewPolicy`
 *   3. `hubConfig.defaultReviewPolicy`
 *
 * Invalid values at any scope fall through to the next. Never throws.
 */
export function resolveReviewPolicy(inputs: ReviewPolicyInputs): ReviewPolicy {
  const taskRaw = inputs.taskMetadata?.review_policy;
  if (isReviewPolicy(taskRaw)) return taskRaw;

  const cascade = inputs.swarmCapabilities?.cascade;
  if (cascade && typeof cascade === 'object') {
    const swarmRaw = (cascade as Record<string, unknown>).reviewPolicy;
    if (isReviewPolicy(swarmRaw)) return swarmRaw;
  }

  return inputs.hubConfig.defaultReviewPolicy;
}
