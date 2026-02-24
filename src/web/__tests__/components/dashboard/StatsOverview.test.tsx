import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatsOverview } from '../../../components/dashboard/StatsOverview';

const mockMapStats = {
  swarms: { total: 12, online: 8, offline: 4 },
  nodes: { total: 34, active: 28 },
  hive_memberships: 5,
  preauth_keys: { total: 3, active: 2 },
};

vi.mock('../../../hooks/useApi', () => ({
  useMapStats: vi.fn().mockReturnValue({
    data: {
      swarms: { total: 12, online: 8, offline: 4 },
      nodes: { total: 34, active: 28 },
      hive_memberships: 5,
      preauth_keys: { total: 3, active: 2 },
    },
    isLoading: false,
  }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe('StatsOverview', () => {
  it('renders four stat cards', () => {
    renderWithQuery(<StatsOverview />);
    expect(screen.getByText('Total Swarms')).toBeDefined();
    expect(screen.getByText('Online')).toBeDefined();
    expect(screen.getByText('Agents')).toBeDefined();
    expect(screen.getByText('Hive Links')).toBeDefined();
  });

  it('displays correct stat values', () => {
    renderWithQuery(<StatsOverview />);
    expect(screen.getByText('12')).toBeDefined(); // total swarms
    expect(screen.getByText('8')).toBeDefined();  // online
    expect(screen.getByText('34')).toBeDefined(); // agents
    expect(screen.getByText('5')).toBeDefined();  // hive links
  });

  it('shows loading skeleton when data is loading', async () => {
    const { useMapStats } = await import('../../../hooks/useApi');
    (useMapStats as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    const { container } = renderWithQuery(<StatsOverview />);
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBe(4);
  });
});
