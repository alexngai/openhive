/**
 * Per-swarm `workspace_policy` enforcement — the runtime gate that the
 * `OpenHiveRepoHandler` (explicit declares) and the trajectory bootstrap
 * (implicit declares from checkpoint metadata) both consult before
 * persisting a workspace binding.
 *
 * Three modes (see `WorkspacePolicy` in `src/swarm/types.ts`):
 *   - `open`         → no-op; all declares accepted.
 *   - `allow_listed` → declare URL must canonicalize to one of `allowed_repos`.
 *   - `pinned`       → declare URL must canonicalize to `pinned_repo`. Auto-bind
 *                       on swarm-register is not yet implemented; this gate
 *                       currently behaves like a single-entry allow_list.
 *
 * Backwards compat: `policy === null` (legacy swarm row, or operator who didn't
 * pass `workspace_policy` at spawn) is treated as `open`.
 *
 * Throws `PolicyViolationError('swarm', …)` on the first mismatch so callers
 * can short-circuit before any upsert lands.
 */

import { canonicalizeRepoUrl, PolicyViolationError } from 'agent-workspace/kinds/repo';
import type { WorkspacePolicy } from '../types.js';

/**
 * Operator-facing audit breadcrumb for off-policy declares. Every gate
 * rejection becomes a hub-side console.warn so a misconfigured swarm
 * surfaces in logs even though the JSON-RPC error returns to the agent
 * (and the trajectory path silently swallows). Callers should not
 * duplicate this log; if they re-catch the error they may add their own
 * context but the throw itself is already logged here.
 */
function logPolicyRejection(
  policy: WorkspacePolicy,
  attemptedUrl: string,
  detail: string,
): void {
  const ctx = {
    mode: policy.mode,
    attempted: attemptedUrl,
    pinned_repo: policy.pinned_repo,
    allowed_count: policy.allowed_repos?.length,
    detail,
  };
  console.warn('[workspace-policy] rejected off-policy declare', JSON.stringify(ctx));
}

/**
 * Validate a batch of declare URLs (already canonicalized) against a swarm's
 * `workspace_policy`. Pre-canonicalize the policy's own URLs once so a `.git`
 * suffix mismatch in `allowed_repos` doesn't cause spurious rejections — both
 * forms canonicalize to the same string.
 *
 * Use the helper in `enforceSwarmWorkspacePolicyForUrls` for callers that have
 * raw URLs and want a one-shot check.
 */
export function enforceSwarmWorkspacePolicy(
  policy: WorkspacePolicy | null,
  declareCanonicalUrls: string[],
): void {
  if (!policy || policy.mode === 'open') return;

  let allowedRaw: string[];
  if (policy.mode === 'pinned') {
    if (!policy.pinned_repo) {
      // Defense in depth: SpawnSwarmSchema rejects this shape, but a corrupt
      // row written out-of-band shouldn't fail open. Audit-log the
      // corruption so an operator investigating "every declare from this
      // swarm is failing" finds the root cause in the hub log.
      const detail =
        `swarm policy is mode='pinned' but pinned_repo is unset; reject all declares`;
      logPolicyRejection(policy, declareCanonicalUrls[0] ?? '<batch>', detail);
      throw new PolicyViolationError('swarm', detail);
    }
    allowedRaw = [policy.pinned_repo];
  } else {
    // mode === 'allow_listed'
    allowedRaw = policy.allowed_repos ?? [];
  }

  const allowed = new Set<string>();
  for (const raw of allowedRaw) {
    try {
      allowed.add(canonicalizeRepoUrl(raw).canonicalUrl);
    } catch {
      // A policy URL that fails to canonicalize is dropped from the allow
      // set. The Zod validator should reject these at policy-write time;
      // surfacing here would mask the real declare-side error. Falls
      // through to the per-URL loop below — if every policy URL is bad,
      // every declare gets a deterministic rejection.
    }
  }

  for (const url of declareCanonicalUrls) {
    if (!allowed.has(url)) {
      const detail = policy.mode === 'pinned'
        ? `swarm is pinned to ${policy.pinned_repo}; cannot declare ${url}`
        : `${url} is not in the swarm's allow_listed repos`;
      logPolicyRejection(policy, url, detail);
      throw new PolicyViolationError('swarm', detail);
    }
  }
}

/**
 * Convenience: canonicalize raw declare URLs and run the gate. Most callers
 * (trajectory bootstrap, single-URL declares) want this shape.
 */
export function enforceSwarmWorkspacePolicyForUrls(
  policy: WorkspacePolicy | null,
  declareUrls: string[],
): void {
  if (!policy || policy.mode === 'open') return;
  const canonical = declareUrls.map((u) => canonicalizeRepoUrl(u).canonicalUrl);
  enforceSwarmWorkspacePolicy(policy, canonical);
}
