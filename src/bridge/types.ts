/**
 * Channel Bridge Types
 *
 * Interfaces for the bridge system: adapter interface, normalized message
 * formats, configuration types, and runtime state.
 */

// ============================================================================
// Platform & Transport
// ============================================================================

export type BridgePlatform = 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'matrix';
export type TransportMode = 'outbound' | 'webhook';
export type BridgeDirection = 'inbound' | 'outbound' | 'bidirectional';
export type ThreadMode = 'post_per_message' | 'single_thread' | 'explicit_only';
export type BridgeStatusType = 'active' | 'inactive' | 'error';
export type RunningBridgeStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

// ============================================================================
// Database Row Types
// ============================================================================

export interface BridgeConfig {
  id: string;
  name: string;
  platform: BridgePlatform;
  transport_mode: TransportMode;
  credentials_encrypted: string;
  status: BridgeStatusType;
  error_message: string | null;
  owner_agent_id: string;
  created_at: string;
  updated_at: string;
}

export interface ChannelMapping {
  id: string;
  bridge_id: string;
  platform_channel_id: string;
  platform_channel_name: string | null;
  hive_name: string;
  direction: BridgeDirection;
  thread_mode: ThreadMode;
  created_at: string;
  updated_at: string;
}

export interface ProxyAgent {
  id: string;
  bridge_id: string;
  platform_user_id: string;
  agent_id: string;
  platform_display_name: string | null;
  platform_avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageMapping {
  id: string;
  bridge_id: string;
  platform_message_id: string;
  platform_channel_id: string;
  post_id: string | null;
  comment_id: string | null;
  created_at: string;
}

// ============================================================================
// Normalized Message Types
// ============================================================================

export interface Attachment {
  type: 'image' | 'file' | 'link';
  url: string;
  name?: string;
  mimeType?: string;
}

/** Normalized inbound message from an external platform */
export interface InboundMessage {
  /** Unique message ID from the platform */
  platformMessageId: string;

  /** Platform identifier */
  platform: string;

  /** Platform channel/group/chat ID */
  platformChannelId: string;

  /** Author info from the platform */
  author: {
    platformUserId: string;
    displayName: string;
    avatarUrl?: string;
  };

  /** Message content */
  content: {
    text: string;
    attachments?: Attachment[];
  };

  /** Threading info */
  thread?: {
    /** Platform's thread/reply ID — indicates this is a reply */
    parentMessageId: string;
  };

  /** Mentions extracted from the message */
  mentions?: string[];

  /** ISO 8601 timestamp */
  timestamp: string;

  /**
   * Platform-specific metadata preserved for round-tripping.
   * Used when sending responses back to the correct context.
   */
  platformMeta: Record<string, unknown>;
}

/** Normalized outbound message to an external platform */
export interface OutboundMessage {
  /** Message text content (may contain markdown) */
  text: string;

  /** Attachments to include */
  attachments?: Attachment[];

  /** If replying to a specific platform message */
  replyTo?: string;
}

/** Target destination on an external platform */
export interface PlatformDestination {
  /** Platform channel/group/chat ID to send to */
  platformChannelId: string;

  /** Optional thread to reply in */
  threadId?: string;
}

// ============================================================================
// Adapter Interface
// ============================================================================

export interface AdapterConfig {
  /** Transport mode */
  mode: TransportMode;

  /** Platform-specific credentials (decrypted) */
  credentials: Record<string, string>;

  /** Channel mappings (platform channel ID → hive name) */
  channelMappings: ChannelMapping[];

  /** Webhook base URL (only used in webhook mode) */
  webhookBaseUrl?: string;

  /** Bridge ID (for webhook routing) */
  bridgeId?: string;
}

/** Platform adapter interface — each platform implements this */
export interface BridgeAdapter {
  /** Platform identifier */
  readonly platform: string;

  /**
   * Start the adapter and connect to the platform.
   * The adapter handles its own transport internally (WebSocket, polling, webhook listener).
   */
  connect(config: AdapterConfig): Promise<void>;

  /**
   * Stream of inbound messages from the platform.
   * Each adapter produces these regardless of transport mode.
   */
  messages(): AsyncIterable<InboundMessage>;

  /**
   * Send a message to the platform.
   * The adapter translates from normalized format to platform-native format.
   */
  send(destination: PlatformDestination, message: OutboundMessage): Promise<void>;

  /**
   * Gracefully disconnect from the platform.
   */
  disconnect(): Promise<void>;
}

// ============================================================================
// Runtime Types
// ============================================================================

export interface RunningBridge {
  config: BridgeConfig;
  adapter: BridgeAdapter;
  mappings: ChannelMapping[];
  status: RunningBridgeStatus;
  error?: string;
}

/** Bridge metadata stored in post.metadata for bridged content */
export interface BridgePostMetadata {
  bridge: string;
  bridge_id: string;
  platform_message_id: string;
  platform_channel_id: string;
  mentions?: string[];
}

// ============================================================================
// API Input Types
// ============================================================================

export interface CreateBridgeInput {
  name: string;
  platform: BridgePlatform;
  transport_mode: TransportMode;
  credentials: Record<string, string>;
}

export interface UpdateBridgeInput {
  name?: string;
  transport_mode?: TransportMode;
  credentials?: Record<string, string>;
}

export interface CreateChannelMappingInput {
  platform_channel_id: string;
  platform_channel_name?: string;
  hive_name: string;
  direction?: BridgeDirection;
  thread_mode?: ThreadMode;
}
