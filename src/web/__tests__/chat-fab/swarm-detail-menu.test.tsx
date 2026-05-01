/**
 * SwarmDetail menu integration — swarm context surfaces as primary when
 * the page calls `usePageContext`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../../components/chat-fab/context-types';
import { usePageContext } from '../../components/chat-fab/usePageContext';
import { swarmContextItem } from '../../components/chat-fab/context-types/swarm';
import { ContextMenu } from '../../components/chat-fab/ContextMenu';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';

function FakeSwarmPage() {
  usePageContext(
    () => [
      swarmContextItem(
        {
          id: 'swarm-1',
          name: 'dev-swarm',
          status: 'online',
          agent_count: 5,
          registered_agent_count: 3,
          last_seen_at: '2026-04-22T00:00:00Z',
        },
        { primary: true },
      ),
    ],
    [],
  );
  return <div>swarm body</div>;
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

describe('Layout-gap integration (SwarmDetail-shaped producer)', () => {
  beforeEach(() => {
    usePageContextStore.setState({ items: [] });
    cleanup();
  });

  it('shows the primary swarm item in the menu', () => {
    render(
      <LayoutShell>
        <FakeSwarmPage />
      </LayoutShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Add context/i }));
    expect(screen.getByText(/Swarm: dev-swarm/i)).toBeDefined();
  });

  it('marks exactly one primary (the swarm)', () => {
    render(
      <LayoutShell>
        <FakeSwarmPage />
      </LayoutShell>,
    );
    const stored = usePageContextStore.getState().items;
    const primaries = stored.filter((i) => i.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.type).toBe('swarm');
  });

  it('clears items on page unmount', () => {
    function Host({ mounted }: { mounted: boolean }) {
      return <LayoutShell>{mounted ? <FakeSwarmPage /> : null}</LayoutShell>;
    }
    const { rerender } = render(<Host mounted={true} />);
    expect(screen.getByRole('button', { name: /Add context/i })).toBeDefined();

    rerender(<Host mounted={false} />);
    expect(screen.queryByRole('button', { name: /Add context/i })).toBeNull();
  });
});
