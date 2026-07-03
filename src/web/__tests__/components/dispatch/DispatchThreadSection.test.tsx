import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DispatchThreadSection } from '../../../components/dispatch/DispatchThreadSection';
import type { DispatchStatus } from '../../../hooks/useDispatch';

const mockUseMailConversation = vi.fn();
const mockPost = vi.fn();

vi.mock('../../../hooks/useApi', async () => {
  const actual = await vi.importActual<typeof import('../../../hooks/useApi')>('../../../hooks/useApi');
  return {
    ...actual,
    useMailConversation: (...args: unknown[]) => mockUseMailConversation(...args),
  };
});

vi.mock('../../../lib/api', () => ({
  api: { post: (...args: unknown[]) => mockPost(...args) },
}));

function renderSection(props: {
  conversationId: string | null;
  dispatchStatus: DispatchStatus;
  teamConversationId?: string | null;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DispatchThreadSection dispatchId="disp_1" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<DispatchThreadSection />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMailConversation.mockReturnValue({ data: undefined, isLoading: false });
  });

  it('renders nothing when terminal with no conversation', () => {
    const { container } = renderSection({ conversationId: null, dispatchStatus: 'complete' });
    expect(container.firstChild).toBeNull();
  });

  it('shows the pre-conversation composer when active with no conversation', () => {
    renderSection({ conversationId: null, dispatchStatus: 'running' });
    expect(screen.getByText(/No coordination thread yet/)).toBeDefined();
    expect(
      screen.getByPlaceholderText('Start a coordination thread — message the agent...'),
    ).toBeDefined();
  });

  it('first send posts to the turns route to lazily create the conversation', async () => {
    mockPost.mockResolvedValue({});
    renderSection({ conversationId: null, dispatchStatus: 'running' });

    const input = screen.getByPlaceholderText('Start a coordination thread — message the agent...');
    fireEvent.change(input, { target: { value: 'hello agent' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/dispatches/disp_1/thread/turns', {
        content: 'hello agent',
        importance: 'high',
      });
    });
  });

  it('shows the shared team thread pointer when teamConversationId is set', () => {
    renderSection({
      conversationId: null,
      dispatchStatus: 'running',
      teamConversationId: 'team-conv-xyz',
    });
    expect(screen.getByText(/coordinated team/)).toBeDefined();
    expect(screen.getByText('team-conv-xyz')).toBeDefined();
  });

  it('renders the message list when a conversation exists', () => {
    mockUseMailConversation.mockReturnValue({
      data: {
        conversation: { status: 'active' },
        turns: [
          { id: 't1', participant_id: 'agent:a', content: 'working on it', created_at: '2026-04-15T20:00:00Z' },
        ],
        turn_count: 1,
      },
      isLoading: false,
    });
    renderSection({ conversationId: 'conv_1', dispatchStatus: 'running' });
    expect(screen.getByText('working on it')).toBeDefined();
    expect(screen.getByPlaceholderText('Send a message to the agent...')).toBeDefined();
  });
});
