import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DispatchModal } from '../../../components/dispatch/DispatchModal';
import type { Spec } from '../../../hooks/useSpecs';
import type { MapSwarm } from '../../../lib/api';

const mockMutateAsync = vi.fn();
const mockUseCreateDispatch = vi.fn();
const mockUseMapSwarms = vi.fn();
const mockToastSuccess = vi.fn();
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../hooks/useDispatch', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useDispatch')>(
    '../../../hooks/useDispatch',
  );
  return {
    ...actual,
    useCreateDispatch: () => mockUseCreateDispatch(),
  };
});

vi.mock('../../../hooks/useApi', () => ({
  useMapSwarmsForPicker: () => mockUseMapSwarms(),
  // Advanced-section data sources (P4.1). Empty lists keep the simple path.
  useResourcesByType: () => ({ data: { data: [] } }),
  useRepos: () => ({ data: { data: [] } }),
}));

vi.mock('../../../stores/toast', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 's-1',
    resource_id: 'res_a',
    resource_name: 'Graph A',
    swarm_id: null,
    swarm_name: null,
    title: 'Auth rewrite',
    content: '',
    status: null,
    priority: 1,
    archived: false,
    created_at: null,
    updated_at: null,
    uri: null,
    source: 'local',
    ...overrides,
  };
}

function makeSwarm(overrides: Partial<MapSwarm>): MapSwarm {
  return {
    id: 'sw_default',
    name: 'default',
    description: null,
    map_endpoint: 'ws://x',
    map_transport: 'websocket',
    status: 'online',
    last_seen_at: null,
    capabilities: { protocols: ['acp'] },
    auth_method: null,
    agent_count: 1,
    scope_count: 0,
    metadata: null,
    hives: [],
    ...overrides,
  };
}

