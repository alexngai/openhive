/**
 * SessionDetail menu integration — session primary, with optional
 * conversation + spec secondaries that SessionDetail emits when lineage
 * is present.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../../components/chat-fab/context-types';
import { usePageContext } from '../../components/chat-fab/usePageContext';
import { sessionContextItem } from '../../components/chat-fab/context-types/session';
import { conversationContextItem } from '../../components/chat-fab/context-types/conversation';
import { specContextItem } from '../../components/chat-fab/context-types/spec';
import { ContextMenu } from '../../components/chat-fab/ContextMenu';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';

function FakeSessionPage() {
  usePageContext(
    () => [
      sessionContextItem(
        {
          id: 'session-1',
          swarm_id: 'swarm-1',
          name: 'openhive@main · help me tighten…',
          project: 'openhive',
          branch: 'main',
          first_prompt: 'help me tighten section 2',
          state: 'active',
          checkpoint_count: 4,
        },
        { primary: true },
      ),
      conversationContextItem({
        id: 'conv-1',
        subject: 'Linked mail thread',
        status: 'active',
      }),
      specContextItem({
        id: 'spec-1',
        resource_id: 'res-xyz',
        title: 'Auth rewrite',
        content: 'body',
      }),
    ],
    [],
  );
  return <div>session body</div>;
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

describe('Layout-gap integration (SessionDetail-shaped producer)', () => {
  beforeEach(() => {
    usePageContextStore.setState({ items: [] });
    cleanup();
  });

  it('shows primary session plus linked conversation and spec', () => {
    render(
      <LayoutShell>
        <FakeSessionPage />
      </LayoutShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Add context/i }));

    expect(screen.getByText(/Session:/i)).toBeDefined();
    expect(screen.getByText(/Conversation: Linked mail thread/i)).toBeDefined();
    expect(screen.getByText(/Spec: Auth rewrite/i)).toBeDefined();
  });

  it('marks exactly one primary (the session)', () => {
    render(
      <LayoutShell>
        <FakeSessionPage />
      </LayoutShell>,
    );
    const stored = usePageContextStore.getState().items;
    const primaries = stored.filter((i) => i.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.type).toBe('session');
  });

  it('clears items on page unmount', () => {
    function Host({ mounted }: { mounted: boolean }) {
      return <LayoutShell>{mounted ? <FakeSessionPage /> : null}</LayoutShell>;
    }
    const { rerender } = render(<Host mounted={true} />);
    expect(screen.getByRole('button', { name: /Add context/i })).toBeDefined();

    rerender(<Host mounted={false} />);
    expect(screen.queryByRole('button', { name: /Add context/i })).toBeNull();
  });
});
