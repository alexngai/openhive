/**
 * MAP trust-model resolution (3c migration guard).
 *
 * `mapHub.trustModel` is OPTIONAL in config so the server can tell an explicit
 * operator choice apart from "unset". When unset:
 *   - a NEW hub (no agents yet) defaults to `verified` — agents must present a
 *     signed agent-iam token to join the mesh (secure default);
 *   - an EXISTING hub (already has agents) is grandfathered to `open`, because
 *     flipping it to verified would reject already-connected agents that have
 *     no token. The operator is warned and told how to migrate.
 *
 * An explicit value in config always wins.
 */
export type TrustModel = 'open' | 'verified';

export function resolveMapTrustModel(
  configured: TrustModel | undefined,
  existingAgents: number,
): { trustModel: TrustModel; migrated: boolean } {
  if (configured !== undefined) {
    return { trustModel: configured, migrated: false };
  }
  if (existingAgents > 0) {
    // Grandfather an existing hub so its tokenless agents keep connecting.
    return { trustModel: 'open', migrated: true };
  }
  return { trustModel: 'verified', migrated: false };
}
