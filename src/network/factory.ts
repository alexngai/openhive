/**
 * Network Provider Factory
 *
 * Creates the appropriate NetworkProvider based on configuration.
 */

import type { NetworkProvider } from './types.js';
import { NoopNetworkProvider } from './types.js';
import { TailscaleCloudProvider } from './tailscale-provider.js';
import { HeadscaleSidecarProvider } from './headscale-provider.js';
import { HeadscaleExternalProvider } from './headscale-provider.js';

export interface NetworkConfig {
  /** Which provider to use */
  provider: 'tailscale-cloud' | 'headscale-sidecar' | 'headscale-external' | 'none';

  /** Tailscale Cloud options (when provider = 'tailscale-cloud') */
  tailscale?: {
    /** Tailnet name or '-' for default */
    tailnet: string;
    /** API key (tskey-api-...) — use this OR OAuth credentials */
    apiKey?: string;
    /** OAuth client ID */
    oauthClientId?: string;
    /** OAuth client secret */
    oauthClientSecret?: string;
  };

  /** Headscale sidecar options (when provider = 'headscale-sidecar') */
  headscaleSidecar?: {
    /** Server URL that tailscale clients connect to (MUST be HTTPS) */
    serverUrl: string;
    /** MagicDNS base domain */
    baseDomain?: string;
    /** Data directory */
    dataDir?: string;
    /** Path to headscale binary */
    binaryPath?: string;
    /** Listen address */
    listenAddr?: string;
    /** Enable embedded DERP */
    embeddedDerp?: boolean;
    /** Public IP for DERP (auto-detected if not set) */
    derpPublicIp?: string;
    /** TLS configuration */
    tls?: {
      mode: 'none' | 'letsencrypt' | 'manual' | 'reverse-proxy';
      letsencryptHostname?: string;
      certPath?: string;
      keyPath?: string;
    };
  };

  /** Headscale external options (when provider = 'headscale-external') */
  headscaleExternal?: {
    /** URL of the headscale REST API */
    apiUrl: string;
    /** API key */
    apiKey: string;
    /** Server URL that tailscale clients connect to */
    serverUrl?: string;
    /** MagicDNS base domain */
    baseDomain?: string;
  };
}

/**
 * Create a NetworkProvider from the given config.
 */
export function createNetworkProvider(config: NetworkConfig): NetworkProvider {
  switch (config.provider) {
    case 'tailscale-cloud': {
      if (!config.tailscale) {
        throw new Error('network.tailscale config required when provider is "tailscale-cloud"');
      }
      return new TailscaleCloudProvider({
        tailnet: config.tailscale.tailnet,
        apiKey: config.tailscale.apiKey,
        oauthClientId: config.tailscale.oauthClientId,
        oauthClientSecret: config.tailscale.oauthClientSecret,
      });
    }

    case 'headscale-sidecar': {
      if (!config.headscaleSidecar) {
        throw new Error('network.headscaleSidecar config required when provider is "headscale-sidecar"');
      }
      const hs = config.headscaleSidecar;
      return new HeadscaleSidecarProvider({
        serverUrl: hs.serverUrl,
        baseDomain: hs.baseDomain,
        dataDir: hs.dataDir,
        binaryPath: hs.binaryPath,
        listenAddr: hs.listenAddr,
        embeddedDerp: hs.embeddedDerp,
        derpPublicIp: hs.derpPublicIp,
        tls: hs.tls,
      });
    }

    case 'headscale-external': {
      if (!config.headscaleExternal) {
        throw new Error('network.headscaleExternal config required when provider is "headscale-external"');
      }
      const he = config.headscaleExternal;
      return new HeadscaleExternalProvider({
        apiUrl: he.apiUrl,
        apiKey: he.apiKey,
        serverUrl: he.serverUrl,
        baseDomain: he.baseDomain,
      });
    }

    case 'none':
    default:
      return new NoopNetworkProvider();
  }
}
