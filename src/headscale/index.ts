/**
 * Headscale Integration Module
 *
 * Provides headscale sidecar management for OpenHive's MAP hub.
 * Enables L3/L4 mesh networking between swarm hosts via Tailscale/WireGuard.
 */

export { HeadscaleClient, HeadscaleClientError } from './client.js';
export { HeadscaleManager, type HeadscaleManagerOptions, type HeadscaleManagerState } from './manager.js';
export { HeadscaleSync, type NetworkProvisionResult, type SwarmNetworkInfo } from './sync.js';
export {
  generateHeadscaleConfig,
  writeHeadscaleConfig,
  type HeadscaleSidecarOptions,
} from './config.js';
export type {
  HeadscaleUser,
  HeadscaleNode,
  HeadscalePreauthKey,
  HeadscaleApiKey,
  HeadscaleConfig,
  HealthResponse as HeadscaleHealthResponse,
} from './types.js';
