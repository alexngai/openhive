import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { usePageContextStore } from '../../components/chat-fab/page-context-store';
import type { ChatFabContextItem } from '../../components/chat-fab/chat-fab-item';

function reset() {
  usePageContextStore.setState({ items: [] });
}

describe('PageContextStore primary uniqueness', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('keeps the last-written primary when two are submitted together', () => {
    const items: ChatFabContextItem[] = [
      { type: 'spec', label: 'First', data: { id: '1' }, primary: true },
      { type: 'tasks', label: 'Also primary', data: { id: '2' }, primary: true },
    ];
    usePageContextStore.getState().setItems(items);
    const stored = usePageContextStore.getState().items;
    const primaries = stored.filter((i) => i.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.label).toBe('Also primary');
  });

  it('fires a dev-mode warning when multiple primaries are submitted', () => {
    const items: ChatFabContextItem[] = [
      { type: 'spec', label: 'A', data: {}, primary: true },
      { type: 'tasks', label: 'B', data: {}, primary: true },
    ];
    usePageContextStore.getState().setItems(items);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does not warn when only one primary is present', () => {
    const items: ChatFabContextItem[] = [
      { type: 'spec', label: 'Only', data: {}, primary: true },
      { type: 'tasks', label: 'Not primary', data: {} },
    ];
    usePageContextStore.getState().setItems(items);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(usePageContextStore.getState().items).toHaveLength(2);
  });

  it('clear() empties items', () => {
    usePageContextStore.getState().setItems([
      { type: 'spec', label: 'X', data: {} },
    ]);
    usePageContextStore.getState().clear();
    expect(usePageContextStore.getState().items).toEqual([]);
  });
});
