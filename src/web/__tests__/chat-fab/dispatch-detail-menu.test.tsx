/**
 * Verifies the Layout gap is closed for DispatchDetail: a page that calls
 * `usePageContext` with dispatch items populates the store; the
 * `ContextMenu` (a Layout sibling in production) reads that store and
 * renders the items.
 *
 * Parallel to `spec-detail-menu.test.tsx` but scoped to the dispatch
 * context type added in step 4 of the chat-context-injection rollout.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../../components/chat-fab/context-types';
import { usePageContext } from '../../components/chat-fab/usePageContext';
import { dispatchContextItem } from '../../components/chat-fab/context-types/dispatch';
import { specContextItem } from '../../components/chat-fab/context-types/spec';
import { tasksContextItem } from '../../components/chat-fab/context-types/tasks';
import { ContextMenu } from '../../components/chat-fab/ContextMenu';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';

function FakeDispatchPage() {
  usePageContext(
    () => [
      dispatchContextItem(
        {
          id: 'd-abc12345',
          spec_id: 'spec-xyz',
          target_swarm_id: 'swarm-1',
          status: 'running',
        },
        { primary: true },
      ),
      specContextItem({
        id: 'spec-xyz',
        resource_id: 'res-xyz',
        title: 'Source spec',
        content: 'body',
      }),
      tasksContextItem([
        { id: 't-1', title: 'Linked task', status: 'open' },
      ]),
    ],
    [],
  );
  return <div>dispatch body</div>;
}

function LayoutShell({ children }: { children: React.ReactNode }) {
  // Model the production Layout gap: the "page" and `<ContextMenu />`
  // live in sibling subtrees, connected only through the module-level
  // `PageContextStore`.
  return (
    <div>
      <div data-testid="page">{children}</div>
      <div data-testid="chat-fab-sibling">
        <ContextMenu onInject={() => {}} />
      </div>
    </div>
  );
}

describe('Layout-gap integration (DispatchDetail-shaped producer)', () => {
  beforeEach(() => {
    usePageContextStore.setState({ items: [] });
    cleanup();
  });

  it('shows the primary dispatch item plus spec and tasks in the menu', () => {
    render(
      <LayoutShell>
        <FakeDispatchPage />
      </LayoutShell>,
    );

    const btn = screen.getByRole('button', { name: /Add context/i });
    expect(btn).toBeDefined();

    fireEvent.click(btn);

    // Dispatch (primary) + source spec + linked tasks all surface.
    expect(screen.getByText(/Dispatch: d-abc123/i)).toBeDefined();
    expect(screen.getByText(/Spec: Source spec/i)).toBeDefined();
    expect(screen.getByText(/Linked tasks \(1\)/i)).toBeDefined();
  });

  it('marks exactly one primary (the dispatch)', () => {
    render(
      <LayoutShell>
        <FakeDispatchPage />
      </LayoutShell>,
    );
    const stored = usePageContextStore.getState().items;
    const primaries = stored.filter((i) => i.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.type).toBe('dispatch');
  });

  it('clears items on page unmount', () => {
    function Host({ mounted }: { mounted: boolean }) {
      return (
        <LayoutShell>{mounted ? <FakeDispatchPage /> : null}</LayoutShell>
      );
    }
    const { rerender } = render(<Host mounted={true} />);
    expect(screen.getByRole('button', { name: /Add context/i })).toBeDefined();

    rerender(<Host mounted={false} />);
    expect(screen.queryByRole('button', { name: /Add context/i })).toBeNull();
  });
});
