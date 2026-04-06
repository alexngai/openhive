import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mapHubEvents } from '../../map/service.js';

/**
 * Tests for event emissions added to existing OpenHive modules
 * for the SwarmCraft bridge integration.
 */

describe('SwarmCraft Bridge Event Emissions', () => {
  let events: Array<{ name: string; args: unknown[] }>;

  beforeEach(() => {
    events = [];
    // Spy on emit to capture all events
    vi.spyOn(mapHubEvents, 'emit').mockImplementation(((event: string, ...args: unknown[]) => {
      events.push({ name: event, args });
      return true;
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('mapHubEvents', () => {
    it('should be an EventEmitter instance', () => {
      expect(mapHubEvents).toBeDefined();
      expect(typeof mapHubEvents.on).toBe('function');
      expect(typeof mapHubEvents.emit).toBe('function');
      expect(typeof mapHubEvents.removeListener).toBe('function');
    });
  });

  describe('expected event types', () => {
    it('should support swarm_registered event (pre-existing)', () => {
      mapHubEvents.emit('swarm_registered', {
        swarm_id: 'test-swarm',
        name: 'Test Swarm',
        map_endpoint: 'ws://localhost:8080',
      });
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('swarm_registered');
    });

    it('should support node_registered event (new)', () => {
      mapHubEvents.emit('node_registered', {
        node_id: 'node-1',
        swarm_id: 'swarm-1',
        map_agent_id: 'agent-1',
        name: 'Test Agent',
        role: 'worker',
        state: 'active',
      });
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('node_registered');
    });

    it('should support swarm_offline event (new)', () => {
      mapHubEvents.emit('swarm_offline', { swarm_id: 'swarm-1' });
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('swarm_offline');
    });

    it('should support trajectory_checkpoint event (new)', () => {
      mapHubEvents.emit('trajectory_checkpoint', {
        session_resource_id: 'res-1',
        checkpoint_id: 'cp-1',
        agent: 'sidecar',
        branch: 'main',
        files_touched: ['src/index.ts'],
        projectPath: '/Users/test/project',
        source_swarm_id: 'swarm-1',
        source_agent_id: 'agent-1',
        created: true,
      });
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('trajectory_checkpoint');
      const payload = events[0].args[0] as Record<string, unknown>;
      expect(payload.projectPath).toBe('/Users/test/project');
    });

    it('should support task_assigned event (new)', () => {
      mapHubEvents.emit('task_assigned', {
        task_id: 'task-1',
        title: 'Build feature',
        description: 'Implement the thing',
        priority: 'high',
        assigned_by: 'agent-1',
        assigned_to_swarm: 'swarm-2',
        source_swarm_id: 'swarm-1',
      });
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('task_assigned');
    });

    it('should support task_status_changed event (new)', () => {
      mapHubEvents.emit('task_status_changed', {
        task_id: 'task-1',
        status: 'completed',
        progress: 100,
        result: { output: 'done' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('task_status_changed');
    });

    it('should support resource_published event (new)', () => {
      mapHubEvents.emit('resource_published', {
        resource_id: 'res-1',
        resource_type: 'memory_bank',
        name: 'Agent Memory',
        owner_agent_id: 'agent-1',
      });
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('resource_published');
    });

    it('should support resource_updated event (new)', () => {
      mapHubEvents.emit('resource_updated', {
        resource_id: 'res-1',
        fields: { name: 'Updated Name' },
        owner_agent_id: 'agent-1',
      });
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('resource_updated');
    });

    it('should support resource_synced event (new)', () => {
      mapHubEvents.emit('resource_synced', {
        resource_id: 'res-1',
        commit_hash: 'abc123',
        pusher_agent_id: 'agent-1',
      });
      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('resource_synced');
    });
  });
});
