/**
 * MAP OpenTasks Wire Protocol Types
 *
 * JSON-RPC 2.0 methods for querying OpenTasks graphs through a MAP connection.
 * Allows remote agents to access OpenTasks stores hosted on this instance.
 *
 * Wire methods: map/opentasks/summary, map/opentasks/ready, map/opentasks/query, map/opentasks/status
 */

// ============================================================================
// JSON-RPC Method Names
// ============================================================================

export const MAP_OPENTASKS_METHODS = {
  SUMMARY: 'map/opentasks/summary',
  READY: 'map/opentasks/ready',
  QUERY: 'map/opentasks/query',
  STATUS: 'map/opentasks/status',
} as const;

export type MAPOpenTasksMethod = (typeof MAP_OPENTASKS_METHODS)[keyof typeof MAP_OPENTASKS_METHODS];

/** Set for fast lookup in ws-map.ts */
export const MAP_OPENTASKS_METHOD_SET = new Set<string>(Object.values(MAP_OPENTASKS_METHODS));

// ============================================================================
// Request Parameter Types
// ============================================================================

/**
 * Common resource targeting fields.
 * Agents can identify a resource by one of:
 * - `resource_id`: the OpenHive resource ID (e.g. "res_abc123")
 * - `path`: local filesystem path to the .opentasks directory (resolves symlinks)
 * - `name`: scoped resource name (e.g. "project/opentasks", "global/opentasks")
 *
 * At least one must be provided. Priority: resource_id > path > name.
 * When `path` is used and no matching resource exists, OpenHive will auto-register
 * the resource for the requesting agent (if the path is a valid .opentasks directory).
 * The `name` strategy is useful for remote agents that know the scope but not the path.
 */
export interface OpenTasksResourceTarget {
  resource_id?: string;
  path?: string;
  name?: string;
}

export interface OpenTasksSummaryParams extends OpenTasksResourceTarget {}

export interface OpenTasksReadyParams extends OpenTasksResourceTarget {
  limit?: number;
}

export interface OpenTasksQueryParams extends OpenTasksResourceTarget {
  filter?: {
    status?: string;
    type?: string;
    archived?: boolean;
  };
  limit?: number;
  offset?: number;
}

export interface OpenTasksStatusParams extends OpenTasksResourceTarget {}

// ============================================================================
// Response Types
// ============================================================================

export interface OpenTasksSummaryResult {
  node_count: number;
  edge_count: number;
  task_counts: {
    open: number;
    in_progress: number;
    blocked: number;
    closed: number;
  };
  context_count: number;
  feedback_count: number;
  ready_count: number;
  daemon_connected: boolean;
}

export interface OpenTasksReadyResult {
  items: Array<{
    id: string;
    type: string;
    title: string;
    status?: string;
    priority?: number;
  }>;
  total: number;
  daemon_connected: boolean;
}

export interface OpenTasksQueryResult {
  items: Array<{
    id: string;
    type: string;
    title: string;
    status?: string;
    priority?: number;
  }>;
  daemon_connected: boolean;
}

export interface OpenTasksStatusResult {
  daemon_running: boolean;
  graph_file_exists: boolean;
  graph_last_modified: string | null;
}
