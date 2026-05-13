/**
 * Feature flag gating — §7.0 / §7.1 step 9.
 *
 * Post-step-9 semantics:
 *   - Default (no env var): chips ON.
 *   - `VITE_CHAT_CONTEXT_CHIPS=false`: chips OFF (escape hatch / rollback lever).
 *   - `VITE_CHAT_CONTEXT_CHIPS=true`: chips ON (redundant, still ON).
 *
 * The legacy direct-injection path was deleted in step 9; when the flag is
 * OFF, ChatPanel renders the plain swarmcraft `ChatInput` and ContextMenu is
 * not rendered at all. This test only exercises the helper + the chip-stage
 * behavior of ContextMenu (which itself is only rendered when the flag is ON).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../../components/chat-fab/context-types';
import { ContextMenu } from '../../components/chat-fab/ContextMenu';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';
import { useChatFabStagedChipsStore } from '../../components/chat-fab/chat-fab-staged-chips-store';
import { isChatContextChipsEnabled } from '../../components/chat-fab/feature-flags';
import type { ChatFabContextItem } from '../../components/chat-fab/chat-fab-item';

function reset() {
  usePageContextStore.setState({ items: [] });
  useChatFabStagedChipsStore.setState({ stagedChips: [] });
  cleanup();
}

const item: ChatFabContextItem = {
  type: 'spec',
  label: 'Spec A',
  data: { id: 'a', resource_id: 'r', title: 't', content: 'c' },
};

describe('CHAT_CONTEXT_CHIPS feature flag', () => {
  beforeEach(() => {
    reset();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('helper returns true by default (no env var)', () => {
    vi.stubEnv('VITE_CHAT_CONTEXT_CHIPS', '');
    expect(isChatContextChipsEnabled()).toBe(true);
  });

  it('helper returns false ONLY when VITE_CHAT_CONTEXT_CHIPS=false', () => {
    vi.stubEnv('VITE_CHAT_CONTEXT_CHIPS', 'false');
    expect(isChatContextChipsEnabled()).toBe(false);
  });

  it('helper returns true when VITE_CHAT_CONTEXT_CHIPS=true (redundant explicit on)', () => {
    vi.stubEnv('VITE_CHAT_CONTEXT_CHIPS', 'true');
    expect(isChatContextChipsEnabled()).toBe(true);
  });

  it('helper returns true for any non-"false" value (e.g. typos, unset)', () => {
    vi.stubEnv('VITE_CHAT_CONTEXT_CHIPS', 'no');
    expect(isChatContextChipsEnabled()).toBe(true);
  });

  it('clicking a context-menu item stages a chip (the only path post-step-9)', () => {
    usePageContextStore.getState().setItems([item]);
    render(<ContextMenu />);
    fireEvent.click(screen.getByRole('button', { name: /Add context/i }));
    fireEvent.click(screen.getByText('Spec A'));

    const chips = useChatFabStagedChipsStore.getState().stagedChips;
    expect(chips).toHaveLength(1);
    expect(chips[0]?.item.label).toBe('Spec A');
  });
});