function renderModal(props: Partial<React.ComponentProps<typeof DispatchModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DispatchModal
          open={true}
          onClose={vi.fn()}
          spec={makeSpec()}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<DispatchModal />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCreateDispatch.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    });
  });

  it('lists only online + ACP/mail-capable or Codex executor swarms by default', () => {
    mockUseMapSwarms.mockReturnValue({
      data: [
        makeSwarm({ id: 'sw_acp', name: 'acp-swarm', capabilities: { protocols: ['acp'] } }),
        makeSwarm({ id: 'sw_mail', name: 'mail-swarm', capabilities: { mail: { canCreate: true } } }),
        makeSwarm({
          id: 'sw_codex',
          name: 'codex-executor',
          capabilities: {},
          metadata: { kind: 'swarm-codex' },
        }),
        makeSwarm({ id: 'sw_offline', name: 'down', status: 'offline' }),
        makeSwarm({ id: 'sw_dumb', name: 'no-caps', capabilities: {} }),
      ],
    });
    renderModal();
    expect(screen.getByText('acp-swarm')).toBeDefined();
    expect(screen.getByText('mail-swarm')).toBeDefined();
    expect(screen.getByText('codex-executor')).toBeDefined();
    expect(screen.queryByText('down')).toBeNull();
    expect(screen.queryByText('no-caps')).toBeNull();
  });

  it('warns that selected Codex executor dispatches use danger-full-access unless overridden', () => {
    mockUseMapSwarms.mockReturnValue({
      data: [
        makeSwarm({
          id: 'sw_codex',
          name: 'codex-executor',
          capabilities: { dispatch: { executors: ['swarm-codex'] } },
        }),
      ],
    });
    renderModal();

    expect(screen.queryByText(/full filesystem access/i)).toBeNull();
    expect(screen.getByText('Codex')).toBeDefined();

    fireEvent.click(screen.getByText('codex-executor').closest('label')!);

    expect(screen.getByText(/Codex dispatch uses full filesystem access by default/i)).toBeDefined();
    expect(screen.getByText('danger-full-access')).toBeDefined();
    expect(screen.getByText('dispatch.codex_executor.sandbox')).toBeDefined();
  });

  it('includes ineligible swarms (disabled) when "show offline" is on', () => {
    mockUseMapSwarms.mockReturnValue({
      data: [
        makeSwarm({ id: 'sw_offline', name: 'down', status: 'offline' }),
      ],
    });
    renderModal();
    expect(screen.queryByText('down')).toBeNull();

    fireEvent.click(screen.getByLabelText(/show offline/i));
    expect(screen.getByText('down')).toBeDefined();
    // explanation text shows the swarm status
    expect(screen.getByText('offline')).toBeDefined();
  });

  it('shows a message when no swarms are available', () => {
    mockUseMapSwarms.mockReturnValue({ data: [] });
    renderModal();
    expect(
      screen.getByText(/No online swarms with ACP, mail, or Codex executor capability/i),
    ).toBeDefined();
  });

  it('selects swarms by clicking and surfaces the selection count', () => {
    mockUseMapSwarms.mockReturnValue({
      data: [
        makeSwarm({ id: 'sw_a', name: 'a', capabilities: { protocols: ['acp'] } }),
        makeSwarm({ id: 'sw_b', name: 'b', capabilities: { protocols: ['acp'] } }),
      ],
    });
    renderModal();

    const aRow = screen.getByText('a').closest('label')!;
    const bRow = screen.getByText('b').closest('label')!;
    fireEvent.click(aRow);
    fireEvent.click(bRow);

    expect(screen.getByText(/2 swarms selected/i)).toBeDefined();
  });

  it('errors when Dispatch is clicked with no swarms selected', async () => {
    mockUseMapSwarms.mockReturnValue({
      data: [makeSwarm({ id: 'sw_a', name: 'a', capabilities: { protocols: ['acp'] } })],
    });
    renderModal();

    const dispatchBtn = screen.getByRole('button', { name: /^Dispatch$/i });
    // disabled when no selection
    expect((dispatchBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls useCreateDispatch and auto-navigates to the detail page on single-swarm dispatch', async () => {
    mockUseMapSwarms.mockReturnValue({
      data: [makeSwarm({ id: 'sw_a', name: 'a', capabilities: { protocols: ['acp'] } })],
    });
    mockMutateAsync.mockResolvedValue({
      dispatches: [
        {
          id: 'disp_x',
          target_swarm_id: 'sw_a',
          target_swarm_name: 'a',
          seed_prompt: '...',
        },
      ],
    });
    const onClose = vi.fn();
    renderModal({ onClose });

    fireEvent.click(screen.getByText('a').closest('label')!);
    fireEvent.change(screen.getByPlaceholderText(/Anything beyond/i), {
      target: { value: 'extra context' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Dispatch$/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalled());
    expect(mockMutateAsync).toHaveBeenCalledWith({
      resource_id: 'res_a',
      spec_id: 's-1',
      target_swarms: ['sw_a'],
      prompt: 'extra context',
    });
    // Single-swarm → navigate to the detail page, suppress toast (the
    // detail page carries its own confirmation via status chip).
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dispatch/disp_x'));
    expect(mockToastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows a summary toast and does NOT navigate for multi-swarm dispatch', async () => {
    mockUseMapSwarms.mockReturnValue({
      data: [
        makeSwarm({ id: 'sw_a', name: 'a', capabilities: { protocols: ['acp'] } }),
        makeSwarm({ id: 'sw_b', name: 'b', capabilities: { protocols: ['acp'] } }),
      ],
    });
    mockMutateAsync.mockResolvedValue({
      dispatches: [
        { id: 'disp_a', target_swarm_id: 'sw_a', target_swarm_name: 'a', seed_prompt: '' },
        { id: 'disp_b', target_swarm_id: 'sw_b', target_swarm_name: 'b', seed_prompt: '' },
      ],
    });
    const onClose = vi.fn();
    renderModal({ onClose });

    fireEvent.click(screen.getByText('a').closest('label')!);
    fireEvent.click(screen.getByText('b').closest('label')!);
    fireEvent.click(screen.getByRole('button', { name: /^Dispatch$/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalled());
    // Multi-swarm → no single detail to land on, so we surface a toast
    // instead. User drills in from the Dispatches list.
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('validation preset prefills reviewer role, prompt template, and a non-executor swarm (P5.3)', async () => {
    mockUseMapSwarms.mockReturnValue({
      data: [
        makeSwarm({ id: 'sw_exec', name: 'executor', capabilities: { protocols: ['acp'] } }),
        makeSwarm({ id: 'sw_review', name: 'reviewer-swarm', capabilities: { protocols: ['acp'] } }),
      ],
    });
    renderModal({
      validationPreset: {
        summary: 'Implemented rate limiting middleware.',
        executorSwarmId: 'sw_exec',
        streamRef: 'sw_exec/stream_xyz',
      },
    });

    // reviewer prompt template rendered into the textarea
    const textarea = screen.getByPlaceholderText(/Anything beyond/i) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toMatch(/validating completed work/i));
    expect(textarea.value).toContain('Implemented rate limiting middleware.');
    expect(textarea.value).toContain('sw_exec/stream_xyz');

    // Advanced expanded with role=reviewer
    const roleInput = screen.getByPlaceholderText('e.g. worker') as HTMLInputElement;
    expect(roleInput.value).toBe('reviewer');

    // Default target is the non-executor swarm.
    await waitFor(() => expect(screen.getByText(/1 swarm selected/i)).toBeDefined());
  });

  it('validation preset still prefills prompt + reviewer role with zero online swarms (P5.3 regression)', async () => {
    // No dispatchable swarms — the prefill must not be gated on the swarm list.
    mockUseMapSwarms.mockReturnValue({ data: [] });
    renderModal({
      validationPreset: {
        summary: 'Implemented rate limiting middleware.',
        executorSwarmId: 'sw_exec',
        streamRef: 'sw_exec/stream_xyz',
      },
    });

    const textarea = screen.getByPlaceholderText(/Anything beyond/i) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toMatch(/validating completed work/i));
    expect(textarea.value).toContain('Implemented rate limiting middleware.');

    const roleInput = screen.getByPlaceholderText('e.g. worker') as HTMLInputElement;
    expect(roleInput.value).toBe('reviewer');

    // Empty-state message still shown (no swarm auto-selected).
    expect(
      screen.getByText(/No online swarms with ACP, mail, or Codex executor capability/i),
    ).toBeDefined();
  });

  it('shows error and keeps modal open on dispatch failure', async () => {
    mockUseMapSwarms.mockReturnValue({
      data: [makeSwarm({ id: 'sw_a', name: 'a', capabilities: { protocols: ['acp'] } })],
    });
    mockMutateAsync.mockRejectedValue(new Error('hub down'));
    const onClose = vi.fn();
    renderModal({ onClose });

    fireEvent.click(screen.getByText('a').closest('label')!);
    fireEvent.click(screen.getByRole('button', { name: /^Dispatch$/i }));

    await waitFor(() => expect(screen.getByText(/hub down/i)).toBeDefined());
    expect(onClose).not.toHaveBeenCalled();
  });
});
