import { useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, MessageSquare, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMailConversation, useSessionsList } from '../../hooks/useApi';
import { useEnrichedUserTurns } from '../../hooks/useEnrichedUserTurns';
import { useSubscribe, useWSEvent } from '../../hooks/useWebSocket';
import { TimeAgo } from '../common/TimeAgo';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { AgentAvatar } from '../common/AgentAvatar';
import {
  useChatChannel,
  ChatMessageList,
  ChatInput,
  PermissionDialog,
} from 'swarmcraft/ui/embed';
import { useConversationCapabilityResolver, conversationTarget } from '../../lib/chat/resolvers';
import { useOpenHiveAdapters } from '../../adapters/openhive-adapters';
import { usePageContext } from '../chat-fab/usePageContext';
import {
  conversationContextItem,
  type ConversationTurnRef,
} from '../chat-fab/context-types';
import type { ChatFabContextItem } from '../chat-fab/chat-fab-item';

/** Participant enrichment — maps the raw agent id on a mail turn/participant
 *  to the linked session and, when available, a better display name pulled
 *  from the session (latest_agent is the checkpoint-reporting name — usually
 *  the human-readable agent name). Avatar falls back to hashing the raw
 *  agent id when the agent never produced a checkpoint. */
interface ParticipantLink {
  sessionId: string;
  /** Display name — prefers session.latest_agent, else session.name, else the
   *  raw agent id. Seeded into AgentAvatar so the boring-avatar palette is
   *  consistent with Sessions list rendering. */
  agentName: string;
}

/**
 * Mail conversation detail, rendered inside the unified Threads page.
 * Mirrors the chat surface from SessionDetail's trajectory tab — same
 * ChatMessageList + ChatInput + PermissionDialog components, mail-only
 * adapter. Extracted from the legacy Conversation.tsx so mail threads can
 * be viewed without a separate top-level route.
 */
