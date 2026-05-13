import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity, ChevronDown, ChevronRight, Clock, Cpu, FileText, Loader2, Mail,
  Search, User, Users,
} from 'lucide-react';
import { useSessionsList, useSessionsInfinite, useMapSwarms, useMailConversations, useHostedSwarms } from '../hooks/useApi';
import { useSessionsRealtime } from '../hooks/useRealtimeInvalidation';
import { useSubscribe, useWSEvent } from '../hooks/useWebSocket';
import { useQueryClient } from '@tanstack/react-query';
import { LoadingSpinner, PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { AgentAvatar } from '../components/common/AgentAvatar';
import { StatusChip, type StatusTone } from '../components/common/StatusChip';
import { useSessionAttentionStore } from '../stores/session-attention';
import { SessionDetail } from './SessionDetail';
import { MailThreadView } from '../components/sessions/MailThreadView';
import { HostedChat } from '../components/hosted-chat/HostedChat';
import { Link } from 'react-router-dom';
import type { SessionListItem, MapSwarm, MailConversation, HostedSwarm } from '../lib/api';

// ============================================================================
// Constants
// ============================================================================

/** Sessions synced within this window stay visible even if the swarm disconnects */
const STALE_MARGIN_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// Thread model — unifies sessions + mail conversations
// ============================================================================

type ThreadFlavor = 'session' | 'mail' | 'dispatch' | 'hosted-chat';

type ThreadStatus = 'live' | 'recent' | 'idle' | 'mail-active' | 'mail-completed' | 'hosted-running';

interface Thread {
  /** Underlying data id (session resource id or mail conversation id) */
  id: string;
  flavor: ThreadFlavor;
  /** Route path — `/threads/<id>` or `/threads/mail/<id>` */
  to: string;
  title: string;
  description?: string | null;
  status: ThreadStatus;
  /** Primary sort key */
  lastActivityAt: string;
  participantCount: number;
  /** Session-specific */
  session?: SessionListItem;
  /** Mail-specific */
  conversation?: MailConversation;
}

function getSessionStatus(
  session: SessionListItem,
  swarmStatusMap: Map<string, MapSwarm['status']>,
): 'online' | 'recent' | 'stale' {
  const swarmIds = session.source_swarm_ids?.length
    ? session.source_swarm_ids
    : session.source_swarm_id ? [session.source_swarm_id] : [];

  let hasUnreachable = false;
  for (const swarmId of swarmIds) {
    const status = swarmStatusMap.get(swarmId);
    if (status === 'online') return 'online';
    if (status === 'unreachable') hasUnreachable = true;
  }
  if (hasUnreachable) return 'recent';

  if (session.last_synced_at) {
    const age = Date.now() - new Date(session.last_synced_at).getTime();
    if (age < STALE_MARGIN_MS) return 'recent';
  }

  return 'stale';
}

function sessionToThread(
  session: SessionListItem,
  swarmStatusMap: Map<string, MapSwarm['status']>,
): Thread {
  const raw = getSessionStatus(session, swarmStatusMap);
  const status: ThreadStatus =
    raw === 'online' ? 'live' : raw === 'recent' ? 'recent' : 'idle';
  return {
    id: session.id,
    flavor: 'session',
    to: `/threads/${session.id}`,
    title: session.name,
    description: session.description,
    status,
    lastActivityAt: session.last_synced_at ?? new Date(0).toISOString(),
    participantCount: 1,
    session,
  };
}

function mailToThread(conv: MailConversation): Thread {
  const isDispatchThread = conv.scope === 'dispatch-thread';
  const status: ThreadStatus = conv.status === 'active' ? 'mail-active' : 'mail-completed';
  // Dispatch threads link to their dispatch detail page instead of the mail view
  const dispatchId = isDispatchThread
    ? (conv.metadata?.dispatch_id as string | undefined)
    : undefined;
  return {
    id: conv.id,
    flavor: isDispatchThread ? 'dispatch' : 'mail',
    to: dispatchId ? `/dispatch/${dispatchId}` : `/threads/mail/${conv.id}`,
    title: conv.subject || (isDispatchThread ? 'Dispatch thread' : 'Untitled conversation'),
    description: conv.participants.map((p) => p.agent_id).join(', ') || null,
    status,
    lastActivityAt: conv.updated_at,
    participantCount: conv.participants.length,
    conversation: conv,
  };
}

const STATUS_CHIP: Record<ThreadStatus, { label: string; tone: StatusTone }> = {
  live:             { label: 'live',    tone: 'success' },
  recent:           { label: 'recent',  tone: 'warning' },
  idle:             { label: 'idle',    tone: 'neutral' },
  'mail-active':    { label: 'active',  tone: 'success' },
  'mail-completed': { label: 'closed',  tone: 'neutral' },
  'hosted-running': { label: 'running', tone: 'success' },
};

const TONE_BORDER_HEX: Record<StatusTone, string> = {
  success: '#34d399',
  warning: '#fbbf24',
  danger:  '#ef4444',
  info:    '#3b82f6',
  neutral: 'transparent',
  accent:  '#f5a623',
};

function statusBorderColor(status: ThreadStatus): string {
  return TONE_BORDER_HEX[STATUS_CHIP[status].tone];
}

// ============================================================================
// Filter chips
// ============================================================================

type FilterKey = 'all' | 'live' | 'mail' | 'dispatch';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all',      label: 'All' },
  { key: 'live',     label: 'Live' },
  { key: 'mail',     label: 'Mail' },
  { key: 'dispatch', label: 'Dispatch' },
];

