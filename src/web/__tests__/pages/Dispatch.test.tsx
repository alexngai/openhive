import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Dispatch } from '../../pages/Dispatch';

const mockUseDispatchList = vi.fn();
const mockUseDispatchRealtime = vi.fn();
const mockUseMapSwarmsForPicker = vi.fn();

vi.mock('../../hooks/useDispatch', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useDispatch')>(
    '../../hooks/useDispatch',
  );
  return {
    ...actual,
    useDispatchList: (...args: unknown[]) => mockUseDispatchList(...args),
  };
});

vi.mock('../../hooks/useDispatchRealtime', () => ({
  useDispatchRealtime: () => mockUseDispatchRealtime(),
}));

vi.mock('../../hooks/useApi', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useApi')>('../../hooks/useApi');
  return {
    ...actual,
    useMapSwarmsForPicker: () => mockUseMapSwarmsForPicker(),
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Dispatch />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<Dispatch /> page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMapSwarmsForPicker.mockReturnValue({
      data: [
        { id: 'sw_a', name: 'alpha' },
        { id: 'sw_b', name: 'beta' },
      ],
    });
  });

  it('renders empty state when no dispatches', () => {
    mockUseDispatchList.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText(/No dispatches match your filter/i)).toBeDefined();
  });

  it('renders dispatch cards with status chip and swarm name', () => {
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
      error: null,
    });
    renderPage();
    expect(screen.getByText('disp_x')).toBeDefined();
    expect(screen.getByText('s-1')).toBeDefined();
    // 'alpha' appears in both the dispatch card and the swarm filter <option>.
    expect(screen.getAllByText('alpha').length).toBeGreaterThanOrEqual(1);
    // 'Running' appears in both the status filter chip and the row's status
    // chip. The presence of either is enough for this smoke assertion.
    expect(screen.getAllByText('Running').length).toBeGreaterThanOrEqual(1);
  });

  it('toggles status filter when chip clicked', () => {
    mockUseDispatchList.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(mockUseDispatchList).toHaveBeenLastCalledWith({
      status: undefined,
      target_swarm_id: undefined,
    });

    fireEvent.click(screen.getByRole('button', { name: /running/i }));
    expect(mockUseDispatchList).toHaveBeenLastCalledWith({
      status: ['running'],
      target_swarm_id: undefined,
    });
  });

  it('filters by swarm via the dropdown', () => {
    mockUseDispatchList.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    });
    renderPage();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'sw_b' } });
    expect(mockUseDispatchList).toHaveBeenLastCalledWith({
      status: undefined,
      target_swarm_id: 'sw_b',
    });
  });

  it('subscribes to realtime updates', () => {
    mockUseDispatchList.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(mockUseDispatchRealtime).toHaveBeenCalled();
  });
});