export function MailThreadView({ conversationId }: { conversationId: string }) {
  const { data, isLoading } = useMailConversation(conversationId);
  const { data: sessionsData } = useSessionsList();
  const queryClient = useQueryClient();

  useSubscribe([`mail:conversation:${conversationId}`]);
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['mail-conversation', conversationId] });
  }, [queryClient, conversationId]);
  useWSEvent('mail.turn.added', invalidate);
  useWSEvent('mail.participant.joined', invalidate);
  useWSEvent('mail.closed', invalidate);

  const adapters = useOpenHiveAdapters();
  const resolveCapabilities = useConversationCapabilityResolver(conversationId);
  const target = useMemo(() => conversationTarget(conversationId), [conversationId]);
  const channel = useChatChannel({ target, adapters, resolveCapabilities });

  // Map participant agent id → session resource id so each avatar becomes a
  // drill-in when a linked session exists. Two match paths:
  //   1. Session's metadata.acp_target_agent_id matches the participant id
  //      directly (the common case — an ACP target is also a mail speaker).
  //   2. Session's metadata.mail_conversation_id === this conversation AND
  //      owner_agent_id matches the participant (covers user-owned sessions
  //      that aren't ACP-targeted at the participant).
  //
  // Only the first match wins if both hit. Participants with no match stay
  // non-clickable.
  const participantSessionMap = useMemo(() => {
    const map = new Map<string, ParticipantLink>();
    const sessions = sessionsData?.data ?? [];
    const nameFor = (s: (typeof sessions)[number]) =>
      s.latest_agent ?? s.name ?? s.acp_target_agent_id ?? '';
    for (const s of sessions) {
      if (s.acp_target_agent_id && !map.has(s.acp_target_agent_id)) {
        map.set(s.acp_target_agent_id, {
          sessionId: s.id,
          agentName: nameFor(s) || s.acp_target_agent_id,
        });
      }
    }
    for (const s of sessions) {
      if (s.mail_conversation_id === conversationId && s.owner_agent_id && !map.has(s.owner_agent_id)) {
        map.set(s.owner_agent_id, {
          sessionId: s.id,
          agentName: nameFor(s) || s.owner_agent_id,
        });
      }
    }
    return map;
  }, [sessionsData, conversationId]);

  // Enrich agent-authored messages with the resolved session-agent name
  // (ChatBubble uses `agentIdentity.name` to seed its BoringAvatar palette).
  // User/supervisor turns are decorated by `useEnrichedUserTurns` below.
  const agentEnriched = useMemo(() => {
    if (!channel.messages.length) return channel.messages;
    if (participantSessionMap.size === 0) return channel.messages;
    return channel.messages.map((m) => {
      if (m.role === 'user' || m.role === 'supervisor') return m;
      const link = m.sender ? participantSessionMap.get(m.sender) : undefined;
      if (!link) return m;
      return {
        ...m,
        senderName: link.agentName,
        agentIdentity: {
          ...(m.agentIdentity ?? {}),
          id: m.sender,
          name: link.agentName,
        },
      };
    });
  }, [channel.messages, participantSessionMap]);

  // Second pass: decorate user/supervisor turns with openhive Agent
  // identity. Unified across surfaces so the same viewer sees the same
  // user avatar + name in mail, trajectory, and coordination chat.
  const enrichedMessages = useEnrichedUserTurns(agentEnriched);

  // Declare chat context items. Primary is the conversation; the last few
  // turns ride inline in the conversation body via recent_turns. Runs
  // unconditionally before the early returns below so hook order is stable.
  const conversationForContext = data?.conversation;
  const turnsForContext = data?.turns;
  const turnCountForContext = data?.turn_count;
  usePageContext(
    () => {
      if (!conversationForContext) return [];
      const recent: ConversationTurnRef[] = (turnsForContext ?? [])
        .slice(-3)
        .map((t) => {
          const content = t.content as unknown;
          let content_text: string | undefined;
          if (typeof content === 'string') {
            content_text = content;
          } else if (content && typeof content === 'object') {
            const c = content as Record<string, unknown>;
            if (typeof c.text === 'string') content_text = c.text;
          }
          return {
            participant_id: t.participant_id,
            content_text,
            created_at: t.created_at,
          };
        });
      const items: ChatFabContextItem[] = [
        conversationContextItem(
          {
            id: conversationForContext.id,
            subject: conversationForContext.subject,
            status: conversationForContext.status,
            scope: conversationForContext.scope,
            participant_count: conversationForContext.participants?.length,
            turn_count: turnCountForContext,
            recent_turns: recent.length > 0 ? recent : undefined,
          },
          { primary: true },
        ),
      ];
      return items;
    },
    [conversationForContext, turnsForContext, turnCountForContext],
  );

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <LoadingSpinner />
      </div>
    );
  }

  const conversation = data?.conversation;
  const threads = data?.threads ?? [];

  if (!conversation) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Conversation not found.
        </p>
      </div>
    );
  }

  const isGroup = conversation.participants.length > 2;

  return (
    <div className="flex flex-col h-full">
      {/* Header — mirrors SessionDetail's sticky header but with group-chat
          participant stack when N > 2. */}
      <div
        className="px-4 py-3 border-b flex items-center gap-3 shrink-0"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <MessageSquare className="w-4 h-4 text-honey-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-bold truncate flex items-center gap-2">
            {conversation.subject || 'Untitled conversation'}
            {isGroup && (
              <span
                className="text-2xs font-normal px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: 'var(--color-accent-bg)',
                  color: 'var(--color-accent)',
                }}
              >
                group · {conversation.participants.length}
              </span>
            )}
          </h1>
          <div className="flex items-center gap-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <span
              className={`px-1.5 py-0.5 rounded ${
                conversation.status === 'active'
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-gray-500/10 text-gray-400'
              }`}
            >
              {conversation.status}
            </span>
            <span>{data?.turn_count ?? 0} turn{(data?.turn_count ?? 0) !== 1 ? 's' : ''}</span>
            {threads.length > 0 && (
              <span>{threads.length} sub-thread{threads.length !== 1 ? 's' : ''}</span>
            )}
            <span>
              <TimeAgo date={conversation.updated_at} />
            </span>
          </div>
        </div>

        {/* Participant stack (group-thread affordance: shows who's here).
            Linked participants (agent has a session) render as a boring-
            avatar keyed on the resolved agent name + accent border + link;
            unlinked participants fall back to the raw agent id so the
            palette stays deterministic (matches Sessions list visuals). */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Users className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          <div className="flex -space-x-1.5">
            {conversation.participants.slice(0, 5).map((p) => {
              const link = participantSessionMap.get(p.agent_id);
              const displayName = link?.agentName ?? p.agent_id;
              const label = `${displayName}${p.role ? ` (${p.role})` : ''}`;
              const avatar = (
                <AgentAvatar
                  name={displayName}
                  size={24}
                  borderColor={link ? 'var(--color-accent)' : undefined}
                />
              );
              return link ? (
                <Link
                  key={p.agent_id}
                  to={`/threads/${link.sessionId}`}
                  className="hover:scale-110 transition-transform"
                  title={`${label} — view session →`}
                >
                  {avatar}
                </Link>
              ) : (
                <div key={p.agent_id} title={`${label} — no linked session`}>
                  {avatar}
                </div>
              );
            })}
            {conversation.participants.length > 5 && (
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-2xs border-2"
                style={{
                  backgroundColor: 'var(--color-elevated)',
                  borderColor: 'var(--color-bg)',
                  color: 'var(--color-text-muted)',
                }}
              >
                +{conversation.participants.length - 5}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Participants strip — explicit list with per-participant session
          drill-in. Only rendered for group threads (> 2 participants) since
          1:1 conversations already show the speaker in the bubble header.
          Each row: name · role · [View session →] when a session exists. */}
      {isGroup && (
        <div
          className="px-4 py-2 border-b flex items-center gap-2 overflow-x-auto shrink-0"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-elevated)',
          }}
        >
          <span
            className="text-2xs font-medium uppercase tracking-wider shrink-0"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Participants
          </span>
          {conversation.participants.map((p) => {
            const link = participantSessionMap.get(p.agent_id);
            const displayName = link?.agentName ?? p.agent_id;
            const roleSuffix = p.role ? ` · ${p.role}` : '';
            const avatar = <AgentAvatar name={displayName} size={16} />;
            return link ? (
              <Link
                key={p.agent_id}
                to={`/threads/${link.sessionId}`}
                className="flex items-center gap-1.5 text-2xs px-2 py-0.5 rounded-md cursor-pointer transition-colors shrink-0"
                style={{
                  backgroundColor: 'var(--color-accent-bg)',
                  color: 'var(--color-accent)',
                }}
                title={`View ${displayName}'s session trajectory`}
              >
                {avatar}
                <span className="font-medium">{displayName}</span>
                <span className="opacity-70">{roleSuffix}</span>
                <ExternalLink className="w-2.5 h-2.5" />
              </Link>
            ) : (
              <span
                key={p.agent_id}
                className="flex items-center gap-1.5 text-2xs px-2 py-0.5 rounded-md shrink-0"
                style={{ color: 'var(--color-text-muted)' }}
              >
                {avatar}
                <span className="font-medium">{displayName}</span>
                <span>{roleSuffix}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* Chat surface. `messages` prop overrides channel.messages so we can
          inject resolved agent names/avatars per bubble; the rest of the
          channel (status, permissions, reply callbacks) flows through. */}
      <div className="flex-1 min-h-0 flex flex-col">
        <ChatMessageList
          channel={channel}
          messages={enrichedMessages}
          continuationHeaders
          emptyMessage="No messages in this conversation yet."
        />
      </div>
      <PermissionDialog
        channel={channel}
        variant="sticky-external"
        descriptionAs="code"
        approveLabel="Allow"
      />
      <ChatInput
        channel={channel}
        showModeBadge
        // Override the generic "Agent is offline" fallback when the thread
        // itself was closed — the swarm may be fine, just this conversation
        // is terminated. Only applies once the conversation has loaded;
        // during the loading gap the default "No channel available" is
        // more accurate.
        unavailableReason={
          conversation.status !== 'active'
            ? `Conversation ${conversation.status} — replies disabled`
            : undefined
        }
      />
    </div>
  );
}
