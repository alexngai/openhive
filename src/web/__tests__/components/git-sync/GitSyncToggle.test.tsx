import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GitSyncToggle } from '../../../components/git-sync/GitSyncToggle';
import type { SyncableResource } from '../../../lib/api';

const useResourceGitSync = vi.fn();
const mutate = vi.fn();
const useUpdateResourceGitSync = vi.fn();

vi.mock('../../../hooks/useApi', () => ({
  useResourceGitSync: (...args: unknown[]) => useResourceGitSync(...args),
  useUpdateResourceGitSync: (...args: unknown[]) => useUpdateResourceGitSync(...args),
}));

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function taskResource(overrides: Partial<SyncableResource> = {}): SyncableResource {
  return {
    id: 'res_1',
    resource_type: 'task',
    name: 'test',
    local_path: '/tmp/fake',
    metadata: null,
    visibility: 'private',
    owner_agent_id: 'agent_1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as SyncableResource;
}

beforeEach(() => {
  useResourceGitSync.mockReset();
  mutate.mockReset();
  useUpdateResourceGitSync.mockReset().mockReturnValue({
    mutate,
    isPending: false,
    isError: false,
    error: null,
  });
});

describe('GitSyncToggle', () => {
  it('renders nothing for non-task resources', () => {
    useResourceGitSync.mockReturnValue({ data: undefined, isLoading: false });
    const resource = taskResource({ resource_type: 'memory_bank' });
    const { container } = renderWithQuery(<GitSyncToggle resource={resource} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the task resource has no local_path', () => {
    useResourceGitSync.mockReturnValue({ data: undefined, isLoading: false });
    const resource = taskResource({ local_path: null });
    const { container } = renderWithQuery(<GitSyncToggle resource={resource} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "Sync: off" when the flag is disabled', () => {
    useResourceGitSync.mockReturnValue({
      data: { git_sync: { enabled: false } },
      isLoading: false,
    });
    renderWithQuery(<GitSyncToggle resource={taskResource()} />);
    expect(screen.getByText(/Sync: off/)).toBeDefined();
  });

  it('shows "Sync: on" when the flag is enabled', () => {
    useResourceGitSync.mockReturnValue({
      data: { git_sync: { enabled: true, remote: 'origin' } },
      isLoading: false,
    });
    renderWithQuery(<GitSyncToggle resource={taskResource()} />);
    expect(screen.getByText(/Sync: on/)).toBeDefined();
  });

  it('opens a popover and fires the mutation on toggle', () => {
    useResourceGitSync.mockReturnValue({
      data: { git_sync: { enabled: false, remote: 'origin' } },
      isLoading: false,
    });
    renderWithQuery(<GitSyncToggle resource={taskResource()} />);

    fireEvent.click(screen.getByText(/Sync: off/));
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeDefined();

    fireEvent.click(checkbox);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      resourceId: 'res_1',
      gitSync: { enabled: true, remote: 'origin' },
    });
  });
});
