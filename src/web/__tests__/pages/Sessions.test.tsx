import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ── Mocks ──

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockUseSessionsList = vi.fn();
const mockUseSessionsInfinite = vi.fn();
const mockUseMapSwarms = vi.fn();
const mockUseMailConversations = vi.fn();
const mockUseResource = vi.fn();
const mockUseSessionCheckpoints = vi.fn();
const mockUseSessionStats = vi.fn();
const mockUseSessionEvents = vi.fn();
const mockUseSessionParticipants = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useSessionsList: (...args: unknown[]) => mockUseSessionsList(...args),
  useSessionsInfinite: (...args: unknown[]) => mockUseSessionsInfinite(...args),
  useMapSwarms: () => mockUseMapSwarms(),
  useMailConversations: (...args: unknown[]) => mockUseMailConversations(...args),
  // Sessions.tsx uses useHostedSwarms to surface programmatic-mode
  // (mode='rpc') swarms as live threads. Default to an empty list so
  // existing test cases (none of which set hosted-chat fixtures) get
  // the same threads list they did before the integration.
  useHostedSwarms: () => ({ data: [], isLoading: false }),
  useResource: (...args: unknown[]) => mockUseResource(...args),
  useSessionCheckpoints: (...args: unknown[]) => mockUseSessionCheckpoints(...args),
  useSessionStats: (...args: unknown[]) => mockUseSessionStats(...args),
  useSessionEvents: (...args: unknown[]) => mockUseSessionEvents(...args),
  useSessionParticipants: (...args: unknown[]) => mockUseSessionParticipants(...args),
}));

vi.mock('../../hooks/useRealtimeInvalidation', () => ({
  useSessionsRealtime: vi.fn(),
}));

vi.mock('../../hooks/useWebSocket', () => ({
  useSubscribe: vi.fn(),
  useWSEvent: vi.fn(),
}));

vi.mock('../../components/sessions/MailThreadView', () => ({
  MailThreadView: () => <div data-testid="mail-thread-view" />,
}));

