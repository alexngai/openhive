/**
 * Config metadata registry — describes each config section and field
 * for the admin API (secret redaction, read-only enforcement) and
 * the Settings UI (labels, groups, descriptions, badges).
 */

// ─── Types ───────────────────────────────────────────────────────

export type ConfigGroup = 'general' | 'swarms' | 'integrations' | 'networking' | 'storage' | 'resources';

export interface SectionMeta {
  key: string;
  label: string;
  description: string;
  group: ConfigGroup;
  /** Entire section is read-only (cannot PATCH) */
  readOnly?: boolean;
}

export interface FieldMeta {
  label: string;
  description?: string;
  secret?: boolean;
  readOnly?: boolean;
  restartRequired?: boolean;
}

// ─── Section metadata ────────────────────────────────────────────

export const CONFIG_SECTIONS: SectionMeta[] = [
  // General
  { key: 'instance', label: 'Instance', description: 'Instance identity and branding', group: 'general' },
  { key: 'cors', label: 'CORS', description: 'Cross-origin request policy', group: 'general' },
  { key: 'rateLimit', label: 'Rate Limiting', description: 'Request throttling', group: 'general' },

  // Swarms
  { key: 'mapHub', label: 'MAP Hub', description: 'Multi-Agent Protocol hub for swarm coordination', group: 'swarms' },
  { key: 'swarmHosting', label: 'Swarm Hosting', description: 'Spawn and manage OpenSwarm instances', group: 'swarms' },
  { key: 'swarmcraft', label: 'SwarmCraft', description: 'MAP client for agent monitoring', group: 'swarms' },

  // Integrations
  { key: 'learning', label: 'Learning Engine', description: 'Cognitive-core Atlas integration', group: 'integrations' },
  { key: 'bridge', label: 'Channel Bridge', description: 'External platform integration (Slack, Discord)', group: 'integrations' },
  { key: 'githubApp', label: 'GitHub App', description: 'Automatic webhook handling for memory banks', group: 'integrations' },
  { key: 'swarmhub', label: 'SwarmHub', description: 'SwarmHub connector for managed instances', group: 'integrations' },

  // Networking
  { key: 'federation', label: 'Federation', description: 'Cross-instance content sync', group: 'networking' },
  { key: 'network', label: 'Mesh Network', description: 'Tailscale/Headscale mesh networking', group: 'networking' },
  { key: 'sync', label: 'Hive Sync', description: 'Cross-instance mesh sync protocol', group: 'networking' },

  // Storage
  { key: 'sessions', label: 'Session Storage', description: 'Trajectory content caching backend', group: 'storage' },
  { key: 'sessionlog', label: 'Session Log', description: 'Local sessionlog transcript lookup paths', group: 'storage' },
  { key: 'resourceStorage', label: 'Resource Storage', description: 'Cloned resource data storage', group: 'storage' },

  // Resources
  { key: 'autoPull', label: 'Auto-Pull', description: 'Automatic pulling of remote git-backed resources', group: 'resources' },
  { key: 'resourceDiscovery', label: 'Resource Discovery', description: 'Filesystem scanning for memory banks and skills', group: 'resources' },
  { key: 'resourceSync', label: 'Resource Sync', description: 'Sync strategies for remote resources', group: 'resources' },
];

export const CONFIG_GROUP_LABELS: Record<ConfigGroup, string> = {
  general: 'General',
  swarms: 'Swarms',
  integrations: 'Integrations',
  networking: 'Networking',
  storage: 'Storage',
  resources: 'Resources',
};

// Group ordering for UI rendering
export const CONFIG_GROUP_ORDER: ConfigGroup[] = [
  'general', 'swarms', 'integrations', 'networking', 'storage', 'resources',
];

// ─── Field-level metadata ────────────────────────────────────────
// Dot-path notation: "section.field" or "section.nested.field"

