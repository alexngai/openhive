import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DispatchThreadSection } from '../../../components/dispatch/DispatchThreadSection';
import type { DispatchStatus } from '../../../hooks/useDispatch';

const mockPost = vi.fn();
const mockMailThreadView = vi.fn();

// MailThreadView pulls in the swarmcraft chat embed + openhive adapters, which
// are heavy to wire up in a unit test. Stub it and assert delegation instead.
vi.mock('../../../components/sessions/MailThreadView', () => ({
  MailThreadView: (props: { conversationId: string; registerPageContext?: boolean }) => {
    mockMailThreadView(props);
    return <div data-testid="mail-thread-view" data-conversation-id={props.conversationId} />;
  },
}));

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

  it('delegates to MailThreadView (embedded, no page-context) when a conversation exists', () => {
    renderSection({ conversationId: 'conv_1', dispatchStatus: 'running' });
    const view = screen.getByTestId('mail-thread-view');
    expect(view.getAttribute('data-conversation-id')).toBe('conv_1');
    expect(mockMailThreadView).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv_1', registerPageContext: false }),
    );
  });

  it('still shows the team pointer above the embedded thread', () => {
    renderSection({
      conversationId: 'conv_1',
      dispatchStatus: 'running',
      teamConversationId: 'team-conv-xyz',
    });
    expect(screen.getByTestId('mail-thread-view')).toBeDefined();
    expect(screen.getByText(/coordinated team/)).toBeDefined();
  });
});
