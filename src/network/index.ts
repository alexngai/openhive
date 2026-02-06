/**
 * Network Module
 *
 * Provides mesh networking for MAP swarm hosts via a pluggable
 * provider interface. Supports:
 *   - Tailscale Cloud (SaaS, simplest)
 *   - Headscale sidecar (self-hosted, managed binary)
 *   - Headscale external (BYO headscale instance)
 *   - None (L7-only discovery, no mesh)
 */

export type {
  NetworkProvider,
  NetworkProviderType,
  CreateAuthKeyOptions,
  AuthKeyResult,
  DeviceInfo,
  ConnectivityResult,
} from './types.js';

export { NoopNetworkProvider } from './types.js';

export {
  TailscaleCloudProvider,
  type TailscaleProviderOptions,
} from './tailscale-provider.js';

export {
  TailscaleClient,
  TailscaleClientError,
  type TailscaleClientOptions,
  type TailscaleAuthKey,
  type TailscaleDevice,
} from './tailscale-client.js';

export {
  HeadscaleSidecarProvider,
  HeadscaleExternalProvider,
  type HeadscaleSidecarProviderOptions,
  type HeadscaleExternalProviderOptions,
} from './headscale-provider.js';

export { createNetworkProvider } from './factory.js';
