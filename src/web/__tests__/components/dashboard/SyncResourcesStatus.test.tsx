import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SyncResourcesStatus } from '../../../components/dashboard/SyncResourcesStatus';

const mockUseResources = vi.fn();
const mockUseSyncStatus = vi.fn();

vi.mock('../../../hooks/useApi', () => ({
  useResources: (...args: unknown[]) => mockUseResources(...args),
  useSyncStatus: (...args: unknown[]) => mockUseSyncStatus(...args),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe('SyncResourcesStatus', () => {
  it('shows empty state when no resources exist', () => {
    mockUseResources.mockReturnValue({ data: { data: [], total: 0 } });
    mockUseSyncStatus.mockReturnValue({ data: undefined });

    renderWithQuery(<SyncResourcesStatus />);
    expect(screen.getByText('No resources registered')).toBeDefined();
  });

  it('renders resource list with names', () => {
    mockUseResources.mockReturnValue({
      data: {
        data: [
          { id: 'r1', name: 'project-memory', resource_type: 'memory_bank', last_push_at: '2025-01-15T10:00:00Z', last_commit_hash: 'abc123' },
          { id: 'r2', name: 'code-skills', resource_type: 'skill', last_push_at: null, last_commit_hash: null },
        ],
        total: 2,
      },
    });
    mockUseSyncStatus.mockReturnValue({ data: undefined });

    renderWithQuery(<SyncResourcesStatus />);
    expect(screen.getByText('project-memory')).toBeDefined();
    expect(screen.getByText('code-skills')).toBeDefined();
  });

  it('shows "never" for resources that have never synced', () => {
    mockUseResources.mockReturnValue({
      data: {
        data: [
          { id: 'r1', name: 'unsynced', resource_type: 'memory_bank', last_push_at: null, last_commit_hash: null },
        ],
        total: 1,
      },
    });
    mockUseSyncStatus.mockReturnValue({ data: undefined });

    renderWithQuery(<SyncResourcesStatus />);
    expect(screen.getByText('never')).toBeDefined();
  });

  it('shows sync active badge when sync is enabled', () => {
    mockUseResources.mockReturnValue({ data: { data: [], total: 0 } });
    mockUseSyncStatus.mockReturnValue({
      data: { enabled: true, instance_id: 'test-instance', groups: [] },
    });

    renderWithQuery(<SyncResourcesStatus />);
    expect(screen.getByText('sync active')).toBeDefined();
  });

  it('shows peer connectivity info when sync groups exist', () => {
    mockUseResources.mockReturnValue({ data: { data: [], total: 0 } });
    mockUseSyncStatus.mockReturnValue({
      data: {
        enabled: true,
        groups: [
          { sync_group_id: 'g1', hive_name: 'general', seq: 100, peer_count: 4, connected_peers: 3 },
        ],
      },
    });

    renderWithQuery(<SyncResourcesStatus />);
    expect(screen.getByText('Hive sync: 3/4 peers connected')).toBeDefined();
  });

  it('aggregates peer counts across multiple sync groups', () => {
    mockUseResources.mockReturnValue({ data: { data: [], total: 0 } });
    mockUseSyncStatus.mockReturnValue({
      data: {
        enabled: true,
        groups: [
          { sync_group_id: 'g1', hive_name: 'general', seq: 50, peer_count: 2, connected_peers: 2 },
          { sync_group_id: 'g2', hive_name: 'dev', seq: 30, peer_count: 3, connected_peers: 1 },
        ],
      },
    });

    renderWithQuery(<SyncResourcesStatus />);
    expect(screen.getByText('Hive sync: 3/5 peers connected')).toBeDefined();
  });
});
