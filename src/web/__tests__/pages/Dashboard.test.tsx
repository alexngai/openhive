import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dashboard } from '../../pages/Dashboard';

// Mock all dashboard section components to isolate Dashboard page tests
vi.mock('../../components/dashboard/StatsOverview', () => ({
  StatsOverview: () => <div data-testid="stats-overview">StatsOverview</div>,
}));
vi.mock('../../components/dashboard/SwarmStatusSummary', () => ({
  SwarmStatusSummary: () => <div data-testid="swarm-status-summary">SwarmStatusSummary</div>,
}));
vi.mock('../../components/dashboard/SyncResourcesStatus', () => ({
  SyncResourcesStatus: () => <div data-testid="sync-resources-status">SyncResourcesStatus</div>,
}));
vi.mock('../../components/dashboard/RecentActivity', () => ({
  RecentActivity: () => <div data-testid="recent-activity">RecentActivity</div>,
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

describe('Dashboard', () => {
  it('renders the Dashboard heading', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeDefined();
  });

  it('renders quick action links to /swarms', () => {
    renderWithProviders(<Dashboard />);
    const links = screen.getAllByRole('link');
    const spawnLink = links.find((l) => l.textContent?.includes('Spawn'));
    const connectLink = links.find((l) => l.textContent?.includes('Connect'));

    expect(spawnLink).toBeDefined();
    expect(spawnLink!.getAttribute('href')).toBe('/swarms?action=spawn');
    expect(connectLink).toBeDefined();
    expect(connectLink!.getAttribute('href')).toBe('/swarms?action=connect');
  });

  it('renders all dashboard sections', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId('stats-overview')).toBeDefined();
    expect(screen.getByTestId('swarm-status-summary')).toBeDefined();
    expect(screen.getByTestId('sync-resources-status')).toBeDefined();
    expect(screen.getByTestId('recent-activity')).toBeDefined();
  });
});
