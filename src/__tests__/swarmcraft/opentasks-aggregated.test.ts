import { describe, it, expect } from 'vitest';

/**
 * Tests for the OpenTasks status mapping and resource filtering
 * used by useOpenTasksAggregated.
 * (The hook itself is a React component tested separately in web tests.)
 */

describe('OpenTasks Status Mapping', () => {
  // Maps OpenTasks statuses to SwarmCraft TaskStatus
  function mapOpenTasksStatus(status?: string): string {
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

  it('should map open to pending', () => {
    expect(mapOpenTasksStatus('open')).toBe('pending');
  });

  it('should map in_progress to in_progress', () => {
    expect(mapOpenTasksStatus('in_progress')).toBe('in_progress');
  });

  it('should map blocked to assigned', () => {
    expect(mapOpenTasksStatus('blocked')).toBe('assigned');
  });

  it('should map completed to completed', () => {
    expect(mapOpenTasksStatus('completed')).toBe('completed');
  });

  it('should map closed to completed', () => {
    expect(mapOpenTasksStatus('closed')).toBe('completed');
  });

  it('should map failed to failed', () => {
    expect(mapOpenTasksStatus('failed')).toBe('failed');
  });

  it('should default undefined to pending', () => {
    expect(mapOpenTasksStatus(undefined)).toBe('pending');
  });

  it('should default unknown to pending', () => {
    expect(mapOpenTasksStatus('something_else')).toBe('pending');
  });

  // Composite ID parsing used by the hook
  function parseTaskId(compositeId: string): { resourceId: string; nodeId: string } {
    const idx = compositeId.indexOf(':');
    if (idx === -1) return { resourceId: '', nodeId: compositeId };
    return { resourceId: compositeId.slice(0, idx), nodeId: compositeId.slice(idx + 1) };
  }

  describe('parseTaskId', () => {
    it('should split on first colon', () => {
      const { resourceId, nodeId } = parseTaskId('res_abc:node_123');
      expect(resourceId).toBe('res_abc');
      expect(nodeId).toBe('node_123');
    });

    it('should handle node IDs with colons', () => {
      const { resourceId, nodeId } = parseTaskId('res_abc:node:with:colons');
      expect(resourceId).toBe('res_abc');
      expect(nodeId).toBe('node:with:colons');
    });

    it('should handle missing colon', () => {
      const { resourceId, nodeId } = parseTaskId('plain-id');
      expect(resourceId).toBe('');
      expect(nodeId).toBe('plain-id');
    });
  });

  // Resource filtering — only resources with local_path or local sync_strategy
  // should be queried for opentasks content (prevents 404s for remote resources)
  describe('Resource filtering', () => {
    // Mirrors the filter in useOpenTasksAggregated
    function filterAccessibleResources(
      resources: Array<{ id: string; local_path?: string | null; sync_strategy?: string }>,
    ) {
      return resources.filter((r) => r.local_path || r.sync_strategy === 'local');
    }

    it('should include resources with local_path set', () => {
      const resources = [
        { id: 'r1', local_path: '/some/path', sync_strategy: 'metadata' },
        { id: 'r2', local_path: null, sync_strategy: 'metadata' },
      ];
      const result = filterAccessibleResources(resources);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('r1');
    });

    it('should include resources with local sync_strategy', () => {
      const resources = [
        { id: 'r1', local_path: null, sync_strategy: 'local' },
        { id: 'r2', local_path: null, sync_strategy: 'ls-remote' },
      ];
      const result = filterAccessibleResources(resources);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('r1');
    });

    it('should exclude resources with no local_path and remote sync_strategy', () => {
      const resources = [
        { id: 'r1', local_path: null, sync_strategy: 'ls-remote' },
        { id: 'r2', local_path: null, sync_strategy: 'mirror' },
        { id: 'r3', sync_strategy: 'metadata' },
      ];
      const result = filterAccessibleResources(resources);
      expect(result).toHaveLength(0);
    });

    it('should include both local_path and local sync_strategy resources', () => {
      const resources = [
        { id: 'r1', local_path: '/path/a' },
        { id: 'r2', sync_strategy: 'local' },
        { id: 'r3', local_path: null, sync_strategy: 'mirror' },
      ];
      const result = filterAccessibleResources(resources);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.id)).toEqual(['r1', 'r2']);
    });
  });
});
