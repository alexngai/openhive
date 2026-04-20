/**
 * Agent capability vocabulary and predicates.
 *
 * Capabilities are narrow, revocable grants that let an operator give an
 * agent access to specific admin-gated operations without making them
 * fully admin. See `docs/RFC_AGENT_CAPABILITIES.md` for the full design.
 *
 * Naming convention: `<surface>:<resource>:<verb>` — colon-separated to align
 * with the agent-iam scope format, so capability strings stored in the DB
 * can also flow into agent-iam tokens without conversion.
 *
 * Vocabulary is a frozen Set — the grant endpoint rejects strings outside
 * this set so typos fail fast at the admin boundary instead of silently
 * no-op'ing at the enforcement site.
 */

export const KNOWN_CAPABILITIES = new Set<string>([
  // v4: map:agents:spawn — grants the holder the ability to call
  // map/agents/spawn on the MAP WS connection, minting delegated
  // credentials for sibling agents. See docs/RFC_AGENT_CAPABILITIES.md.
  'map:agents:spawn',
]);

export type Capability = string;

export function isKnownCapability(cap: string): boolean {
  return KNOWN_CAPABILITIES.has(cap);
}

/**
 * Parse an agent's capabilities column into a plain object.
 * Default-deny on parse errors — a malformed column means no grants.
 */
export function parseCapabilities(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    // Normalize: only keep boolean-true entries. Anything else is treated
    // as "not granted" so future schema extensions (scoped grants, etc.)
    // can't accidentally enable access when parsed by an older hub.
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeCapabilities(caps: Record<string, boolean>): string | null {
  const filtered: Record<string, true> = {};
  for (const [k, v] of Object.entries(caps)) {
    if (v === true) filtered[k] = true;
  }
  return Object.keys(filtered).length === 0 ? null : JSON.stringify(filtered);
}

/** Test whether a serialized capability blob grants a specific capability. */
export function hasCapability(raw: string | null | undefined, cap: Capability): boolean {
  return parseCapabilities(raw)[cap] === true;
}
