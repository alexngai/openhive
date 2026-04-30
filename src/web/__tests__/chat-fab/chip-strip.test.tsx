import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../../components/chat-fab/context-types';
import { ChipStrip } from '../../components/chat-fab/ChipStrip';
import { useChatFabStagedChipsStore } from '../../components/chat-fab/chat-fab-staged-chips-store';
import type { ChatFabContextItem } from '../../components/chat-fab/chat-fab-item';

function reset() {
  useChatFabStagedChipsStore.setState({ stagedChips: [] });
  cleanup();
}

function stage(item: ChatFabContextItem) {
  useChatFabStagedChipsStore.getState().addChip(item);
}

function stageN(n: number, prefix = 'spec') {
  for (let i = 0; i < n; i++) {
    stage({
      type: prefix,
      label: `${prefix} ${i}`,
      data: { id: `${prefix}-${i}` },
    });
  }
}

describe('ChipStrip', () => {
  beforeEach(reset);

  it('renders nothing when no chips are staged', () => {
    render(<ChipStrip />);
    expect(screen.queryByTestId('chip-strip')).toBeNull();
  });

  it('renders one chip per staged item', () => {
    stage({ type: 'spec', label: 'Spec A', data: { id: 'a' } });
    stage({ type: 'task', label: 'Task B', data: { id: 'b' } });
    render(<ChipStrip />);
    expect(screen.getByText('Spec A')).toBeDefined();
    expect(screen.getByText('Task B')).toBeDefined();
  });

  it('× click removes the chip from the store', () => {
    stage({ type: 'spec', label: 'Spec A', data: { id: 'a' } });
    render(<ChipStrip />);
    const removeBtn = screen.getByLabelText('Remove chip Spec A');
    fireEvent.click(removeBtn);
    expect(useChatFabStagedChipsStore.getState().stagedChips).toHaveLength(0);
  });

  it('6th chip collapses into +N; clicking expands popover listing hidden chips', () => {
    stageN(6);
    render(<ChipStrip />);
    // First 5 visible, 6th is in overflow.
    expect(screen.getByText('spec 0')).toBeDefined();
    expect(screen.getByText('spec 4')).toBeDefined();
    expect(screen.queryByText('spec 5')).toBeNull();

    // +N button shows overflow count.
    const plusN = screen.getByText(/^\+1$/);
    expect(plusN).toBeDefined();

    fireEvent.click(plusN);
    const popover = screen.getByTestId('chip-overflow-popover');
    expect(popover).toBeDefined();
    // Now spec 5 is visible in the popover.
    expect(screen.getByText('spec 5')).toBeDefined();
  });

  it('hover preview appears on pointer-enter; dismisses on pointer-leave and Escape', () => {
    stage({
      type: 'spec',
      label: 'Spec A',
      data: {
        id: 'a',
        resource_id: 'res-1',
        title: 'Auth',
        content: 'body-text',
      },
    });
    render(<ChipStrip />);
    const chip = screen.getByRole('group', {
      name: /Staged context: Spec A/i,
    });
    fireEvent.pointerEnter(chip);
    const preview = screen.getByTestId('chip-hover-preview');
    expect(preview).toBeDefined();
    // Preview body contains the fenced-block text.
    expect(preview.textContent).toMatch(/<context /);

    fireEvent.pointerLeave(chip);
    expect(screen.queryByTestId('chip-hover-preview')).toBeNull();

    // Re-open + dismiss with Escape.
    fireEvent.pointerEnter(chip);
    expect(screen.getByTestId('chip-hover-preview')).toBeDefined();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('chip-hover-preview')).toBeNull();
  });

  it('overflow popover chips can be individually removed', () => {
    stageN(6);
    render(<ChipStrip />);
    fireEvent.click(screen.getByText(/^\+1$/));
    // Overflow chip "spec 5" has an × button
    const removeBtn = screen.getByLabelText('Remove chip spec 5');
    fireEvent.click(removeBtn);
    expect(useChatFabStagedChipsStore.getState().stagedChips).toHaveLength(5);
  });
});
