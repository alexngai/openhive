import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OutcomeActionBar } from '../../../components/dispatch/OutcomeActionBar';
import type { DispatchLinkedTaskRef } from '../../../hooks/useDispatch';

const mockMutateAsync = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../../../hooks/useApi', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useApi')>('../../../hooks/useApi');
  return {
    ...actual,
    useUpdateOpenTaskStatus: () => ({ mutateAsync: mockMutateAsync }),
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderBar(opts?: {
  linkedTasks?: DispatchLinkedTaskRef[];
  onDispatchValidation?: () => void;
}) {
  return render(
    <MemoryRouter>
      <OutcomeActionBar
        specResourceId="res_1"
        specId="spec_1"
        linkedTasks={opts?.linkedTasks ?? []}
        onDispatchValidation={opts?.onDispatchValidation ?? vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('<OutcomeActionBar />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockResolvedValue({});
  });

  it('renders the three Flow 5 actions', () => {
    renderBar();
    expect(screen.getByText(/Accept & close/)).toBeDefined();
    expect(screen.getByText('Dispatch validation')).toBeDefined();
    expect(screen.getByText('Send back')).toBeDefined();
  });

  it('Accept & close confirms then closes every linked task', async () => {
    renderBar({
      linkedTasks: [
        { resource_id: 'res_1', node_id: 'n1' },
        { resource_id: 'res_1', node_id: 'n2' },
      ],
    });
    fireEvent.click(screen.getByText(/Accept & close/));
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(2);
    });
    expect(mockMutateAsync).toHaveBeenCalledWith({ nodeId: 'n1', status: 'closed' });
    expect(mockMutateAsync).toHaveBeenCalledWith({ nodeId: 'n2', status: 'closed' });
    await waitFor(() => expect(screen.getByText('Accepted')).toBeDefined());
  });

  it('Dispatch validation fires the preset callback', () => {
    const onValidate = vi.fn();
    renderBar({ onDispatchValidation: onValidate });
    fireEvent.click(screen.getByText('Dispatch validation'));
    expect(onValidate).toHaveBeenCalledOnce();
  });

  it('Send back navigates to the spec discussion thread', () => {
    renderBar();
    fireEvent.click(screen.getByText('Send back'));
    expect(mockNavigate).toHaveBeenCalledWith('/specs/res_1/spec_1?tab=discussion');
  });
});
