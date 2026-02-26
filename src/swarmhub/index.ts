/**
 * SwarmHub Connector Module
 *
 * Optional bridge that connects a managed OpenHive instance to SwarmHub.
 * Auto-activates when SWARMHUB_API_URL + SWARMHUB_HIVE_TOKEN env vars
 * are present (set by SwarmHub at provisioning time, or manually for
 * self-hosted instances linking to a SwarmHub account).
 *
 * Current capabilities:
 * - GitHub credential proxying (scoped installation tokens)
 * - Hive identity and repo mapping queries
 * - Health monitoring
 *
 * Future capabilities:
 * - Webhook forwarding (GitHub, Slack, etc.)
 * - Inter-hive signaling via SwarmHub
 * - Usage metering and billing signals
 */

export { SwarmHubConnector } from './connector.js';
export { SwarmHubClient } from './client.js';
export { swarmhubRoutes } from './routes.js';
export type {
  SwarmHubConfig,
  HiveIdentity,
  HiveRepo,
  HiveReposResponse,
  GitHubTokenRequest,
  GitHubTokenResponse,
  ConnectorState,
  ConnectorStatus,
  SwarmHubEvents,
} from './types.js';
