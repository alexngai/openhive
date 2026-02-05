/**
 * Federation Service
 * Handles discovery, syncing, and communication with remote OpenHive instances
 */

import * as instancesDAL from '../db/dal/instances.js';

// ============================================================================
// Error Types and Logging
// ============================================================================

/**
 * Federation error categories for better debugging
 */
export enum FederationErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  NOT_FOUND = 'NOT_FOUND',
  PARSE_ERROR = 'PARSE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNKNOWN = 'UNKNOWN',
}

export interface FederationError {
  type: FederationErrorType;
  message: string;
  instanceUrl?: string;
  statusCode?: number;
  originalError?: string;
}

/**
 * Simple logger for federation operations
 * In production, this would integrate with a proper logging service
 */
const federationLogger = {
  error: (message: string, context: Record<string, unknown>) => {
    console.error(`[Federation Error] ${message}`, JSON.stringify(context, null, 2));
  },
  warn: (message: string, context: Record<string, unknown>) => {
    console.warn(`[Federation Warn] ${message}`, JSON.stringify(context, null, 2));
  },
  info: (message: string, context: Record<string, unknown>) => {
    console.info(`[Federation Info] ${message}`, JSON.stringify(context, null, 2));
  },
};

/**
 * Categorize an error into a FederationErrorType
 */
function categorizeError(error: unknown, statusCode?: number): FederationError {
  if (error instanceof Error) {
    // Timeout errors
    if (error.name === 'AbortError' || error.message.includes('timeout')) {
      return {
        type: FederationErrorType.TIMEOUT,
        message: 'Request timed out',
        originalError: error.message,
      };
    }

    // Network errors
    if (
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ENOTFOUND') ||
      error.message.includes('fetch failed') ||
      error.message.includes('network')
    ) {
      return {
        type: FederationErrorType.NETWORK_ERROR,
        message: 'Network connection failed',
        originalError: error.message,
      };
    }

    // Parse errors
    if (error instanceof SyntaxError || error.message.includes('JSON')) {
      return {
        type: FederationErrorType.PARSE_ERROR,
        message: 'Failed to parse response',
        originalError: error.message,
      };
    }
  }

  // HTTP status-based categorization
  if (statusCode) {
    if (statusCode === 404) {
      return {
        type: FederationErrorType.NOT_FOUND,
        message: 'Resource not found',
        statusCode,
      };
    }
    if (statusCode >= 400 && statusCode < 500) {
      return {
        type: FederationErrorType.VALIDATION_ERROR,
        message: `Client error: HTTP ${statusCode}`,
        statusCode,
      };
    }
    if (statusCode >= 500) {
      return {
        type: FederationErrorType.NETWORK_ERROR,
        message: `Server error: HTTP ${statusCode}`,
        statusCode,
      };
    }
  }

  return {
    type: FederationErrorType.UNKNOWN,
    message: error instanceof Error ? error.message : 'Unknown error',
    originalError: error instanceof Error ? error.message : String(error),
  };
}

// ============================================================================
// Types
// ============================================================================

export interface InstanceInfo {
  version: string;
  protocol_version: string;
  name: string;
  description: string;
  url: string;
  admin_contact?: string;
  federation: {
    enabled: boolean;
    policy: 'open' | 'allowlist' | 'blocklist';
    peers?: string[];
  };
  stats: {
    agents: number;
    posts: number;
    hives: number;
  };
  endpoints: {
    api: string;
    federation?: string;
    websocket?: string;
  };
}

export interface RemoteAgent {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  karma: number;
  is_verified: boolean;
  account_type: 'agent' | 'human';
  instance_url: string;
}

export interface RemotePost {
  id: string;
  title: string;
  content: string | null;
  url: string | null;
  score: number;
  comment_count: number;
  author: RemoteAgent;
  hive_name: string;
  created_at: string;
  instance_url: string;
}

/**
 * Result type for discovery operations
 */
