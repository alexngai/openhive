/**
 * agent-iam TokenService singleton for the MAP hub.
 *
 * The hub is the sole token authority in verified mode — it generates and
 * verifies all agent-iam capability tokens. The HMAC signing secret is loaded
 * from config, env var, or auto-generated and persisted to the data directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { TokenService, generateSecret } from 'agent-iam';
import type { AgentToken, VerificationResult } from 'agent-iam';

/** Optional DB persistence callbacks. Set via setPersistence(). */
let persistRevoke: ((agentId: string, reason?: string) => void) | null = null;
let persistUnrevoke: ((agentId: string) => void) | null = null;

let tokenService: TokenService | null = null;

/** In-memory set of revoked token IDs (agentId). */
const revokedTokens: Set<string> = new Set();

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
  persistRevoke = null;
  persistUnrevoke = null;
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
    // Check revocation
    if (revokedTokens.has(token.agentId)) {
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
