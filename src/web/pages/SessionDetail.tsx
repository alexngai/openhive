import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowDown, Bot, Brain, ChevronDown, ChevronRight,
  Clock, Code, Cpu, FileText, GitBranch, GitCommit, Hash,
  MessageSquare, Terminal, User, Wrench,
} from 'lucide-react';
import { useResource, useSessionCheckpoints, useSessionStats, useSessionEvents, useSessionParticipants } from '../hooks/useApi';
import { useSessionsRealtime } from '../hooks/useRealtimeInvalidation';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader, LoadingSpinner } from '../components/common/LoadingSpinner';
import { AgentAvatar } from '../components/common/AgentAvatar';
import {
  formatTokens, extractText, truncate,
} from '../components/sessions/EventBubble';
import { MarkdownContent } from '../components/sessions/MarkdownContent';
import type { TrajectoryCheckpoint, SessionEvent, SessionContentBlock, AgentIdentity } from '../lib/api';
import clsx from 'clsx';

// ============================================================================
// Helpers
// ============================================================================

// formatTokens, extractText, truncate imported from components/sessions/EventBubble

// ============================================================================
// Shared Components
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
// Trajectory Viewer
// ============================================================================

// ============================================================================
// JSON Viewer
// ============================================================================

import JsonView from 'react18-json-view';
import 'react18-json-view/src/style.css';

const jsonViewTheme = {
  keyColor: '#c084fc',
  indexColor: '#9ca3af',
  numberColor: '#60a5fa',
  stringColor: '#34d399',
  booleanColor: '#fbbf24',
  nullColor: '#9ca3af',
};

function OutputBlock({ output, status }: { output: string; status?: string }) {
  // Try to parse as JSON for structured rendering
  let parsed: unknown = null;
  try {
    const trimmed = output.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      parsed = JSON.parse(trimmed);
    }
  } catch {
    // Not JSON — render as text
  }

  const borderClass = status === 'failed' ? 'border-red-400/30' : 'border-emerald-400/30';

  if (parsed) {
    return (
      <div
        className={clsx('text-2xs rounded px-2 py-1.5 overflow-x-auto border-l-2', borderClass)}
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <JsonView src={parsed} collapsed={2} theme="a11y" dark collapseStringsAfterLength={120} style={{ fontSize: '10px', backgroundColor: 'transparent' }} />
      </div>
    );
  }

  return (
    <div
      className={clsx('text-2xs rounded px-2 py-1.5 overflow-x-auto font-mono border-l-2 whitespace-pre-wrap break-words', borderClass)}
      style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
    >
      {truncate(output, 2000)}
    </div>
  );
}

function ToolCallBlock({ block }: { block: SessionContentBlock }) {
  const [expanded, setExpanded] = useState(false);
  const tc = block as SessionContentBlock & { toolCallId?: string; toolName?: string; status?: string; output?: string; input?: Record<string, unknown> };
  const hasOutput = !!tc.output;
  const hasInput = tc.input && Object.keys(tc.input).length > 0;
  const isExpandable = hasOutput || hasInput;

  return (
    <div>
      <div
        className={clsx(
          'text-2xs px-2 py-1 rounded flex items-center gap-1.5',
          isExpandable && 'cursor-pointer',
        )}
        style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
        onClick={isExpandable ? () => setExpanded(!expanded) : undefined}
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
        {isExpandable && (
          <span className="ml-auto">
            {expanded ? <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} /> : <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />}
          </span>
        )}
      </div>
      {expanded && (
        <div className="mt-1 space-y-1">
          {hasInput && (
            <div
              className="text-2xs rounded px-2 py-1.5 overflow-x-auto"
              style={{ backgroundColor: 'var(--color-elevated)' }}
            >
              <JsonView src={tc.input} collapsed={2} theme="a11y" dark collapseStringsAfterLength={120} style={{ fontSize: '10px', backgroundColor: 'transparent' }} />
            </div>
          )}
          {hasOutput && (
            <OutputBlock output={tc.output!} status={tc.status} />
          )}
        </div>
      )}
    </div>
  );
}

