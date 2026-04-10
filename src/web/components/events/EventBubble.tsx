/**
 * EventBubble — Consolidated session event renderer.
 *
 * Renders a single SessionEvent as a chat-style bubble with support for:
 * - showHeader (continuation style without avatar for same-author runs)
 * - customEvents (inline badges for grouped custom events)
 * - Lazy-loaded JsonView for tool call inputs/outputs
 *
 * Used by EventStream and can be used standalone for any SessionEvent rendering.
 */

import { useState } from 'react';
import {
  Bot, Brain, User, Terminal, Wrench, Code,
  AlertTriangle, ChevronDown, ChevronRight,
} from 'lucide-react';
import clsx from 'clsx';
import type { SessionEvent, SessionContentBlock, AgentIdentity } from '../../lib/api';
import { TimeAgo } from '../common/TimeAgo';
import { AgentAvatar } from '../common/AgentAvatar';
import { MarkdownContent } from '../sessions/MarkdownContent';
import { formatTokens, extractText, truncate } from './event-utils';
import { CustomEventBadges } from './CustomEventBadges';

// ── Lazy JsonView ──────────────────────────────────────────────────────────

let _JsonView: any = null;
function getJsonView(): Promise<any> {
  if (_JsonView) return Promise.resolve(_JsonView);
  return import('react18-json-view').then(m => { _JsonView = m.default; return _JsonView; });
}

// ── OutputBlock ────────────────────────────────────────────────────────────

function OutputBlock({ output, status }: { output: string; status?: string }) {
  const [jsonViewLoaded, setJsonViewLoaded] = useState(false);
  const [JV, setJV] = useState<any>(null);

  let parsed: unknown = null;
  try {
    const trimmed = output.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      parsed = JSON.parse(trimmed);
    }
  } catch { /* not JSON */ }

  if (parsed && !jsonViewLoaded) {
    getJsonView().then(v => { setJV(() => v); setJsonViewLoaded(true); });
  }

  const borderClass = status === 'failed' ? 'border-red-400/30' : 'border-emerald-400/30';

  if (parsed && JV) {
    return (
      <div
        className={clsx('text-2xs rounded px-2 py-1.5 overflow-x-auto border-l-2', borderClass)}
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <JV src={parsed} collapsed={2} theme="a11y" dark collapseStringsAfterLength={120} style={{ fontSize: '10px', backgroundColor: 'transparent' }} />
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

// ── ToolCallBlock ──────────────────────────────────────────────────────────

export function ToolCallBlock({ block }: { block: SessionContentBlock }) {
  const [expanded, setExpanded] = useState(false);
  const [JV, setJV] = useState<any>(null);

  const tc = block as SessionContentBlock & { toolCallId?: string; toolName?: string; status?: string; output?: string; input?: Record<string, unknown> };
  const hasOutput = !!tc.output;
  const hasInput = tc.input && Object.keys(tc.input).length > 0;
  const isExpandable = hasOutput || hasInput;

  if (expanded && hasInput && !JV) {
    getJsonView().then(v => setJV(() => v));
  }

  return (
    <div>
      <div
        className={clsx(
          'text-2xs px-2 py-1 rounded flex items-center gap-1.5 transition-colors',
          isExpandable && 'cursor-pointer hover:bg-white/10',
        )}
        style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
        onClick={isExpandable ? () => setExpanded(!expanded) : undefined}
      >
        {isExpandable && (
          expanded ? <ChevronDown className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} /> : <ChevronRight className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        )}
        <Wrench className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        <span className="font-mono">{tc.toolName}</span>
        {tc.status && tc.status !== 'completed' && (
          <span className={clsx(
            'text-2xs px-1 rounded',
            tc.status === 'failed' ? 'text-red-400' : 'text-yellow-400'
          )}>
            {tc.status}
          </span>
        )}
      </div>
      {expanded && (
        <div className="mt-1 space-y-1">
          {hasInput && JV && (
            <div
              className="text-2xs rounded px-2 py-1.5 overflow-x-auto"
              style={{ backgroundColor: 'var(--color-elevated)' }}
            >
              <JV src={tc.input} collapsed={2} theme="a11y" dark collapseStringsAfterLength={120} style={{ fontSize: '10px', backgroundColor: 'transparent' }} />
            </div>
          )}
          {hasInput && !JV && (
            <pre className="text-2xs rounded px-2 py-1.5 overflow-x-auto font-mono whitespace-pre-wrap" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}>
              {JSON.stringify(tc.input, null, 2)}
            </pre>
          )}
          {hasOutput && (
            <OutputBlock output={tc.output!} status={tc.status} />
          )}
        </div>
      )}
    </div>
  );
}

// ── EventBubble ────────────────────────────────────────────────────────────

export interface EventBubbleProps {
  event: SessionEvent;
  showHeader?: boolean;
  agentIdentity?: AgentIdentity;
  customEvents?: SessionEvent[];
}

export function EventBubble({ event, showHeader = true, agentIdentity, customEvents }: EventBubbleProps) {
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
            style={{ backgroundColor: 'var(--color-accent-bg, rgba(245, 158, 11, 0.08))', color: 'var(--color-text)' }}
          >
            {text ? <MarkdownContent>{text}</MarkdownContent> : <p>(empty)</p>}
          </div>
        </div>
      );
    }
    return (
      <div className="flex gap-2.5 items-start">
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-honey-500"
          style={{ backgroundColor: 'var(--color-accent-bg, rgba(245, 158, 11, 0.1))' }}
        >
          <User className="w-3 h-3" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-2xs font-medium text-honey-500">User</span>
            {event.timestamp && (
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                <TimeAgo date={event.timestamp} />
              </span>
            )}
            <CustomEventBadges events={customEvents} />
          </div>
          <div
            className="text-sm rounded-lg px-3 py-2 max-w-[85%]"
            style={{ backgroundColor: 'var(--color-accent-bg, rgba(245, 158, 11, 0.08))', color: 'var(--color-text)' }}
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
    const isStreaming = (event as any)._isStreaming === true;
    const content = (
      <>
        {text && (
          <div className="text-sm max-w-[85%]" style={{ color: 'var(--color-text-secondary)' }}>
            <MarkdownContent>{text}</MarkdownContent>
            {isStreaming && (
              <span className="inline-block w-2 h-4 ml-0.5 bg-honey-500/60 animate-pulse rounded-sm" />
            )}
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
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
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
            <CustomEventBadges events={customEvents} />
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
          <LazyJsonBlock src={event.input} />
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
            className="mt-1 text-2xs rounded-lg px-3 py-2 max-w-[85%] overflow-x-auto font-mono whitespace-pre-wrap break-words"
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

// ── LazyJsonBlock (internal helper) ────────────────────────────────────────

function LazyJsonBlock({ src }: { src: Record<string, unknown> }) {
  const [JV, setJV] = useState<any>(null);

  if (!JV) {
    getJsonView().then(v => setJV(() => v));
    return (
      <pre className="mt-1 max-w-[85%] text-2xs rounded-lg px-3 py-2 overflow-x-auto font-mono whitespace-pre-wrap" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}>
        {JSON.stringify(src, null, 2)}
      </pre>
    );
  }

  return (
    <div
      className="mt-1 max-w-[85%] text-2xs rounded-lg px-3 py-2 overflow-x-auto"
      style={{ backgroundColor: 'var(--color-elevated)' }}
    >
      <JV src={src} collapsed={2} theme="a11y" dark collapseStringsAfterLength={120} style={{ fontSize: '10px', backgroundColor: 'transparent' }} />
    </div>
  );
}
