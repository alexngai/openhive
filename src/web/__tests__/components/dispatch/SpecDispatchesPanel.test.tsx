import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpecDispatchesPanel } from '../../../components/dispatch/SpecDispatchesPanel';

const mockUseDispatches = vi.fn();
const mockUseDispatchesRealtime = vi.fn();
const mockUseMapSwarms = vi.fn();

vi.mock('../../../hooks/useDispatches', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useDispatches')>(
    '../../../hooks/useDispatches',
  );
  return {
    ...actual,
    useDispatches: (...args: unknown[]) => mockUseDispatches(...args),
  };
});

vi.mock('../../../hooks/useDispatchesRealtime', () => ({
  useDispatchesRealtime: () => mockUseDispatchesRealtime(),
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
        <SpecDispatchesPanel resourceId={resourceId} specId={specId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<SpecDispatchesPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMapSwarms.mockReturnValue({ data: [{ id: 'sw_a', name: 'alpha' }] });
  });

  it('subscribes to realtime and queries scoped to (resource_id, spec_id)', () => {
    mockUseDispatches.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
    });
    renderPanel('res_a', 's-1');
    expect(mockUseDispatchesRealtime).toHaveBeenCalled();
    expect(mockUseDispatches).toHaveBeenCalledWith({
      spec_resource_id: 'res_a',
      spec_id: 's-1',
      limit: 50,
    });
  });

  it('renders empty state when no dispatches', () => {
    mockUseDispatches.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
    });
    renderPanel();
    expect(screen.getByText('No dispatches yet')).toBeDefined();
  });

  it('shows loading state', () => {
    mockUseDispatches.mockReturnValue({ data: undefined, isLoading: true });
    renderPanel();
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  it('renders dispatch list with status chip and swarm name', () => {
    mockUseDispatches.mockReturnValue({
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
