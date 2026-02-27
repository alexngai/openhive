/**
 * SwarmHub Connector Module
 *
 * Optional bridge that connects a managed OpenHive instance to SwarmHub.
 * Auto-activates when SWARMHUB_API_URL + SWARMHUB_HIVE_TOKEN env vars
 * are present (set by SwarmHub at provisioning time, or manually for
 * self-hosted instances linking to a SwarmHub account).
 *
 * Capabilities:
 * - GitHub credential proxying (scoped installation tokens)
 * - Slack credential proxying (bot tokens for SwarmHub-hosted Slack App)
 * - Webhook ingestion for SwarmHub-forwarded events (Slack, GitHub, etc.)
 * - Hive identity and mapping queries
 * - Health monitoring
 *
 * Future:
 * - Inter-hive signaling via SwarmHub
 * - Usage metering and billing signals
 * - Additional integrations (Linear, Discord, etc.)
 */

export { SwarmHubConnector } from './connector.js';
export { SwarmHubClient } from './client.js';
export { swarmhubRoutes, swarmhubWebhookRoutes } from './routes.js';
export { handleForwardedSlackEvent, clearManagedBridgeCache } from './webhook-handler.js';
export type {
  SwarmHubConfig,
  HiveIdentity,
  HiveRepo,
  HiveReposResponse,
  GitHubTokenRequest,
  GitHubTokenResponse,
  SlackInstallation,
  SlackChannelMapping,
  SlackCredentialsRequest,
  SlackCredentialsResponse,
  SlackInstallationsResponse,
  ForwardedSlackEvent,
  SlackEventPayload,
  ConnectorState,
  ConnectorStatus,
  SwarmHubEvents,
} from './types.js';
