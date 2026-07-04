/**
 * AttentionBell — the cockpit's "who needs me?" surface. A bell button with
 * a count badge that opens a popover listing every attention item from the
 * session-attention store, newest first:
 *
 * - permission items render inline Allow / Deny buttons that post directly
 *   to the reply endpoint for their source (ACP stream or hosted codex) —
 *   no chat channel needs to be mounted, and no thread needs to be opened.
 * - idle items deep-link to their thread (clicking clears the idle flag).
 *
 * Resolution flows through the store: the optimistic resolvePermission on
 * reply plus the `permission.resolved` WS event (answered in any tab) both
 * remove the item, so the panel empties itself as requests are handled.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Check, Clock, ShieldAlert, Sparkles, X } from 'lucide-react';
import {
  useSessionAttentionStore,
  type AttentionItem,
} from '../../stores/session-attention';
import { replyAcpPermission } from '../../adapters/openhive-acp-service';
import { hostedChatService } from '../../services/hosted-chat-service';
import { useHostedSwarms } from '../../hooks/useApi';
import { toast } from '../../stores/toast';
import type { SessionListItem } from '../../lib/api';

function timeAgo(timestamp: number): string {
  const s = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Route for a thread key; `stream:` fallback items can only go to the list. */
function threadPath(threadKey: string): string {
  const [flavor, id] = [
    threadKey.slice(0, threadKey.indexOf(':')),
    threadKey.slice(threadKey.indexOf(':') + 1),
  ];
  switch (flavor) {
    case 'session': return `/threads/${id}`;
    case 'hosted-chat': return `/threads/hosted-chat/${id}`;
    case 'dispatch': return `/dispatch/${id}`;
    default: return '/threads';
  }
}

export function AttentionBell() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const items = useSessionAttentionStore((s) => s.items);
  const clearIdle = useSessionAttentionStore((s) => s.clearIdle);
  const clearThread = useSessionAttentionStore((s) => s.clearThread);
  const resolvePermission = useSessionAttentionStore((s) => s.resolvePermission);

  // requestIds with an in-flight reply, so double-clicks don't double-post.
  const [replying, setReplying] = useState<Set<string>>(new Set());

  const sorted = useMemo(
    () => [...items.values()].sort((a, b) => b.timestamp - a.timestamp),
    [items],
  );
  const permissionCount = useMemo(
    () => sorted.filter((i) => i.kind === 'permission').length,
    [sorted],
  );

  const { data: hostedSwarms } = useHostedSwarms();

  const threadLabel = useCallback((item: AttentionItem): string => {
    const [flavor, id] = [
      item.threadKey.slice(0, item.threadKey.indexOf(':')),
      item.threadKey.slice(item.threadKey.indexOf(':') + 1),
    ];
    if (flavor === 'dispatch') {
      return `Dispatch ${id.slice(0, 8)}`;
    }
    if (flavor === 'hosted-chat') {
      return (hostedSwarms ?? []).find((h) => h.id === id)?.name ?? 'Hosted agent';
    }
    if (flavor === 'session') {
      const cached = queryClient.getQueriesData<{ data: SessionListItem[] }>({
        queryKey: ['sessions-overview'],
      });
      for (const [, data] of cached) {
        const session = data?.data?.find((s) => s.id === id);
        if (session) return session.name;
      }
      return 'Session';
    }
    return 'Agent session';
  }, [hostedSwarms, queryClient]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const reply = useCallback(async (item: AttentionItem, granted: boolean) => {
    if (!item.requestId || replying.has(item.requestId)) return;
    setReplying((prev) => new Set(prev).add(item.requestId!));
    try {
      if (item.streamId) {
        await replyAcpPermission(item.streamId, item.requestId, granted);
      } else if (item.hostedSwarmId) {
        await hostedChatService.replyPermission(
          item.hostedSwarmId,
          item.requestId,
          granted ? 'approved' : 'denied',
        );
      } else {
        throw new Error('No reply route on this permission item');
      }
      // Optimistic removal — the permission.resolved WS event is the
      // authoritative cleanup, but don't leave the row hanging until then.
      resolvePermission(item.requestId);
    } catch (err) {
      toast.error('Reply failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setReplying((prev) => {
        const next = new Set(prev);
        next.delete(item.requestId!);
        return next;
      });
    }
  }, [replying, resolvePermission]);

  const openThread = useCallback((item: AttentionItem) => {
    if (item.kind === 'idle') clearIdle(item.threadKey);
    else if (item.kind === 'dispatch') clearThread(item.threadKey);
    setOpen(false);
    navigate(threadPath(item.threadKey));
  }, [clearIdle, clearThread, navigate]);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Attention queue (${sorted.length})`}
        aria-expanded={open}
        className="relative p-1.5 rounded-md cursor-pointer transition-colors duration-80 hover:bg-[var(--color-hover)]"
        style={{ color: 'var(--color-text-secondary)' }}
        title="Attention queue"
      >
        <Bell className="w-4 h-4" />
        {sorted.length > 0 && (
          <span
            className={`absolute -top-0.5 -right-0.5 text-[9px] font-semibold px-1 py-px rounded-full leading-none min-w-[14px] text-center ${
              permissionCount > 0
                ? 'bg-red-500/20 text-red-400'
                : 'bg-amber-500/20 text-amber-400'
            }`}
          >
            {sorted.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-80 max-h-96 overflow-y-auto rounded-lg border shadow-xl z-50"
          style={{
            backgroundColor: 'var(--color-bg-elevated, var(--color-bg))',
            borderColor: 'var(--color-border-subtle)',
          }}
          role="dialog"
          aria-label="Attention queue"
        >
          <div
            className="px-3 py-2 border-b text-xs font-semibold"
            style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}
          >
            Needs attention
          </div>
          {sorted.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
              All clear — no agents waiting on you.
            </div>
          ) : (
            <ul>
              {sorted.map((item) => {
                const rowKey = item.kind === 'permission'
                  ? `${item.threadKey}#perm:${item.requestId}`
                  : `${item.threadKey}#${item.kind}`;
                const busy = item.requestId ? replying.has(item.requestId) : false;
                return (
                  <li
                    key={rowKey}
                    className="px-3 py-2 border-b last:border-b-0"
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  >
                    <div className="flex items-start gap-2">
                      {item.kind === 'permission' ? (
                        <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-400" />
                      ) : item.kind === 'dispatch' ? (
                        <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0 text-honey-500" />
                      ) : (
                        <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-400" />
                      )}
                      <div className="min-w-0 flex-1">
                        <button
                          onClick={() => openThread(item)}
                          className="text-xs font-medium truncate block max-w-full text-left cursor-pointer hover:underline"
                          style={{ color: 'var(--color-text)' }}
                        >
                          {threadLabel(item)}
                        </button>
                        <p className="text-2xs truncate" style={{ color: 'var(--color-text-secondary)' }}>
                          {item.kind === 'idle' ? 'Awaiting input' : item.description}
                        </p>
                        <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                          {timeAgo(item.timestamp)}
                        </p>
                      </div>
                      {item.kind === 'permission' && (
                        <div className="flex gap-1 shrink-0">
                          <button
                            onClick={() => void reply(item, true)}
                            disabled={busy}
                            aria-label="Allow"
                            className="p-1 rounded cursor-pointer bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-50 transition-colors duration-80"
                            title="Allow"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => void reply(item, false)}
                            disabled={busy}
                            aria-label="Deny"
                            className="p-1 rounded cursor-pointer bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-50 transition-colors duration-80"
                            title="Deny"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
