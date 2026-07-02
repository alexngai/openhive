/**
 * InviteAgentButton (P3.4) — invite a mail-capable agent into a discussion.
 *
 * Covers:
 * - popover lists mail-capable agents (grouped by swarm), excluding sidecars
 *   and existing participants
 * - selecting an agent calls the invite mutation with the conversation id
 * - non-mail swarms are excluded
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const mockUseSwarms = vi.fn();
const mockInviteMutateAsync = vi.fn();

vi.mock('../../hooks/useApi', () => ({
  useMapSwarmsForPicker: (...args: unknown[]) => mockUseSwarms(...args),
  useInviteMailParticipant: () => ({
    mutateAsync: mockInviteMutateAsync,
    isError: false,
    error: null,
  }),
}));

vi.mock('../../hooks/useRealtimeInvalidation', () => ({
  useSwarmRealtime: () => {},
}));

import { InviteAgentButton } from '../../components/sessions/InviteAgentButton';

const mailSwarm = {
  id: 'sw-mail',
  name: 'mailer',
  status: 'online',
  capabilities: { mail: { canJoin: true } },
  registered_agents: [
    { id: 'codex-1', name: 'Codex One', role: 'agent' },
    { id: 'sidecar-1', name: 'Sidecar', role: 'sidecar' },
    { id: 'already-in', name: 'Already Here', role: 'agent' },
  ],
};

const acpOnlySwarm = {
  id: 'sw-acp',
  name: 'acp-only',
  status: 'online',
  capabilities: {},
  registered_agents: [{ id: 'acp-1', name: 'Acp One', role: 'agent' }],
};

describe('InviteAgentButton', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockInviteMutateAsync.mockResolvedValue({ ok: true, agent_id: 'codex-1' });
  });

  it('lists mail-capable agents, excluding sidecars, existing participants, and non-mail swarms', () => {
    mockUseSwarms.mockReturnValue({ data: [mailSwarm, acpOnlySwarm] });

    render(
      <InviteAgentButton conversationId="conv-1" existingParticipantIds={['already-in']} />,
    );
    fireEvent.click(screen.getByLabelText('Invite agent'));

    expect(screen.getByText('Codex One')).toBeDefined();
    // sidecar filtered
    expect(screen.queryByText('Sidecar')).toBeNull();
    // existing participant filtered
    expect(screen.queryByText('Already Here')).toBeNull();
    // agent on a non-mail swarm filtered
    expect(screen.queryByText('Acp One')).toBeNull();
  });

  it('invites the selected agent with the conversation id', async () => {
    mockUseSwarms.mockReturnValue({ data: [mailSwarm] });

    render(<InviteAgentButton conversationId="conv-1" />);
    fireEvent.click(screen.getByLabelText('Invite agent'));
    fireEvent.click(screen.getByText('Codex One'));

    await waitFor(() => expect(mockInviteMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockInviteMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      agentId: 'codex-1',
    });
  });

  it('shows an empty state when no mail-capable agents are online', () => {
    mockUseSwarms.mockReturnValue({ data: [acpOnlySwarm] });

    render(<InviteAgentButton conversationId="conv-1" />);
    fireEvent.click(screen.getByLabelText('Invite agent'));

    expect(screen.getByText('No mail-capable agents online.')).toBeDefined();
  });
});