/** Fields that contain secrets — redacted on GET, sentinel-skipped on PATCH */
export const SECRET_PATHS = new Set([
  'admin.key',
  'mapHub.iamSecret',
  'githubApp.webhookSecret',
  'githubApp.privateKey',
  'githubApp.clientSecret',
  'swarmhub.oauth.clientSecret',
  'network.tailscale.apiKey',
  'network.tailscale.oauthClientSecret',
  'network.headscaleExternal.apiKey',
  'sync.handshake_secret',
  'bridge.credentialEncryptionKey',
  'learning.atlas.embedding.apiKey',
  'learning.distributed.learningHiveApiKey',
]);

/** Fields that cannot be changed via the API */
export const READONLY_PATHS = new Set([
  'admin.key',
  'admin.createOnStartup',
]);

/** Read-only sections (not exposed for PATCH at all) */
export const READONLY_SECTIONS = new Set([
  'headscale', // legacy — use network.* instead
]);

/** Fields that require a server restart to take effect */
export const RESTART_REQUIRED_PATHS = new Set([
  'auth.mode',
  'cors.origin',
  'cors.enabled',
  'federation.enabled',
  'network.provider',
  'network.tailscale',
  'network.headscaleSidecar',
  'network.headscaleExternal',
  'sync.enabled',
  'sync.instanceId',
  'sync.sync_endpoint',
  'sessions.type',
  'swarmhub.enabled',
  'swarmhub.apiUrl',
  'swarmhub.oauth',
  'githubApp.enabled',
  'githubApp.appId',
  'swarmHosting.default_provider',
  'swarmcraft.enabled',
  'swarmcraft.prefix',
  'swarmcraft.wsPath',
  'bridge.enabled',
  'learning.enabled',
]);

/** Sentinel value used for redacted secrets */
export const SECRET_SENTINEL = '********';

// ─── Field labels & descriptions (for _meta) ────────────────────

