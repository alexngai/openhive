/**
 * Extract the peer-side addressable ID from an agent's registration metadata.
 *
 * Mirrors the server-side `getPeerMapId()` in `src/map/connection-registry.ts`
 * — see that file for the full rationale on the three-name fallback chain.
 * Kept in the web bundle so four read sites don't each re-implement it.
 */
export function getPeerMapId(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  const peerMapId = metadata.peerMapId;
  if (typeof peerMapId === 'string' && peerMapId) return peerMapId;
  const peerAgentId = metadata.peerAgentId;
  if (typeof peerAgentId === 'string' && peerAgentId) return peerAgentId;
  const localAgentId = metadata.localAgentId;
  if (typeof localAgentId === 'string' && localAgentId) return localAgentId;
  return undefined;
}
