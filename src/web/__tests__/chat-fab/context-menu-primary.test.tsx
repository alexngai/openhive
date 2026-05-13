/**
 * ContextMenu — primary styling + `@` shortcut.
 *
 * We use the public `forwardRef` handle (`openWithPrimary`) to simulate the
 * `@` keystroke path. The chip path is the flag-on default for this test
 * (dev env has `CHAT_CONTEXT_CHIPS` on by default); the legacy path is
 * covered in `feature-flag.test.tsx`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createRef } from 'react';
import '../../components/chat-fab/context-types';
import {
  ContextMenu,
  type ContextMenuHandle,
} from '../../components/chat-fab/ContextMenu';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';
import { useChatFabStagedChipsStore } from '../../components/chat-fab/chat-fab-staged-chips-store';
import type { ChatFabContextItem } from '../../components/chat-fab/chat-fab-item';

function reset() {
  usePageContextStore.setState({ items: [] });
  useChatFabStagedChipsStore.setState({ stagedChips: [] });
  cleanup();
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_CHAT_CONTEXT_CHIPS', 'true');
}

const primaryItem: ChatFabContextItem = {
  type: 'spec',
  label: 'Auth Spec',
  data: { id: 'spec-a', resource_id: 'r', title: 'Auth', content: 'x' },
  primary: true,
};
const secondaryItem: ChatFabContextItem = {
  type: 'task',
  label: 'Task B',
  data: { id: 't-b' },
};

describe('ContextMenu primary + @', () => {
  beforeEach(reset);

  it('renders primary item at top with distinct styling', () => {
    usePageContextStore.getState().setItems([primaryItem, secondaryItem]);
    render(<ContextMenu onInject={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Add context/i }));

    const primaryBtn = screen.getByTestId('context-menu-primary');
    expect(primaryBtn).toBeDefined();
    expect(primaryBtn.textContent).toMatch(/@Current page/);
    expect(primaryBtn.textContent).toMatch(/Auth Spec/);

    // Separator + secondary present.
    expect(screen.getByRole('separator')).toBeDefined();
    expect(screen.getByText('Task B')).toBeDefined();
  });

  it('openWithPrimary() opens the menu preselected; Enter stages the primary as a chip', () => {
    usePageContextStore.getState().setItems([primaryItem, secondaryItem]);
    const ref = createRef<ContextMenuHandle>();
    render(<ContextMenu ref={ref} onInject={() => {}} />);

    let opened = false;
    act(() => {
      opened = ref.current?.openWithPrimary() ?? false;
    });
    expect(opened).toBe(true);

    // Menu visible
    expect(screen.getByRole('menu')).toBeDefined();

    // Enter stages the primary chip.
    act(() => {
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' });
    });
    const chips = useChatFabStagedChipsStore.getState().stagedChips;
    expect(chips).toHaveLength(1);
    expect(chips[0]?.item.type).toBe('spec');
    expect(chips[0]?.item.data).toMatchObject({ id: 'spec-a' });
  });

  it('openWithPrimary() returns false when no primary is registered', () => {
    usePageContextStore.getState().setItems([secondaryItem]);
    const ref = createRef<ContextMenuHandle>();
    render(<ContextMenu ref={ref} onInject={() => {}} />);
    let opened = true;
    act(() => {
      opened = ref.current?.openWithPrimary() ?? false;
    });
    expect(opened).toBe(false);
  });

  it('normal menu button still opens the menu', () => {
    usePageContextStore.getState().setItems([primaryItem]);
    render(<ContextMenu onInject={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Add context/i }));
    expect(screen.getByRole('menu')).toBeDefined();
  });
});
