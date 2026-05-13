/**
 * ChatFabContextItem — the in-flight shape for a single context entry as it
 * moves from a page declaration (via `usePageContext`) through the menu,
 * the staged-chip store, and the formatter.
 */

export interface ChatFabContextItem {
  /** Display label in the context menu */
  label: string;
  /**
   * Item type — used for icon selection and formatting. Typed as `string`
   * so registry-backed types can participate without extending the legacy
   * closed union. Existing literal unions remain assignable.
   */
  type:
    | 'spec' | 'tasks' | 'dispatch' | 'swarm' | 'session' | 'task' | 'context' | 'custom'
    | (string & {});
  /** The data payload to format into a chat message */
  data: Record<string, unknown>;
  /**
   * At-most-one primary item per page. Renders pinned at the top of the
   * context menu. Enforced store-side (last-write-wins + dev warning).
   */
  primary?: boolean;
}
