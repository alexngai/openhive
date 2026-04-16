import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpecNew } from '../../pages/SpecNew';

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

const mockUseResourcesByType = vi.fn();
vi.mock('../../hooks/useApi', () => ({
  useResourcesByType: (...args: unknown[]) => mockUseResourcesByType(...args),
}));

const mockMutateAsync = vi.fn();
const mockUseCreateSpec = vi.fn();
vi.mock('../../hooks/useSpecs', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useSpecs')>(
    '../../hooks/useSpecs',
  );
  return {
    ...actual,
    useCreateSpec: () => mockUseCreateSpec(),
  };
});

const DRAFT_KEY = 'openhive:spec-draft';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SpecNew />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<SpecNew /> page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockUseResourcesByType.mockReturnValue({
      data: {
        data: [
          { id: 'res_a', name: 'Graph A', metadata: { opentasks: true } },
          { id: 'res_b', name: 'Graph B', metadata: { opentasks: true } },
          { id: 'res_other', name: 'Memory', metadata: null },
        ],
      },
    });
    mockUseCreateSpec.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    });
  });

  it('renders the resource picker with only opentasks resources', () => {
    renderPage();
    // First combobox is the resource picker; second is the priority select inside SpecEditor.
    const [resourceSelect] = screen.getAllByRole('combobox');
    const options = Array.from((resourceSelect as HTMLSelectElement).options).map((o) => o.textContent);
    expect(options).toEqual(['Graph A', 'Graph B']);
  });

  it('shows guidance when no opentasks resources exist', () => {
    mockUseResourcesByType.mockReturnValue({ data: { data: [] } });
    renderPage();
    expect(screen.getByText(/No OpenTasks task graphs are accessible/i)).toBeDefined();
  });

  it('autosaves the draft to localStorage on input', () => {
    renderPage();

    const titleInput = screen.getByPlaceholderText(/What is this spec for/i);
    fireEvent.change(titleInput, { target: { value: 'Plan the rewrite' } });

    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY)!);
    expect(stored.title).toBe('Plan the rewrite');
    expect(stored.resource_id).toBe('res_a');
    expect(stored.saved_at).toBeTypeOf('number');
  });

  it('restores a previously saved draft on mount', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        title: 'Older draft',
        content: 'old body',
        priority: 1,
        resource_id: 'res_b',
        saved_at: Date.now(),
      }),
    );

    renderPage();
    expect((screen.getByPlaceholderText(/What is this spec for/i) as HTMLInputElement).value).toBe(
      'Older draft',
    );
    const [resourceSelect] = screen.getAllByRole('combobox');
    expect((resourceSelect as HTMLSelectElement).value).toBe('res_b');
    expect(screen.getByText(/Restored a draft/i)).toBeDefined();
  });

  it('discards the draft and navigates back to /specs', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ title: 'tossable', content: '', resource_id: 'res_a', saved_at: Date.now() }),
    );

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Discard draft/i }));

    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(navigateSpy).toHaveBeenCalledWith('/specs');
  });

  it('saves the spec, clears draft, and navigates to detail page', async () => {
    mockMutateAsync.mockResolvedValue({ spec: { id: 's-new' } });
    renderPage();

    fireEvent.change(screen.getByPlaceholderText(/What is this spec for/i), {
      target: { value: 'Real spec' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create spec/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalled());
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: 'res_a', title: 'Real spec' }),
    );

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/specs/res_a/s-new'));
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('shows an error and keeps the draft when save fails', async () => {
    mockMutateAsync.mockRejectedValue(new Error('daemon down'));
    renderPage();

    fireEvent.change(screen.getByPlaceholderText(/What is this spec for/i), {
      target: { value: 'Will fail' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create spec/i }));

    await waitFor(() => expect(screen.getByText(/daemon down/)).toBeDefined());
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
