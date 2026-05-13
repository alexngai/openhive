/**
 * usePageContext — register the current page's context items.
 *
 * Call from a page component to declare what items show up in the ChatFab
 * "Add context" menu while the page is mounted. Items are replaced on
 * dependency change, and cleared on unmount.
 *
 * See §4.2 in docs/CHAT_CONTEXT_INJECTION_DESIGN.md.
 */

import { useEffect, type DependencyList } from 'react';
import type { ChatFabContextItem } from './chat-fab-item';
import { usePageContextStore } from './page-context-store';

export function usePageContext(
  build: () => ChatFabContextItem[],
  deps: DependencyList,
): void {
  useEffect(() => {
    const items = build();
    usePageContextStore.getState().setItems(items);
    return () => {
      usePageContextStore.getState().clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
