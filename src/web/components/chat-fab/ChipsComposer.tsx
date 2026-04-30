/**
 * ChipsComposer — composer used when `CHAT_CONTEXT_CHIPS` is ON.
 *
 * Owns its own textarea state so we can:
 * - capture the `@` keystroke → open ContextMenu with primary preselected
 * - compose the final turn from staged chips + text on Send
 * - disable Send during streaming (queue-on-next-turn is simulated by
 *   delaying the send call until the status flips back to `ready`)
 * - enforce §8.1's `MAX_USER_TURN_BYTES` hard cap
 *
 * Mirrors swarmcraft `ChatInput`'s visual shape — same "Enter to send,
 * Shift+Enter for newline", same Send/Cancel button behavior — but the
 * internals differ enough (`@` interception, chip strip integration) that
 * reusing `ChatInput` wholesale wasn't tractable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Send } from 'lucide-react';
import type { ChatChannel } from 'swarmcraft/ui/embed';
import { useChatFabStagedChipsStore } from './chat-fab-staged-chips-store';
import {
  MAX_USER_TURN_BYTES,
  byteLength,
  composeTurn,
  composeTurnWithLiveRefresh,
} from './chat-send-utils';

export interface ChipsComposerProps {
  channel: ChatChannel;
  /** Called when the user presses `@` — parent opens the ContextMenu. */
  onAtKey: () => boolean;
  compact?: boolean;
}

export function ChipsComposer({ channel, onAtKey, compact }: ChipsComposerProps) {
  const stagedChips = useChatFabStagedChipsStore((s) => s.stagedChips);
  const clearChips = useChatFabStagedChipsStore((s) => s.clearChips);
  // The QueryClient powers the live-refresh wrapper. In the real app the
  // <QueryClientProvider> in main.tsx guarantees one is in scope; the
  // test harness supplies one via `TestQueryClientProvider`. If neither
  // exists the hook throws, which is the correct failure mode — we don't
  // want silent snapshot-only behavior in production.
  const queryClient = useQueryClient();

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [tooBigToast, setTooBigToast] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { status, send, mode } = channel;
  const isStreaming = status === 'streaming';
  const isReady = status === 'ready' || status === 'streaming';
  const hasContent = text.trim().length > 0 || stagedChips.length > 0;
  const canSend = isReady && hasContent && !sending && !isStreaming;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, compact ? 100 : 160) + 'px';
  }, [text, compact]);

  const doSend = useCallback(async () => {
    if (!canSend) return;
    // Live-refresh each chip (bounded by 200ms per chip, parallel). Falls
    // back to snapshot on timeout/abort/throw; marks `stale="true"` on
    // the fenced block iff the live loader explicitly returned null.
    //
    // Fail-closed: if the QueryClient is somehow unavailable we'd still
    // have the sync `composeTurn` snapshot path. In practice
    // `useQueryClient` above throws first, so this branch is belt-and-
    // braces.
    const composed = queryClient
      ? await composeTurnWithLiveRefresh(stagedChips, text, queryClient)
      : composeTurn(stagedChips, text);
    if (composed.length === 0) return;
    if (byteLength(composed) > MAX_USER_TURN_BYTES) {
      setTooBigToast(
        'Context too large to send — remove some chips or shorten text',
      );
      // Chips remain staged (§ spec: "Chips remain staged").
      return;
    }
    setSending(true);
    setSendError(null);
    setTooBigToast(null);
    try {
      await send(composed);
      setText('');
      clearChips();
    } catch (err) {
      setSendError((err as Error)?.message ?? 'Failed to send');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }, [canSend, stagedChips, text, send, clearChips, queryClient]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
        return;
      }
      // `@` shortcut: only intercept when the textarea is empty or preceded
      // by whitespace — a bare `@` starting a mention is the signal; `@` in
      // the middle of typing (e.g. an email address) should insert normally.
      if (e.key === '@') {
        const el = e.currentTarget as HTMLTextAreaElement;
        const before = el.value.slice(0, el.selectionStart ?? 0);
        const atWordStart = before.length === 0 || /\s$/.test(before);
        if (atWordStart) {
          const handled = onAtKey();
          if (handled) e.preventDefault();
        }
      }
    },
    [doSend, onAtKey],
  );

  const handleCancel = useCallback(async () => {
    if (channel.cancel) await channel.cancel();
  }, [channel]);

  const hintText = sendError
    ? `Send failed: ${sendError}`
    : tooBigToast
      ? tooBigToast
      : isStreaming
        ? 'Sending after current reply…'
        : status === 'connecting'
          ? 'Connecting...'
          : status === 'detecting'
            ? 'Detecting channel...'
            : mode === 'acp'
              ? 'Enter to send, Shift+Enter for new line'
              : mode === 'mail'
                ? 'Enter to send as supervisor turn'
                : '';

  const hintIsError = Boolean(sendError || tooBigToast);

  return (
    <div className={compact ? 'px-0 py-0' : 'px-0 py-0'}>
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isStreaming
              ? 'Agent is responding...'
              : mode === 'acp'
                ? 'Message agent...'
                : mode === 'mail'
                  ? 'Send a message...'
                  : 'No channel available'
          }
          disabled={
            status === 'error' ||
            status === 'closed' ||
            mode === 'unavailable' ||
            isStreaming ||
            sending
          }
          rows={1}
          className={`
            flex-1 resize-none rounded-lg border border-border-subtle bg-surface/50
            text-text-primary placeholder:text-text-muted
            focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20
            disabled:opacity-40 disabled:cursor-not-allowed
            ${compact ? 'px-2.5 py-1.5 text-xs min-h-[30px]' : 'px-3 py-2 text-sm min-h-[38px]'}
          `}
        />
        {isStreaming && channel.cancel ? (
          <button
            type="button"
            onClick={handleCancel}
            title="Cancel response"
            className={`flex items-center justify-center rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors flex-shrink-0 ${
              compact ? 'w-7 h-7' : 'w-9 h-9'
            }`}
          >
            <Loader2 size={compact ? 13 : 15} className="animate-spin" />
          </button>
        ) : (
          <button
            type="button"
            onClick={doSend}
            disabled={!canSend}
            aria-label="Send message"
            title="Send message"
            className={`flex items-center justify-center rounded-lg transition-colors flex-shrink-0
              ${
                canSend
                  ? 'bg-accent/20 text-accent hover:bg-accent/30'
                  : 'bg-surface text-text-muted opacity-40 cursor-not-allowed'
              }
              ${compact ? 'w-7 h-7' : 'w-9 h-9'}`}
          >
            {sending ? (
              <Loader2 size={compact ? 13 : 15} className="animate-spin" />
            ) : (
              <Send size={compact ? 13 : 15} />
            )}
          </button>
        )}
      </div>
      {hintText && (
        <div className="mt-1.5 px-0.5">
          <span
            className={`text-[10px] ${hintIsError ? 'text-red-400' : 'text-text-muted'}`}
          >
            {hintText}
          </span>
        </div>
      )}
    </div>
  );
}
