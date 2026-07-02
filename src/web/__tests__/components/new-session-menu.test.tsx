/**
 * NewSessionMenu (P1.1) — "New session" picker on Threads.
 *
 * Covers:
 * - trigger opens the dialog on the Connect tab, listing ACP agents only
 * - clicking an agent row POSTs /sessions/acp-connect and navigates to the
 *   Threads deep link with resume params
 * - Spawn tab default (codex chat) spawns with kind=codex and navigates to
 *   /threads/hosted-chat/:id
 * - Claude Code choice spawns kind=claude-code and lands on hosted-tui
 * - failed preflight disables the spawn button until "attempt anyway"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockPickerSwarms = vi.fn();
const mockSpawnMutateAsync = vi.fn();
const mockPreflight = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useMapSwarmsForPicker: (...args: unknown[]) => mockPickerSwarms(...args),
  useSpawnSwarm: () => ({ mutateAsync: mockSpawnMutateAsync, isPending: false }),
  useSpawnPreflight: (...args: unknown[]) => mockPreflight(...args),
  useKnownProjectPathEntries: () => ({ data: [] }),
}));

vi.mock('../../hooks/useRealtimeInvalidation', () => ({
  useSwarmRealtime: () => {},
}));

// SpawnAgentDialog pulls in its own hook set; not under test here.
vi.mock('../../components/swarm/SpawnAgentDialog', () => ({
  SpawnAgentDialog: () => <div data-testid="spawn-agent-dialog" />,
}));

// SessionPicker re-exports SpawnFormDialog from pages/Swarms — stub the
// whole page module but keep the pure grouping helper real.
vi.mock('../../pages/Swarms', () => ({
  SpawnFormDialog: () => <div data-testid="spawn-form-dialog" />,
}));

const mockApiPost = vi.fn();
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, post: (...args: unknown[]) => mockApiPost(...args) } };
});

import { NewSessionButton } from '../../components/threads/NewSessionMenu';

const acpSwarm = {
  id: 'sw-1',
  name: 'alpha',
  status: 'online',
  capabilities: {},
  registered_agents: [
    {
      id: 'ag-1',
      name: 'Coordinator',
      role: 'coordinator',
      capabilities: { protocols: ['acp'] },
      metadata: { peerMapId: 'peer-1' },
    },
    {
      // mail-only agent — must not appear on the Connect tab
      id: 'ag-mail',
      name: 'Mailbox',
      role: 'agent',
      capabilities: {},
      metadata: {},
    },
  ],
};

function renderTrigger() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NewSessionButton />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function openDialog() {
  renderTrigger();
  fireEvent.click(screen.getByLabelText('New session'));
}

describe('NewSessionMenu', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockPickerSwarms.mockReturnValue({ data: [acpSwarm] });
    mockPreflight.mockReturnValue({ data: { ready: true, checks: [] } });
  });

  it('opens on the Connect tab and lists ACP agents only', () => {
    openDialog();

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('Coordinator')).toBeDefined();
    expect(screen.queryByText('Mailbox')).toBeNull();
  });

  it('connects via /sessions/acp-connect and navigates with resume params', async () => {
    mockApiPost.mockResolvedValue({
      session_resource_id: 'sess-1',
      acp_session_id: 'as-1',
      acp_stream_id: 'st-1',
      created: true,
    });
    openDialog();

    fireEvent.click(screen.getByText('Coordinator'));

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(1));
    expect(mockApiPost).toHaveBeenCalledWith('/sessions/acp-connect', {
      swarm_id: 'sw-1',
      agent_id: 'ag-1',
      peer_map_id: 'peer-1',
    });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/threads/sess-1?streamId=st-1&sessionId=as-1'),
    );
  });

  it('spawns codex-rpc by default and navigates to hosted-chat', async () => {
    mockSpawnMutateAsync.mockResolvedValue({ id: 'hs-1' });
    openDialog();

    fireEvent.click(screen.getByRole('tab', { name: 'Spawn a new agent' }));
    fireEvent.click(screen.getByRole('button', { name: /Spawn & open/ }));

    await waitFor(() => expect(mockSpawnMutateAsync).toHaveBeenCalledTimes(1));
    const payload = mockSpawnMutateAsync.mock.calls[0]![0];
    expect(payload.kind).toBe('codex');
    expect(payload.mode).toBeUndefined();
    expect(payload.name).toBeTruthy();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/threads/hosted-chat/hs-1'));
  });

  it('spawns claude-code and navigates to hosted-tui', async () => {
    mockSpawnMutateAsync.mockResolvedValue({ id: 'hs-2' });
    openDialog();

    fireEvent.click(screen.getByRole('tab', { name: 'Spawn a new agent' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: /Spawn & open/ }));

    await waitFor(() => expect(mockSpawnMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockSpawnMutateAsync.mock.calls[0]![0].kind).toBe('claude-code');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/threads/hosted-tui/hs-2'));
  });

  it('blocks spawn on failed preflight until "attempt anyway"', () => {
    mockPreflight.mockReturnValue({
      data: {
        ready: false,
        checks: [{ id: 'binary', ok: false, message: 'codex binary not found' }],
      },
    });
    openDialog();

    fireEvent.click(screen.getByRole('tab', { name: 'Spawn a new agent' }));

    const spawnBtn = screen.getByRole('button', { name: /Spawn & open/ }) as HTMLButtonElement;
    expect(spawnBtn.disabled).toBe(true);
    expect(screen.getByText('codex binary not found')).toBeDefined();

    fireEvent.click(screen.getByLabelText(/Attempt anyway/i));
    expect(spawnBtn.disabled).toBe(false);
  });
});
