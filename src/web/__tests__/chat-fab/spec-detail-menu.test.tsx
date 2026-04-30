/**
 * Verifies the Layout gap is closed: a page that calls `usePageContext`
 * populates the store; the `ContextMenu` (a Layout sibling in production)
 * reads that store and renders the items.
 *
 * We bypass the full SpecDetail component (Tiptap + sidebar pull heavy
 * deps) and exercise the same contract directly — this is §3.1.2 + §3.1.8
 * at the producer/consumer seam.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../../components/chat-fab/context-types';
import { usePageContext } from '../../components/chat-fab/usePageContext';
import { specContextItem } from '../../components/chat-fab/context-types/spec';
import { tasksContextItem } from '../../components/chat-fab/context-types/tasks';
import { ContextMenu } from '../../components/chat-fab/ContextMenu';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';

function FakeSpecPage() {
  usePageContext(
    () => [
      specContextItem(
        {
          id: 'spec-1',
          resource_id: 'res-xyz',
          title: 'Auth rewrite',
          content: 'body',
        },
        { primary: true },
      ),
      tasksContextItem([
        { id: 't-1', title: 'Wire OAuth', status: 'open' },
      ]),
    ],
    [],
  );
  return <div>spec body</div>;
}

function LayoutShell({ children }: { children: React.ReactNode }) {
  // In production, <ContextMenu /> renders inside <ChatPanel />, which is
  // a Layout sibling to the page <Outlet />. Model that here: children
  // (the "page") mount in one subtree, ContextMenu in a sibling subtree,
  // both reading the module-level store.
  return (
    <div>
      <div data-testid="page">{children}</div>
      <div data-testid="chat-fab-sibling">
        <ContextMenu onInject={() => {}} />
      </div>
    </div>
  );
}

describe('Layout-gap integration (SpecDetail-shaped producer)', () => {
  beforeEach(() => {
    usePageContextStore.setState({ items: [] });
    cleanup();
  });

  it('shows registered page items in the Add-context menu', () => {
    render(
      <LayoutShell>
        <FakeSpecPage />
      </LayoutShell>,
    );

    // Menu button should be present (items.length > 0)
    const btn = screen.getByRole('button', { name: /Add context/i });
    expect(btn).toBeDefined();

    fireEvent.click(btn);

    // Spec primary + tasks secondary both appear
    expect(screen.getByText(/Spec: Auth rewrite/i)).toBeDefined();
    expect(screen.getByText(/Linked tasks \(1\)/i)).toBeDefined();
  });

  it('hides the menu when a page has not called usePageContext', () => {
    function BarePage() {
      return <div>no context here</div>;
    }
    render(
      <LayoutShell>
        <BarePage />
      </LayoutShell>,
    );
    expect(screen.queryByRole('button', { name: /Add context/i })).toBeNull();
  });

  it('clears items on page unmount', () => {
    function Host({ mounted }: { mounted: boolean }) {
      return (
        <LayoutShell>{mounted ? <FakeSpecPage /> : null}</LayoutShell>
      );
    }
    const { rerender } = render(<Host mounted={true} />);
    expect(screen.getByRole('button', { name: /Add context/i })).toBeDefined();

    rerender(<Host mounted={false} />);
    // After the page unmounts, cleanup should clear the store → menu hides
    expect(screen.queryByRole('button', { name: /Add context/i })).toBeNull();
  });

  it('keeps at most one primary when a page submits two', () => {
    function DoublePrimaryPage() {
      // Mirror the concurrent-mode near-race that §4.3 talks about —
      // two items both flagged primary in one batch.
      usePageContext(
        () => [
          specContextItem(
            {
              id: 'spec-a',
              resource_id: 'res',
              title: 'A',
              content: 'a',
            },
            { primary: true },
          ),
          specContextItem(
            {
              id: 'spec-b',
              resource_id: 'res',
              title: 'B',
              content: 'b',
            },
            { primary: true },
          ),
        ],
        [],
      );
      return null;
    }
    // Silence the expected console.warn for this test only
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      render(<LayoutShell><DoublePrimaryPage /></LayoutShell>);
      const stored = usePageContextStore.getState().items;
      const primaries = stored.filter((i) => i.primary);
      expect(primaries).toHaveLength(1);
      expect(primaries[0]?.data).toMatchObject({ id: 'spec-b' });
    } finally {
      console.warn = origWarn;
    }
  });
});