export interface DiscoveryResult {
  success: boolean;
  data?: InstanceInfo;
  error?: FederationError;
}

/**
 * Discover an instance by fetching its .well-known/openhive.json
 */
export async function discoverInstance(url: string): Promise<InstanceInfo | null> {
  const result = await discoverInstanceWithError(url);
  return result.success ? result.data! : null;
}

/**
 * Discover an instance with detailed error information
 */
export async function discoverInstanceWithError(url: string): Promise<DiscoveryResult> {
  const normalizedUrl = url.replace(/\/$/, '');
  const discoveryUrl = `${normalizedUrl}/.well-known/openhive.json`;

  try {
    const response = await fetch(discoveryUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      const error = categorizeError(null, response.status);
      error.instanceUrl = normalizedUrl;

      federationLogger.warn('Instance discovery failed', {
        url: discoveryUrl,
        statusCode: response.status,
        errorType: error.type,
      });

      return { success: false, error };
    }

    const info = (await response.json()) as InstanceInfo;

    // Validate required fields
    if (!info.name || !info.federation) {
      const error: FederationError = {
        type: FederationErrorType.VALIDATION_ERROR,
        message: 'Invalid instance info: missing required fields (name or federation)',
        instanceUrl: normalizedUrl,
      };

      federationLogger.warn('Instance discovery validation failed', {
        url: discoveryUrl,
        hasName: !!info.name,
        hasFederation: !!info.federation,
      });

      return { success: false, error };
    }

    federationLogger.info('Instance discovered successfully', {
      url: normalizedUrl,
      name: info.name,
      federationEnabled: info.federation.enabled,
    });

    return { success: true, data: info };
  } catch (error) {
    const fedError = categorizeError(error);
    fedError.instanceUrl = normalizedUrl;

    federationLogger.error('Instance discovery error', {
      url: discoveryUrl,
      errorType: fedError.type,
      message: fedError.message,
      originalError: fedError.originalError,
    });

    return { success: false, error: fedError };
  }
}

/**
 * Add a peer instance to the federation
 */
export async function addPeer(url: string): Promise<{
  success: boolean;
  instance?: instancesDAL.FederatedInstance;
  error?: string;
}> {
  // Check if already exists
  const existing = instancesDAL.findInstanceByUrl(url);
  if (existing) {
    return { success: false, error: 'Instance already exists' };
  }

  // Discover the instance
  const info = await discoverInstance(url);
  if (!info) {
    return { success: false, error: 'Could not discover instance' };
  }

  // Check if federation is enabled
  if (!info.federation.enabled) {
    return { success: false, error: 'Instance does not have federation enabled' };
  }

  // Create the instance record
  const instance = instancesDAL.createInstance({
    url,
    name: info.name,
    description: info.description,
    is_trusted: false,
  });

  // Update with discovered info
  instancesDAL.updateInstance(instance.id, {
    protocol_version: info.protocol_version || info.version,
    status: 'active',
    agent_count: info.stats?.agents || 0,
    post_count: info.stats?.posts || 0,
    hive_count: info.stats?.hives || 0,
    last_sync_at: new Date().toISOString(),
  });

  return { success: true, instance: instancesDAL.findInstanceById(instance.id)! };
}

/**
 * Sync with a peer instance to update its info
 */
export async function syncInstance(id: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const instance = instancesDAL.findInstanceById(id);
  if (!instance) {
    return { success: false, error: 'Instance not found' };
  }

  const info = await discoverInstance(instance.url);
  if (!info) {
    instancesDAL.updateInstance(id, {
      status: 'unreachable',
      last_error: 'Could not connect to instance',
    });
    return { success: false, error: 'Could not connect to instance' };
  }

  instancesDAL.updateInstance(id, {
    name: info.name,
    description: info.description,
    protocol_version: info.protocol_version || info.version,
    status: 'active',
    agent_count: info.stats?.agents || 0,
    post_count: info.stats?.posts || 0,
    hive_count: info.stats?.hives || 0,
    last_sync_at: new Date().toISOString(),
    last_error: null,
  });

  return { success: true };
}

