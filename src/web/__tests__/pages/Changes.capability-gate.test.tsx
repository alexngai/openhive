/**
 * Phase 4: capability-gating the cascade "Changes" UI.
 *
 * The cascade action controls (Merge / Pause / Abandon / Force-resolve in
 * StreamActions, the Push button in StreamBranchSection, and Commit in
 * StreamCommitSection) are gated per-stream on the owning swarm's
 * `capabilities.cascade.canAct`. An observe-only swarm (cc-swarm declares
 * `canAct: false`) renders them disabled with a reason; a full-control swarm
 * (macro-agent declares `canAct: true`) renders them enabled exactly as today.
 *
 * The gate keys on each stream's `source_swarm_id` — verified by driving
 * `useMapSwarm` to return different capability blocks per test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Heavy / WebGL components rendered by Changes — stubbed so jsdom is happy.
vi.mock('../../components/streams/StreamCascadeMap', () => ({
  StreamCascadeMap: () => <div data-testid="cascade-map" />,
}));
vi.mock('../../components/cascade/DiffView', () => ({
  DiffView: () => <div data-testid="diff-view" />,
}));
vi.mock('../../components/cascade/StackDiffView', () => ({
  StackDiffView: () => <div data-testid="stack-diff-view" />,
}));
vi.mock('../../components/cascade/PRStackDrawer', () => ({
  PRStackDrawer: () => <div data-testid="pr-stack-drawer" />,
}));

// Realtime invalidation — no-op in tests.
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

// One active stream owned by `swarm-observe` (the gate target).
const STREAM_NODE = {
  id: 'row-1',
  stream_id: 'stream-aaaaaaaa',
  source_swarm_id: 'swarm-observe',
  source_agent_id: 'worker-1',
  parent_stream_id: 'parent-stream',
  name: 'feature/login',
  status: 'active',
  task_resource_id: null,
  task_node_id: null,
  publish_branch: null,
  opened_at: '2026-05-20T10:00:00Z',
  last_event_at: '2026-05-21T10:00:00Z',
  commit_count: 3,
  open_conflict_count: 0,
};

// Per-test override for the swarm `useMapSwarm` resolves to.
let mockSwarm: { capabilities: Record<string, unknown> | null } | undefined;

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
    useMapSwarm: (id: string) => ({
      // Echo back the per-test swarm only for the stream's owning swarm so
      // the gate is exercised on `source_swarm_id` specifically.
      data: id === 'swarm-observe' ? mockSwarm : undefined,
    }),
    useCascadeStreamTimeline: () => ({ data: { data: [] }, isLoading: false }),
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

/** Open the detail sidebar by clicking the single stream row. */
function openSidebar() {
  const row = screen.getByText('feature/login');
  fireEvent.click(row);
}

function actionButton(name: RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

describe('<Changes /> cascade capability gate', () => {
  beforeEach(() => {
    cleanup();
    mockSwarm = undefined;
  });

  describe('observe-only swarm (cascade.canAct = false)', () => {
    beforeEach(() => {
      mockSwarm = {
        capabilities: { cascade: { canServeDiff: true, canAct: false, emitsConflicts: false } },
      };
    });

    it('disables the Merge / Pause / Abandon action buttons', () => {
      renderChanges();
      openSidebar();
      expect(actionButton(/Merge/).disabled).toBe(true);
      expect(actionButton(/Pause/).disabled).toBe(true);
      expect(actionButton(/Abandon/).disabled).toBe(true);
    });

    it('surfaces the observe-only reason as a note + button tooltip', () => {
      renderChanges();
      openSidebar();
      expect(screen.getByText(/observe-only/i)).toBeDefined();
      expect(actionButton(/Pause/).title).toMatch(/observe-only/i);
    });

    it('disables the Commit changes button', () => {
      renderChanges();
      openSidebar();
      expect(actionButton(/Commit changes/).disabled).toBe(true);
    });
  });

  describe('full-control swarm (cascade.canAct = true)', () => {
    beforeEach(() => {
      mockSwarm = {
        capabilities: { cascade: { canServeDiff: true, canAct: true, emitsConflicts: true } },
      };
    });

    it('enables the Merge / Pause / Abandon action buttons', () => {
      renderChanges();
      openSidebar();
      expect(actionButton(/Merge/).disabled).toBe(false);
      expect(actionButton(/Pause/).disabled).toBe(false);
      expect(actionButton(/Abandon/).disabled).toBe(false);
    });

    it('does not render the observe-only note', () => {
      renderChanges();
      openSidebar();
      expect(screen.queryByText(/observe-only/i)).toBeNull();
    });

    it('enables the Commit changes button', () => {
      renderChanges();
      openSidebar();
      expect(actionButton(/Commit changes/).disabled).toBe(false);
    });
  });

  describe('swarm with no cascade block declared', () => {
    beforeEach(() => {
      mockSwarm = { capabilities: { mail: { canJoin: true } } };
    });

    it('treats a missing cascade block as not-capable (actions disabled)', () => {
      renderChanges();
      openSidebar();
      expect(actionButton(/Pause/).disabled).toBe(true);
      expect(actionButton(/Abandon/).disabled).toBe(true);
    });

    it('shows the "does not report cascade conflicts" note in the sidebar', () => {
      renderChanges();
      openSidebar();
      expect(screen.getByText(/does not report cascade conflicts/i)).toBeDefined();
    });
  });
});
