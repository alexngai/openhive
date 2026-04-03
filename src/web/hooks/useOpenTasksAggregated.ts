/**
 * Aggregated OpenTasks hook for SwarmCraft integration.
 *
 * Queries all task-type resources, fetches their OpenTasks graph nodes,
 * and maps them to SwarmCraft's Task type for the kanban UI.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { SyncableResource, OpenTasksGraphNode } from '../lib/api';

// SwarmCraft Task type (matches swarmcraft/ui/types/map.ts)
type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

interface SCTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignedAgentId: string | null;
  parentTaskId: string | null;
  priority: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  result: unknown | null;
}

// ── Status mapping ──────────────────────────────────────────────────────

function mapOpenTasksStatus(status?: string): TaskStatus {
  switch (status) {
    case 'open': return 'pending';
    case 'in_progress': return 'in_progress';
    case 'blocked': return 'assigned';
    case 'completed': return 'completed';
    case 'closed': return 'completed';
    case 'failed': return 'failed';
    default: return 'pending';
  }
}

function mapToSCTask(node: OpenTasksGraphNode, resourceId: string): SCTask {
  return {
    id: `${resourceId}:${node.id}`,
    title: node.title || node.id,
    description: (node.description as string) || null,
    status: mapOpenTasksStatus(node.status),
    assignedAgentId: (node.assignee as string) || null,
    parentTaskId: null,
    priority: node.priority ?? 2,
    createdAt: node.created_at ? new Date(node.created_at).getTime() : Date.now(),
    startedAt: node.status === 'in_progress' && node.updated_at
      ? new Date(node.updated_at).getTime() : null,
    completedAt: (node.status === 'completed' || node.status === 'closed') && node.updated_at
      ? new Date(node.updated_at).getTime() : null,
    result: null,
  };
}

// Parse composite ID back to resourceId + nodeId
function parseTaskId(compositeId: string): { resourceId: string; nodeId: string } {
  const idx = compositeId.indexOf(':');
  if (idx === -1) return { resourceId: '', nodeId: compositeId };
  return { resourceId: compositeId.slice(0, idx), nodeId: compositeId.slice(idx + 1) };
}

// ── Main hook ───────────────────────────────────────────────────────────

export function useOpenTasksAggregated() {
  const queryClient = useQueryClient();

  // Step 1: Get all task-type resources
  const { data: resourcesData } = useQuery({
    queryKey: ['resources', { type: 'task', limit: 50 }],
    queryFn: () => api.get<{ data: SyncableResource[]; total: number }>('/resources?type=task&limit=50'),
  });

  const resources = resourcesData?.data ?? [];
  const resourceIds = resources.map(r => r.id);

  // Step 2: Fetch tasks from each resource's OpenTasks graph
  const { data: allTasks = [], isLoading } = useQuery({
    queryKey: ['opentasks-aggregated', resourceIds],
    queryFn: async () => {
      if (resourceIds.length === 0) return [];

      // Fetch sequentially to avoid bursting the rate limiter
      const allResults: SCTask[] = [];
      for (const id of resourceIds) {
        try {
          const resp = await api.get<{ items: OpenTasksGraphNode[]; daemon_connected: boolean }>(
            `/resources/${id}/content/opentasks/tasks?limit=200`,
          );
          const tasks = (resp.items || [])
            .filter((n: OpenTasksGraphNode) => n.type === 'task')
            .map((n: OpenTasksGraphNode) => mapToSCTask(n, id));
          allResults.push(...tasks);
        } catch {
          // skip failed resources
        }
      }
      return allResults;
    },
    enabled: resourceIds.length > 0,
    staleTime: 10_000,
  });

  // Step 3: Mutations

  const createTask = useMutation({
    mutationFn: async (params: { title: string; description?: string }) => {
      // Create in the first available task resource
      const targetId = resourceIds[0];
      if (!targetId) throw new Error('No task resource available');
      return api.post<{ node_id: string; status: string }>(
        `/resources/${targetId}/content/opentasks/tasks`,
        { title: params.title, description: params.description, status: 'open' },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['opentasks-aggregated'] });
      for (const id of resourceIds) {
        queryClient.invalidateQueries({ queryKey: ['opentasks-summary', id] });
        queryClient.invalidateQueries({ queryKey: ['opentasks-graph', id] });
      }
    },
  });

  const updateTaskStatus = useMutation({
    mutationFn: async (params: { taskId: string; status: string }) => {
      const { resourceId, nodeId } = parseTaskId(params.taskId);
      if (!resourceId) throw new Error('Invalid task ID');
      return api.patch<{ node_id: string; new_status: string }>(
        `/resources/${resourceId}/content/opentasks/tasks/${nodeId}`,
        { status: params.status },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['opentasks-aggregated'] });
    },
  });

  return {
    tasks: allTasks,
    isLoading,
    resourceCount: resources.length,

    createTask: async (title: string, description?: string): Promise<SCTask> => {
      const result = await createTask.mutateAsync({ title, description });
      return {
        id: `${resourceIds[0]}:${result.node_id}`,
        title,
        description: description || null,
        status: 'pending',
        assignedAgentId: null,
        parentTaskId: null,
        priority: 2,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        result: null,
      };
    },

    assignTask: async (taskId: string, agentId: string): Promise<void> => {
      // OpenTasks doesn't have a direct assign endpoint via the REST API,
      // so we update the task metadata. For now, this is a no-op placeholder
      // since the kanban UI primarily uses status transitions.
      void taskId;
      void agentId;
    },

    updateStatus: async (taskId: string, status: string): Promise<void> => {
      await updateTaskStatus.mutateAsync({ taskId, status });
    },
  };
}