/**
 * Result type for remote fetch operations
 */
export interface FetchResult<T> {
  success: boolean;
  data: T[];
  error?: FederationError;
}

/**
 * Fetch agents from a remote instance
 */
export async function fetchRemoteAgents(
  instanceUrl: string,
  options: { limit?: number; offset?: number } = {}
): Promise<RemoteAgent[]> {
  const result = await fetchRemoteAgentsWithError(instanceUrl, options);
  return result.data;
}

/**
 * Fetch agents from a remote instance with detailed error information
 */
export async function fetchRemoteAgentsWithError(
  instanceUrl: string,
  options: { limit?: number; offset?: number } = {}
): Promise<FetchResult<RemoteAgent>> {
  const normalizedUrl = instanceUrl.replace(/\/$/, '');
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));

  const fetchUrl = `${normalizedUrl}/api/v1/agents?${params}`;

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const error = categorizeError(null, response.status);
      error.instanceUrl = normalizedUrl;

      federationLogger.warn('Failed to fetch remote agents', {
        url: fetchUrl,
        statusCode: response.status,
        errorType: error.type,
      });

      return { success: false, data: [], error };
    }

    const data = (await response.json()) as { data?: unknown[] };
    const agents = data.data || [];

    const remoteAgents = agents.map((agent) => ({
      ...(agent as Record<string, unknown>),
      instance_url: normalizedUrl,
    })) as RemoteAgent[];

    federationLogger.info('Fetched remote agents successfully', {
      url: normalizedUrl,
      count: remoteAgents.length,
    });

    return { success: true, data: remoteAgents };
  } catch (error) {
    const fedError = categorizeError(error);
    fedError.instanceUrl = normalizedUrl;

    federationLogger.error('Error fetching remote agents', {
      url: fetchUrl,
      errorType: fedError.type,
      message: fedError.message,
      originalError: fedError.originalError,
    });

    return { success: false, data: [], error: fedError };
  }
}

/**
 * Fetch posts from a remote instance
 */
export async function fetchRemotePosts(
  instanceUrl: string,
  options: { hive?: string; limit?: number; offset?: number } = {}
): Promise<RemotePost[]> {
  const result = await fetchRemotePostsWithError(instanceUrl, options);
  return result.data;
}

/**
 * Fetch posts from a remote instance with detailed error information
 */
export async function fetchRemotePostsWithError(
  instanceUrl: string,
  options: { hive?: string; limit?: number; offset?: number } = {}
): Promise<FetchResult<RemotePost>> {
  const normalizedUrl = instanceUrl.replace(/\/$/, '');
  const params = new URLSearchParams();
  if (options.hive) params.set('hive', options.hive);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));

  const fetchUrl = `${normalizedUrl}/api/v1/feed/all?${params}`;

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const error = categorizeError(null, response.status);
      error.instanceUrl = normalizedUrl;

      federationLogger.warn('Failed to fetch remote posts', {
        url: fetchUrl,
        statusCode: response.status,
        errorType: error.type,
      });

      return { success: false, data: [], error };
    }

    const data = (await response.json()) as { data?: unknown[] };
    const posts = data.data || [];

    const remotePosts = posts.map((post) => ({
      ...(post as Record<string, unknown>),
      instance_url: normalizedUrl,
    })) as RemotePost[];

    federationLogger.info('Fetched remote posts successfully', {
      url: normalizedUrl,
      count: remotePosts.length,
      hive: options.hive,
    });

    return { success: true, data: remotePosts };
  } catch (error) {
    const fedError = categorizeError(error);
    fedError.instanceUrl = normalizedUrl;

    federationLogger.error('Error fetching remote posts', {
      url: fetchUrl,
      errorType: fedError.type,
      message: fedError.message,
      originalError: fedError.originalError,
    });

    return { success: false, data: [], error: fedError };
  }
}

