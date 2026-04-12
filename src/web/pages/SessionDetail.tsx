import { useState, useEffect, useMemo } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  Activity, AlertTriangle, Brain, ChevronDown, ChevronRight,
  Clock, Cpu, FileText, GitBranch, GitCommit, Hash,
  MessageSquare, ShieldAlert, User,
} from 'lucide-react';
import { useResource, useSessionCheckpoints, useSessionStats, useSessionEvents, useSessionParticipants } from '../hooks/useApi';
import { useSessionsRealtime } from '../hooks/useRealtimeInvalidation';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { AgentAvatar } from '../components/common/AgentAvatar';
import { formatTokens, deduplicateStreamingEvents } from '../components/events/event-utils';
import { EventStream } from '../components/events/EventStream';
import { SessionChatInput } from '../components/events/SessionChatInput';
import type { TrajectoryCheckpoint, AgentIdentity } from '../lib/api';
import { useSessionAttentionStore } from '../stores/session-attention';
import { useSessionChat } from '../hooks/useSessionChat';
import clsx from 'clsx';

// ============================================================================
// Helpers
// ============================================================================

type DetailTab = 'checkpoints' | 'trajectory' | 'learning';

// ============================================================================
// Checkpoint Timeline
// ============================================================================

function CheckpointRow({ checkpoint }: { checkpoint: TrajectoryCheckpoint }) {
  const [expanded, setExpanded] = useState(false);
  const inputTokens = checkpoint.token_usage?.input_tokens ?? 0;
  const outputTokens = checkpoint.token_usage?.output_tokens ?? 0;
  const totalTokens = inputTokens + outputTokens;

  return (
    <div className="relative pl-6">
      <div
        className="absolute left-0 top-2.5 w-2.5 h-2.5 rounded-full border-2"
        style={{
          borderColor: 'var(--color-honey-500, #f59e0b)',
          backgroundColor: 'var(--color-bg)',
        }}
      />

      <div
        className={clsx(
          'card px-3 py-2 cursor-pointer transition-colors',
          expanded && 'ring-1 ring-honey-500/20'
        )}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <code
            className="text-2xs font-mono px-1 py-0.5 rounded shrink-0"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
          >
            {checkpoint.commit_hash.slice(0, 7)}
          </code>

          <span className="text-xs truncate flex items-center gap-1" style={{ color: 'var(--color-text)' }}>
            <User className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
            {checkpoint.agent}
          </span>

          {checkpoint.branch && (
            <span
              className="text-2xs px-1.5 py-0.5 rounded flex items-center gap-0.5 shrink-0"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
            >
              <GitBranch className="w-2.5 h-2.5" />
              {checkpoint.branch}
            </span>
          )}

          <div className="flex-1" />

          <div className="flex items-center gap-2.5 text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
            {checkpoint.files_touched.length > 0 && (
              <span className="flex items-center gap-0.5" title="Files touched">
                <FileText className="w-3 h-3" />
                {checkpoint.files_touched.length}
              </span>
            )}
            {totalTokens > 0 && (
              <span className="flex items-center gap-0.5" title="Tokens">
                <Cpu className="w-3 h-3" />
                {formatTokens(totalTokens)}
              </span>
            )}
            <TimeAgo date={checkpoint.synced_at} />
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </div>
        </div>

        {expanded && (
          <div className="mt-2 pt-2 border-t space-y-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {totalTokens > 0 && (
              <div className="flex items-center gap-4 text-2xs" style={{ color: 'var(--color-text-secondary)' }}>
                <span>Input: {formatTokens(inputTokens)}</span>
                <span>Output: {formatTokens(outputTokens)}</span>
              </div>
            )}

            {checkpoint.files_touched.length > 0 && (
              <div>
                <p className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
                  Files touched
                </p>
                <div className="flex flex-wrap gap-1">
                  {checkpoint.files_touched.map((f) => (
                    <code
                      key={f}
                      className="text-2xs px-1.5 py-0.5 rounded font-mono"
                      style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
                    >
                      {f}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {checkpoint.summary && (
              <div>
                <p className="text-2xs font-medium mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Summary</p>
                {checkpoint.summary.intent && (
                  <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    <strong>Intent:</strong> {checkpoint.summary.intent}
                  </p>
                )}
                {checkpoint.summary.outcome && (
                  <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    <strong>Outcome:</strong> {checkpoint.summary.outcome}
                  </p>
                )}
              </div>
            )}

            {checkpoint.attribution && Object.keys(checkpoint.attribution).length > 0 && (
              <div>
                <p className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>Attribution</p>
                <div className="flex gap-2">
                  {Object.entries(checkpoint.attribution).map(([key, val]) => (
                    <span
                      key={key}
                      className="text-2xs px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
                    >
                      {key}: {typeof val === 'number' ? `${Math.round(val * 100)}%` : String(val)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              <span className="flex items-center gap-0.5">
                <Hash className="w-3 h-3" />
                {checkpoint.checkpoint_id.slice(0, 12)}
              </span>
              {checkpoint.source_swarm_id && (
                <span>swarm: {checkpoint.source_swarm_id.slice(0, 8)}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CheckpointsTab({ checkpoints, total, isLoading }: {
  checkpoints: TrajectoryCheckpoint[];
  total: number;
  isLoading: boolean;
}) {
  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          Checkpoint Timeline
          {total > 0 && (
            <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
              ({total})
            </span>
          )}
        </h2>
      </div>

      {isLoading ? (
        <PageLoader />
      ) : checkpoints.length > 0 ? (
        <div className="relative space-y-2 ml-1">
          <div
            className="absolute left-[4px] top-3 bottom-3 w-px"
            style={{ backgroundColor: 'var(--color-border-subtle)' }}
          />
          {checkpoints.map((cp) => (
            <CheckpointRow key={cp.id} checkpoint={cp} />
          ))}
        </div>
      ) : (
        <div className="card px-6 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
          <Activity className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-xs">No checkpoint data yet for this session.</p>
        </div>
      )}
    </>
  );
}

// ============================================================================
// Trajectory Viewer (thin wrapper around EventStream)
// ============================================================================

function TrajectoryTab({ sessionId, hasTrajectorySupport, agentIdentity, sourceSwarmId, existingAcpStreamId, existingAcpSessionId }: {
  sessionId: string;
  hasTrajectorySupport: boolean;
  agentIdentity?: AgentIdentity;
  sourceSwarmId?: string | null;
  existingAcpStreamId?: string | null;
  existingAcpSessionId?: string | null;
}) {
  const {
    data,
    isLoading,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useSessionEvents(sessionId, { enabled: hasTrajectorySupport });

  // Chat integration — gated by published MAP capabilities
  const {
    chatMode, chatStatus, sendMessage, cancelStream, capabilities, streamingEvents, streamError,
    permissions, replyPermission,
  } = useSessionChat({ sessionId, sourceSwarmId, enabled: hasTrajectorySupport, existingAcpStreamId, existingAcpSessionId });

  const pages = data?.pages ?? [];
  const trajectoryEvents = pages.flatMap((page) => page.events);
  const total = pages[0]?.total ?? 0;

  // Merge ACP streaming events with trajectory events, deduplicating overlaps.
  // Must be called unconditionally (before early returns) to satisfy Rules of Hooks.
  const events = useMemo(() => {
    if (streamingEvents.length === 0) return trajectoryEvents;
    const unique = deduplicateStreamingEvents(streamingEvents, trajectoryEvents);
    if (unique.length === 0) return trajectoryEvents;
    return [...[...unique].reverse(), ...trajectoryEvents];
  }, [trajectoryEvents, streamingEvents]);

  if (!hasTrajectorySupport) {
    return (
      <div className="card px-6 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
        <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          Trajectory not available
        </p>
        <p className="text-xs">
          No trajectory data available. The swarm may be offline or no checkpoints have been recorded yet.
        </p>
      </div>
    );
  }

  if (isError && events.length === 0) {
    return (
      <>
        <div className="card px-6 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
            Could not load trajectory
          </p>
          <p className="text-xs">{(error as Error)?.message || 'Unknown error'}</p>
        </div>
        <SessionChatInput
          mode={chatMode}
          status={chatStatus}
          onSend={sendMessage}
          onCancel={cancelStream}
          capabilities={capabilities}
          streamError={streamError}
        />
      </>
    );
  }

  return (
    <>
      <EventStream
        events={events}
        agentIdentity={agentIdentity}
        isLoading={isLoading}
        hasMore={hasNextPage}
        onLoadMore={() => fetchNextPage()}
        isLoadingMore={isFetchingNextPage}
        total={total}
        formatId={pages[0]?.format_id}
        emptyMessage="No events found in this session."
        emptyIcon={MessageSquare}
      />
      {permissions.length > 0 && (
        <div className="border-t px-4 py-3 space-y-2" style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-secondary)' }}>
          {permissions.map((perm) => (
            <div key={perm.requestId} className="flex items-center gap-3 px-3 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--color-border-warning, var(--color-border))', background: 'var(--color-bg)' }}>
              <ShieldAlert className="w-4 h-4 shrink-0" style={{ color: 'var(--color-text-warning, var(--color-accent))' }} />
              <div className="flex-1 min-w-0">
                <span className="font-medium">Tool approval: </span>
                <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'var(--color-bg-tertiary)' }}>
                  {perm.toolCall?.name ?? 'unknown tool'}
                </code>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => replyPermission(perm.requestId, true)}
                  className="px-2.5 py-1 text-xs font-medium rounded"
                  style={{ background: 'var(--color-accent)', color: 'white' }}
                >
                  Allow
                </button>
                <button
                  onClick={() => replyPermission(perm.requestId, false)}
                  className="px-2.5 py-1 text-xs font-medium rounded border"
                  style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <SessionChatInput
        mode={chatMode}
        status={chatStatus}
        onSend={sendMessage}
        onCancel={cancelStream}
        capabilities={capabilities}
        streamError={streamError}
      />
    </>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<DetailTab>('trajectory');
  const { data: resource, isLoading: resourceLoading } = useResource(id!);
  const { data: checkpointsData, isLoading: checkpointsLoading } = useSessionCheckpoints(id!);
  const { data: stats } = useSessionStats(id!);
  const { data: participantsData } = useSessionParticipants(id!);
  const { hasAttention, clearAttention } = useSessionAttentionStore();
  useSessionsRealtime();

  // Clear attention when viewing a session
  useEffect(() => {
    if (id && hasAttention(id)) clearAttention(id);
  }, [id, hasAttention, clearAttention]);

  // Derive assistant agent identity for the trajectory view.
  const assistantAgent: AgentIdentity | undefined = (() => {
    if (resource) {
      return {
        id: resource.owner?.id || resource.owner_agent_id || '',
        name: resource.name,
        avatarUrl: null,
      };
    }
    return undefined;
  })();

  if (resourceLoading) return <PageLoader />;

  if (!resource) {
    return (
      <div className="px-4 py-12 text-center">
        <p style={{ color: 'var(--color-text-muted)' }}>Session not found.</p>
      </div>
    );
  }

  const checkpoints = checkpointsData?.data ?? [];
  const total = checkpointsData?.total ?? 0;
  const meta = (resource?.metadata ?? {}) as Record<string, unknown>;
  const sourceSwarmId = checkpoints[0]?.source_swarm_id
    ?? (meta.source_swarm_id as string)
    ?? null;
  // Existing ACP stream/session from create-acp endpoint (avoids duplicate stream creation).
  // URL search params survive page reloads; metadata is the async fallback.
  const existingAcpStreamId = searchParams.get('streamId') ?? (meta.acpStreamId as string) ?? null;
  const existingAcpSessionId = searchParams.get('sessionId') ?? (meta.sessionId as string) ?? null;
  // Enable trajectory/chat for sessions with checkpoints OR eagerly-created ACP sessions
  const hasTrajectorySupport = total > 0 || !!sourceSwarmId;

  return (
    <>
      {/* Full-width sticky header */}
      <div
        className="sticky top-0 z-10 py-2 px-6 border-b"
        style={{ backgroundColor: 'var(--color-bg)', borderColor: 'var(--color-border-subtle)' }}
      >
        <div className="flex items-center gap-3 mb-2">
          {assistantAgent && (
            <AgentAvatar name={assistantAgent.name} src={assistantAgent.avatarUrl} size={32} />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold truncate">{resource.name}</h1>
              <span className="text-2xs px-1.5 py-0.5 rounded bg-honey-500/10 text-honey-500">
                session
              </span>
              {id && hasAttention(id) && (
                <span className="text-2xs px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 animate-pulse">
                  Awaiting input
                </span>
              )}
            </div>
            {stats && (
              <div className="flex items-center gap-2.5 mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                <span className="flex items-center gap-1 text-2xs">
                  <Cpu className="w-3 h-3" />
                  {formatTokens(stats.total_input_tokens)} / {formatTokens(stats.total_output_tokens)}
                </span>
                <span className="flex items-center gap-1 text-2xs" title="Files modified">
                  <FileText className="w-3 h-3" />
                  {stats.total_files_touched}
                </span>
              </div>
            )}
          </div>
          {/* Inline tab group */}
          <div
            className="flex items-center rounded-md p-0.5 shrink-0"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            {([
              { key: 'trajectory', icon: MessageSquare, label: 'Trajectory' },
              { key: 'checkpoints', icon: GitCommit, label: 'Checkpoints' },
              { key: 'learning', icon: Brain, label: 'Learning' },
            ] as const).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                className={clsx(
                  'flex items-center gap-1 px-2 py-1 rounded text-2xs font-medium transition-colors cursor-pointer',
                  tab === key
                    ? 'bg-honey-500/15 text-honey-500'
                    : 'hover:text-honey-500/70'
                )}
                style={tab !== key ? { color: 'var(--color-text-muted)' } : undefined}
                onClick={() => setTab(key)}
              >
                <Icon className="w-3 h-3" />
                {label}
                {key === 'checkpoints' && total > 0 && (
                  <span className="opacity-70">{total}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="max-w-4xl mx-auto px-4 py-4">
        {tab === 'checkpoints' && (
          <CheckpointsTab checkpoints={checkpoints} total={total} isLoading={checkpointsLoading} />
        )}
        {tab === 'trajectory' && (
          <TrajectoryTab sessionId={id!} hasTrajectorySupport={hasTrajectorySupport} agentIdentity={assistantAgent} sourceSwarmId={sourceSwarmId} existingAcpStreamId={existingAcpStreamId} existingAcpSessionId={existingAcpSessionId} />
        )}
        {tab === 'learning' && (
          <SessionLearningTab sessionId={id!} />
        )}
      </div>
    </>
  );
}

// ============================================================================
// Session Learning Tab
// ============================================================================

function SessionLearningTab({ sessionId }: { sessionId: string }) {
  const [learningAvailable, setLearningAvailable] = useState<boolean | null>(null);
  const [learningData, setLearningData] = useState<{
    experiences: any[];
    stats: any;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { api } = await import('../lib/api');
        const health = await api.get<{ available: boolean }>('/learning/health');
        if (cancelled) return;
        setLearningAvailable(health.available);

        if (health.available) {
          const experiences = await api.get<{ data: any[]; total: number }>('/learning/experiences?limit=100');
          const stats = await api.get<any>('/learning/stats');
          if (cancelled) return;
          setLearningData({ experiences: experiences.data, stats });
        }
      } catch {
        if (!cancelled) setLearningAvailable(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-4 h-4 border-2 border-honey-500/30 border-t-honey-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!learningAvailable) {
    return (
      <div className="card px-4 py-8 flex flex-col items-center gap-3 text-center">
        <Brain className="w-8 h-8 text-text-muted" />
        <p className="text-sm font-medium">Learning engine not available</p>
        <p className="text-2xs text-text-muted max-w-md">
          Enable learning in openhive.config.js to see what the learning engine extracted from this session.
        </p>
        <Link to="/learning" className="text-2xs text-honey-500 hover:underline">
          Go to Learning Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="card px-3 py-2.5">
        <h3 className="text-xs font-medium text-text-secondary mb-2 flex items-center gap-1.5">
          <Brain className="w-3.5 h-3.5" />
          Learning Summary
        </h3>
        <div className="grid grid-cols-2 gap-3 text-2xs">
          <div>
            <span className="text-text-muted">Total experiences:</span>
            <span className="ml-1 text-text-secondary">{learningData?.stats?.memory?.experienceCount ?? 0}</span>
          </div>
          <div>
            <span className="text-text-muted">Total playbooks:</span>
            <span className="ml-1 text-text-secondary">{learningData?.stats?.memory?.playbookCount ?? 0}</span>
          </div>
          <div>
            <span className="text-text-muted">Trajectories processed:</span>
            <span className="ml-1 text-text-secondary">{learningData?.stats?.learning?.trajectoriesProcessed ?? 0}</span>
          </div>
        </div>
      </div>

      <div className="card px-3 py-2.5">
        <p className="text-2xs text-text-muted">
          Session-specific learning extraction tracking (linking individual sessions to the experiences and playbook updates they produced) will be available in a future update.
        </p>
        <Link to="/learning" className="text-2xs text-honey-500 hover:underline mt-1 inline-block">
          View full Learning Dashboard
        </Link>
      </div>
    </div>
  );
}