/** Determine the "author" for grouping consecutive events. */
function getEventAuthor(event: SessionEvent): string | null {
  switch (event.type) {
    case 'user_message': return 'user';
    case 'assistant_message':
    case 'assistant_thinking':
    case 'tool_call':
    case 'tool_result': return 'assistant';
    default: return null; // system-level events don't group
  }
}

function EventBubble({ event, showHeader = true, agentIdentity }: { event: SessionEvent; showHeader?: boolean; agentIdentity?: AgentIdentity }) {
  const [expanded, setExpanded] = useState(false);

  // Left padding to align content when avatar is hidden
  const continuationPl = 'pl-[34px]';

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
    if (!showHeader) {
      return (
        <div className={continuationPl}>
          <div
            className="text-sm rounded-lg px-3 py-2 max-w-[85%]"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text)' }}
          >
            {text ? <MarkdownContent>{text}</MarkdownContent> : <p>(empty)</p>}
          </div>
        </div>
      );
    }
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
            {text ? <MarkdownContent>{text}</MarkdownContent> : <p>(empty)</p>}
          </div>
        </div>
      </div>
    );
  }

  if (event.type === 'assistant_message') {
    const text = extractText(event.content);
    const toolCalls = event.content?.filter((b) => b.type === 'tool_call') ?? [];
    const content = (
      <>
        {text && (
          <div className="text-sm max-w-[85%]" style={{ color: 'var(--color-text-secondary)' }}>
            <MarkdownContent>{text}</MarkdownContent>
          </div>
        )}
        {toolCalls.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {toolCalls.map((tc, i) => (
              <ToolCallBlock key={tc.toolCallId || i} block={tc} />
            ))}
          </div>
        )}
      </>
    );
    if (!showHeader) {
      return <div className={continuationPl}>{content}</div>;
    }
    return (
      <div className="flex gap-2.5 items-start">
        {agentIdentity ? (
          <AgentAvatar src={agentIdentity.avatarUrl} name={agentIdentity.name} size={24} className="mt-0.5" />
        ) : (
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
            style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)' }}
          >
            <Bot className="w-3 h-3 text-honey-500" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-2xs font-medium text-honey-500">{agentIdentity?.name || 'Assistant'}</span>
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
          {content}
        </div>
      </div>
    );
  }

  if (event.type === 'assistant_thinking') {
    const content = (
      <>
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
            <MarkdownContent className="text-xs">{event.thinking}</MarkdownContent>
          </div>
        )}
      </>
    );
    if (!showHeader) {
      return <div className={continuationPl}>{content}</div>;
    }
    return (
      <div className="flex gap-2.5 items-start">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ backgroundColor: 'rgba(139, 92, 246, 0.15)' }}
        >
          <Brain className="w-3 h-3 text-purple-400" />
        </div>
        <div className="flex-1 min-w-0">
          {content}
        </div>
      </div>
    );
  }

  if (event.type === 'tool_call') {
    const content = (
      <>
        <button
          className="flex items-center gap-1.5 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-2xs font-mono text-blue-400">{event.toolName}</span>
          {expanded ? <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} /> : <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />}
        </button>
        {expanded && event.input && (
          <div
            className="mt-1 max-w-[85%] text-2xs rounded-lg px-3 py-2 overflow-x-auto"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            <JsonView src={event.input} collapsed={2} theme="a11y" dark collapseStringsAfterLength={120} style={{ fontSize: '10px', backgroundColor: 'transparent' }} />
          </div>
        )}
      </>
    );
    if (!showHeader) {
      return <div className={continuationPl}>{content}</div>;
    }
    return (
      <div className="flex gap-2.5 items-start">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
          style={{ backgroundColor: 'rgba(59, 130, 246, 0.15)' }}
        >
          <Terminal className="w-3 h-3 text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          {content}
        </div>
      </div>
    );
  }

  if (event.type === 'tool_result') {
    const resultText = extractText(event.content);
    const content = (
      <>
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
      </>
    );
    if (!showHeader) {
      return <div className={continuationPl}>{content}</div>;
    }
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
          {content}
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

  // Fallback for custom/unknown events — show aggregated count if available
  const count = (event.data as Record<string, unknown>)?.count as number | undefined;
  return (
    <div className="flex justify-center py-0.5">
      <span className="text-2xs px-2 py-0.5 rounded-full" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
        {event.eventType || event.type}{count && count > 1 ? ` (${count})` : ''}
      </span>
    </div>
  );
}

