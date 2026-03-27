/**
 * Provider registry — maps sync strategies to their SyncProvider implementations.
 */
import type { SyncStrategy, SyncProvider } from './types.js';
import { MetadataProvider } from './metadata.js';
import { LocalProvider } from './local.js';
import { LsRemoteProvider } from './ls-remote.js';
import { MirrorProvider } from './mirror.js';
import type { Config } from '../../config.js';

export type { SyncProvider, SyncStrategy };

const providers = new Map<SyncStrategy, SyncProvider>();

// Register built-in providers (no config needed)
providers.set('metadata', new MetadataProvider());
providers.set('local', new LocalProvider());

/**
 * Initialize config-dependent providers (ls-remote, mirror).
 * Call once after config is loaded (e.g., during server startup).
 */
export function initProviders(config: Config): void {
  const dataDir = config.resourceStorage.dataDir;
  const lsRemoteTtl = config.resourceSync.lsRemoteTtl;
  const mirrorFetchTimeout = config.resourceSync.mirrorFetchTimeout;

  providers.set('ls-remote', new LsRemoteProvider(dataDir, lsRemoteTtl));
  providers.set('mirror', new MirrorProvider(dataDir, mirrorFetchTimeout));
}

/**
 * Get the SyncProvider for a given strategy.
 * Falls back to metadata provider for unregistered strategies.
 */
export function getProvider(strategy: SyncStrategy): SyncProvider {
  return providers.get(strategy) ?? providers.get('metadata')!;
}

/**
 * Register a SyncProvider for a strategy.
 * Used to add custom or future providers (e.g., bundle).
 */
export function registerProvider(strategy: SyncStrategy, provider: SyncProvider): void {
  providers.set(strategy, provider);
}

/**
 * Check if a provider is registered for a given strategy.
 */
export function hasProvider(strategy: SyncStrategy): boolean {
  return providers.has(strategy);
}
