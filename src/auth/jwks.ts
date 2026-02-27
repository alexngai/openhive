import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyResult } from 'jose';

export interface SwarmHubJwtPayload extends JWTPayload {
  sub: string;
  email?: string;
  name?: string;
  avatar_url?: string;
}

export interface JwksConfig {
  jwksUrl: string;
  issuer?: string;
  audience?: string;
}

let jwksGetter: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksConfig: JwksConfig | null = null;

/**
 * Initialize the JWKS fetcher. Call once at server startup.
 * jose handles caching, rotation, and automatic re-fetch on unknown key IDs.
 */
export function initJwks(config: JwksConfig): void {
  const jwksUrl = new URL(config.jwksUrl);
  jwksGetter = createRemoteJWKSet(jwksUrl, {
    cooldownDuration: 30_000,
    cacheMaxAge: 3_600_000,
  });
  jwksConfig = config;
  console.log(`[openhive] JWKS initialized from ${config.jwksUrl}`);
}

/**
 * Validate a SwarmHub JWT token.
 * Returns the decoded payload on success, null on failure.
 */
export async function validateSwarmHubToken(
  token: string
): Promise<SwarmHubJwtPayload | null> {
  if (!jwksGetter || !jwksConfig) {
    return null;
  }

  try {
    const result: JWTVerifyResult = await jwtVerify(token, jwksGetter, {
      ...(jwksConfig.issuer && { issuer: jwksConfig.issuer }),
      ...(jwksConfig.audience && { audience: jwksConfig.audience }),
    });
    return result.payload as SwarmHubJwtPayload;
  } catch {
    return null;
  }
}

export function isJwksInitialized(): boolean {
  return jwksGetter !== null;
}
