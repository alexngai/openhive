import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SwarmStatusSummary } from '../../../components/dashboard/SwarmStatusSummary';

const mockUseHostedSwarms = vi.fn();
const mockUseMapSwarms = vi.fn();

vi.mock('../../../hooks/useApi', () => ({
  useHostedSwarms: (...args: unknown[]) => mockUseHostedSwarms(...args),
  useMapSwarms: (...args: unknown[]) => mockUseMapSwarms(...args),
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SwarmStatusSummary', () => {
  it('shows empty state when no swarms exist', () => {
    mockUseHostedSwarms.mockReturnValue({ data: [] });
    mockUseMapSwarms.mockReturnValue({ data: [] });

    renderWithProviders(<SwarmStatusSummary />);
    expect(screen.getByText('No swarms connected')).toBeDefined();
    expect(screen.getByText('Connect a swarm')).toBeDefined();
  });

  it('renders hosted swarms with state badges', () => {
    mockUseHostedSwarms.mockReturnValue({
      data: [
        { id: 'swarm-alpha', state: 'running', provider: 'local', created_at: '2025-01-01T00:00:00Z' },
        { id: 'swarm-beta', state: 'stopped', provider: 'docker', created_at: '2025-01-01T00:00:00Z' },
      ],
    });
    mockUseMapSwarms.mockReturnValue({ data: [] });

    renderWithProviders(<SwarmStatusSummary />);
    expect(screen.getByText('swarm-alpha')).toBeDefined();
    expect(screen.getByText('swarm-beta')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByText('Stopped')).toBeDefined();
  });

  it('renders map swarms with status badges', () => {
    mockUseHostedSwarms.mockReturnValue({ data: [] });
    mockUseMapSwarms.mockReturnValue({
      data: [
        {
          id: 'ext-1', name: 'external-swarm', status: 'online', agent_count: 5,
          map_endpoint: 'ws://localhost:3000', created_at: '2025-01-01T00:00:00Z',
        },
      ],
    });

    renderWithProviders(<SwarmStatusSummary />);
    expect(screen.getByText('external-swarm')).toBeDefined();
    expect(screen.getByText('Online')).toBeDefined();
    expect(screen.getByText('registered')).toBeDefined();
  });

  it('shows combined total count', () => {
    mockUseHostedSwarms.mockReturnValue({
      data: [{ id: 'h1', state: 'running', created_at: '2025-01-01T00:00:00Z' }],
    });
    mockUseMapSwarms.mockReturnValue({
      data: [
        { id: 'm1', name: 'map1', status: 'online', agent_count: 2, created_at: '2025-01-01T00:00:00Z' },
      ],
    });

    renderWithProviders(<SwarmStatusSummary />);
    expect(screen.getByText('2 total')).toBeDefined();
  });

  it('sorts swarms by status priority (running/online first)', () => {
    mockUseHostedSwarms.mockReturnValue({
      data: [
        { id: 'stopped-swarm', state: 'stopped', created_at: '2025-01-01T00:00:00Z' },
        { id: 'running-swarm', state: 'running', created_at: '2025-01-01T00:00:00Z' },
      ],
    });
    mockUseMapSwarms.mockReturnValue({ data: [] });

    renderWithProviders(<SwarmStatusSummary />);
    const names = screen.getAllByText(/swarm/).map((el) => el.textContent);
    // running-swarm should appear before stopped-swarm
    const runningIdx = names.indexOf('running-swarm');
    const stoppedIdx = names.indexOf('stopped-swarm');
    expect(runningIdx).toBeLessThan(stoppedIdx);
  });

  it('limits display to 8 swarms', () => {
    const hosted = Array.from({ length: 10 }, (_, i) => ({
      id: `swarm-${i}`, state: 'running' as const, created_at: '2025-01-01T00:00:00Z',
    }));
    mockUseHostedSwarms.mockReturnValue({ data: hosted });
    mockUseMapSwarms.mockReturnValue({ data: [] });

    renderWithProviders(<SwarmStatusSummary />);
    const hostedLabels = screen.getAllByText('hosted');
    expect(hostedLabels.length).toBe(8);
  });

  it('contains a "View all swarms" link to /swarms', () => {
    mockUseHostedSwarms.mockReturnValue({
      data: [{ id: 's1', state: 'running', created_at: '2025-01-01T00:00:00Z' }],
    });
    mockUseMapSwarms.mockReturnValue({ data: [] });

    renderWithProviders(<SwarmStatusSummary />);
    const link = screen.getByText('View all swarms');
    expect(link.closest('a')!.getAttribute('href')).toBe('/swarms');
  });
});
