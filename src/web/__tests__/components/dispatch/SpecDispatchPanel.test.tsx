import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpecDispatchPanel } from '../../../components/dispatch/SpecDispatchPanel';

const mockUseDispatchList = vi.fn();
const mockUseDispatchRealtime = vi.fn();
const mockUseMapSwarms = vi.fn();

vi.mock('../../../hooks/useDispatch', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useDispatch')>(
    '../../../hooks/useDispatch',
  );
  return {
    ...actual,
    useDispatchList: (...args: unknown[]) => mockUseDispatchList(...args),
  };
});

vi.mock('../../../hooks/useDispatchRealtime', () => ({
  useDispatchRealtime: () => mockUseDispatchRealtime(),
}));

vi.mock('../../../hooks/useApi', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useApi')>('../../../hooks/useApi');
  return {
    ...actual,
    useMapSwarms: () => mockUseMapSwarms(),
  };
});

function renderPanel(resourceId = 'res_a', specId = 's-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SpecDispatchPanel resourceId={resourceId} specId={specId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<SpecDispatchPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMapSwarms.mockReturnValue({ data: [{ id: 'sw_a', name: 'alpha' }] });
  });

  it('subscribes to realtime and queries scoped to (resource_id, spec_id)', () => {
    mockUseDispatchList.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
    });
    renderPanel('res_a', 's-1');
    expect(mockUseDispatchRealtime).toHaveBeenCalled();
    expect(mockUseDispatchList).toHaveBeenCalledWith({
      spec_resource_id: 'res_a',
      spec_id: 's-1',
      limit: 50,
    });
  });

  it('renders empty state when no dispatches', () => {
    mockUseDispatchList.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
    });
    renderPanel();
    expect(screen.getByText('No dispatches yet')).toBeDefined();
  });

  it('shows loading state', () => {
    mockUseDispatchList.mockReturnValue({ data: undefined, isLoading: true });
    renderPanel();
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  it('renders dispatch list with status chip and swarm name', () => {
    mockUseDispatchList.mockReturnValue({
      data: {
        data: [
          {
            id: 'disp_x',
            spec_resource_id: 'res_a',
            spec_id: 's-1',
            spec_captured_at: null,
            target_swarm_id: 'sw_a',
            status: 'running',
            initiator_type: 'user',
            initiator_id: 'u',
            session_ids: [],
            outcome: null,
            prompt_override: null,
            created_at: '2026-04-15T20:00:00Z',
            updated_at: '2026-04-15T20:00:00Z',
          },
        ],
        total: 1, limit: 50, offset: 0,
      },
      isLoading: false,
    });
    renderPanel();
    expect(screen.getByText('disp_x')).toBeDefined();
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('Running')).toBeDefined();
  });
});
