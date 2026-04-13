import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Activity, ChevronDown, ChevronRight, Clock, Cpu, FileText, Loader2, Search, User } from 'lucide-react';
import { useSessionsList, useSessionsInfinite, useMapSwarms } from '../hooks/useApi';
import { useSessionsRealtime } from '../hooks/useRealtimeInvalidation';
import { LoadingSpinner, PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { AgentAvatar } from '../components/common/AgentAvatar';
import { useSessionAttentionStore } from '../stores/session-attention';
import { SessionDetail } from './SessionDetail';
import type { SessionListItem, MapSwarm } from '../lib/api';

// ============================================================================
// Constants
// ============================================================================

/** Sessions synced within this window stay visible even if the swarm disconnects */
const STALE_MARGIN_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// Status helpers
// ============================================================================

type SessionStatus = 'online' | 'recent' | 'stale';

function getSessionStatus(
  session: SessionListItem,
  swarmStatusMap: Map<string, MapSwarm['status']>,
): SessionStatus {
  // Check all contributing swarms, not just the latest
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

  // Check recency fallback
  if (session.last_synced_at) {
    const age = Date.now() - new Date(session.last_synced_at).getTime();
    if (age < STALE_MARGIN_MS) return 'recent';
  }

  return 'stale';
}

const STATUS_COLORS: Record<SessionStatus, string> = {
  online: 'bg-emerald-400',
  recent: 'bg-amber-400',
  stale: 'bg-gray-500',
};

const STATUS_BORDER_COLORS: Record<SessionStatus, string> = {
  online: '#34d399',
  recent: '#fbbf24',
  stale: 'transparent',
};

// ============================================================================
// Sidebar item
// ============================================================================

function SidebarItem({
  session,
  status,
  isSelected,
  onClick,
}: {
  session: SessionListItem;
  status: SessionStatus;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { hasAttention, clearAttention } = useSessionAttentionStore();
  const needsAttention = hasAttention(session.id);

  const handleClick = () => {
    if (needsAttention) clearAttention(session.id);
    onClick();
  };

  return (
    <button
      onClick={handleClick}
      className="w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors cursor-pointer rounded-md"
      style={{
        backgroundColor: isSelected ? 'var(--color-elevated)' : undefined,
      }}
    >
      <div className="relative shrink-0">
        <AgentAvatar name={session.name} size={24} borderColor={STATUS_BORDER_COLORS[status]} />
        {needsAttention && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse border border-[var(--color-bg)]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate" style={{
          color: isSelected ? 'var(--color-text)' : 'var(--color-text-secondary)',
        }}>
          {session.name}
        </p>
      </div>
    </button>
  );
}

// ============================================================================
// Empty states
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
        <p className="text-sm">Select a session from the sidebar</p>
      </div>
    </div>
  );
}

