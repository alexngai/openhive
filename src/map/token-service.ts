/**
 * agent-iam TokenService singleton for the MAP hub.
 *
 * The hub is the sole token authority in verified mode — it generates and
 * verifies all agent-iam capability tokens. The HMAC signing secret is loaded
 * from config, env var, or auto-generated and persisted to the data directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TokenService, generateSecret, scopeMatches } from 'agent-iam';
import type { AgentToken, VerificationResult } from 'agent-iam';

/** Optional DB persistence callbacks. Set via setPersistence(). */
let persistRevoke: ((agentId: string, reason?: string) => void) | null = null;
let persistUnrevoke: ((agentId: string) => void) | null = null;

/**
 * Optional hook fired after `revokeToken` to force-disconnect any
 * in-flight MAP WS sessions authenticated by the revoked token. Wired
 * to `ws-map.disconnectSessionsForAgent` during server startup. Kept
 * behind a setter to avoid a `token-service ↔ ws-map` import cycle.
 */
let onRevokeSessionCleanup: ((agentId: string) => void) | null = null;

export function setSessionCleanupHook(
  hook: ((agentId: string) => void) | null,
): void {
  onRevokeSessionCleanup = hook;
}

let tokenService: TokenService | null = null;

/** In-memory set of revoked token IDs (agentId). */
const revokedTokens: Set<string> = new Set();

/**
 * child agentId → immediate parent agentId. Populated by
 * `delegate-for-spawn.ts` on every successful delegation so
 * `verifyToken` can walk ancestors and enforce cascade revocation.
 *
 * Lost on process restart — persistent cascade lookups would require
 * a DB edge table. For v4 (short-lived delegated tokens, revocation
 * is a recovery action) the in-memory registry is sufficient: any
 * ancestors revoked before restart are in the persisted `revokedTokens`
 * set, and children minted pre-restart will expire within their TTL.
 */
const parentChain: Map<string, string> = new Map();

/**
 * Record a child→parent edge for cascade revocation. Called from
 * `delegate-for-spawn.ts` after a successful `ts.delegate` (or after
 * the operator-bootstrap `createRootToken` when a logical parent agent
 * exists). Cycles are guarded at read time in `isAncestorRevoked`.
 */
export function recordParent(childAgentId: string, parentAgentId: string): void {
  if (childAgentId === parentAgentId) return; // defensive: no self-parent
  parentChain.set(childAgentId, parentAgentId);
}

/** @internal For tests only. */
export function _resetParentChain(): void {
  parentChain.clear();
}

/**
 * Walk up the parent chain from `agentId` and return true if any
 * ancestor is revoked. Stops at the first unknown parent (root) or
 * when a cycle is detected.
 */
function isAncestorRevoked(agentId: string): boolean {
  let current = parentChain.get(agentId);
  const seen = new Set<string>([agentId]);
  while (current) {
    if (seen.has(current)) return false; // cycle guard
    seen.add(current);
    if (revokedTokens.has(current)) return true;
    current = parentChain.get(current);
  }
  return false;
}

/**
 * Load persisted revocations from the database into the in-memory set.
 * Called after DB initialization to restore revocation state across restarts.
 */
export function loadRevocations(agentIds: string[]): void {
  for (const id of agentIds) {
    revokedTokens.add(id);
  }
}

/**
 * Initialize the token service. Called once during server startup.
 *
 * @param secret  Explicit secret from config/env. If undefined, auto-generates
 *                and persists to `<dataDir>/data/iam-secret.key`.
 * @param dataDir The OpenHive data directory for secret persistence.
 */
