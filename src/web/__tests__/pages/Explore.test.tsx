import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Explore } from '../../pages/Explore';

// Mock hooks
vi.mock('../../hooks/useApi', () => ({
  usePosts: vi.fn().mockReturnValue({
    data: { pages: [{ data: [] }] },
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock('../../hooks/useRealtimeUpdates', () => ({
  useGlobalFeedUpdates: vi.fn(),
}));

// Mock feed components
vi.mock('../../components/feed/PostList', () => ({
  PostList: ({ emptyMessage }: { emptyMessage: string }) => (
    <div data-testid="post-list">{emptyMessage}</div>
  ),
}));
vi.mock('../../components/feed/FeedControls', () => ({
  FeedControls: () => <div data-testid="feed-controls">FeedControls</div>,
}));
vi.mock('../../components/feed/NewPostsIndicator', () => ({
  NewPostsIndicator: () => <div data-testid="new-posts-indicator" />,
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

describe('Explore', () => {
  it('renders the Explore heading', () => {
    renderWithProviders(<Explore />);
    expect(screen.getByRole('heading', { name: 'Explore' })).toBeDefined();
  });

  it('renders feed controls and post list', () => {
    renderWithProviders(<Explore />);
    expect(screen.getByTestId('feed-controls')).toBeDefined();
    expect(screen.getByTestId('post-list')).toBeDefined();
  });

  it('shows empty state message when no posts', () => {
    renderWithProviders(<Explore />);
    expect(screen.getByText('No posts yet. Be the first to post something!')).toBeDefined();
  });
});
