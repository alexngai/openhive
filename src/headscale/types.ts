/**
 * Headscale API Types
 *
 * TypeScript types matching the headscale REST API (v0.28+).
 * Auto-generated from the gRPC/protobuf definitions via gRPC-Gateway.
 */

// ============================================================================
// User (formerly Namespace)
// ============================================================================

export interface HeadscaleUser {
  id: string;
  name: string;
  createdAt: string;
  displayName?: string;
  email?: string;
  providerId?: string;
  provider?: string;
  profilePicUrl?: string;
}

export interface CreateUserRequest {
  name: string;
  displayName?: string;
  email?: string;
}

export interface ListUsersResponse {
  users: HeadscaleUser[];
}

// ============================================================================
// Node
// ============================================================================

export type RegisterMethod =
  | 'REGISTER_METHOD_UNSPECIFIED'
  | 'REGISTER_METHOD_AUTH_KEY'
  | 'REGISTER_METHOD_CLI'
  | 'REGISTER_METHOD_OIDC';

export interface HeadscaleNode {
  id: string;
  machineKey: string;
  nodeKey: string;
  discoKey: string;
  ipAddresses: string[];
  name: string;
  givenName: string;
  user: HeadscaleUser;
  lastSeen: string;
  expiry: string;
  createdAt: string;
  preAuthKey?: HeadscalePreauthKey;
  registerMethod: RegisterMethod;
  online: boolean;
  approvedRoutes: string[];
  availableRoutes: string[];
  subnetRoutes: string[];
  tags: string[];
}

export interface ListNodesResponse {
  nodes: HeadscaleNode[];
}

export interface SetTagsRequest {
  tags: string[];
}

export interface ApproveRoutesRequest {
  routes: string[];
}

// ============================================================================
// Pre-Auth Key
// ============================================================================

export interface HeadscalePreauthKey {
  user?: HeadscaleUser;
  id: string;
  key: string;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiration: string;
  createdAt: string;
  aclTags: string[];
}

export interface CreatePreauthKeyRequest {
  user: string; // user ID
  reusable?: boolean;
  ephemeral?: boolean;
  expiration?: string; // ISO timestamp
  aclTags?: string[];
}

export interface CreatePreauthKeyResponse {
  preAuthKey: HeadscalePreauthKey;
}

export interface ListPreauthKeysResponse {
  preAuthKeys: HeadscalePreauthKey[];
}

// ============================================================================
// API Key
// ============================================================================

export interface HeadscaleApiKey {
  id: string;
  prefix: string;
  expiration: string;
  createdAt: string;
  lastSeen: string;
}

export interface CreateApiKeyRequest {
  expiration?: string;
}

export interface CreateApiKeyResponse {
  apiKey: string; // full key, only returned at creation
}

export interface ListApiKeysResponse {
  apiKeys: HeadscaleApiKey[];
}

// ============================================================================
// Policy
// ============================================================================

export interface PolicyResponse {
  policy: string;
  updatedAt: string;
}

export interface SetPolicyRequest {
  policy: string;
}

// ============================================================================
// Health
// ============================================================================

export interface HealthResponse {
  databaseConnectivity: boolean;
}

// ============================================================================
// Error
// ============================================================================

export interface HeadscaleError {
  code: number;
  message: string;
  details: unknown[];
}

// ============================================================================
// Headscale Config (for generating headscale.yaml)
// ============================================================================

export interface HeadscaleConfig {
  server_url: string;
  listen_addr: string;
  metrics_listen_addr: string;
  grpc_listen_addr: string;
  grpc_allow_insecure: boolean;
  tls_cert_path?: string;
  tls_key_path?: string;
  tls_letsencrypt_hostname?: string;
  tls_letsencrypt_challenge_type?: string;
  tls_letsencrypt_listen?: string;
  noise: {
    private_key_path: string;
  };
  prefixes: {
    v4: string;
    v6: string;
    allocation: 'sequential' | 'random';
  };
  derp: {
    server: {
      enabled: boolean;
      region_id?: number;
      region_code?: string;
      region_name?: string;
      stun_listen_addr?: string;
      ipv4?: string;
      ipv6?: string;
    };
    urls: string[];
    paths: string[];
    auto_update_enabled: boolean;
    update_frequency: string;
  };
  disable_check_updates: boolean;
  ephemeral_node_inactivity_timeout: string;
  database: {
    type: 'sqlite';
    sqlite: {
      path: string;
      write_ahead_log: boolean;
    };
  };
  dns: {
    magic_dns: boolean;
    base_domain: string;
    override_local_dns: boolean;
    nameservers: {
      global: string[];
    };
  };
  policy: {
    mode: 'file' | 'database';
    path?: string;
  };
  unix_socket: string;
  unix_socket_permission: string;
  log: {
    level: string;
    format: string;
  };
  logtail: {
    enabled: boolean;
  };
}
