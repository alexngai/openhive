import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Specs } from '../../pages/Specs';

const mockUseSpecs = vi.fn();
const mockUseSpecsRealtime = vi.fn();

vi.mock('../../hooks/useSpecs', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useSpecs')>(
    '../../hooks/useSpecs',
  );
  return {
    ...actual,
    useSpecs: (...args: unknown[]) => mockUseSpecs(...args),
  };
});

vi.mock('../../hooks/useSpecsRealtime', () => ({
  useSpecsRealtime: () => mockUseSpecsRealtime(),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Specs />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<Specs /> page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state while fetching', () => {
    mockUseSpecs.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderPage();
    expect(screen.getByRole('status', { name: /loading/i })).toBeDefined();
  });

  it('shows empty state when no specs exist', () => {
    mockUseSpecs.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText(/No specs found/i)).toBeDefined();
  });

  it('renders specs from the hook and the New spec link', () => {
    mockUseSpecs.mockReturnValue({
      data: {
        data: [
          {
            id: 's-1', resource_id: 'res_a', resource_name: 'Graph A',
            swarm_id: null, swarm_name: null, title: 'Auth rewrite',
            content: 'rewrite auth', status: 'active', priority: 0,
            archived: false, created_at: null, updated_at: null, uri: null, source: 'local',
          },
          {
            id: 's-2', resource_id: 'res_a', resource_name: 'Graph A',
            swarm_id: null, swarm_name: null, title: 'Search redesign',
            content: '', status: 'active', priority: 2, archived: false,
            created_at: null, updated_at: null, uri: null, source: 'local',
          },
        ],
        total: 2, limit: 50, offset: 0,
      },
      isLoading: false,
      error: null,
    });

    renderPage();
    expect(screen.getByText('Auth rewrite')).toBeDefined();
    expect(screen.getByText('Search redesign')).toBeDefined();
    expect(screen.getByRole('link', { name: /New spec/i })).toBeDefined();
  });

  it('shows error message when fetch fails', () => {
    mockUseSpecs.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    });
    renderPage();
    expect(screen.getByText(/Failed to load specs/i)).toBeDefined();
    expect(screen.getByText(/boom/)).toBeDefined();
  });

  it('toggles archive filter on the hook input', () => {
    mockUseSpecs.mockReturnValue({
      data: { data: [], total: 0, limit: 50, offset: 0 },
      isLoading: false,
      error: null,
    });

    renderPage();

    expect(mockUseSpecs).toHaveBeenLastCalledWith({ includeArchived: false });

    const checkbox = screen.getByLabelText(/Include archived/i) as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(mockUseSpecs).toHaveBeenLastCalledWith({ includeArchived: true });
  });

  it('surfaces partial-fetch errors when present', () => {
    mockUseSpecs.mockReturnValue({
      data: {
        data: [],
        total: 0,
        limit: 50,
        offset: 0,
        errors: [{ resource_id: 'res_x', message: 'unreachable' }],
      },
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText(/1 resource.*could not be reached/i)).toBeDefined();
  });
});
