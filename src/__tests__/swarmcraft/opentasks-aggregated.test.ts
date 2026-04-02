import { describe, it, expect } from 'vitest';

/**
 * Tests for the OpenTasks status mapping used by useOpenTasksAggregated.
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
});
