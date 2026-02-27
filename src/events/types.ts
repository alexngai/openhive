/**
 * Event Routing Types
 *
 * Source-agnostic event types for the dual-path dispatcher:
 * - Post Pipeline: configurable rules turn events into posts
 * - MAP Dispatch: subscribed swarms receive JSON-RPC messages
 */

// ============================================================================
// Core Event Type
// ============================================================================

/** Source-agnostic normalized event flowing through the router */
export interface NormalizedEvent {
  source: 'github' | 'slack' | string;
  event_type: string;           // 'push', 'pull_request.opened', 'message'
  action?: string;              // GitHub action (opened, closed, etc.)
  delivery_id: string;
  timestamp: string;
  /** Set by normalizer — if present, the post pipeline can create a post */
  post?: {
    title: string;
    content: string;
    url?: string;
  };
  raw_payload: Record<string, unknown>;
  metadata: EventMetadata;
}

export interface EventMetadata {
  repo?: string;
  branch?: string;
  channel_id?: string;
  channel_name?: string;
  sender?: string;
  [key: string]: unknown;
}

// ============================================================================
// Post Rules (which events become posts)
// ============================================================================

export interface PostRule {
  id: string;
  hive_id: string;
  source: string;               // 'github' | 'slack' | '*'
  event_types: string[];        // parsed from JSON text column
  filters: EventFilters | null; // parsed from JSON text column
  normalizer: string;           // 'default' or custom normalizer name
  thread_mode: PostRuleThreadMode;
  priority: number;
  enabled: boolean;
  created_by: string | null;    // 'swarmhub' | 'api' | agent_id
  created_at: string;
  updated_at: string;
}

export type PostRuleThreadMode = 'post_per_event' | 'single_thread' | 'skip';

// ============================================================================
// Event Subscriptions (which swarms receive which events via MAP)
// ============================================================================

export interface EventSubscription {
  id: string;
  hive_id: string;
  swarm_id: string | null;      // NULL = hive default (all online swarms)
  source: string;               // 'github' | 'slack' | '*'
  event_types: string[];        // parsed from JSON text column
  filters: EventFilters | null; // parsed from JSON text column
  priority: number;
  enabled: boolean;
  created_by: string | null;    // 'swarmhub' | 'api' | 'swarm:{id}'
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Filters
// ============================================================================

export interface EventFilters {
  repos?: string[];
  channels?: string[];
  branches?: string[];
}

// ============================================================================
// Delivery Log
// ============================================================================

export interface EventDeliveryLog {
  id: string;
  delivery_id: string;
  subscription_id: string | null;
  swarm_id: string;
  source: string;
  event_type: string;
  status: 'sent' | 'failed' | 'offline';
  error: string | null;
  created_at: string;
}

// ============================================================================
// Router Result
// ============================================================================

export interface RouteResult {
  posts_created: number;
  swarms_notified: number;
  deliveries: EventDeliveryLog[];
}

// ============================================================================
// MAP Message Format
// ============================================================================

/** JSON-RPC 2.0 notification for webhook event dispatch to swarms */
export interface MapWebhookEventMessage {
  jsonrpc: '2.0';
  method: 'x-openhive/event.webhook';
  params: {
    source: string;
    event_type: string;
    action?: string;
    delivery_id: string;
    payload: Record<string, unknown>;
    metadata: EventMetadata;
  };
}
