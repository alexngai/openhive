/**
 * Conversation context type — a mail (MAP Agent Inbox) thread.
 *
 * Prose body (§4.5): markdown with subject, status, participant count,
 * and a capped excerpt of the last N turns (N=3) as quoted block excerpts.
 */

import type { ChatFabContextItem } from '../chat-fab-item';
import { registerContextType } from '../context-registry';
import { fencedBlock } from '../fenced-block';

const MAX_TURNS = 3;
const TURN_EXCERPT_MAX_CHARS = 200;

export interface ConversationTurnRef {
  participant_id?: string;
  content_text?: string;
  created_at?: string;
}

export interface ConversationData {
  id: string;
  subject?: string;
  status?: string;
  participant_count?: number;
  turn_count?: number;
  recent_turns?: ConversationTurnRef[];
  swarm_id?: string;
  scope?: string;
}

/**
 * React Query shape returned by `useMailConversation`
 * (`['mail-conversation', id]`). Narrowed locally — turn content can be
 * any `MessageContent`, we only peek for a `text` string.
 */
interface CachedMailConversation {
  conversation?: {
    id?: string;
    subject?: string;
    status?: string;
    scope?: string;
    participants?: Array<unknown>;
  };
  turns?: Array<{
    participant_id?: string;
    content?: unknown;
    content_type?: string;
    created_at?: string;
  }>;
  turn_count?: number;
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
    if (typeof c.summary === 'string') return c.summary;
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

function identity(d: ConversationData): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      id: d.id,
      swarm_id: d.swarm_id,
    }).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
}

function buildAttrs(
  d: ConversationData,
  stale: boolean,
): Record<string, string> {
  const attrs: Record<string, string> = {
    kind: 'openhive:conversation',
    ...identity(d),
  };
  if (stale) attrs.stale = 'true';
  return attrs;
}

function formatBody(d: ConversationData): string {
  const lines: string[] = [];
  if (d.subject) lines.push(`**${d.subject}**`);
  const meta: string[] = [];
  if (d.status) meta.push(`- Status: \`${d.status}\``);
  if (typeof d.participant_count === 'number') {
    meta.push(`- Participants: ${d.participant_count}`);
  }
  if (typeof d.turn_count === 'number') {
    meta.push(`- Turns: ${d.turn_count}`);
  }
  if (d.scope) meta.push(`- Scope: \`${d.scope}\``);
  if (meta.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(...meta);
  }
  const recent = d.recent_turns ?? [];
  if (recent.length > 0) {
    const capped = recent.slice(-MAX_TURNS);
    lines.push('', `_Last ${capped.length} turn${capped.length === 1 ? '' : 's'}:_`);
    for (const t of capped) {
      const speaker = t.participant_id ? `\`${t.participant_id}\`` : '_unknown_';
      const text = t.content_text
        ? truncate(t.content_text, TURN_EXCERPT_MAX_CHARS).replace(/\n+/g, ' ')
        : '_(no text content)_';
      lines.push(`> **${speaker}:** ${text}`);
    }
  }
  if (lines.length === 0) return `- ID: \`${d.id}\``;
  return lines.join('\n');
}

function projectCachedConversation(
  cached: CachedMailConversation,
  fallback: ConversationData,
): ConversationData | null {
  const c = cached.conversation;
  if (!c || !c.id) return null;
  const turns = cached.turns ?? [];
  const recent_turns: ConversationTurnRef[] = turns
    .slice(-MAX_TURNS)
    .map((t) => ({
      participant_id: t.participant_id,
      content_text: extractText(t.content),
      created_at: t.created_at,
    }));
  return {
    id: c.id,
    subject: c.subject ?? fallback.subject,
    status: c.status ?? fallback.status,
    scope: c.scope ?? fallback.scope,
    swarm_id: fallback.swarm_id,
    participant_count: c.participants?.length ?? fallback.participant_count,
    turn_count: cached.turn_count ?? fallback.turn_count,
    recent_turns: recent_turns.length > 0 ? recent_turns : fallback.recent_turns,
  };
}

registerContextType<ConversationData>({
  type: 'conversation',
  kind: 'openhive:conversation',
  description: 'A mail thread (MAP agent inbox) — async agent conversation.',
  icon: '📬',
  label: (d) => `Conversation: ${d.subject ?? d.id}`,
  identity,
  format: (d, flags) =>
    fencedBlock(
      'context',
      buildAttrs(d, Boolean(flags?.stale)),
      formatBody(d),
    ),
  live: async (d, { queryClient, signal }) => {
    const cached = queryClient.getQueryData<CachedMailConversation>([
      'mail-conversation',
      d.id,
    ]);
    if (cached) {
      return projectCachedConversation(cached, d);
    }
    const fetched = await queryClient.fetchQuery<CachedMailConversation>({
      queryKey: ['mail-conversation', d.id],
      signal,
    });
    if (!fetched) return null;
    return projectCachedConversation(fetched, d);
  },
});

export function conversationContextItem(
  conversation: ConversationData,
  opts: { primary?: boolean } = {},
): ChatFabContextItem & { type: 'conversation'; data: ConversationData } {
  return {
    type: 'conversation',
    label: `Conversation: ${conversation.subject ?? conversation.id}`,
    data: conversation,
    primary: opts.primary,
  };
}
