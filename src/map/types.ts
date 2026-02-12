/**
 * MAP Hub Types
 *
 * OpenHive acts as a headscale-style coordination plane for MAP (Multi-Agent Protocol)
 * swarms. These types define the hub's data model for swarm registration, agent node
 * discovery, pre-auth keys, and peer coordination.
 *
 * Analogy:
 *   Headscale (WireGuard mesh)  ->  OpenHive MAP Hub (agent mesh)
 *   Machine/Node                ->  Swarm (a MAP system)
 *   Individual WG peer          ->  Node (a MAP agent within a swarm)
 *   Namespace/User              ->  Hive (discoverability boundary)
 *   Pre-auth key                ->  Pre-auth key (automated registration)
 *   DERP map / peer list        ->  Peer list (MAP federation endpoints)
 */

// ============================================================================
// Swarm Types (analogous to headscale machines)
// ============================================================================

export type MapTransport = 'websocket' | 'http-sse' | 'ndjson';
export type MapAuthMethod = 'bearer' | 'api-key' | 'mtls' | 'none';
export type SwarmStatus = 'online' | 'offline' | 'unreachable';

export interface MapSwarm {
  id: string;
  name: string;
  description: string | null;
  // Connection info
  map_endpoint: string;
  map_transport: MapTransport;
  // Ownership
  owner_agent_id: string;
  // State
  status: SwarmStatus;
  last_seen_at: string;
  // Capabilities advertised by the MAP system
  capabilities: MapSwarmCapabilities | null;
  // Auth for federation connections to this swarm
  auth_method: MapAuthMethod;
  auth_token_hash: string | null;
  // Stats
  agent_count: number;
  scope_count: number;
  // Headscale network info (populated when host joins the tailnet)
  headscale_node_id: string | null;
  tailscale_ips: string[] | null;
  tailscale_dns_name: string | null;
  // Metadata
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface MapSwarmCapabilities {
  observation?: boolean;
  messaging?: boolean;
  lifecycle?: boolean;
  scopes?: boolean;
  federation?: boolean;
  hive_sync?: boolean;
  protocols?: string[]; // e.g. ['acp', 'a2a']
}

// ============================================================================
// Node Types (analogous to individual tailscale nodes / MAP agents)
// ============================================================================

export type MapNodeState = 'registered' | 'active' | 'busy' | 'idle' | 'suspended' | 'stopped' | 'failed';
export type MapNodeVisibility = 'public' | 'hive-only' | 'swarm-only';

export interface MapNode {
  id: string;
  swarm_id: string;
  // MAP agent identity
  map_agent_id: string;
  name: string | null;
  description: string | null;
  role: string | null;
  // State (mirrors MAP agent states)
  state: MapNodeState;
  // Discovery info
  capabilities: Record<string, unknown> | null;
  scopes: string[] | null;
  visibility: MapNodeVisibility;
  // Metadata
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Swarm-Hive Membership
// ============================================================================

export interface MapSwarmHive {
  id: string;
  swarm_id: string;
  hive_id: string;
  joined_at: string;
}

// ============================================================================
// Pre-auth Keys (analogous to headscale pre-auth keys)
// ============================================================================

export interface MapPreauthKey {
  id: string;
  key_hash: string;
  hive_id: string | null;
  uses_left: number;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

// ============================================================================
// Federation Log
// ============================================================================

export type FederationConnectionStatus = 'initiated' | 'connected' | 'failed' | 'disconnected';

export interface MapFederationLogEntry {
  id: string;
  source_swarm_id: string | null;
  target_swarm_id: string | null;
  status: FederationConnectionStatus;
  error: string | null;
  created_at: string;
}

// ============================================================================
// API Input/Response Types
// ============================================================================

export interface RegisterSwarmInput {
  name: string;
  description?: string;
  map_endpoint: string;
  map_transport?: MapTransport;
  capabilities?: MapSwarmCapabilities;
  auth_method?: MapAuthMethod;
  auth_token?: string; // Will be hashed before storage
  metadata?: Record<string, unknown>;
  // Optional pre-auth key for auto-registration + auto-join
  preauth_key?: string;
}

export interface UpdateSwarmInput {
  name?: string;
  description?: string;
  map_endpoint?: string;
  map_transport?: MapTransport;
  status?: SwarmStatus;
  capabilities?: MapSwarmCapabilities;
  auth_method?: MapAuthMethod;
  auth_token?: string;
  agent_count?: number;
  scope_count?: number;
  headscale_node_id?: string;
  tailscale_ips?: string[];
  tailscale_dns_name?: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterNodeInput {
  swarm_id: string;
  map_agent_id: string;
  name?: string;
  description?: string;
  role?: string;
  state?: MapNodeState;
  capabilities?: Record<string, unknown>;
  scopes?: string[];
  visibility?: MapNodeVisibility;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface UpdateNodeInput {
  name?: string;
  description?: string;
  role?: string;
  state?: MapNodeState;
  capabilities?: Record<string, unknown>;
  scopes?: string[];
  visibility?: MapNodeVisibility;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface DiscoverNodesOptions {
  hive_id?: string;
  swarm_id?: string;
  role?: string;
  state?: MapNodeState;
  tags?: string[];
  visibility?: MapNodeVisibility;
  limit?: number;
  offset?: number;
}

export interface CreatePreauthKeyInput {
  hive_id?: string;
  uses?: number;
  expires_in_hours?: number;
}

// ============================================================================
// Peer List (headscale-style DERP map equivalent)
// ============================================================================

export interface SwarmPeer {
  swarm_id: string;
  name: string;
  map_endpoint: string;
  map_transport: MapTransport;
  auth_method: MapAuthMethod;
  status: SwarmStatus;
  agent_count: number;
  capabilities: MapSwarmCapabilities | null;
  shared_hives: string[]; // Hive names that both swarms belong to
  // Headscale/Tailscale network info (for L3/L4 connectivity)
  tailscale_ips: string[] | null;
  tailscale_dns_name: string | null;
}

export interface PeerList {
  swarm_id: string;
  peers: SwarmPeer[];
  generated_at: string;
}

// ============================================================================
// Public Swarm/Node types (for API responses, no secrets)
// ============================================================================

export interface MapSwarmPublic {
  id: string;
  name: string;
  description: string | null;
  map_endpoint: string;
  map_transport: MapTransport;
  status: SwarmStatus;
  last_seen_at: string;
  capabilities: MapSwarmCapabilities | null;
  auth_method: MapAuthMethod;
  agent_count: number;
  scope_count: number;
  // Headscale/Tailscale network info
  tailscale_ips: string[] | null;
  tailscale_dns_name: string | null;
  metadata: Record<string, unknown> | null;
  hives: string[];
  created_at: string;
}

export interface MapNodePublic {
  id: string;
  swarm_id: string;
  swarm_name: string;
  map_agent_id: string;
  name: string | null;
  description: string | null;
  role: string | null;
  state: MapNodeState;
  capabilities: Record<string, unknown> | null;
  scopes: string[] | null;
  visibility: MapNodeVisibility;
  tags: string[] | null;
  created_at: string;
}
