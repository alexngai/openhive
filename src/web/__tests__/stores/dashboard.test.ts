import { describe, it, expect, beforeEach } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard';

describe('useDashboardStore', () => {
  beforeEach(() => {
    useDashboardStore.setState({ activities: [] });
  });

  it('starts with empty activities', () => {
    const { activities } = useDashboardStore.getState();
    expect(activities).toEqual([]);
  });

  it('adds an activity to the front of the list', () => {
    const { addActivity } = useDashboardStore.getState();

    addActivity({ id: '1', type: 'swarm_registered', message: 'First', timestamp: '2025-01-01T00:00:00Z' });
    addActivity({ id: '2', type: 'swarm_spawned', message: 'Second', timestamp: '2025-01-01T00:01:00Z' });

    const { activities } = useDashboardStore.getState();
    expect(activities.length).toBe(2);
    expect(activities[0].message).toBe('Second');
    expect(activities[1].message).toBe('First');
  });

  it('caps activities at 50 items', () => {
    const { addActivity } = useDashboardStore.getState();

    for (let i = 0; i < 60; i++) {
      addActivity({ id: String(i), type: 'test', message: `Event ${i}`, timestamp: new Date().toISOString() });
    }

    const { activities } = useDashboardStore.getState();
    expect(activities.length).toBe(50);
    // Most recent should be first
    expect(activities[0].message).toBe('Event 59');
  });

  it('clears all activities', () => {
    const store = useDashboardStore.getState();
    store.addActivity({ id: '1', type: 'test', message: 'test', timestamp: '2025-01-01T00:00:00Z' });
    store.addActivity({ id: '2', type: 'test', message: 'test2', timestamp: '2025-01-01T00:00:00Z' });

    store.clearActivities();

    const { activities } = useDashboardStore.getState();
    expect(activities).toEqual([]);
  });
});
