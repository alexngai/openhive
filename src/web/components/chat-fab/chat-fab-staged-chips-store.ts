/**
 * ChatFabStagedChipsStore — session-scoped, tab-local store of chips the
 * user has staged in the composer.
 *
 * Distinct from `PageContextStore` (page-scoped menu items). See §4.2 of
 * docs/CHAT_CONTEXT_INJECTION_DESIGN.md:
 *
 * | Store | Contents | Scope | Cleared by |
 * |---|---|---|---|
 * | `PageContextStore`   | menu items declared by the active page | page | on unmount |
 * | `ChatFabStagedChips` | chips staged in composer | session/tab | ×, Send, Clear, session swap |
 *
 * Tab-local: no cross-tab sync, no persistence, no WS fan-out.
 */

import { create } from 'zustand';
import type { ChatFabContextItem } from './chat-fab-item';

export interface ChatFabStagedChip {
  /** Local uuid for removal. Not persisted. */
  chipId: string;
  /** Full item snapshot — data travels with the chip so the page can unmount. */
  item: ChatFabContextItem;
  /** ms epoch */
  stagedAt: number;
}

export interface ChatFabStagedChipsState {
  stagedChips: ChatFabStagedChip[];
  addChip: (item: ChatFabContextItem) => void;
  removeChip: (chipId: string) => void;
  clearChips: () => void;
}

function dedupeKey(item: ChatFabContextItem): string {
  // kind+id dedup per §4.6. Prefer the registry `kind` when available,
  // but fall back to `type` for untyped legacy items. The id comes from
  // `data.id` — our registered types (spec/tasks/dispatch) all put it
  // there, and legacy pages that construct items by hand follow the same
  // convention.
  const id =
    (item.data as { id?: string | number } | undefined)?.id ??
    // `tasks` has no single id; use a stable stringification of ids
    ((item.data as { tasks?: Array<{ id?: string }> } | undefined)?.tasks
      ?.map((t) => t?.id ?? '?')
      .join(','));
  return `${item.type}:${id ?? '?'}`;
}

function generateChipId(): string {
  // Small uid; doesn't need cryptographic strength.
  return `chip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useChatFabStagedChipsStore = create<ChatFabStagedChipsState>((set, get) => ({
  stagedChips: [],
  addChip: (item) => {
    const key = dedupeKey(item);
    const existing = get().stagedChips;
    if (existing.some((c) => dedupeKey(c.item) === key)) {
      // Silent no-op on dupes per worker brief.
      return;
    }
    const chip: ChatFabStagedChip = {
      chipId: generateChipId(),
      item,
      stagedAt: Date.now(),
    };
    set({ stagedChips: [...existing, chip] });
  },
  removeChip: (chipId) => {
    set({
      stagedChips: get().stagedChips.filter((c) => c.chipId !== chipId),
    });
  },
  clearChips: () => set({ stagedChips: [] }),
}));