/** Check if an assistant_message is tool-use-only (has tool_call blocks, no meaningful text). */
function isToolUseOnlyMessage(event: SessionEvent): boolean {
  if (event.type !== 'assistant_message') return false;
  const toolCalls = event.content?.filter((b) => b.type === 'tool_call') ?? [];
  if (toolCalls.length === 0) return false;
  const text = extractText(event.content);
  return !text || text.trim().length === 0;
}

/** Collapsible group for consecutive tool-use assistant messages. */
function ToolCallGroupBlock({ events }: { events: SessionEvent[] }) {
  const [expanded, setExpanded] = useState(false);

  // Collect all tool_call content blocks from assistant_message events,
  // plus standalone tool_call events as fallback
  const allToolCalls: SessionContentBlock[] = [];
  for (const event of events) {
    if (event.type === 'assistant_message') {
      const tcs = event.content?.filter((b) => b.type === 'tool_call') ?? [];
      allToolCalls.push(...tcs);
    } else if (event.type === 'tool_call') {
      allToolCalls.push(event as unknown as SessionContentBlock);
    }
  }

  const uniqueNames = [...new Set(
    allToolCalls.map((tc) => (tc as SessionContentBlock & { toolName?: string }).toolName).filter(Boolean),
  )];

  return (
    <div className="pl-[34px]">
      <button
        className="flex items-center gap-1.5 cursor-pointer w-full"
        onClick={() => setExpanded(!expanded)}
      >
        <Wrench className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-2xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {allToolCalls.length} tool {allToolCalls.length === 1 ? 'call' : 'calls'}
        </span>
        <span className="flex flex-wrap gap-1 flex-1 min-w-0">
          {uniqueNames.map((name) => (
            <span
              key={name}
              className="text-2xs font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
            >
              {name}
            </span>
          ))}
        </span>
        {expanded
          ? <ChevronDown className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          : <ChevronRight className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        }
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {events.map((event) => (
            <EventBubble key={event.id} event={event} showHeader={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function TrajectoryTab({ sessionId, hasTrajectorySupport, agentIdentity }: { sessionId: string; hasTrajectorySupport: boolean; agentIdentity?: AgentIdentity }) {
  const {
    data,
    isLoading,
    isError,
    error,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useSessionEvents(sessionId, { enabled: hasTrajectorySupport });

  const bottomRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Track whether the bottom anchor is visible
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsAtBottom(entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Auto-scroll to bottom on initial load
  const pages = data?.pages ?? [];
  const events = pages.flatMap((page) => page.events);

  useEffect(() => {
    if (events.length > 0 && !hasScrolledRef.current) {
      hasScrolledRef.current = true;
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'instant' });
      });
    }
  }, [events.length]);

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

  const total = pages[0]?.total ?? 0;
  const firstPage = pages[0];

  if (events.length === 0) {
    return (
      <div className="card px-6 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
        <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-xs">No events found in this session.</p>
      </div>
    );
  }

  // Events come newest-first from API; reverse for chronological display
  const chronologicalEvents = [...events].reverse();

  // Group consecutive tool-use runs into collapsible groups,
  // and consecutive custom events into badge rows.
  // A "tool run" is a sequence of tool-use-only assistant_messages, assistant_thinking,
  // standalone tool_call/tool_result events, and custom events (which are noise between tool calls).
  type ToolGroup = { _toolGroup: true; events: SessionEvent[] };
  type CustomGroup = { _customGroup: true; events: SessionEvent[] };
  type DisplayItem = SessionEvent | ToolGroup | CustomGroup;
  const displayEvents: DisplayItem[] = [];

  let toolRun: SessionEvent[] = [];
  let customRun: SessionEvent[] = [];

  const isToolRunEvent = (e: SessionEvent) =>
    isToolUseOnlyMessage(e) ||
    e.type === 'tool_call' ||
    e.type === 'tool_result' ||
    e.type === 'assistant_thinking' ||
    e.type === 'custom';

  const countToolCalls = (run: SessionEvent[]) => {
    let count = 0;
    for (const e of run) {
      if (e.type === 'assistant_message') {
        count += (e.content?.filter((b) => b.type === 'tool_call') ?? []).length;
      } else if (e.type === 'tool_call') {
        count += 1;
      }
    }
    return count;
  };

  const flushToolRun = () => {
    if (toolRun.length === 0) return;
    if (countToolCalls(toolRun) > 1) {
      displayEvents.push({ _toolGroup: true, events: toolRun });
    } else {
      // Not enough tool calls to group — push events individually
      for (const e of toolRun) {
        if (e.type === 'custom') {
          customRun.push(e);
        } else {
          flushCustomRun();
          displayEvents.push(e);
        }
      }
    }
    toolRun = [];
  };
  const flushCustomRun = () => {
    if (customRun.length === 0) return;
    displayEvents.push({ _customGroup: true, events: customRun });
    customRun = [];
  };

  for (const event of chronologicalEvents) {
    if (toolRun.length > 0 && isToolRunEvent(event)) {
      // Continue an existing tool run
      toolRun.push(event);
    } else if (isToolUseOnlyMessage(event) || event.type === 'tool_call') {
      // Start a new tool run
      flushCustomRun();
      toolRun.push(event);
    } else if (event.type === 'custom') {
      customRun.push(event);
    } else {
      flushToolRun();
      flushCustomRun();
      displayEvents.push(event);
    }
  }
  flushToolRun();
  flushCustomRun();

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          Agent Trajectory
          <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
            ({total} events)
          </span>
        </h2>
        {firstPage?.format_id && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
          >
            {firstPage.format_id}
          </span>
        )}
      </div>

      {/* Load more button for older events */}
      {isFetchingNextPage && (
        <div className="flex items-center justify-center py-3">
          <LoadingSpinner />
          <span className="ml-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            Loading older events…
          </span>
        </div>
      )}
      {hasNextPage && !isFetchingNextPage && (
        <div className="text-center py-2">
          <button
            onClick={() => fetchNextPage()}
            className="text-2xs px-3 py-1 rounded transition-colors"
            style={{
              color: 'var(--color-accent)',
              backgroundColor: 'var(--color-elevated)',
              border: '1px solid var(--color-border)',
            }}
          >
            Load older events ({events.length} of {total})
          </button>
        </div>
      )}
      {!hasNextPage && total > events.length && (
        <div className="text-center py-2">
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            All {total} events loaded
          </span>
        </div>
      )}

      <div className="space-y-3">
        {(() => {
          // Flatten display items into SessionEvent[] for custom-event grouping,
          // preserving tool groups as opaque markers
          let lastAuthor: string | null = null;
          return displayEvents.map((item, i) => {
            // Tool call groups
            if ('_toolGroup' in item) {
              const showHeader = lastAuthor !== 'assistant';
              lastAuthor = 'assistant';
              return (
                <div key={`tg-${i}`} className={showHeader ? '' : '-mt-1.5'}>
                  <ToolCallGroupBlock events={item.events} />
                </div>
              );
            }

            // Custom event badge rows — don't reset author continuity
            if ('_customGroup' in item) {
              return (
                <div key={`cg-${i}`} className="flex flex-wrap gap-1 py-0.5">
                  {item.events.map((event) => {
                    const count = (event.data as Record<string, unknown>)?.count as number | undefined;
                    return (
                      <span
                        key={event.id}
                        className="text-2xs px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
                      >
                        {event.eventType || event.type}{count && count > 1 ? ` (${count})` : ''}
                      </span>
                    );
                  })}
                </div>
              );
            }

            const event = item;
            const author = getEventAuthor(event);
            // System events (token_usage, error) don't reset author grouping
            if (author === null) {
              return <EventBubble key={event.id} event={event} agentIdentity={agentIdentity} />;
            }
            const showHeader = author !== lastAuthor;
            lastAuthor = author;
            return (
              <div key={event.id} className={showHeader ? '' : '-mt-1.5'}>
                <EventBubble event={event} showHeader={showHeader} agentIdentity={agentIdentity} />
              </div>
            );
          });
        })()}
      </div>

      {/* Scroll anchor for auto-scroll to bottom */}
      <div ref={bottomRef} />

      {/* Scroll-to-bottom FAB */}
      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-6 right-6 z-20 w-8 h-8 rounded-full flex items-center justify-center shadow transition-all hover:brightness-125 cursor-pointer border"
          style={{
            backgroundColor: 'var(--color-elevated)',
            color: 'var(--color-text-muted)',
            borderColor: 'var(--color-border-subtle)',
          }}
          title="Scroll to bottom"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<DetailTab>('trajectory');
  const { data: resource, isLoading: resourceLoading } = useResource(id!);
  const { data: checkpointsData, isLoading: checkpointsLoading } = useSessionCheckpoints(id!);
  const { data: stats } = useSessionStats(id!);
  const { data: participantsData } = useSessionParticipants(id!);
  useSessionsRealtime();

  // Derive assistant agent identity for the trajectory view.
  // Uses the session resource name (e.g. "openhive-3 (agents)") for boring-avatar
  // hashing — this is unique per session and gives each one a distinct avatar.
  // The checkpoint agent field is generic ("default-sidecar") so we don't use it.
  const assistantAgent: AgentIdentity | undefined = (() => {
    if (resource) {
      return {
        id: resource.owner?.id || resource.owner_agent_id || '',
        name: resource.name,
        avatarUrl: null, // always use boring-avatar, not account avatar
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

  // Determine if trajectory events can be loaded.
  // Events are available from: local/cloud storage backends, or on-demand from connected swarms.
  // The backend handles fallback — if no local storage, it requests from the swarm.
  // We enable the tab whenever there are checkpoints (indicating a session exists).
  const hasTrajectorySupport = total > 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-4">
      {/* Sticky header: session detail + stats + tabs */}
      <div
        className="sticky top-0 z-10 -mx-4 px-4 pb-0 pt-2"
        style={{ backgroundColor: 'var(--color-bg)' }}
      >
        {/* Header with inline stats */}
        <div className="card px-4 py-2.5 mb-3">
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold truncate">{resource.name}</h1>
                <span className="text-2xs px-1.5 py-0.5 rounded bg-honey-500/10 text-honey-500">
                  session
                </span>
              </div>
              {resource.description && (
                <p className="text-2xs mt-0.5 truncate" style={{ color: 'var(--color-text-secondary)' }}>
                  {resource.description}
                </p>
              )}
            </div>
            {stats && (
              <div className="flex items-center gap-3 shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                <span className="flex items-center gap-1 text-2xs">
                  <GitCommit className="w-3 h-3" />
                  {stats.total_checkpoints}
                </span>
                <span className="flex items-center gap-1 text-2xs" title="Input tokens">
                  <Cpu className="w-3 h-3" />
                  {formatTokens(stats.total_input_tokens)} in
                </span>
                <span className="flex items-center gap-1 text-2xs" title="Output tokens">
                  {formatTokens(stats.total_output_tokens)} out
                </span>
                <span className="flex items-center gap-1 text-2xs" title="Files modified">
                  <FileText className="w-3 h-3" />
                  {stats.total_files_touched}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div
          className="flex items-center gap-1 mb-4 border-b"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
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
          </span>
        </button>
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
            tab === 'learning'
              ? 'border-honey-500 text-honey-500'
              : 'border-transparent'
          )}
          style={tab !== 'learning' ? { color: 'var(--color-text-muted)' } : undefined}
          onClick={() => setTab('learning')}
        >
          <span className="flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5" />
            Learning
          </span>
        </button>
        </div>
      </div>

      {/* Tab content */}
      {tab === 'checkpoints' && (
        <CheckpointsTab checkpoints={checkpoints} total={total} isLoading={checkpointsLoading} />
      )}
      {tab === 'trajectory' && (
        <TrajectoryTab sessionId={id!} hasTrajectorySupport={hasTrajectorySupport} agentIdentity={assistantAgent} />
      )}
      {tab === 'learning' && (
        <SessionLearningTab sessionId={id!} />
      )}
    </div>
  );
}

// ============================================================================
// Session Learning Tab
// ============================================================================

function SessionLearningTab({ sessionId }: { sessionId: string }) {
  // Query the learning health to check if learning is available
  const [learningAvailable, setLearningAvailable] = useState<boolean | null>(null);
  const [learningData, setLearningData] = useState<{
    experiences: any[];
    stats: any;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch learning data on mount
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
