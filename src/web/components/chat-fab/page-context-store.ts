/**
 * PageContextStore — module-level zustand store holding the current page's
 * declared context items.
 *
 * React Context can't bridge the Layout gap (producer in `<Outlet />`
 * page tree, consumer in `<ChatFab />` Layout sibling), so pages write
 * here and `ContextMenu` subscribes directly.
 *
 * See §4.2 / §4.3 in docs/CHAT_CONTEXT_INJECTION_DESIGN.md.
 */

import { create } from 'zustand';
import type { ChatFabContextItem } from './chat-fab-item';

export interface PageContextState {
  items: ChatFabContextItem[];
  setItems: (items: ChatFabContextItem[]) => void;
  clear: () => void;
}

export const usePageContextStore = create<PageContextState>((set) => ({
  items: [],
  setItems: (items) => {
    // At-most-one primary, enforced at the store so concurrent-mode route
    // transitions (two near-simultaneous `usePageContext` effects) settle
    // on last-write-wins rather than racing.
    const primaries = items.filter((i) => i.primary);
    if (primaries.length > 1) {
      if (import.meta.env?.DEV) {
        console.warn(
          '[PageContextStore] multiple primary items; keeping last',
        );
      }
      const last = primaries[primaries.length - 1]!;
      items = [
        ...items.filter((i) => !i.primary || i === last),
      ];
    }
    set({ items });
  },
  clear: () => set({ items: [] }),
}));
