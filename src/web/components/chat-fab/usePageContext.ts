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
  options?: { enabled?: boolean },
): void {
  // The page-context store is a single global slot (setItems replaces, clear
  // empties on unmount), so two simultaneous callers stomp each other. When a
  // component is embedded inside a page that already owns the context (e.g.
  // MailThreadView inside DispatchDetail), pass `enabled: false` so it stays a
  // no-op and leaves the host page's context intact.
  const enabled = options?.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const items = build();
    usePageContextStore.getState().setItems(items);
    return () => {
      usePageContextStore.getState().clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);
}
