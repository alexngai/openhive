/**
 * Mail conversation menu integration — conversation primary with recent
 * turns inline (emitted via `recent_turns` in the formatted body).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../../components/chat-fab/context-types';
import { usePageContext } from '../../components/chat-fab/usePageContext';
import { conversationContextItem } from '../../components/chat-fab/context-types/conversation';
import { ContextMenu } from '../../components/chat-fab/ContextMenu';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';

function FakeMailConversationPage() {
  usePageContext(
    () => [
      conversationContextItem(
        {
          id: 'conv-1',
          subject: 'Auth plan',
          status: 'active',
          participant_count: 3,
          turn_count: 7,
          recent_turns: [
            {
              participant_id: 'agent-a',
              content_text: 'First turn content',
              created_at: '2026-04-22T00:00:00Z',
            },
            {
              participant_id: 'agent-b',
              content_text: 'Second turn reply',
              created_at: '2026-04-22T00:01:00Z',
            },
          ],
        },
        { primary: true },
      ),
    ],
    [],
  );
  return <div>mail body</div>;
}

function LayoutShell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div data-testid="page">{children}</div>
      <div data-testid="chat-fab-sibling">
        <ContextMenu onInject={() => {}} />
      </div>
    </div>
  );
}

describe('Layout-gap integration (MailConversation-shaped producer)', () => {
  beforeEach(() => {
    usePageContextStore.setState({ items: [] });
    cleanup();
  });

  it('shows the primary conversation item in the menu', () => {
    render(
      <LayoutShell>
        <FakeMailConversationPage />
      </LayoutShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Add context/i }));
    expect(screen.getByText(/Conversation: Auth plan/i)).toBeDefined();
  });

  it('marks exactly one primary (the conversation)', () => {
    render(
      <LayoutShell>
        <FakeMailConversationPage />
      </LayoutShell>,
    );
    const stored = usePageContextStore.getState().items;
    const primaries = stored.filter((i) => i.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.type).toBe('conversation');
  });

  it('clears items on page unmount', () => {
    function Host({ mounted }: { mounted: boolean }) {
      return (
        <LayoutShell>
          {mounted ? <FakeMailConversationPage /> : null}
        </LayoutShell>
      );
    }
    const { rerender } = render(<Host mounted={true} />);
    expect(screen.getByRole('button', { name: /Add context/i })).toBeDefined();

    rerender(<Host mounted={false} />);
    expect(screen.queryByRole('button', { name: /Add context/i })).toBeNull();
  });
});
