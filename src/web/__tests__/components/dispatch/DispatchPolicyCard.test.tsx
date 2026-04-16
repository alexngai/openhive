import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DispatchPolicyCard } from '../../../components/dispatch/DispatchPolicyCard';

const mockUpdate = vi.fn();
const mockUseDispatchPolicy = vi.fn();
const mockUseUpdateDispatchPolicy = vi.fn();

vi.mock('../../../hooks/useDispatches', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useDispatches')>(
    '../../../hooks/useDispatches',
  );
  return {
    ...actual,
    useDispatchPolicy: () => mockUseDispatchPolicy(),
    useUpdateDispatchPolicy: () => mockUseUpdateDispatchPolicy(),
  };
});

function renderCard(props: Partial<React.ComponentProps<typeof DispatchPolicyCard>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DispatchPolicyCard isAdmin={true} {...props} />
    </QueryClientProvider>,
  );
}

describe('<DispatchPolicyCard />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUpdateDispatchPolicy.mockReturnValue({
      mutateAsync: mockUpdate,
      isPending: false,
    });
  });

  it('renders nothing for non-admins', () => {
    mockUseDispatchPolicy.mockReturnValue({ data: { autonomous_dispatch_paused: false } });
    const { container } = renderCard({ isAdmin: false });
    expect(container.firstChild).toBeNull();
  });

  it('shows live state and a Pause button when not paused', () => {
    mockUseDispatchPolicy.mockReturnValue({ data: { autonomous_dispatch_paused: false } });
    renderCard();
    expect(screen.getByText(/^Live/)).toBeDefined();
    expect(screen.getByRole('button', { name: /Pause/i })).toBeDefined();
  });

  it('shows paused state and a Resume button when paused', () => {
    mockUseDispatchPolicy.mockReturnValue({ data: { autonomous_dispatch_paused: true } });
    renderCard();
    expect(screen.getByText(/^Paused/)).toBeDefined();
    expect(screen.getByRole('button', { name: /Resume/i })).toBeDefined();
  });

  it('flips state when the toggle button is clicked', async () => {
    mockUseDispatchPolicy.mockReturnValue({ data: { autonomous_dispatch_paused: false } });
    mockUpdate.mockResolvedValue({ autonomous_dispatch_paused: true });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Pause/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith(true));
  });

  it('surfaces an action error when the mutation rejects', async () => {
    mockUseDispatchPolicy.mockReturnValue({ data: { autonomous_dispatch_paused: false } });
    mockUpdate.mockRejectedValue(new Error('forbidden'));
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Pause/i }));
    await waitFor(() => expect(screen.getByText(/forbidden/)).toBeDefined());
  });
});
