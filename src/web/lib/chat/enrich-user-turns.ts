/**
 * enrich-user-turns — consistent identity rendering for user/supervisor
 * ChatMessages across every chat surface (mail, trajectory, ACP, coord).
 *
 * Today the five code paths that produce user turns (mail adapter, session
 * event converter, ACP service echo, useChatChannel optimistic echo,
 * coordination adapter) each hardcode `senderName: 'You'` or leave it
 * blank. That's wrong when:
 *   1. Multiple openhive users share a hive and one views another's turn
 *      (was rendered as "You" because the heuristic doesn't know who's
 *      viewing).
 *   2. The sender's Agent record carries a name + avatar_url the UI never
 *      surfaces.
 *
 * This module resolves `ChatMessage.sender` against an openhive Agent map
 * and decorates user/supervisor turns uniformly:
 *   - avatar_url present → `agentIdentity.avatar` → ChatBubble renders an img
 *   - avatar_url absent  → `agentIdentity.color = honey` → role icon, tinted
 *     like the sidebar's fallback user chip
 *   - unknown sender     → name = 'user', honey tint
 *
 * Decision note: every hive user, including the viewer themselves, shows
 * their real name. No special "You" case. Treats all humans uniformly and
 * eliminates the multi-user bug entirely.
 */

import type { ChatMessage } from 'swarmcraft/ui/embed';
import type { Agent } from '../api';

/** Honey-500 — matches `var(--color-accent)` in the dark theme. Used as
 *  the user-turn fallback tint so the bubble's role icon matches the
 *  sidebar's user avatar chip when no avatar_url is uploaded. */
const USER_TINT = '#f59e0b';

/** Generic fallback sender ids that useChatChannel / adapters emit for
 *  turns without a resolved identity (typical of optimistic echoes on
 *  fresh ACP streams). Never resolved via the lookup — always decorated
 *  as `user`. */
const GENERIC_USER_SENDERS = new Set(['user', 'local-user']);

function isUserRole(role: ChatMessage['role']): boolean {
  return role === 'user' || role === 'supervisor';
}

function resolveSenderAgent(sender: string | undefined, lookup: Record<string, Agent>): Agent | null {
  if (!sender) return null;
  if (GENERIC_USER_SENDERS.has(sender)) return null;
  // `local-user-<ts>` is a useChatChannel optimistic sentinel and can never
  // be a real openhive agent id — reject before probing the lookup so a
  // spurious lookup entry with the same prefix can't accidentally resolve.
  if (sender.startsWith('local-user-')) return null;
  const direct = lookup[sender];
  return direct ?? null;
}

/**
 * Extract the unique set of sender ids from user/supervisor messages that
 * might resolve to a hive Agent. Generic `user`/`local-user-*` sentinels
 * are filtered out — they never resolve.
 */
export function extractUserSenderIds(messages: ChatMessage[]): string[] {
  const set = new Set<string>();
  for (const m of messages) {
    if (!isUserRole(m.role)) continue;
    const s = m.sender;
    if (!s) continue;
    if (GENERIC_USER_SENDERS.has(s)) continue;
    if (s.startsWith('local-user-')) continue;
    set.add(s);
  }
  return Array.from(set);
}

/**
 * Decorate user/supervisor messages with resolved identity. Agent messages
 * pass through unchanged (their enrichment happens elsewhere — the
 * participant-session map in MailThreadView, or at the adapter layer).
 *
 * Apply at every chat-consuming surface so the visual identity of a user
 * turn is the same in MailThreadView, SessionDetail trajectory, ChatFab
 * panel, and SwarmDetail coordination.
 */
export function enrichUserTurns(
  messages: ChatMessage[],
  lookup: Record<string, Agent>,
): ChatMessage[] {
  if (messages.length === 0) return messages;
  return messages.map((m) => {
    if (!isUserRole(m.role)) return m;
    const agent = resolveSenderAgent(m.sender, lookup);
    const name = agent?.name ?? 'user';
    const avatarUrl = agent?.avatar_url ?? null;
    // Preserve any identity an upstream layer already set (e.g. coordination
    // adapter might already carry a swarm-level identity); only fill gaps.
    const existing = m.agentIdentity ?? {};
    return {
      ...m,
      // Normalize role to 'user' so every human turn renders with the same
      // ChatBubble icon (User/person). Mail adapter stamps 'supervisor',
      // which would otherwise render as a Shield — creating a surface-
      // dependent avatar for the *same* person. Continuation grouping and
      // bubble tinting already bucket 'user' and 'supervisor' identically
      // (see getMessageAuthor + isUserAuthored in ChatBubble), so this is
      // purely an icon normalization.
      role: 'user',
      senderName: m.senderName && m.senderName !== 'You' ? m.senderName : name,
      agentIdentity: {
        id: existing.id ?? agent?.id,
        name: existing.name ?? name,
        avatar: existing.avatar ?? avatarUrl ?? undefined,
        // Tint only kicks in when no avatar URL is available — ChatBubble's
        // avatar picker will render an img when `avatar` is set and ignore
        // `color`. Keeping both means any caller that uploads an avatar
        // still gets the img path without losing the color-fallback.
        color: existing.color ?? (avatarUrl ? undefined : USER_TINT),
      },
    };
  });
}
