/**
 * Swarm Hosting Module
 *
 * Enables OpenHive to spawn and manage OpenSwarm instances.
 * Supports local sidecar processes with extensibility for
 * Docker, Fly.io, SSH, and Kubernetes providers.
 */

export { SwarmManager, SwarmHostingError, type SwarmHostingErrorCode } from './manager.js';
export { HOSTED_SWARM_SCHEMA } from './schema.js';

export type {
  // Provider interface
  HostingProvider,
  HostingProviderType,
  SwarmProvisionConfig,
  ProvisionResult,
  InstanceStatus,
  LogOptions,
  // Spawn types
  SpawnSwarmInput,
  BootstrapToken,
  // DB types
  HostedSwarm,
  HostedSwarmState,
  // Config
  SwarmHostingConfig,
} from './types.js';
