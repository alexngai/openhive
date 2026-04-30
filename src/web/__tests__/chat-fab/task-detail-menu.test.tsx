/**
 * TaskDetail menu integration — verifies the singular `task` context type
 * surfaces as primary alongside the plural `tasks` aggregates (parents +
 * children).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../../components/chat-fab/context-types';
import { usePageContext } from '../../components/chat-fab/usePageContext';
import { taskContextItem } from '../../components/chat-fab/context-types/task';
import { tasksContextItem } from '../../components/chat-fab/context-types/tasks';
import { ContextMenu } from '../../components/chat-fab/ContextMenu';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';

function FakeTaskPage() {
  usePageContext(
    () => [
      taskContextItem(
        {
          id: 't-node-9',
          resource_id: 'res-tasks',
          title: 'Wire OAuth',
          status: 'in_progress',
          assignee: 'agent-42',
          blocked_by: ['t-node-1'],
          blocks: ['t-node-12'],
        },
        { primary: true },
      ),
      tasksContextItem([{ id: 't-node-1', title: 'Scope auth', status: 'done' }]),
      tasksContextItem([
        { id: 't-node-12', title: 'Follow-up', status: 'open' },
      ]),
    ],
    [],
  );
  return <div>task body</div>;
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

describe('Layout-gap integration (TaskDetail-shaped producer)', () => {
  beforeEach(() => {
    usePageContextStore.setState({ items: [] });
    cleanup();
  });

  it('shows the primary task plus parent + child aggregates', () => {
    render(
      <LayoutShell>
        <FakeTaskPage />
      </LayoutShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Add context/i }));

    expect(screen.getByText(/Task: Wire OAuth/i)).toBeDefined();
    expect(screen.getAllByText(/Linked tasks \(1\)/i).length).toBeGreaterThanOrEqual(1);
  });

  it('marks exactly one primary (the task)', () => {
    render(
      <LayoutShell>
        <FakeTaskPage />
      </LayoutShell>,
    );
    const stored = usePageContextStore.getState().items;
    const primaries = stored.filter((i) => i.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.type).toBe('task');
  });

  it('clears items on page unmount', () => {
    function Host({ mounted }: { mounted: boolean }) {
      return <LayoutShell>{mounted ? <FakeTaskPage /> : null}</LayoutShell>;
    }
    const { rerender } = render(<Host mounted={true} />);
    expect(screen.getByRole('button', { name: /Add context/i })).toBeDefined();

    rerender(<Host mounted={false} />);
    expect(screen.queryByRole('button', { name: /Add context/i })).toBeNull();
  });
});
