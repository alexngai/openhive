/**
 * Sidebar tabs (Details / Evolution) on the Changes page.
 *
 * Verifies the tab toggle introduced alongside StreamCascadeMap: Details is
 * the default; clicking Evolution swaps the body to the commit-centric list
 * and the cumulative-diff CTA; clicking a commit row fires the diff opener.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Heavy components rendered by Changes — stubbed so jsdom is happy.
vi.mock('../../components/streams/StreamCascadeMap', () => ({
  StreamCascadeMap: () => <div data-testid="cascade-map" />,
}));
vi.mock('../../components/cascade/DiffView', () => ({
  DiffView: ({ commitHash }: { commitHash: string }) => (
    <div data-testid="diff-view">{commitHash}</div>
  ),
}));
vi.mock('../../components/cascade/StackDiffView', () => ({
  StackDiffView: () => <div data-testid="stack-diff-view" />,
}));
vi.mock('../../components/cascade/PRStackDrawer', () => ({
  PRStackDrawer: () => <div data-testid="pr-stack-drawer" />,
}));

vi.mock('../../hooks/useRealtimeInvalidation', () => ({
  useCascadeStreamsRealtime: vi.fn(),
}));
vi.mock('../../hooks/useDispatch', () => ({
  useDispatch: () => ({ data: undefined }),
  useDispatchList: () => ({ data: { data: [] } }),
}));
vi.mock('../../hooks/useSpecs', () => ({
  useSpec: () => ({ data: undefined }),
}));
vi.mock('../../hooks/useSchedules', () => ({
  useSchedules: () => ({ data: { data: [] } }),
  getPayloadKind: (payload: { kind?: string }) =>
    payload.kind === 'dispatch_prompt' ? 'dispatch_prompt' : 'dispatch_spec',
}));

const STREAM_NODE = {
  id: 'row-1',
  stream_id: 'stream-aaaaaaaa',
  source_swarm_id: 'swarm-1',
  source_agent_id: 'worker-1',
  parent_stream_id: null,
  name: 'feature/login',
  status: 'active',
  task_resource_id: null,
  task_node_id: null,
  publish_branch: null,
  opened_at: '2026-05-20T10:00:00Z',
  last_event_at: '2026-05-21T10:00:00Z',
  commit_count: 2,
  open_conflict_count: 0,
};

const COMMIT_HASH_A = 'aaaaaaa1111122223333444455556666777788889';
const COMMIT_HASH_B = 'bbbbbbb2222233334444555566667777888899990';

const TIMELINE = [
  {
    type: 'commit',
    timestamp: '2026-05-21T08:00:00Z',
    data: {
      commit_hash: COMMIT_HASH_A,
      message_summary: 'Scaffold login route',
      author_agent_id: 'worker-1',
    },
  },
  {
    type: 'commit',
    timestamp: '2026-05-21T09:00:00Z',
    data: {
      commit_hash: COMMIT_HASH_B,
      message_summary: 'Add password hashing',
      author_agent_id: 'worker-1',
    },
  },
  {
    type: 'push',
    timestamp: '2026-05-21T09:30:00Z',
    data: { remote_ref: 'refs/heads/feature/login' },
  },
];

vi.mock('../../hooks/useApi', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useApi')>(
    '../../hooks/useApi',
  );
  return {
    ...actual,
    useCascadeDAG: () => ({
      data: { data: { nodes: [STREAM_NODE], edges: [] } },
      isLoading: false,
    }),
    useMapSwarms: () => ({ data: { data: [] } }),
    useMapSwarm: () => ({ data: { capabilities: { cascade: { canAct: true, emitsConflicts: true } } } }),
    useCascadeStreamTimeline: () => ({ data: { data: TIMELINE }, isLoading: false }),
    useCascadeStreamAction: () => ({ mutate: vi.fn(), isPending: false }),
    useCascadeStreamPR: () => ({ data: { data: null } }),
    useCreatePR: () => ({ mutate: vi.fn(), isPending: false }),
    useUpdatePR: () => ({ mutate: vi.fn(), isPending: false }),
    useClosePR: () => ({ mutate: vi.fn(), isPending: false }),
    useUpdatePublishBranch: () => ({ mutate: vi.fn(), isPending: false }),
    useGitHubStatus: () => ({ data: { data: { connected: false } } }),
    useSessionsList: () => ({ data: { data: [] } }),
  };
});

import { Changes } from '../../pages/Changes';

function renderChanges() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Changes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function openSidebar() {
  // The list shows the stream by name. Clicking the row opens the sidebar.
  fireEvent.click(screen.getByText('feature/login'));
}

describe('<Changes /> sidebar tabs', () => {
  beforeEach(() => {
    cleanup();
  });

  it('defaults to the Details tab and shows the action buttons', () => {
    renderChanges();
    openSidebar();

    const detailsTab = screen.getByRole('button', { name: 'Details' });
    const evolutionTab = screen.getByRole('button', { name: 'Evolution' });
    expect(detailsTab.getAttribute('aria-pressed')).toBe('true');
    expect(evolutionTab.getAttribute('aria-pressed')).toBe('false');

    // Details body markers — an action button is enough to confirm.
    expect(screen.getByRole('button', { name: /Abandon/ })).toBeDefined();
  });

  it('switches to Evolution and shows the commit list + cumulative-diff CTA', () => {
    renderChanges();
    openSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Evolution' }));

    expect(screen.getByRole('button', { name: 'Evolution' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-pressed')).toBe('false');

    // Cumulative-diff CTA at top of the tab.
    expect(screen.getByRole('button', { name: /View cumulative diff/ })).toBeDefined();

    // Commits heading + both commit message summaries from the mocked timeline.
    expect(screen.getByRole('heading', { name: /Commits/ })).toBeDefined();
    expect(screen.getByText('Scaffold login route')).toBeDefined();
    expect(screen.getByText('Add password hashing')).toBeDefined();

    // Non-commit events live under "Other events" so the push row should not
    // appear in the Commits section but should still be present in the tab.
    expect(screen.getByRole('heading', { name: /Other events/ })).toBeDefined();
    expect(screen.getByText(/Pushed to/)).toBeDefined();
  });

  it('clicking a commit in Evolution opens the DiffView for that hash', () => {
    renderChanges();
    openSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Evolution' }));

    // Each commit row has role="button" with title="View diff for <hash7>".
    const row = screen.getByRole('button', { name: /Scaffold login route/ });
    fireEvent.click(row);

    const diff = screen.getByTestId('diff-view');
    expect(diff.textContent).toBe(COMMIT_HASH_A);
  });

  it('Details tab still surfaces the cumulative-diff CTA via "Stream diff"', () => {
    renderChanges();
    openSidebar();
    // Default tab is Details — Stream diff button lives in the secondary row.
    expect(screen.getByRole('button', { name: /Stream diff/ })).toBeDefined();
  });
});
