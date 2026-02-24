import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Routes, Route } from 'react-router-dom';
import { Dashboard } from '../pages/Dashboard';
import { Explore } from '../pages/Explore';

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

// Mock feed components
vi.mock('../hooks/useApi', () => ({
  usePosts: vi.fn().mockReturnValue({
    data: { pages: [{ data: [] }] },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
}));
vi.mock('../hooks/useRealtimeUpdates', () => ({
  useGlobalFeedUpdates: vi.fn(),
}));
vi.mock('../components/feed/PostList', () => ({
  PostList: () => <div>PostList</div>,
}));
vi.mock('../components/feed/FeedControls', () => ({
  FeedControls: () => <div>FeedControls</div>,
}));
vi.mock('../components/feed/NewPostsIndicator', () => ({
  NewPostsIndicator: () => <div />,
}));

function renderRoute(initialRoute: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="explore" element={<Explore />} />
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

  it('renders Explore at /explore', () => {
    renderRoute('/explore');
    expect(screen.getByRole('heading', { name: 'Explore' })).toBeDefined();
  });

  it('does not render forum feed at /', () => {
    renderRoute('/');
    expect(screen.queryByText('PostList')).toBeNull();
  });
});
