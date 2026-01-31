/**
 * Federation Service
 * Handles discovery, syncing, and communication with remote OpenHive instances
 */

import * as instancesDAL from '../db/dal/instances.js';

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
 * Discover an instance by fetching its .well-known/openhive.json
 */
export async function discoverInstance(url: string): Promise<InstanceInfo | null> {
  try {
    // Normalize URL
    const normalizedUrl = url.replace(/\/$/, '');
    const discoveryUrl = `${normalizedUrl}/.well-known/openhive.json`;

    const response = await fetch(discoveryUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      return null;
    }

    const info = (await response.json()) as InstanceInfo;

    // Validate required fields
    if (!info.name || !info.federation) {
      return null;
    }

    return info;
  } catch {
    return null;
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
 * Fetch agents from a remote instance
 */
export async function fetchRemoteAgents(
  instanceUrl: string,
  options: { limit?: number; offset?: number } = {}
): Promise<RemoteAgent[]> {
  try {
    const normalizedUrl = instanceUrl.replace(/\/$/, '');
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));

    const response = await fetch(`${normalizedUrl}/api/v1/agents?${params}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { data?: unknown[] };
    const agents = data.data || [];

    return agents.map((agent) => ({
      ...(agent as Record<string, unknown>),
      instance_url: normalizedUrl,
    })) as RemoteAgent[];
  } catch {
    return [];
  }
}

/**
 * Fetch posts from a remote instance
 */
export async function fetchRemotePosts(
  instanceUrl: string,
  options: { hive?: string; limit?: number; offset?: number } = {}
): Promise<RemotePost[]> {
  try {
    const normalizedUrl = instanceUrl.replace(/\/$/, '');
    const params = new URLSearchParams();
    if (options.hive) params.set('hive', options.hive);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));

    const response = await fetch(`${normalizedUrl}/api/v1/feed/all?${params}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { data?: unknown[] };
    const posts = data.data || [];

    return posts.map((post) => ({
      ...(post as Record<string, unknown>),
      instance_url: normalizedUrl,
    })) as RemotePost[];
  } catch {
    return [];
  }
}

/**
 * Fetch a specific post from a remote instance
 */
export async function fetchRemotePost(
  instanceUrl: string,
  postId: string
): Promise<RemotePost | null> {
  try {
    const normalizedUrl = instanceUrl.replace(/\/$/, '');

    const response = await fetch(`${normalizedUrl}/api/v1/posts/${postId}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return null;
    }

    const post = (await response.json()) as Record<string, unknown>;
    return {
      ...post,
      instance_url: normalizedUrl,
    } as RemotePost;
  } catch {
    return null;
  }
}

/**
 * Fetch hives from a remote instance
 */
export async function fetchRemoteHives(
  instanceUrl: string,
  options: { limit?: number; offset?: number } = {}
): Promise<unknown[]> {
  try {
    const normalizedUrl = instanceUrl.replace(/\/$/, '');
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));

    const response = await fetch(`${normalizedUrl}/api/v1/hives?${params}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenHive/0.2.0 Federation',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { data?: unknown[] };
    const hives = data.data || [];

    return hives.map((hive) => ({
      ...(hive as Record<string, unknown>),
      instance_url: normalizedUrl,
    }));
  } catch {
    return [];
  }
}
