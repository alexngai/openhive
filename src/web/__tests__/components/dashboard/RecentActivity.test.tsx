import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentActivity } from '../../../components/dashboard/RecentActivity';
import { useDashboardStore } from '../../../stores/dashboard';

// Mock WebSocket hooks
vi.mock('../../../hooks/useWebSocket', () => ({
  useSubscribe: vi.fn(),
  useWSEvent: vi.fn(),
}));

describe('RecentActivity', () => {
  beforeEach(() => {
    // Reset the Zustand store between tests
    useDashboardStore.setState({ activities: [] });
  });

  it('shows empty state message when no activity', () => {
    render(<RecentActivity />);
    expect(screen.getByText('No recent activity. Events will appear here in real-time.')).toBeDefined();
  });

  it('renders activity items from the store', () => {
    useDashboardStore.setState({
      activities: [
        { id: '1', type: 'swarm_registered', message: 'Swarm "alpha" registered', timestamp: new Date().toISOString() },
        { id: '2', type: 'memory:sync', message: 'Memory synced (res_mem_1)', timestamp: new Date().toISOString() },
      ],
    });

    render(<RecentActivity />);
    expect(screen.getByText('Swarm "alpha" registered')).toBeDefined();
    expect(screen.getByText('Memory synced (res_mem_1)')).toBeDefined();
  });

  it('limits displayed items to 20', () => {
    const activities = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      type: 'swarm_registered',
      message: `Event ${i}`,
      timestamp: new Date().toISOString(),
    }));
    useDashboardStore.setState({ activities });

    render(<RecentActivity />);
    // Should show first 20 (items 0-19), not the full 30
    expect(screen.getByText('Event 0')).toBeDefined();
    expect(screen.getByText('Event 19')).toBeDefined();
    expect(screen.queryByText('Event 20')).toBeNull();
  });

  it('subscribes to global and map:discovery channels', async () => {
    const { useSubscribe } = await import('../../../hooks/useWebSocket');
    render(<RecentActivity />);
    expect(useSubscribe).toHaveBeenCalledWith(['global', 'map:discovery']);
  });

  it('registers WebSocket event listeners for all expected event types', async () => {
    const { useWSEvent } = await import('../../../hooks/useWebSocket');
    render(<RecentActivity />);

    const registeredEvents = (useWSEvent as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0]
    );

    expect(registeredEvents).toContain('swarm_registered');
    expect(registeredEvents).toContain('swarm_offline');
    expect(registeredEvents).toContain('node_registered');
    expect(registeredEvents).toContain('node_state_changed');
    expect(registeredEvents).toContain('swarm_spawned');
    expect(registeredEvents).toContain('swarm_stopped');
    expect(registeredEvents).toContain('memory:sync');
    expect(registeredEvents).toContain('skill:sync');
    expect(registeredEvents).toContain('resource_updated');
    expect(registeredEvents).toContain('resource_created');
  });
});