function SessionsGrid({
  sessions,
  onSelect,
}: {
  sessions: SessionListItem[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Activity className="w-5 h-5 text-honey-500" />
          Sessions
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
          {sessions.length} session{sessions.length !== 1 ? 's' : ''} tracked.
        </p>
      </div>
      <div className="space-y-1.5">
        {sessions.map((session) => {
          const totalTokens = session.total_input_tokens + session.total_output_tokens;
          return (
            <button
              key={session.id}
              onClick={() => onSelect(session.id)}
              className="card card-hover px-3 py-2.5 flex items-start gap-3 group w-full text-left cursor-pointer"
            >
              <div
                className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-0.5"
                style={{ backgroundColor: 'var(--color-elevated)' }}
              >
                <Activity className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
                    {session.name}
                  </h3>
                  {session.total_checkpoints > 0 && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                  )}
                </div>
                {session.description && (
                  <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                    {session.description}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  {session.latest_agent && (
                    <span className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {session.latest_agent}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Activity className="w-3 h-3" />
                    {session.total_checkpoints}
                  </span>
                  {totalTokens > 0 && (
                    <span className="flex items-center gap-1">
                      <Cpu className="w-3 h-3" />
                      {formatTokens(totalTokens)}
                    </span>
                  )}
                  {session.last_synced_at && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <TimeAgo date={session.last_synced_at} />
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

function EmptySidebar() {
  return (
    <div className="px-4 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
      <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
      <p className="text-xs">No active sessions</p>
      <p className="text-2xs mt-1">Connect a swarm to see sessions here.</p>
    </div>
  );
}

// ============================================================================
// Inactive sessions section (paginated with search)
// ============================================================================

function InactiveSection({
  selectedId,
  swarmStatusMap,
  onSelect,
}: {
  selectedId?: string;
  swarmStatusMap: Map<string, MapSwarm['status']>;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce search input
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

  // Flatten pages and compute statuses
  const allSessions = useMemo(() => {
    if (!data) return [];
    return data.pages.flatMap((page) =>
      page.data.map((session) => ({
        session,
        status: getSessionStatus(session, swarmStatusMap),
      }))
    );
  }, [data, swarmStatusMap]);

  // When searching, show all results; when browsing, only show stale
  const displaySessions = useMemo(() => {
    if (debouncedSearch) return allSessions;
    return allSessions.filter(({ status }) => status === 'stale');
  }, [allSessions, debouncedSearch]);

  const total = data?.pages[0]?.total ?? 0;

  return (
    <div className="mt-2 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-2xs font-medium cursor-pointer"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {expanded
          ? <ChevronDown className="w-3 h-3" />
          : <ChevronRight className="w-3 h-3" />
        }
        {debouncedSearch ? `Results (${total})` : `Inactive (${total})`}
      </button>

      {expanded && (
        <div>
          {/* Search input */}
          <div className="px-2 pb-2">
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs"
              style={{
                backgroundColor: 'var(--color-elevated)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <Search className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
              <input
                type="text"
                value={search}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search sessions..."
                className="bg-transparent outline-none flex-1 text-xs placeholder:text-[var(--color-text-muted)]"
                style={{ color: 'var(--color-text)' }}
              />
            </div>
          </div>

          {/* Session list */}
          {isLoading ? (
            <div className="py-4 flex justify-center">
              <LoadingSpinner />
            </div>
          ) : displaySessions.length > 0 ? (
            <div className="space-y-0.5 px-1.5">
              {displaySessions.map(({ session, status }) => (
                <SidebarItem
                  key={session.id}
                  session={session}
                  status={status}
                  isSelected={session.id === selectedId}
                  onClick={() => onSelect(session.id)}
                />
              ))}

              {/* Load more */}
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
  const { id: selectedId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: sessionsData, isLoading: sessionsLoading } = useSessionsList();
  const { data: swarms } = useMapSwarms();
  useSessionsRealtime();

  // Build swarm status lookup
  const swarmStatusMap = useMemo(() => {
    const map = new Map<string, MapSwarm['status']>();
    if (swarms) {
      for (const s of swarms) {
        map.set(s.id, s.status);
      }
    }
    return map;
  }, [swarms]);

  // Filter to active set from the main sessions query
  const activeSessions = useMemo(() => {
    const all = sessionsData?.data ?? [];
    return all
      .map((session) => ({
        session,
        status: getSessionStatus(session, swarmStatusMap),
      }))
      .filter(({ status }) => status !== 'stale');
  }, [sessionsData, swarmStatusMap]);

  // Auto-navigate to first active session when landing on /sessions
  useEffect(() => {
    if (!selectedId && activeSessions.length > 0) {
      navigate(`/sessions/${activeSessions[0].session.id}`, { replace: true });
    }
  }, [selectedId, activeSessions, navigate]);

  if (sessionsLoading) return <PageLoader />;

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside
        className="w-72 shrink-0 border-r flex flex-col"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <div className="px-3 py-3 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <h2 className="text-xs font-semibold flex items-center gap-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            <Activity className="w-3.5 h-3.5 text-honey-500" />
            Sessions
            {activeSessions.length > 0 && (
              <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
                ({activeSessions.length})
              </span>
            )}
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Active sessions */}
          <div className="p-1.5">
            {activeSessions.length > 0 ? (
              <div className="space-y-0.5">
                {activeSessions.map(({ session, status }) => (
                  <SidebarItem
                    key={session.id}
                    session={session}
                    status={status}
                    isSelected={session.id === selectedId}
                    onClick={() => navigate(`/sessions/${session.id}`)}
                  />
                ))}
              </div>
            ) : (
              <EmptySidebar />
            )}
          </div>

          {/* Inactive sessions (paginated) */}
          <InactiveSection
            selectedId={selectedId}
            swarmStatusMap={swarmStatusMap}
            onSelect={(id) => navigate(`/sessions/${id}`)}
          />
        </div>
      </aside>

      {/* Detail area */}
      <main className="flex-1 overflow-y-auto min-w-0">
        {selectedId ? (
          <SessionDetail />
        ) : activeSessions.length > 0 ? (
          <EmptyDetail />
        ) : (sessionsData?.data ?? []).length > 0 ? (
          <SessionsGrid
            sessions={sessionsData!.data}
            onSelect={(id) => navigate(`/sessions/${id}`)}
          />
        ) : (
          <EmptyDetail />
        )}
      </main>
    </div>
  );
}
