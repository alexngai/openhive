import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowLeft, Bot, Brain, ChevronDown, ChevronRight,
  Clock, Code, Cpu, FileText, GitBranch, GitCommit, Hash,
  MessageSquare, Terminal, User, Wrench,
} from 'lucide-react';
import { useResource, useSessionCheckpoints, useSessionStats, useSessionEvents } from '../hooks/useApi';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader, LoadingSpinner } from '../components/common/LoadingSpinner';
import type { TrajectoryCheckpoint, SessionEvent, SessionContentBlock } from '../lib/api';
import clsx from 'clsx';

// ============================================================================
// Helpers
// ============================================================================

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function extractText(blocks: SessionContentBlock[] | undefined): string {
  if (!blocks) return '';
  return blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

// ============================================================================
// Shared Components
// ============================================================================

type DetailTab = 'checkpoints' | 'trajectory';

function StatCard({ label, value, icon: Icon }: { label: string; value: string | number; icon: React.ElementType }) {
  return (
    <div className="card px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-2xs uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
          {label}
        </span>
      </div>
      <p className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
        {value}
      </p>
    </div>
  );
}

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
// Trajectory Viewer
// ============================================================================

function EventBubble({ event }: { event: SessionEvent }) {
  const [expanded, setExpanded] = useState(false);

  if (event.type === 'token_usage') {
    return (
      <div className="flex justify-center py-1">
        <span className="text-2xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
          {formatTokens(event.inputTokens ?? 0)} in / {formatTokens(event.outputTokens ?? 0)} out
        </span>
      </div>
    );
  }

  if (event.type === 'user_message') {
    const text = extractText(event.content);
    return (
      <div className="flex gap-2.5 items-start">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <User className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>User</span>
            {event.timestamp && (
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                <TimeAgo date={event.timestamp} />
              </span>
            )}
          </div>
          <div
            className="text-sm rounded-lg px-3 py-2 max-w-[85%]"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text)' }}
          >
            <p className="whitespace-pre-wrap break-words">{text || '(empty)'}</p>
          </div>
        </div>
      </div>
    );
  }

  if (event.type === 'assistant_message') {
    const text = extractText(event.content);
    const toolCalls = event.content?.filter((b) => b.type === 'tool_call') ?? [];
    return (
      <div className="flex gap-2.5 items-start">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)' }}
        >
          <Bot className="w-3 h-3 text-honey-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-2xs font-medium text-honey-500">Assistant</span>
            {event.timestamp && (
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                <TimeAgo date={event.timestamp} />
              </span>
            )}
            {event.stopReason && event.stopReason !== 'end_turn' && (
              <span className="text-2xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
                {event.stopReason}
              </span>
            )}
          </div>
          {text && (
            <div className="text-sm max-w-[85%]" style={{ color: 'var(--color-text-secondary)' }}>
              <p className="whitespace-pre-wrap break-words">{text}</p>
            </div>
          )}
          {toolCalls.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {toolCalls.map((tc, i) => (
                <div
                  key={tc.toolCallId || i}
                  className="text-2xs px-2 py-1 rounded flex items-center gap-1.5"
                  style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
                >
                  <Wrench className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                  <span className="font-mono">{tc.toolName}</span>
                  {tc.status && (
                    <span className={clsx(
                      'text-2xs px-1 rounded',
                      tc.status === 'completed' ? 'text-emerald-400' : tc.status === 'failed' ? 'text-red-400' : ''
                    )}>
                      {tc.status}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (event.type === 'assistant_thinking') {
    return (
      <div className="flex gap-2.5 items-start">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ backgroundColor: 'rgba(139, 92, 246, 0.15)' }}
        >
          <Brain className="w-3 h-3 text-purple-400" />
        </div>
        <div className="flex-1 min-w-0">
          <button
            className="flex items-center gap-1.5 text-2xs font-medium cursor-pointer"
            style={{ color: 'var(--color-text-muted)' }}
            onClick={() => setExpanded(!expanded)}
          >
            <span>Thinking</span>
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
          {expanded && event.thinking && (
            <div
              className="mt-1 text-xs rounded-lg px-3 py-2 max-w-[85%] border-l-2"
              style={{
                backgroundColor: 'var(--color-elevated)',
                borderColor: 'rgba(139, 92, 246, 0.3)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <p className="whitespace-pre-wrap break-words">{event.thinking}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (event.type === 'tool_call') {
    const inputStr = event.input ? JSON.stringify(event.input, null, 2) : '';
    return (
      <div className="flex gap-2.5 items-start">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ backgroundColor: 'rgba(59, 130, 246, 0.15)' }}
        >
          <Terminal className="w-3 h-3 text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <button
            className="flex items-center gap-1.5 cursor-pointer"
            onClick={() => setExpanded(!expanded)}
          >
            <span className="text-2xs font-mono text-blue-400">{event.toolName}</span>
            {expanded ? <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} /> : <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />}
          </button>
          {expanded && inputStr && (
            <pre
              className="mt-1 text-2xs rounded-lg px-3 py-2 max-w-[85%] overflow-x-auto font-mono"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
            >
              {truncate(inputStr, 2000)}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (event.type === 'tool_result') {
    const resultText = extractText(event.content);
    return (
      <div className="flex gap-2.5 items-start">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ backgroundColor: event.isError ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)' }}
        >
          {event.isError
            ? <AlertTriangle className="w-3 h-3 text-red-400" />
            : <Code className="w-3 h-3 text-emerald-400" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <button
            className="flex items-center gap-1.5 cursor-pointer"
            onClick={() => setExpanded(!expanded)}
          >
            <span className={clsx('text-2xs font-medium', event.isError ? 'text-red-400' : 'text-emerald-400')}>
              {event.isError ? 'Error' : 'Result'}
            </span>
            {resultText && (
              <>
                {!expanded && (
                  <span className="text-2xs truncate max-w-[200px]" style={{ color: 'var(--color-text-muted)' }}>
                    {truncate(resultText, 60)}
                  </span>
                )}
                {expanded ? <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} /> : <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />}
              </>
            )}
          </button>
          {expanded && resultText && (
            <pre
              className="mt-1 text-2xs rounded-lg px-3 py-2 max-w-[85%] overflow-x-auto font-mono"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
            >
              {truncate(resultText, 3000)}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (event.type === 'error') {
    return (
      <div className="flex gap-2.5 items-start">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)' }}
        >
          <AlertTriangle className="w-3 h-3 text-red-400" />
        </div>
        <div className="text-xs text-red-400">
          Error{event.code ? ` (${event.code})` : ''}: {event.message || 'Unknown error'}
        </div>
      </div>
    );
  }

  // Fallback for custom/unknown events
  return (
    <div className="flex justify-center py-0.5">
      <span className="text-2xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
        {event.type}{event.eventType ? `: ${event.eventType}` : ''}
      </span>
    </div>
  );
}

function TrajectoryTab({ sessionId, hasLocalStorage }: { sessionId: string; hasLocalStorage: boolean }) {
  const { data, isLoading, isError, error } = useSessionEvents(sessionId, { enabled: hasLocalStorage });

  if (!hasLocalStorage) {
    return (
      <div className="card px-6 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
        <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          Trajectory not available
        </p>
        <p className="text-xs">
          Event-level trajectory is only available for sessions with local or cloud storage.
          Git-backed sessions store content in the remote repository.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card px-6 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
        <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          Could not load trajectory
        </p>
        <p className="text-xs">{(error as Error)?.message || 'Unknown error'}</p>
      </div>
    );
  }

  const events = data?.events ?? [];

  if (events.length === 0) {
    return (
      <div className="card px-6 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
        <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-xs">No events found in this session.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          Agent Trajectory
          <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
            ({data?.total ?? events.length} events)
          </span>
        </h2>
        {data?.format_id && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
          >
            {data.format_id}
          </span>
        )}
      </div>

      <div className="space-y-3">
        {events.map((event) => (
          <EventBubble key={event.id} event={event} />
        ))}
      </div>

      {data && data.total > data.events.length && (
        <div className="text-center mt-4">
          <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            Showing {data.events.length} of {data.total} events
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<DetailTab>('checkpoints');
  const { data: resource, isLoading: resourceLoading } = useResource(id!);
  const { data: checkpointsData, isLoading: checkpointsLoading } = useSessionCheckpoints(id!);
  const { data: stats } = useSessionStats(id!);

  if (resourceLoading) return <PageLoader />;

  if (!resource) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 text-center">
        <p style={{ color: 'var(--color-text-muted)' }}>Session not found.</p>
        <Link to="/sessions" className="text-honey-500 text-sm mt-2 inline-block">
          Back to Sessions
        </Link>
      </div>
    );
  }

  const checkpoints = checkpointsData?.data ?? [];
  const total = checkpointsData?.total ?? 0;

  // Determine if local/cloud storage is available for event-level trajectory
  const metadata = resource.metadata as Record<string, unknown> | null;
  const storageBackend = (metadata?.storage as Record<string, unknown> | undefined)?.backend as string | undefined;
  const hasLocalStorage = !!storageBackend && storageBackend !== 'git';

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {/* Back link */}
      <Link
        to="/sessions"
        className="inline-flex items-center gap-1 text-xs mb-4 hover:text-honey-500 transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="w-3 h-3" />
        Sessions
      </Link>

      {/* Header */}
      <div className="card px-4 py-3 mb-4">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-md flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            <Activity className="w-5 h-5 text-honey-500" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold truncate">{resource.name}</h1>
              <span className="text-2xs px-1.5 py-0.5 rounded bg-honey-500/10 text-honey-500">
                session
              </span>
            </div>
            {resource.description && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                {resource.description}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <StatCard label="Checkpoints" value={stats.total_checkpoints} icon={GitCommit} />
          <StatCard label="Input Tokens" value={formatTokens(stats.total_input_tokens)} icon={Cpu} />
          <StatCard label="Output Tokens" value={formatTokens(stats.total_output_tokens)} icon={Cpu} />
          <StatCard label="Files Modified" value={stats.total_files_touched} icon={FileText} />
        </div>
      )}

      {/* Tabs */}
      <div
        className="flex items-center gap-1 mb-4 border-b"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <button
          className={clsx(
            'px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors cursor-pointer',
            tab === 'checkpoints'
              ? 'border-honey-500 text-honey-500'
              : 'border-transparent'
          )}
          style={tab !== 'checkpoints' ? { color: 'var(--color-text-muted)' } : undefined}
          onClick={() => setTab('checkpoints')}
        >
          <span className="flex items-center gap-1.5">
            <GitCommit className="w-3.5 h-3.5" />
            Checkpoints
            {total > 0 && <span className="text-2xs opacity-70">({total})</span>}
          </span>
        </button>
        <button
          className={clsx(
            'px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors cursor-pointer',
            tab === 'trajectory'
              ? 'border-honey-500 text-honey-500'
              : 'border-transparent'
          )}
          style={tab !== 'trajectory' ? { color: 'var(--color-text-muted)' } : undefined}
          onClick={() => setTab('trajectory')}
        >
          <span className="flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5" />
            Trajectory
            {!hasLocalStorage && (
              <span className="text-2xs opacity-50">(n/a)</span>
            )}
          </span>
        </button>
      </div>

      {/* Tab content */}
      {tab === 'checkpoints' && (
        <CheckpointsTab checkpoints={checkpoints} total={total} isLoading={checkpointsLoading} />
      )}
      {tab === 'trajectory' && (
        <TrajectoryTab sessionId={id!} hasLocalStorage={hasLocalStorage} />
      )}
    </div>
  );
}