vi.mock('../../components/common/TimeAgo', () => ({
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

vi.mock('../../components/common/LoadingSpinner', () => ({
  PageLoader: () => <div data-testid="page-loader">Loading...</div>,
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading...</div>,
}));

vi.mock('../../components/sessions/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('../../components/common/Avatar', () => ({
  Avatar: () => <div data-testid="avatar" />,
}));

vi.mock('clsx', () => ({
  default: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Mock SessionDetail to avoid pulling in heavy deps (sigma/WebGL via transitive imports)
vi.mock('../../pages/SessionDetail', () => ({
  SessionDetail: () => <div data-testid="session-detail">SessionDetail</div>,
}));

import { Sessions } from '../../pages/Sessions';

// ── Helpers ──

function renderSessions(route = '/threads') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/threads" element={<Sessions />} />
          <Route path="/threads/:id" element={<Sessions />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const makeSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  name: 'my-project (main)',
  description: null,
  visibility: 'public',
  owner_agent_id: 'agent-1',
  last_commit_hash: null,
  last_push_at: null,
  total_checkpoints: 5,
  total_input_tokens: 1000,
  total_output_tokens: 500,
  latest_agent: 'claude',
  last_synced_at: new Date().toISOString(),
  source_swarm_id: 'swarm-1',
  source_swarm_ids: ['swarm-1'],
  ...overrides,
});

const onlineSwarm = {
  id: 'swarm-1',
  name: 'dev-swarm',
  status: 'online' as const,
  last_seen_at: new Date().toISOString(),
};

// ── Tests ──

beforeEach(() => {
  vi.clearAllMocks();

  // Default: no sessions, no swarms
  mockUseSessionsList.mockReturnValue({ data: { data: [], total: 0 }, isLoading: false });
  mockUseSessionsInfinite.mockReturnValue({
    data: { pages: [{ data: [], total: 0 }] },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
  });
  mockUseMapSwarms.mockReturnValue({ data: [] });
  mockUseMailConversations.mockReturnValue({ data: [], isLoading: false });

  // SessionDetail mocks (not exercised in most tests but needed to avoid errors)
  mockUseResource.mockReturnValue({ data: null, isLoading: false });
  mockUseSessionCheckpoints.mockReturnValue({ data: null, isLoading: false });
  mockUseSessionStats.mockReturnValue({ data: null });
  mockUseSessionEvents.mockReturnValue({ data: null, isLoading: false, fetchNextPage: vi.fn(), hasNextPage: false, isFetchingNextPage: false });
  mockUseSessionParticipants.mockReturnValue({ data: null });
});

describe('Sessions page', () => {
  describe('loading state', () => {
    it('shows page loader while sessions are loading', () => {
      mockUseSessionsList.mockReturnValue({ data: undefined, isLoading: true });
      renderSessions();
      expect(screen.getByTestId('page-loader')).toBeDefined();
    });
  });

  describe('sidebar', () => {
    it('renders sidebar with Threads heading', () => {
      renderSessions();
      expect(screen.getByText('Threads')).toBeDefined();
    });

    it('shows active sessions in sidebar', () => {
      const session = makeSession();
      mockUseSessionsList.mockReturnValue({
        data: { data: [session], total: 1 },
        isLoading: false,
      });
      mockUseMapSwarms.mockReturnValue({ data: [onlineSwarm] });
      renderSessions();

      // Sidebar shows session.name only (post-refactor — `latest_agent` moved
      // out of the sidebar item into the main grid).
      expect(screen.getAllByText('my-project (main)').length).toBeGreaterThan(0);
    });

    it('shows active session count in sidebar header', () => {
      const session = makeSession();
      mockUseSessionsList.mockReturnValue({
        data: { data: [session], total: 1 },
        isLoading: false,
      });
      mockUseMapSwarms.mockReturnValue({ data: [onlineSwarm] });
      renderSessions();

      expect(screen.getByText('(1)')).toBeDefined();
    });

    it('shows empty sidebar message when no active sessions', () => {
      renderSessions();
      expect(screen.getByText('No threads yet')).toBeDefined();
    });

    it('shows inactive section toggle', () => {
      const staleSession = makeSession({
        id: 'stale-1',
        name: 'old-project',
        source_swarm_id: null,
        last_synced_at: '2020-01-01T00:00:00Z',
      });
      mockUseSessionsInfinite.mockReturnValue({
        data: { pages: [{ data: [staleSession], total: 1 }] },
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
        isLoading: false,
      });

      renderSessions();
      expect(screen.getByText('Inactive threads (1)')).toBeDefined();
    });

    it('expands inactive section on click', () => {
      const staleSession = makeSession({
        id: 'stale-1',
        name: 'old-project',
        source_swarm_id: null,
        last_synced_at: '2020-01-01T00:00:00Z',
      });
      mockUseSessionsInfinite.mockReturnValue({
        data: { pages: [{ data: [staleSession], total: 1 }] },
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
        isLoading: false,
      });

      renderSessions();
      fireEvent.click(screen.getByText('Inactive threads (1)'));
      expect(screen.getByText('old-project')).toBeDefined();
      expect(screen.getByPlaceholderText('Search threads...')).toBeDefined();
    });
  });

  describe('auto-focus', () => {
    it('auto-navigates to first active session on /sessions', () => {
      const session = makeSession();
      mockUseSessionsList.mockReturnValue({
        data: { data: [session], total: 1 },
        isLoading: false,
      });
      mockUseMapSwarms.mockReturnValue({ data: [onlineSwarm] });
      renderSessions();

      expect(mockNavigate).toHaveBeenCalledWith('/threads/session-1', { replace: true });
    });

    it('does not auto-navigate when a session is already selected', () => {
      const session = makeSession();
      mockUseSessionsList.mockReturnValue({
        data: { data: [session], total: 1 },
        isLoading: false,
      });
      mockUseMapSwarms.mockReturnValue({ data: [onlineSwarm] });
      renderSessions('/threads/session-1');

      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not auto-navigate when no active sessions exist', () => {
      renderSessions();
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('main content area', () => {
    it('shows sessions grid when no active sessions but historical sessions exist', () => {
      const staleSession = makeSession({
        source_swarm_id: null,
        last_synced_at: '2020-01-01T00:00:00Z',
      });
      mockUseSessionsList.mockReturnValue({
        data: { data: [staleSession], total: 1 },
        isLoading: false,
      });
      renderSessions();

      // The grid shows the thread heading and count
      const headings = screen.getAllByText('Threads');
      // Sidebar heading + grid heading
      expect(headings.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('1 thread tracked.')).toBeDefined();
    });

    it('shows empty state when no sessions at all', () => {
      renderSessions();
      expect(screen.getByText('Select a thread from the sidebar')).toBeDefined();
    });

    it('shows select prompt when active sessions exist but none selected', () => {
      // With auto-navigate, this happens briefly before navigation.
      // But if navigate is mocked and doesn't actually navigate, the prompt shows.
      const session = makeSession();
      mockUseSessionsList.mockReturnValue({
        data: { data: [session], total: 1 },
        isLoading: false,
      });
      mockUseMapSwarms.mockReturnValue({ data: [onlineSwarm] });

      // Since navigate is mocked and doesn't actually change route,
      // we still render at /sessions with activeSessions > 0 => EmptyDetail
      renderSessions();
      expect(screen.getByText('Select a thread from the sidebar')).toBeDefined();
    });
  });

  describe('session status', () => {
    it('treats sessions from online swarms as active', () => {
      const session = makeSession({ source_swarm_id: 'swarm-1' });
      mockUseSessionsList.mockReturnValue({
        data: { data: [session], total: 1 },
        isLoading: false,
      });
      mockUseMapSwarms.mockReturnValue({ data: [onlineSwarm] });
      renderSessions();

      // Active session should appear in sidebar
      expect(screen.getByText('my-project (main)')).toBeDefined();
      // Should show active count
      expect(screen.getByText('(1)')).toBeDefined();
    });

    it('treats recently synced sessions as active even if swarm is offline', () => {
      const recentSession = makeSession({
        source_swarm_id: 'swarm-offline',
        last_synced_at: new Date().toISOString(), // just now
      });
      mockUseSessionsList.mockReturnValue({
        data: { data: [recentSession], total: 1 },
        isLoading: false,
      });
      mockUseMapSwarms.mockReturnValue({
        data: [{ id: 'swarm-offline', name: 'offline', status: 'offline', last_seen_at: null }],
      });
      renderSessions();

      // Should be in active section
      expect(screen.getByText('my-project (main)')).toBeDefined();
    });

    it('treats old sessions from offline swarms as stale', () => {
      const staleSession = makeSession({
        source_swarm_id: 'swarm-gone',
        last_synced_at: '2020-01-01T00:00:00Z',
      });
      mockUseSessionsList.mockReturnValue({
        data: { data: [staleSession], total: 1 },
        isLoading: false,
      });
      mockUseMapSwarms.mockReturnValue({ data: [] });

      mockUseSessionsInfinite.mockReturnValue({
        data: { pages: [{ data: [staleSession], total: 1 }] },
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
        isLoading: false,
      });

      renderSessions();

      // Should not be in active section
      expect(screen.getByText('No threads yet')).toBeDefined();
      // Should appear in inactive section
      expect(screen.getByText('Inactive threads (1)')).toBeDefined();
    });
  });

  describe('sidebar navigation', () => {
    it('navigates when clicking a session in the sidebar', () => {
      const session = makeSession();
      mockUseSessionsList.mockReturnValue({
        data: { data: [session], total: 1 },
        isLoading: false,
      });
      mockUseMapSwarms.mockReturnValue({ data: [onlineSwarm] });
      renderSessions();

      fireEvent.click(screen.getByText('my-project (main)'));
      expect(mockNavigate).toHaveBeenCalledWith('/threads/session-1');
    });
  });

  describe('load more', () => {
    it('shows load more button when more pages available', () => {
      const staleSession = makeSession({
        id: 'stale-1',
        name: 'old-project',
        source_swarm_id: null,
        last_synced_at: '2020-01-01T00:00:00Z',
      });

      const mockFetchNext = vi.fn();
      mockUseSessionsInfinite.mockReturnValue({
        data: { pages: [{ data: [staleSession], total: 5 }] },
        fetchNextPage: mockFetchNext,
        hasNextPage: true,
        isFetchingNextPage: false,
        isLoading: false,
      });

      renderSessions();
      fireEvent.click(screen.getByText('Inactive threads (5)'));
      const loadMoreBtn = screen.getByText('Load more');
      expect(loadMoreBtn).toBeDefined();

      fireEvent.click(loadMoreBtn);
      expect(mockFetchNext).toHaveBeenCalled();
    });
  });
});
