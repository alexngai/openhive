/**
 * Channel Bridge — External Platform Integration
 *
 * Connects OpenHive hives to external communication platforms
 * (Slack, Discord, Telegram, WhatsApp, Matrix) via a transport-agnostic
 * adapter interface.
 */

export type {
  // Platform & transport
  BridgePlatform,
  TransportMode,
  BridgeDirection,
  ThreadMode,
  BridgeStatusType,
  RunningBridgeStatus,

  // Database row types
  BridgeConfig,
  ChannelMapping,
  ProxyAgent,
  MessageMapping,

  // Normalized message types
  Attachment,
  InboundMessage,
  OutboundMessage,
  PlatformDestination,

  // Adapter
  AdapterConfig,
  BridgeAdapter,

  // Runtime
  RunningBridge,
  BridgePostMetadata,

  // API input types
  CreateBridgeInput,
  UpdateBridgeInput,
  CreateChannelMappingInput,
} from './types.js';
