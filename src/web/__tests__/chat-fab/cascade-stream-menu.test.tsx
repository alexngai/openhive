/**
 * Cascade-stream menu integration — a page that calls `usePageContext`
 * with stream items populates the store; the `ContextMenu` (a Layout
 * sibling in production) reads that store and renders them.
 *
 * Parallel to `spec-detail-menu.test.tsx` / `dispatch-detail-menu.test.tsx`
 * but scoped to the `stream` + `task` context types added in step 8.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../../components/chat-fab/context-types';
import { usePageContext } from '../../components/chat-fab/usePageContext';
import { streamContextItem } from '../../components/chat-fab/context-types/stream';
import { taskContextItem } from '../../components/chat-fab/context-types/task';
import { ContextMenu } from '../../components/chat-fab/ContextMenu';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';

function FakeStreamPage() {
  usePageContext(
    () => [
      streamContextItem(
        {
          id: 'stream-row-1',
          stream_id: 'stream-abc',
          source_swarm_id: 'swarm-1',
          name: 'feature/auth',
          status: 'active',
          commit_count: 4,
          task_resource_id: 'res-tasks',
          task_node_id: 't-node-9',
        },
        { primary: true },
      ),
      taskContextItem({
        id: 't-node-9',
        resource_id: 'res-tasks',
        title: 'Wire OAuth',
      }),
    ],
    [],
  );
  return <div>cascade stream body</div>;
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

describe('Layout-gap integration (CascadeStream-shaped producer)', () => {
  beforeEach(() => {
    usePageContextStore.setState({ items: [] });
    cleanup();
  });

  it('shows the primary stream item plus linked task in the menu', () => {
    render(
      <LayoutShell>
        <FakeStreamPage />
      </LayoutShell>,
    );

    const btn = screen.getByRole('button', { name: /Add context/i });
    expect(btn).toBeDefined();

    fireEvent.click(btn);

    expect(screen.getByText(/Stream: feature\/auth/i)).toBeDefined();
    expect(screen.getByText(/Task: Wire OAuth/i)).toBeDefined();
  });

  it('marks exactly one primary (the stream)', () => {
    render(
      <LayoutShell>
        <FakeStreamPage />
      </LayoutShell>,
    );
    const stored = usePageContextStore.getState().items;
    const primaries = stored.filter((i) => i.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.type).toBe('stream');
  });

  it('clears items on page unmount', () => {
    function Host({ mounted }: { mounted: boolean }) {
      return (
        <LayoutShell>{mounted ? <FakeStreamPage /> : null}</LayoutShell>
      );
    }
    const { rerender } = render(<Host mounted={true} />);
    expect(screen.getByRole('button', { name: /Add context/i })).toBeDefined();

    rerender(<Host mounted={false} />);
    expect(screen.queryByRole('button', { name: /Add context/i })).toBeNull();
  });
});