export const FIELD_META: Record<string, FieldMeta> = {
  // Admin
  'admin.key': { label: 'Admin Key', secret: true, readOnly: true },
  'admin.createOnStartup': { label: 'Create on Startup', readOnly: true },

  // Instance
  'instance.name': { label: 'Name', description: 'Display name for this instance' },
  'instance.description': { label: 'Description', description: 'Short description shown in discovery' },
  'instance.url': { label: 'URL', description: 'Public URL for federation' },
  'instance.public': { label: 'Public', description: 'Allow public discovery' },

  // CORS
  'cors.enabled': { label: 'Enabled', restartRequired: true },
  'cors.origin': { label: 'Allowed Origins', description: 'true for all, or specific origins', restartRequired: true },

  // Rate Limiting
  'rateLimit.enabled': { label: 'Enabled' },
  'rateLimit.max': { label: 'Max Requests', description: 'Maximum requests per time window' },
  'rateLimit.timeWindow': { label: 'Time Window', description: 'e.g. "1 minute"' },

  // Auth
  'auth.mode': { label: 'Auth Mode', readOnly: true, restartRequired: true },

  // MAP Hub
  'mapHub.enabled': { label: 'Enabled' },
  'mapHub.trustModel': { label: 'Trust Model', description: 'How agents authenticate via WebSocket' },
  'mapHub.staleThresholdMinutes': { label: 'Stale Threshold', description: 'Minutes before unresponsive swarm goes offline' },
  'mapHub.iamSecret': { label: 'IAM Secret', secret: true },
  'mapHub.missedPongsBeforeTerminate': { label: 'Missed Pongs Tolerance', description: 'Pong misses before connection is terminated' },
  'mapHub.heartbeatDebounceMs': { label: 'Heartbeat Debounce', description: 'Debounce interval (ms) for heartbeat DB writes' },

  // Swarm Hosting
  'swarmHosting.enabled': { label: 'Enabled' },
  'swarmHosting.default_provider': { label: 'Default Provider', restartRequired: true },
  'swarmHosting.openswarm_command': { label: 'OpenSwarm Command' },
  'swarmHosting.data_dir': { label: 'Data Directory' },
  'swarmHosting.port_range': { label: 'Port Range', description: '[min, max]' },
  'swarmHosting.max_swarms': { label: 'Max Swarms' },
  'swarmHosting.health_check_interval': { label: 'Health Check Interval (ms)' },
  'swarmHosting.max_health_failures': { label: 'Max Health Failures' },
  'swarmHosting.auto_restart': { label: 'Auto Restart' },
  'swarmHosting.max_restart_attempts': { label: 'Max Restart Attempts' },

  // SwarmCraft
  'swarmcraft.enabled': { label: 'Enabled', restartRequired: true },
  'swarmcraft.prefix': { label: 'API Prefix', restartRequired: true },
  'swarmcraft.wsPath': { label: 'WebSocket Path', restartRequired: true },
  'swarmcraft.logLevel': { label: 'Log Level' },

  // Learning
  'learning.enabled': { label: 'Enabled', description: 'Master toggle for learning engine', restartRequired: true },
  'learning.atlas.creditStrategy': { label: 'Credit Strategy' },
  'learning.atlas.minTrajectories': { label: 'Min Trajectories' },
  'learning.atlas.maxExperiences': { label: 'Max Experiences' },
  'learning.atlas.maxContextTokens': { label: 'Max Context Tokens' },
  'learning.atlas.embedding.provider': { label: 'Embedding Provider' },
  'learning.atlas.embedding.apiKey': { label: 'Embedding API Key', secret: true },
  'learning.atlas.embedding.model': { label: 'Embedding Model' },
  'learning.ingestion.mode': { label: 'Ingestion Mode' },
  'learning.compute.enabled': { label: 'Compute Enabled' },
  'learning.compute.preferredSwarmId': { label: 'Preferred Swarm ID' },
  'learning.compute.spawnIfNoneAvailable': { label: 'Spawn If None Available' },
  'learning.compute.spawnProvider': { label: 'Spawn Provider' },
  'learning.sync.publishPlaybooks': { label: 'Publish Playbooks' },
  'learning.sync.importPlaybooks': { label: 'Import Playbooks' },
  'learning.sync.conflictStrategy': { label: 'Conflict Strategy' },
  'learning.distributed.mode': { label: 'Distributed Mode' },
  'learning.distributed.learningHiveUrl': { label: 'Learning Hive URL' },
  'learning.distributed.learningHiveApiKey': { label: 'Learning Hive API Key', secret: true },
  'learning.maintenance.schedule': { label: 'Maintenance Schedule', description: 'Cron expression' },
  'learning.maintenance.autoRun': { label: 'Auto Run Maintenance' },

  // Bridge
  'bridge.enabled': { label: 'Enabled', restartRequired: true },
  'bridge.maxBridges': { label: 'Max Bridges' },
  'bridge.credentialEncryptionKey': { label: 'Credential Encryption Key', secret: true },
  'bridge.webhookBaseUrl': { label: 'Webhook Base URL' },

  // GitHub App
  'githubApp.enabled': { label: 'Enabled', restartRequired: true },
  'githubApp.appId': { label: 'App ID', restartRequired: true },
  'githubApp.webhookSecret': { label: 'Webhook Secret', secret: true },
  'githubApp.privateKey': { label: 'Private Key', secret: true },
  'githubApp.clientId': { label: 'Client ID' },
  'githubApp.clientSecret': { label: 'Client Secret', secret: true },

  // SwarmHub
  'swarmhub.enabled': { label: 'Enabled', restartRequired: true },
  'swarmhub.apiUrl': { label: 'API URL', restartRequired: true },
  'swarmhub.healthCheckInterval': { label: 'Health Check Interval (ms)' },
  'swarmhub.oauth.clientId': { label: 'OAuth Client ID' },
  'swarmhub.oauth.clientSecret': { label: 'OAuth Client Secret', secret: true },
  'swarmhub.oauth.jwksUrl': { label: 'JWKS URL' },

  // Federation
  'federation.enabled': { label: 'Enabled', restartRequired: true },
  'federation.peers': { label: 'Peer URLs' },

  // Network
  'network.provider': { label: 'Provider', restartRequired: true },
  'network.tailscale.apiKey': { label: 'Tailscale API Key', secret: true },
  'network.tailscale.oauthClientSecret': { label: 'Tailscale OAuth Client Secret', secret: true },
  'network.headscaleExternal.apiKey': { label: 'Headscale API Key', secret: true },

  // Sync
  'sync.enabled': { label: 'Enabled', restartRequired: true },
  'sync.instanceId': { label: 'Instance ID', restartRequired: true },
  'sync.sync_endpoint': { label: 'Sync Endpoint', restartRequired: true },
  'sync.handshake_secret': { label: 'Handshake Secret', secret: true },
  'sync.max_pending_events': { label: 'Max Pending Events' },
  'sync.max_concurrent_syncs': { label: 'Max Concurrent Syncs' },
  'sync.discovery': { label: 'Discovery Mode' },
  'sync.heartbeat_interval': { label: 'Heartbeat Interval (ms)' },
  'sync.peer_timeout': { label: 'Peer Timeout (ms)' },

  // Sessions
  'sessions.type': { label: 'Storage Type', restartRequired: true },
  'sessions.path': { label: 'Storage Path' },

  // Session Log
  'sessionlog.sessionDirs': { label: 'Session Directories', description: 'Paths to sessionlog state directories' },

  // Resource Discovery
  'resourceDiscovery.globalEnabled': { label: 'Global Scanning' },
  'resourceDiscovery.globalMemoryPath': { label: 'Global Memory Path' },
  'resourceDiscovery.globalSkillPaths': { label: 'Global Skill Paths' },
  'resourceDiscovery.projectRoot': { label: 'Project Root' },
  'resourceDiscovery.globalOpenTasksPath': { label: 'Global OpenTasks Path' },
  'resourceDiscovery.openTasksEnabled': { label: 'OpenTasks Enabled' },

  // Resource Sync
  // Auto-Pull
  'autoPull.intervalMinutes': { label: 'Poll Interval (minutes)', description: 'How often to check remote repos for new commits', restartRequired: true },

  'resourceSync.defaultStrategy': { label: 'Default Strategy' },
  'resourceSync.localDiscoveryStrategy': { label: 'Local Discovery Strategy' },
  'resourceSync.lsRemoteTtl': { label: 'ls-remote TTL (seconds)' },
  'resourceSync.mirrorFetchTimeout': { label: 'Mirror Fetch Timeout (ms)' },
  'resourceSync.bundleMaxSize': { label: 'Max Bundle Size (bytes)' },

  // Resource Storage
  'resourceStorage.dataDir': { label: 'Data Directory' },
  'resourceStorage.autoClone': { label: 'Auto Clone' },
};

