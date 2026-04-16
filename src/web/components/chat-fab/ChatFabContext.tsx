/**
 * ChatFab Context — page-level context injection
 *
 * Each page registers available context items (current spec, tasks, dispatch, etc.)
 * that the user can inject into the chat conversation via the "Add context" menu.
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface ChatFabContextItem {
  /** Display label in the context menu */
  label: string;
  /** Item type — used for icon selection and formatting */
  type: 'spec' | 'tasks' | 'dispatch' | 'swarm' | 'session' | 'task' | 'context' | 'custom';
  /** The data payload to format into a chat message */
  data: Record<string, unknown>;
}

export interface ChatFabContextValue {
  items: ChatFabContextItem[];
}

const ChatFabCtx = createContext<ChatFabContextValue>({ items: [] });

export function ChatFabContextProvider({
  items,
  children,
}: {
  items: ChatFabContextItem[];
  children: ReactNode;
}) {
  return (
    <ChatFabCtx.Provider value={{ items }}>
      {children}
    </ChatFabCtx.Provider>
  );
}

export function useChatFabContext(): ChatFabContextValue {
  return useContext(ChatFabCtx);
}