export function initTokenService(secret?: string, dataDir?: string): TokenService {
  if (tokenService) return tokenService;

  let resolvedSecret: Buffer;

  if (secret) {
    // Config/env secret is hex-encoded
    resolvedSecret = Buffer.from(secret, 'hex');
  } else {
    // Try to load persisted secret
    const secretPath = dataDir ? path.join(dataDir, 'data', 'iam-secret.key') : '';

    if (secretPath && fs.existsSync(secretPath)) {
      resolvedSecret = Buffer.from(fs.readFileSync(secretPath, 'utf-8').trim(), 'hex');
    } else {
      // Generate a new secret
      resolvedSecret = generateSecret();

      // Persist as hex
      if (secretPath) {
        const dir = path.dirname(secretPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(secretPath, resolvedSecret.toString('hex'), { mode: 0o600 });
        console.log(`[openhive] Generated IAM signing secret at ${secretPath}`);
      }
    }
  }

  tokenService = new TokenService(resolvedSecret);
  return tokenService;
}

/** @internal Reset singleton for testing. */
export function _resetTokenService(): void {
  tokenService = null;
  revokedTokens.clear();
  parentChain.clear();
  persistRevoke = null;
  persistUnrevoke = null;
  onRevokeSessionCleanup = null;
}

/**
 * Get the initialized token service. Throws if not initialized.
 */
export function getTokenService(): TokenService {
  if (!tokenService) {
    throw new Error('TokenService not initialized. Call initTokenService() first.');
  }
  return tokenService;
}

/**
 * Create a root token for a swarm.
 */
export function createSwarmToken(swarmId: string, opts?: {
  scopes?: string[];
  ttlDays?: number;
}): { token: AgentToken; serialized: string } {
  const ts = getTokenService();
  const token = ts.createRootToken({
    agentId: swarmId,
    scopes: opts?.scopes ?? ['map:*'],
    ttlDays: opts?.ttlDays ?? 30,
    delegatable: true,
    maxDelegationDepth: 3,
  });
  return { token, serialized: ts.serialize(token) };
}

/**
 * Verify and deserialize a token string.
 */
export function verifyToken(serialized: string): {
  valid: boolean;
  token?: AgentToken;
  error?: string;
} {
  const ts = getTokenService();
  try {
    const token = ts.deserialize(serialized);
    const result: VerificationResult = ts.verify(token);
    if (!result.valid) {
      return { valid: false, error: result.error ?? 'Token verification failed' };
    }
    // Check direct revocation + cascade via parent chain. Revoking an
    // ancestor's agentId (via admin delete-agent, for example)
    // invalidates every token delegated through it — the RFC §"Parent
    // revocation cascade" contract.
    if (revokedTokens.has(token.agentId) || isAncestorRevoked(token.agentId)) {
      return { valid: false, error: 'Token has been revoked' };
    }
    return { valid: true, token };
  } catch (err) {
    return { valid: false, error: (err as Error).message };
  }
}

/**
 * Revoke a token by agent/swarm ID. All tokens for this identity are rejected.
 * Persists to the database if available.
 */
export function revokeToken(agentId: string, reason?: string): void {
  revokedTokens.add(agentId);
  if (persistRevoke) {
    try { persistRevoke(agentId, reason); } catch { /* DB may be unavailable */ }
  }
  // Kick any live MAP WS sessions authenticated by this token. Without
  // this, `sessionScopes` cached at connect time lets a revoked session
  // keep dispatching MAP methods until its natural expiry.
  if (onRevokeSessionCleanup) {
    try { onRevokeSessionCleanup(agentId); } catch { /* best-effort */ }
  }
}

/**
 * Check if a token is revoked.
 */
export function isTokenRevoked(agentId: string): boolean {
  return revokedTokens.has(agentId);
}

/**
 * Remove a revocation (e.g., after re-issuing).
 * Removes from both in-memory set and database.
 */
export function unrevokeToken(agentId: string): void {
  revokedTokens.delete(agentId);
  if (persistUnrevoke) {
    try { persistUnrevoke(agentId); } catch { /* DB may be unavailable */ }
  }
}

/**
 * Set DB persistence callbacks for revocation.
 * Called by the server during startup to wire up the DAL.
 */
export function setPersistence(callbacks: {
  revoke: (agentId: string, reason?: string) => void;
  unrevoke: (agentId: string) => void;
}): void {
  persistRevoke = callbacks.revoke;
  persistUnrevoke = callbacks.unrevoke;
}

/**
 * Delegate a narrower token from a parent token.
 */
export function delegateToken(parentSerialized: string, request: {
  agentId: string;
  scopes?: string[];
  ttlMinutes?: number;
}): { token: AgentToken; serialized: string } {
  const ts = getTokenService();
  const parentToken = ts.deserialize(parentSerialized);
  const childToken = ts.delegate(parentToken, {
    agentId: request.agentId,
    requestedScopes: request.scopes ?? [],
    ttlMinutes: request.ttlMinutes ?? 60,
  });
  return { token: childToken, serialized: ts.serialize(childToken) };
}

/**
 * Verify a serialized token AND check it carries a given scope.
 *
 * Returns `{ ok: true, token }` when the token is valid (signature, expiry,
 * not revoked) AND at least one of its scopes matches `requiredScope` via
 * agent-iam's `scopeMatches` (supports wildcards like `map:*`). Otherwise
 * returns `{ ok: false, error }`.
 *
 * Under v4 (see docs/RFC_AGENT_CAPABILITIES.md), this is the only token
 * verification primitive — the grant_version embedded-scope mechanism and
 * `createAgentToken` exchange endpoint were retired in favor of session
 * scopes resolved at `map/connect` time.
 */
export function tokenHasScope(
  serialized: string,
  requiredScope: string,
): { ok: true; token: AgentToken } | { ok: false; error: string } {
  const result = verifyToken(serialized);
  if (!result.valid || !result.token) {
    return { ok: false, error: result.error ?? 'Token verification failed' };
  }

  const scopeOk = result.token.scopes.some((tokenScope) =>
    scopeMatches(tokenScope, requiredScope),
  );
  if (!scopeOk) {
    return { ok: false, error: `Token does not grant scope ${requiredScope}` };
  }

  return { ok: true, token: result.token };
}

/**
 * True if the token service has been initialized. Call sites that want to
 * support pre-init paths (tests, early server lifecycle) should branch on
 * this instead of try/catching `getTokenService`.
 */
export function isTokenServiceInitialized(): boolean {
  return tokenService !== null;
}