function FilterChips({
  active,
  onChange,
}: {
  active: FilterKey;
  onChange: (key: FilterKey) => void;
}) {
  return (
    <div className="flex gap-1 px-2 py-2 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
      {FILTERS.map((f) => (
        <button
          key={f.key}
          onClick={() => onChange(f.key)}
          className={`text-2xs px-2 py-0.5 rounded-md cursor-pointer transition-colors ${
            active === f.key ? 'bg-honey-500/15 text-honey-500' : ''
          }`}
          style={
            active === f.key
              ? undefined
              : { color: 'var(--color-text-secondary)', backgroundColor: 'var(--color-elevated)' }
          }
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// Thread row (sidebar)
// ============================================================================

function ThreadRow({
  thread,
  isSelected,
  onClick,
}: {
  thread: Thread;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { hasAttention, clearAttention } = useSessionAttentionStore();
  const needsAttention = thread.flavor === 'session' && hasAttention(thread.id);

  const handleClick = () => {
    if (needsAttention) clearAttention(thread.id);
    onClick();
  };

  const isGroup = thread.flavor === 'mail' && thread.participantCount > 2;

  return (
    <button
      onClick={handleClick}
      className="w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors cursor-pointer rounded-md"
      style={{
        backgroundColor: isSelected ? 'var(--color-elevated)' : undefined,
      }}
    >
      <div className="relative shrink-0">
        {thread.flavor === 'session' ? (
          <AgentAvatar
            name={thread.title}
            size={24}
            borderColor={statusBorderColor(thread.status)}
          />
        ) : isGroup ? (
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center"
            style={{
              backgroundColor: 'var(--color-elevated)',
              border: `1.5px solid ${statusBorderColor(thread.status)}`,
            }}
            title={`Group of ${thread.participantCount}`}
          >
            <Users className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
          </div>
        ) : (
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center"
            style={{
              backgroundColor: 'var(--color-elevated)',
              border: `1.5px solid ${statusBorderColor(thread.status)}`,
            }}
            title="Mail thread"
          >
            <Mail className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
          </div>
        )}
        {needsAttention && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse border border-[var(--color-bg)]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p
          className="text-xs font-medium truncate"
          style={{ color: isSelected ? 'var(--color-text)' : 'var(--color-text-secondary)' }}
        >
          {thread.title}
        </p>
        {thread.description && (
          <p className="text-2xs truncate leading-tight" style={{ color: 'var(--color-text-muted)' }}>
            {thread.description}
          </p>
        )}
      </div>
    </button>
  );
}

// ============================================================================
// Empty / grid placeholders
// ============================================================================

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function EmptyDetail() {
  return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="text-center" style={{ color: 'var(--color-text-muted)' }}>
        <Activity className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="text-sm">Select a thread from the sidebar</p>
      </div>
    </div>
  );
}

function EmptySidebar() {
  return (
    <div className="px-4 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
      <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
      <p className="text-xs">No threads yet</p>
      <p className="text-2xs mt-1">Connect a swarm or start a conversation.</p>
    </div>
  );
}

function ThreadsGrid({
  threads,
  onSelect,
}: {
  threads: Thread[];
  onSelect: (thread: Thread) => void;
}) {
  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Activity className="w-5 h-5 text-honey-500" />
          Threads
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
          {threads.length} thread{threads.length !== 1 ? 's' : ''} tracked.
        </p>
      </div>
      <div className="space-y-1.5">
        {threads.map((t) => {
          const chip = STATUS_CHIP[t.status];
          const isGroup = t.flavor === 'mail' && t.participantCount > 2;
          const isMail = t.flavor === 'mail';
          const tokens = t.session
            ? t.session.total_input_tokens + t.session.total_output_tokens
            : 0;
          return (
            <button
              key={`${t.flavor}:${t.id}`}
              onClick={() => onSelect(t)}
              className="card card-hover px-3 py-2.5 flex items-start gap-3 group w-full text-left cursor-pointer"
            >
              <div
                className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-0.5"
                style={{ backgroundColor: 'var(--color-elevated)' }}
              >
                {isMail ? (
                  isGroup ? (
                    <Users className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                  ) : (
                    <Mail className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                  )
                ) : (
                  <Activity className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
                    {t.title}
                  </h3>
                  <StatusChip label={chip.label} tone={chip.tone} shape="square" className="shrink-0" />
                </div>
                {t.description && (
                  <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                    {t.description}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  {t.session?.latest_agent && (
                    <span className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {t.session.latest_agent}
                    </span>
                  )}
                  {t.flavor === 'mail' && (
                    <span className="flex items-center gap-1" title="Participants">
                      <Users className="w-3 h-3" />
                      {t.participantCount}
                    </span>
                  )}
                  {t.session && t.session.total_checkpoints > 0 && (
                    <span className="flex items-center gap-1">
                      <Activity className="w-3 h-3" />
                      {t.session.total_checkpoints}
                    </span>
                  )}
                  {tokens > 0 && (
                    <span className="flex items-center gap-1">
                      <Cpu className="w-3 h-3" />
                      {formatTokens(tokens)}
                    </span>
                  )}
                  {t.lastActivityAt && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <TimeAgo date={t.lastActivityAt} />
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Inactive / stale sessions (paginated with search, sessions-only)
// ============================================================================

function InactiveSection({
  selectedKey,
  swarmStatusMap,
  onSelect,
}: {
  /** `session:<id>` | `mail:<id>` — sidebar highlight key */
  selectedKey: string | null;
  swarmStatusMap: Map<string, MapSwarm['status']>;
  onSelect: (thread: Thread) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = (value: string) => {
    setSearch(value);
    if (debounceRef[0]) clearTimeout(debounceRef[0]);
    debounceRef[0] = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useSessionsInfinite({
    limit: 30,
    search: debouncedSearch || undefined,
  });

  const allThreads = useMemo(() => {
    if (!data) return [] as Thread[];
    return data.pages.flatMap((page) =>
      page.data.map((session) => sessionToThread(session, swarmStatusMap)),
    );
  }, [data, swarmStatusMap]);

  const displayThreads = useMemo(() => {
    if (debouncedSearch) return allThreads;
    return allThreads.filter((t) => t.status === 'idle');
  }, [allThreads, debouncedSearch]);

  const total = data?.pages[0]?.total ?? 0;

  return (
    <div className="mt-2 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-2xs font-medium cursor-pointer"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {debouncedSearch ? `Results (${total})` : `Inactive threads (${total})`}
      </button>

      {expanded && (
        <div>
          <div className="px-2 pb-2">
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
            >
              <Search className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
              <input
                type="text"
                value={search}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search threads..."
                className="bg-transparent outline-none flex-1 text-xs placeholder:text-[var(--color-text-muted)]"
                style={{ color: 'var(--color-text)' }}
              />
            </div>
          </div>

          {isLoading ? (
            <div className="py-4 flex justify-center"><LoadingSpinner /></div>
          ) : displayThreads.length > 0 ? (
            <div className="space-y-0.5 px-1.5">
              {displayThreads.map((t) => (
                <ThreadRow
                  key={`${t.flavor}:${t.id}`}
                  thread={t}
                  isSelected={`${t.flavor}:${t.id}` === selectedKey}
                  onClick={() => onSelect(t)}
                />
              ))}
              {hasNextPage && (
                <button
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  className="w-full py-1.5 text-2xs font-medium cursor-pointer flex items-center justify-center gap-1"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {isFetchingNextPage ? (
                    <><Loader2 className="w-3 h-3 animate-spin" /> Loading...</>
                  ) : (
                    'Load more'
                  )}
                </button>
              )}
            </div>
          ) : (
            <p className="px-3 py-3 text-2xs text-center" style={{ color: 'var(--color-text-muted)' }}>
              {debouncedSearch ? 'No matching sessions' : 'No inactive sessions'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main layout
// ============================================================================

export function Sessions() {
  const params = useParams<{ id?: string; mailId?: string; hostedId?: string }>();
  const navigate = useNavigate();
  const { data: sessionsData, isLoading: sessionsLoading } = useSessionsList();
  const { data: mailConvs } = useMailConversations();
  const { data: swarms } = useMapSwarms();
  // Pull running hosted swarms so codex-rpc rows surface as Threads. We
  // filter client-side; the list is small (capped by max_swarms), and
  // useHostedSwarms already drives query invalidation on swarm-lifecycle
  // events.
  const { data: hostedSwarms } = useHostedSwarms({ state: 'running' });
  useSessionsRealtime();

  // Keep mail list fresh via WebSocket
  useSubscribe(['mail:conversations']);
  const queryClient = useQueryClient();
  const invalidateMail = () => queryClient.invalidateQueries({ queryKey: ['mail-conversations'] });
  useWSEvent('mail.created', invalidateMail);
  useWSEvent('mail.turn.added', invalidateMail);
  useWSEvent('mail.closed', invalidateMail);

  const selectedSessionId = params.id ?? null;
  const selectedMailId = params.mailId ?? null;
  const selectedHostedId = params.hostedId ?? null;
  const selectedKey = selectedSessionId
    ? `session:${selectedSessionId}`
    : selectedMailId
      ? `mail:${selectedMailId}`
      : selectedHostedId
        ? `hosted-chat:${selectedHostedId}`
      : null;

  const [filter, setFilter] = useState<FilterKey>('all');

  const swarmStatusMap = useMemo(() => {
    const map = new Map<string, MapSwarm['status']>();
    if (swarms) {
      for (const s of swarms) map.set(s.id, s.status);
    }
    return map;
  }, [swarms]);

  // Build unified active thread list.
  // "Active" = sessions with a live/recent swarm OR any mail conversation
  // not yet archived. Stale sessions flow into InactiveSection (sessions-only
  // paginated browse).
  const activeThreads = useMemo(() => {
    const sessionThreads = (sessionsData?.data ?? [])
      .map((s) => sessionToThread(s, swarmStatusMap))
      .filter((t) => t.status !== 'idle');
    const mailThreads = (mailConvs ?? [])
      .filter((c) => c.status !== 'archived')
      .map(mailToThread);
    // Programmatic-mode hosted swarms (mode='rpc', any kind) surface as
    // live threads — clicking routes to the swarm detail page where the
    // inline chat lives. Each running rpc-mode swarm gets one thread row.
    // Provider-agnostic — codex today, future kinds drop in without
    // changes here.
    const hostedChatThreads: Thread[] = (hostedSwarms ?? [])
      .filter((h) => h.mode === 'rpc' && h.state === 'running')
      .map((h) => ({
        id: `hosted-chat:${h.id}`,
        flavor: 'hosted-chat' as ThreadFlavor,
        to: `/threads/hosted-chat/${h.id}`,
        title: h.name ?? h.id,
        description: `${h.kind ?? 'hosted'} · openhive chat`,
        status: 'hosted-running' as ThreadStatus,
        lastActivityAt: h.updated_at ?? h.created_at ?? new Date().toISOString(),
        participantCount: 1,
      }));
    return [...sessionThreads, ...mailThreads, ...hostedChatThreads].sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
  }, [sessionsData, mailConvs, swarmStatusMap, hostedSwarms]);

  const liveThreads = useMemo(
    () => activeThreads.filter(
      (t) => t.status === 'live' || t.status === 'mail-active' || t.status === 'hosted-running',
    ),
    [activeThreads],
  );

  const visibleActive = useMemo(() => {
    switch (filter) {
      case 'live': return activeThreads.filter(
        (t) => t.status === 'live' || t.status === 'mail-active' || t.status === 'hosted-running',
      );
      case 'mail': return activeThreads.filter((t) => t.flavor === 'mail');
      case 'dispatch': return activeThreads.filter((t) => t.flavor === 'dispatch');
      default:     return activeThreads;
    }
  }, [activeThreads, filter]);

  // Auto-navigate to first thread when landing on bare /threads
  useEffect(() => {
    if (!selectedKey && activeThreads.length > 0) {
      navigate(activeThreads[0].to, { replace: true });
    }
  }, [selectedKey, activeThreads, navigate]);

  const handleSelect = (t: Thread) => navigate(t.to);

  if (sessionsLoading) return <PageLoader />;

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside
        className="w-72 shrink-0 border-r flex flex-col"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <div
          className="px-3 py-3 border-b"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <h2
            className="text-xs font-semibold flex items-center gap-1.5"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <Activity className="w-3.5 h-3.5 text-honey-500" />
            Threads
            {visibleActive.length > 0 && (
              <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
                ({visibleActive.length})
              </span>
            )}
          </h2>
        </div>

        <FilterChips active={filter} onChange={setFilter} />

        <div className="flex-1 overflow-y-auto">
          {visibleActive.length > 0 ? (
            <div className="p-1.5">
              {/* Pinned Live (only when filter is 'all' and there are mixed states) */}
              {filter === 'all' && liveThreads.length > 0 && liveThreads.length < visibleActive.length && (
                <>
                  <div
                    className="px-2 py-1 text-2xs font-medium uppercase tracking-wider flex items-center gap-1.5"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live
                  </div>
                  <div className="space-y-0.5 mb-2">
                    {liveThreads.map((t) => (
                      <ThreadRow
                        key={`${t.flavor}:${t.id}`}
                        thread={t}
                        isSelected={`${t.flavor}:${t.id}` === selectedKey}
                        onClick={() => handleSelect(t)}
                      />
                    ))}
                  </div>
                  <div
                    className="px-2 py-1 text-2xs font-medium uppercase tracking-wider"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    Recent
                  </div>
                  <div className="space-y-0.5">
                    {visibleActive
                      .filter((t) => t.status !== 'live' && t.status !== 'mail-active')
                      .map((t) => (
                        <ThreadRow
                          key={`${t.flavor}:${t.id}`}
                          thread={t}
                          isSelected={`${t.flavor}:${t.id}` === selectedKey}
                          onClick={() => handleSelect(t)}
                        />
                      ))}
                  </div>
                </>
              )}

              {/* Single flat list (filter active, or no mixed states) */}
              {(filter !== 'all' || liveThreads.length === 0 || liveThreads.length === visibleActive.length) && (
                <div className="space-y-0.5">
                  {visibleActive.map((t) => (
                    <ThreadRow
                      key={`${t.flavor}:${t.id}`}
                      thread={t}
                      isSelected={`${t.flavor}:${t.id}` === selectedKey}
                      onClick={() => handleSelect(t)}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <EmptySidebar />
          )}

          {/* Inactive sessions — stale sessions only; paginated browse */}
          <InactiveSection
            selectedKey={selectedKey}
            swarmStatusMap={swarmStatusMap}
            onSelect={handleSelect}
          />
        </div>
      </aside>

      {/* Detail area */}
      <main className="flex-1 overflow-y-auto min-w-0">
        {selectedMailId ? (
          <MailThreadView conversationId={selectedMailId} />
        ) : selectedSessionId ? (
          <SessionDetail />
        ) : selectedHostedId ? (
          <HostedChatThreadDetail hostedSwarmId={selectedHostedId} hostedSwarms={hostedSwarms ?? []} />
        ) : activeThreads.length > 0 ? (
          <EmptyDetail />
        ) : (sessionsData?.data ?? []).length > 0 || (mailConvs ?? []).length > 0 ? (
          <ThreadsGrid
            threads={[
              ...(sessionsData?.data ?? []).map((s) => sessionToThread(s, swarmStatusMap)),
              ...(mailConvs ?? []).map(mailToThread),
            ].sort((a, b) =>
              new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
            )}
            onSelect={handleSelect}
          />
        ) : (
          <EmptyDetail />
        )}
      </main>
    </div>
  );
}

// ============================================================================
// Hosted-chat detail (codex-rpc and any future programmatic-mode kind)
// ============================================================================

/**
 * Right-pane view for `/threads/hosted-chat/:hostedId`. Composes the same
 * `<HostedChat>` widget the rest of openhive uses (swarmcraft's
 * `ChatMessageList` + `ChatInput` underneath). The list of running hosted
 * swarms is already loaded in Sessions; we just look up this row to drive
 * the header label + a "back to swarm" affordance.
 */
function HostedChatThreadDetail({
  hostedSwarmId,
  hostedSwarms,
}: {
  hostedSwarmId: string;
  hostedSwarms: HostedSwarm[];
}) {
  const hosted = hostedSwarms.find((h) => h.id === hostedSwarmId);
  if (!hosted) {
    return (
      <div className="p-6">
        <div
          className="card p-4 text-center text-xs"
          style={{ color: 'var(--color-text-muted)' }}
        >
          No running hosted swarm with id <code>{hostedSwarmId}</code>. It may
          have stopped — return to{' '}
          <Link to="/threads" className="text-honey-500 hover:underline">
            Threads
          </Link>
          .
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div
        className="px-4 py-2 border-b text-xs flex items-center justify-between"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <div>
          <span className="font-medium">{hosted.name ?? hosted.id}</span>
          <span
            className="ml-2 text-2xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {hosted.kind ?? 'hosted'} · {hosted.mode ?? 'rpc'}
          </span>
        </div>
        <Link
          to={`/swarms/${hosted.swarm_id ?? hosted.id}`}
          className="text-2xs hover:underline"
          style={{ color: 'var(--color-text-muted)' }}
        >
          View swarm details →
        </Link>
      </div>
      <div className="flex-1 min-h-0">
        <HostedChat
          hostedSwarmId={hostedSwarmId}
          providerLabel={hosted.kind}
        />
      </div>
    </div>
  );
}

