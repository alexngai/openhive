/**
 * Credential Resolver for Swarm Hosting
 *
 * Resolves credential sets from config into a flat Record<string, string>
 * ready for injection into swarm processes. The resolver produces an "overlay"
 * that does NOT include process.env — env inheritance is handled separately
 * by each hosting provider via the `inherit_env` flag.
 */

import type {
  CredentialSetConfig,
  ResolvedCredentials,
  SwarmCredentialConfig,
} from './types.js';

/**
 * Resolve a single credential set into concrete key-value pairs.
 */
export function resolveCredentialSet(set: CredentialSetConfig): ResolvedCredentials {
  const result: ResolvedCredentials = {};
  const source = set.source ?? 'static';

  for (const [key, value] of Object.entries(set.vars)) {
    switch (source) {
      case 'static':
        if (value !== undefined && value !== '') {
          result[key] = value;
        }
        break;
      case 'env': {
        // value is the env var name to read from process.env
        const envVal = process.env[value];
        if (envVal !== undefined) {
          result[key] = envVal;
        }
        break;
      }
      case 'env-fallback':
        // Use static value if non-empty, otherwise fall back to same-named env var
        if (value !== undefined && value !== '') {
          result[key] = value;
        } else {
          const fallback = process.env[key];
          if (fallback !== undefined) {
            result[key] = fallback;
          }
        }
        break;
    }
  }

  return result;
}

/**
 * Resolve the credential overlay for a swarm spawn.
 *
 * Returns ONLY the explicit credentials from sets/overrides.
 * Does NOT include process.env (that's handled by the provider via inherit_env).
 *
 * Layer order (later wins):
 *   1. default_set credential set
 *   2. hive-specific override (credential_set swap + extra_vars)
 *   3. spawn-time overrides
 */
export function resolveCredentialOverlay(
  credentialConfig: SwarmCredentialConfig | undefined,
  hiveName?: string,
  spawnOverrides?: Record<string, string>,
): ResolvedCredentials {
  const config = credentialConfig ?? {};
  const result: ResolvedCredentials = {};

  // Layer 1: Default credential set
  if (config.default_set && config.sets?.[config.default_set]) {
    Object.assign(result, resolveCredentialSet(config.sets[config.default_set]));
  }

  // Layer 2: Hive-specific overrides
  if (hiveName && config.hive_overrides?.[hiveName]) {
    const hiveOverride = config.hive_overrides[hiveName];

    if (hiveOverride.credential_set && config.sets?.[hiveOverride.credential_set]) {
      Object.assign(result, resolveCredentialSet(config.sets[hiveOverride.credential_set]));
    }

    if (hiveOverride.extra_vars) {
      Object.assign(result, hiveOverride.extra_vars);
    }
  }

  // Layer 3: Spawn-time overrides
  if (spawnOverrides) {
    Object.assign(result, spawnOverrides);
  }

  return result;
}
