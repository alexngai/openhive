/**
 * Integration Test: Coordination Inbound Task Flow
 *
 * Tests the inbound path for swarm task events:
 *   MAP scope message → isMapTaskEvent() → handleMapTaskEvent()
 *   → mapHubEvents emitted (task_assigned / task_status_changed)
 *
 * The hub is a relay — it emits events for internal consumers and broadcasts
 * to WebSocket subscribers. It does NOT persist task state (agents own their
 * own graphs via local OpenTasks daemons).
 */

import { describe, it, expect, vi } from 'vitest';
import { isMapTaskEvent, handleMapTaskEvent } from '../../coordination/listener.js';
import { mapHubEvents } from '../../map/service.js';

// ==========================================================================
// isMapTaskEvent — Message Detection
// ==========================================================================

describe('isMapTaskEvent — message detection', () => {
  it('should recognize task.created events', () => {
    expect(isMapTaskEvent({
      payload: { type: 'task.created', task: { id: 't1', title: 'Test' } },
    })).toBe(true);
  });

  it('should recognize task.status events', () => {
    expect(isMapTaskEvent({
      payload: { type: 'task.status', taskId: 't1', current: 'completed' },
    })).toBe(true);
  });

  it('should recognize task.assigned events', () => {
    expect(isMapTaskEvent({
      payload: { type: 'task.assigned', taskId: 't1', assignee: 'agent_1' },
    })).toBe(true);
  });

  it('should reject non-task events', () => {
    expect(isMapTaskEvent({ payload: { type: 'trajectory.checkpoint' } })).toBe(false);
    expect(isMapTaskEvent({ payload: { type: 'message.sent' } })).toBe(false);
    expect(isMapTaskEvent({ type: 'task.created' })).toBe(false); // no payload wrapper
    expect(isMapTaskEvent(null)).toBe(false);
    expect(isMapTaskEvent({})).toBe(false);
  });
});

// ==========================================================================
// handleMapTaskEvent — task.created
// ==========================================================================

describe('handleMapTaskEvent — task.created', () => {
  it('should emit task_assigned hub event with task details', () => {
    const handler = vi.fn();
    mapHubEvents.on('task_assigned', handler);

    handleMapTaskEvent(
      {
        type: 'task.created',
        task: { id: 'ext_task_1', title: 'Build feature X', description: 'Full desc', assignee: 'agent_worker' },
      },
      'swarm_source',
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      task_id: 'ext_task_1',
      title: 'Build feature X',
      description: 'Full desc',
      assigned_to_swarm: 'agent_worker',
      source_swarm_id: 'swarm_source',
    });

    mapHubEvents.off('task_assigned', handler);
  });

  it('should use sourceSwarmId as assignee when task has no assignee', () => {
    const handler = vi.fn();
    mapHubEvents.on('task_assigned', handler);

    handleMapTaskEvent(
      { type: 'task.created', task: { id: 't2', title: 'Self-assigned' } },
      'swarm_self',
    );

    expect(handler.mock.calls[0][0].assigned_to_swarm).toBe('swarm_self');
    mapHubEvents.off('task_assigned', handler);
  });

  it('should ignore task.created without title', () => {
    const handler = vi.fn();
    mapHubEvents.on('task_assigned', handler);

    handleMapTaskEvent({ type: 'task.created', task: {} }, 'swarm_1');

    expect(handler).not.toHaveBeenCalled();
    mapHubEvents.off('task_assigned', handler);
  });
});

// ==========================================================================
// handleMapTaskEvent — task.status
// ==========================================================================

describe('handleMapTaskEvent — task.status', () => {
  it('should emit task_status_changed hub event', () => {
    const handler = vi.fn();
    mapHubEvents.on('task_status_changed', handler);

    handleMapTaskEvent(
      { type: 'task.status', taskId: 'task_abc', previous: 'open', current: 'completed' },
      'swarm_source',
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      task_id: 'task_abc',
      status: 'completed',
      previous: 'open',
    });

    mapHubEvents.off('task_status_changed', handler);
  });

  it('should ignore task.status without taskId or current', () => {
    const handler = vi.fn();
    mapHubEvents.on('task_status_changed', handler);

    handleMapTaskEvent({ type: 'task.status', current: 'completed' }, 'swarm_1'); // missing taskId
    handleMapTaskEvent({ type: 'task.status', taskId: 'abc' }, 'swarm_1'); // missing current

    expect(handler).not.toHaveBeenCalled();
    mapHubEvents.off('task_status_changed', handler);
  });
});

// ==========================================================================
// handleMapTaskEvent — task.assigned
// ==========================================================================

describe('handleMapTaskEvent — task.assigned', () => {
  it('should emit task_assigned hub event', () => {
    const handler = vi.fn();
    mapHubEvents.on('task_assigned', handler);

    handleMapTaskEvent(
      { type: 'task.assigned', taskId: 'task_abc', assignee: 'agent_worker_2' },
      'swarm_source',
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toMatchObject({
      task_id: 'task_abc',
      assigned_to_swarm: 'agent_worker_2',
      source_swarm_id: 'swarm_source',
    });

    mapHubEvents.off('task_assigned', handler);
  });

  it('should ignore task.assigned without taskId', () => {
    const handler = vi.fn();
    mapHubEvents.on('task_assigned', handler);

    handleMapTaskEvent({ type: 'task.assigned', assignee: 'agent_1' }, 'swarm_source');

    expect(handler).not.toHaveBeenCalled();
    mapHubEvents.off('task_assigned', handler);
  });
});

// ==========================================================================
// Full Inbound Flow
// ==========================================================================

describe('Full Inbound Flow — event ordering', () => {
  it('task.created → task.status(accepted) → task.status(completed) emits events in order', () => {
    const events: Array<{ event: string; data: any }> = [];
    const onAssigned = (d: any) => events.push({ event: 'task_assigned', data: d });
    const onStatus = (d: any) => events.push({ event: 'task_status_changed', data: d });
    mapHubEvents.on('task_assigned', onAssigned);
    mapHubEvents.on('task_status_changed', onStatus);

    // Step 1: task.created
    handleMapTaskEvent(
      {
        type: 'task.created',
        task: { id: 'lifecycle_1', title: 'Lifecycle task', assignee: 'worker' },
      },
      'agent_lead',
    );

    // Step 2: task.status(accepted)
    handleMapTaskEvent(
      { type: 'task.status', taskId: 'lifecycle_1', previous: 'open', current: 'accepted' },
      'agent_worker',
    );

    // Step 3: task.status(completed)
    handleMapTaskEvent(
      { type: 'task.status', taskId: 'lifecycle_1', previous: 'in_progress', current: 'completed' },
      'agent_worker',
    );

    expect(events.length).toBe(3);
    expect(events[0].event).toBe('task_assigned');
    expect(events[0].data.title).toBe('Lifecycle task');
    expect(events[1].event).toBe('task_status_changed');
    expect(events[1].data.status).toBe('accepted');
    expect(events[2].event).toBe('task_status_changed');
    expect(events[2].data.status).toBe('completed');

    mapHubEvents.off('task_assigned', onAssigned);
    mapHubEvents.off('task_status_changed', onStatus);
  });
});