// ─── Helpers ─────────────────────────────────────────────────────

/** Check if a dot-path matches any entry in a path set (supports prefix matching) */
export function matchesPath(dotPath: string, pathSet: Set<string>): boolean {
  if (pathSet.has(dotPath)) return true;
  // Check if any ancestor path matches (e.g., 'network.tailscale' matches 'network.tailscale.apiKey')
  const parts = dotPath.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.');
    if (pathSet.has(prefix)) return true;
  }
  return false;
}

/** Get section metadata by key */
export function getSectionMeta(key: string): SectionMeta | undefined {
  return CONFIG_SECTIONS.find(s => s.key === key);
}

/** Build _meta object for the GET response */
export function buildMetaResponse(): Record<string, unknown> {
  const meta: Record<string, unknown> = {};

  for (const section of CONFIG_SECTIONS) {
    const fields: Record<string, unknown> = {};
    const prefix = section.key + '.';

    for (const [path, fm] of Object.entries(FIELD_META)) {
      if (path.startsWith(prefix)) {
        const fieldKey = path.slice(prefix.length);
        fields[fieldKey] = {
          label: fm.label,
          ...(fm.description && { description: fm.description }),
          ...(fm.secret && { secret: true }),
          ...(fm.readOnly && { readOnly: true }),
          ...(fm.restartRequired && { restartRequired: true }),
        };
      }
    }

    meta[section.key] = {
      label: section.label,
      description: section.description,
      group: section.group,
      ...(section.readOnly && { readOnly: true }),
      fields,
    };
  }

  return meta;
}
