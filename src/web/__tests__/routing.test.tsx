import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Routes, Route } from 'react-router-dom';

// Mock swarmcraft embed (pulls in sigma/WebGL)
vi.mock('swarmcraft/ui/embed', () => ({
  SwarmCraftApp: () => <div>SwarmCraftApp</div>,
}));
vi.mock('swarmcraft/ui/embed.css', () => ({}));

// Mock all dashboard section components
vi.mock('../components/dashboard/StatsOverview', () => ({
  StatsOverview: () => <div>StatsOverview</div>,
}));
vi.mock('../components/dashboard/SwarmStatusSummary', () => ({
  SwarmStatusSummary: () => <div>SwarmStatusSummary</div>,
}));
vi.mock('../components/dashboard/SyncResourcesStatus', () => ({
  SyncResourcesStatus: () => <div>SyncResourcesStatus</div>,
}));
vi.mock('../components/dashboard/RecentActivity', () => ({
  RecentActivity: () => <div>RecentActivity</div>,
}));

// Mock hooks used by Dashboard
vi.mock('../hooks/useApi', () => ({
  useMapSwarms: vi.fn().mockReturnValue({ data: [] }),
  useHostedSwarms: vi.fn().mockReturnValue({ data: undefined }),
  useSessionsList: vi.fn().mockReturnValue({ data: [] }),
}));
vi.mock('../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: vi.fn().mockReturnValue({ features: {} }),
}));
vi.mock('../hooks/useOpenTasksAggregated', () => ({
  useOpenTasksAggregated: vi.fn().mockReturnValue({ tasks: [], createTask: vi.fn(), assignTask: vi.fn() }),
}));

global.fetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({}),
  ok: true,
}) as unknown as typeof fetch;

import { Dashboard } from '../pages/Dashboard';

function renderRoute(initialRoute: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route index element={<Dashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Route Configuration', () => {
  it('renders Dashboard at / (index route)', () => {
    renderRoute('/');
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeDefined();
  });

  it('renders dashboard sections at /', () => {
    renderRoute('/');
    expect(screen.getByText('StatsOverview')).toBeDefined();
  });
});