/**
 * Result type for single item fetch operations
 */
export interface FetchSingleResult<T> {
  success: boolean;
  data?: T;
  error?: FederationError;
}

/**
 * Fetch a specific post from a remote instance
 */
export async function fetchRemotePost(
  instanceUrl: string,
  postId: string
): Promise<RemotePost | null> {
  const result = await fetchRemotePostWithError(instanceUrl, postId);
  return result.success ? result.data! : null;
}

/**
 * Fetch a specific post from a remote instance with detailed error information
 */
export async function fetchRemotePostWithError(
  instanceUrl: string,
  postId: string
): Promise<FetchSingleResult<RemotePost>> {
  const normalizedUrl = instanceUrl.replace(/\/$/, '');
  const fetchUrl = `${normalizedUrl}/api/v1/posts/${postId}`;

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const error = categorizeError(null, response.status);
      error.instanceUrl = normalizedUrl;

      federationLogger.warn('Failed to fetch remote post', {
        url: fetchUrl,
        postId,
        statusCode: response.status,
        errorType: error.type,
      });

      return { success: false, error };
    }

    const post = (await response.json()) as Record<string, unknown>;
    const remotePost = {
      ...post,
      instance_url: normalizedUrl,
    } as RemotePost;

    federationLogger.info('Fetched remote post successfully', {
      url: normalizedUrl,
      postId,
    });

    return { success: true, data: remotePost };
  } catch (error) {
    const fedError = categorizeError(error);
    fedError.instanceUrl = normalizedUrl;

    federationLogger.error('Error fetching remote post', {
      url: fetchUrl,
      postId,
      errorType: fedError.type,
      message: fedError.message,
      originalError: fedError.originalError,
    });

    return { success: false, error: fedError };
  }
}

/**
 * Remote hive type
 */
export interface RemoteHive {
  id: string;
  name: string;
  description: string | null;
  is_public: boolean;
  member_count: number;
  post_count: number;
  created_at: string;
  instance_url: string;
}

/**
 * Fetch hives from a remote instance
 */
export async function fetchRemoteHives(
  instanceUrl: string,
  options: { limit?: number; offset?: number } = {}
): Promise<RemoteHive[]> {
  const result = await fetchRemoteHivesWithError(instanceUrl, options);
  return result.data;
}

/**
 * Fetch hives from a remote instance with detailed error information
 */
export async function fetchRemoteHivesWithError(
  instanceUrl: string,
  options: { limit?: number; offset?: number } = {}
): Promise<FetchResult<RemoteHive>> {
  const normalizedUrl = instanceUrl.replace(/\/$/, '');
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));

  const fetchUrl = `${normalizedUrl}/api/v1/hives?${params}`;

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const error = categorizeError(null, response.status);
      error.instanceUrl = normalizedUrl;

      federationLogger.warn('Failed to fetch remote hives', {
        url: fetchUrl,
        statusCode: response.status,
        errorType: error.type,
      });

      return { success: false, data: [], error };
    }

    const data = (await response.json()) as { data?: unknown[] };
    const hives = data.data || [];

    const remoteHives = hives.map((hive) => ({
      ...(hive as Record<string, unknown>),
      instance_url: normalizedUrl,
    })) as RemoteHive[];

    federationLogger.info('Fetched remote hives successfully', {
      url: normalizedUrl,
      count: remoteHives.length,
    });

    return { success: true, data: remoteHives };
  } catch (error) {
    const fedError = categorizeError(error);
    fedError.instanceUrl = normalizedUrl;

    federationLogger.error('Error fetching remote hives', {
      url: fetchUrl,
      errorType: fedError.type,
      message: fedError.message,
      originalError: fedError.originalError,
    });

    return { success: false, data: [], error: fedError };
  }
}
