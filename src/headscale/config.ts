/**
 * Headscale Config Generator
 *
 * Generates a headscale.yaml configuration file for the managed sidecar.
 * Maps OpenHive settings to headscale configuration values.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { HeadscaleConfig } from './types.js';

export interface HeadscaleSidecarOptions {
  /** Base directory for headscale data (db, keys, socket) */
  dataDir: string;
  /** URL that tailscale clients connect to (must be reachable by all swarm hosts) */
  serverUrl: string;
  /** HTTP listen address for headscale (REST API + client protocol) */
  listenAddr?: string;
  /** gRPC listen address */
  grpcListenAddr?: string;
  /** Metrics listen address */
  metricsListenAddr?: string;
  /** MagicDNS base domain */
  baseDomain?: string;
  /** IPv4 prefix for Tailscale IPs */
  ipv4Prefix?: string;
  /** IPv6 prefix for Tailscale IPs */
  ipv6Prefix?: string;
  /** DERP server URLs (default: Tailscale's public DERP) */
  derpUrls?: string[];
  /** Enable embedded DERP relay server */
  embeddedDerp?: boolean;
  /** Public IPv4 for embedded DERP (required behind NAT so clients can reach the relay) */
  derpPublicIp?: string;
  /** Public IPv6 for embedded DERP */
  derpPublicIp6?: string;
  /** TLS configuration */
  tls?: {
    mode: 'none' | 'letsencrypt' | 'manual' | 'reverse-proxy';
    letsencryptHostname?: string;
    certPath?: string;
    keyPath?: string;
  };
  /** Log level */
  logLevel?: string;
}

/**
 * Generate a headscale.yaml config suitable for sidecar operation.
 */
export function generateHeadscaleConfig(opts: HeadscaleSidecarOptions): HeadscaleConfig {
  const dataDir = path.resolve(opts.dataDir);

  // TLS configuration
  const tlsMode = opts.tls?.mode || 'none';
  const tlsFields: Pick<HeadscaleConfig, 'tls_cert_path' | 'tls_key_path' | 'tls_letsencrypt_hostname' | 'tls_letsencrypt_challenge_type' | 'tls_letsencrypt_listen'> = {};
  if (tlsMode === 'letsencrypt' && opts.tls?.letsencryptHostname) {
    tlsFields.tls_letsencrypt_hostname = opts.tls.letsencryptHostname;
    tlsFields.tls_letsencrypt_challenge_type = 'HTTP-01';
    tlsFields.tls_letsencrypt_listen = ':http';
  } else if (tlsMode === 'manual' && opts.tls?.certPath && opts.tls?.keyPath) {
    tlsFields.tls_cert_path = opts.tls.certPath;
    tlsFields.tls_key_path = opts.tls.keyPath;
  }
  // 'reverse-proxy' and 'none' — headscale listens on plain HTTP, proxy handles TLS

  // Embedded DERP server config
  const derpServer: HeadscaleConfig['derp']['server'] = {
    enabled: opts.embeddedDerp || false,
    region_id: 999,
    region_code: 'openhive',
    region_name: 'OpenHive Embedded DERP',
    stun_listen_addr: '0.0.0.0:3478',
    ipv4: opts.derpPublicIp,
    ipv6: opts.derpPublicIp6,
  };

  return {
    server_url: opts.serverUrl,
    listen_addr: opts.listenAddr || '127.0.0.1:8085',
    metrics_listen_addr: opts.metricsListenAddr || '127.0.0.1:9095',
    grpc_listen_addr: opts.grpcListenAddr || '127.0.0.1:50443',
    grpc_allow_insecure: tlsMode === 'none' || tlsMode === 'reverse-proxy',
    ...tlsFields,

    noise: {
      private_key_path: path.join(dataDir, 'noise_private.key'),
    },

    prefixes: {
      v4: opts.ipv4Prefix || '100.64.0.0/10',
      v6: opts.ipv6Prefix || 'fd7a:115c:a1e0::/48',
      allocation: 'sequential',
    },

    derp: {
      server: derpServer,
      urls: opts.derpUrls || ['https://controlplane.tailscale.com/derpmap/default'],
      paths: [],
      auto_update_enabled: true,
      update_frequency: '3h',
    },

    disable_check_updates: true,
    ephemeral_node_inactivity_timeout: '30m',

    database: {
      type: 'sqlite',
      sqlite: {
        path: path.join(dataDir, 'headscale.db'),
        write_ahead_log: true,
      },
    },

    dns: {
      magic_dns: true,
      base_domain: opts.baseDomain || 'hive.internal',
      override_local_dns: false,
      nameservers: {
        global: ['1.1.1.1', '1.0.0.1'],
      },
    },

    policy: {
      mode: 'database', // Managed via API
    },

    unix_socket: path.join(dataDir, 'headscale.sock'),
    unix_socket_permission: '0770',

    log: {
      level: opts.logLevel || 'info',
      format: 'json',
    },

    logtail: {
      enabled: false,
    },
  };
}

/**
 * Write a headscale.yaml config file to disk.
 */
export function writeHeadscaleConfig(config: HeadscaleConfig, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Simple YAML serializer (avoids adding a yaml dependency)
  const yaml = toYaml(config);
  fs.writeFileSync(filePath, yaml, 'utf-8');
}

/**
 * Minimal YAML serializer for headscale config.
 * Handles nested objects, arrays, strings, numbers, and booleans.
 */
function toYaml(obj: unknown, indent: number = 0): string {
  const prefix = '  '.repeat(indent);

  if (obj === null || obj === undefined) {
    return 'null';
  }

  if (typeof obj === 'string') {
    // Quote strings that could be misinterpreted
    if (obj === '' || obj === 'true' || obj === 'false' || obj === 'null' ||
        obj.includes(':') || obj.includes('#') || obj.includes('\n') ||
        obj.startsWith(' ') || obj.endsWith(' ')) {
      return `"${obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return obj;
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return String(obj);
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map((item) => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const inner = toYaml(item, indent + 1);
        return `${prefix}- ${inner.trimStart()}`;
      }
      return `${prefix}- ${toYaml(item, indent + 1)}`;
    }).join('\n');
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    return entries.map(([key, value]) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const inner = toYaml(value, indent + 1);
        return `${prefix}${key}:\n${inner}`;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return `${prefix}${key}: []`;
        }
        const inner = toYaml(value, indent + 1);
        return `${prefix}${key}:\n${inner}`;
      }
      return `${prefix}${key}: ${toYaml(value, indent)}`;
    }).join('\n');
  }

  return String(obj);
}
