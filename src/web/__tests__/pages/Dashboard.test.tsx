import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock swarmcraft embed (pulls in sigma/WebGL which isn't available in jsdom)
vi.mock('swarmcraft/ui/embed', () => ({
  SwarmCraftApp: () => <div data-testid="swarmcraft-app">SwarmCraftApp</div>,
}));

// Mock CSS import
vi.mock('swarmcraft/ui/embed.css', () => ({}));

// Mock all dashboard section components
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

// Mock hooks used by Dashboard
vi.mock('../../hooks/useApi', () => ({
  useMapSwarms: vi.fn().mockReturnValue({ data: [] }),
  useSessionsList: vi.fn().mockReturnValue({ data: [] }),
}));
vi.mock('../../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: vi.fn().mockReturnValue({ features: {} }),
}));
vi.mock('../../hooks/useOpenTasksAggregated', () => ({
  useOpenTasksAggregated: vi.fn().mockReturnValue({ tasks: [], createTask: vi.fn(), assignTask: vi.fn() }),
}));

// Mock fetch
global.fetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({}),
  ok: true,
}) as unknown as typeof fetch;

import { Dashboard } from '../../pages/Dashboard';

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

  it('renders Spawn / Connect quick action buttons (open dialogs in-place)', () => {
    // Post-refactor: these are buttons that open SpawnFormDialog /
    // ConnectFormDialog inline, not <Link>s navigating to /swarms.
    renderWithProviders(<Dashboard />);
    const buttons = screen.getAllByRole('button');
    const spawnButton = buttons.find((b) => b.textContent?.trim() === 'Spawn');
    const connectButton = buttons.find((b) => b.textContent?.trim() === 'Connect');
    expect(spawnButton).toBeDefined();
    expect(connectButton).toBeDefined();
  });

  it('renders all dashboard sections', () => {
    renderWithProviders(<Dashboard />);
    expect(screen.getByTestId('stats-overview')).toBeDefined();
    expect(screen.getByTestId('swarm-status-summary')).toBeDefined();
    expect(screen.getByTestId('sync-resources-status')).toBeDefined();
    expect(screen.getByTestId('recent-activity')).toBeDefined();
  });
});
