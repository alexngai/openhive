/**
 * SessionChatInput — Sticky chat input for session trajectory view.
 *
 * Displays at the bottom of the trajectory tab. Mode-aware:
 * - unavailable: read-only indicator
 * - ready: textarea + send button with mode badge
 * - streaming: disabled with "Agent is responding..." indicator
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Send, Square, MessageSquare, Mail, Zap, Loader2 } from 'lucide-react';
import type { ChatChannel, ChatCapabilities, ChatMode, ChatStatus } from 'swarmcraft/ui/embed';

export interface SessionChatInputProps {
  /** Preferred: pass a full ChatChannel — mode/status/onSend/onCancel/capabilities derived from it */
  channel?: ChatChannel;

  // A la carte props (overrides channel fields)
  mode?: ChatMode;
  status?: ChatStatus;
  onSend?: (text: string) => Promise<void>;
  onCancel?: () => Promise<void>;
  /** Published capabilities from the swarm — used for unavailable state messaging */
  capabilities?: ChatCapabilities;
  /** Error detail to surface in the hint line (defaults to channel.statusDetail) */
  streamError?: string | null;
}

const MODE_LABELS: Record<ChatMode, { label: string; icon: typeof MessageSquare }> = {
  acp: { label: 'ACP', icon: Zap },
  mail: { label: 'Mail', icon: Mail },
  inject: { label: 'Inject', icon: Zap },
  unavailable: { label: 'Unavailable', icon: MessageSquare },
};

const MODE_HINTS: Record<ChatMode, string> = {
  acp: 'Streaming — Enter to send, Shift+Enter for new line',
  mail: 'Async turns — Enter to send, Shift+Enter for new line',
  inject: 'One-way — message delivered, no response channel',
  unavailable: '',
};

export function SessionChatInput(props: SessionChatInputProps) {
  const {
    channel,
    mode = channel?.mode ?? 'unavailable',
    status = channel?.status ?? 'detecting',
    onSend = channel?.send ?? (async () => { throw new Error('SessionChatInput: no send handler'); }),
    onCancel = channel?.cancel,
    capabilities = channel?.capabilities,
    streamError = (channel?.status === 'error' ? channel?.statusDetail : null) ?? null,
  } = props;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [text]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(trimmed);
      setText('');
    } catch (err) {
      // Preserve text so the user can retry. Surface the error in the hint line.
      setSendError((err as Error)?.message ?? 'Failed to send');
    } finally {
      setSending(false);
    }
  }, [text, sending, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  if (mode === 'unavailable') {
    // Give specific reason based on capabilities
    let reason = 'Read-only session';
    if (capabilities) {
      if (!capabilities.connected) {
        reason = 'Agent is offline';
      } else if (!capabilities.mail && !capabilities.inject && !capabilities.acp) {
        reason = 'Agent does not publish chat capabilities (mail, messaging, or ACP)';
      }
    }

    return (
      <div
        className="sticky bottom-0 z-10 border-t"
        style={{ backgroundColor: 'var(--color-bg)', borderColor: 'var(--color-border-subtle)' }}
      >
        <div className="max-w-4xl mx-auto px-4 py-2 text-center">
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {reason}
          </span>
        </div>
      </div>
    );
  }

  const isStreaming = status === 'streaming';
  const isReady = status === 'ready';
  const canSend = isReady && text.trim().length > 0 && !sending;
  const canCancel = isStreaming && !!onCancel;
  const modeInfo = MODE_LABELS[mode];
  const ModeIcon = modeInfo.icon;

  return (
    <div
      className="sticky bottom-0 z-10 border-t backdrop-blur"
      style={{
        backgroundColor: 'var(--color-bg)',
        borderColor: 'var(--color-border-subtle)',
      }}
    >
      <div className="max-w-4xl mx-auto px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isStreaming ? 'Agent is responding...'
                : mode === 'inject' ? 'Send a message (one-way)...'
                : 'Send a message to the agent...'
            }
            disabled={isStreaming || sending || !isReady}
            rows={1}
            className="flex-1 resize-none rounded-lg px-3 py-2 text-sm border outline-none transition-colors"
            style={{
              backgroundColor: 'var(--color-elevated)',
              borderColor: 'var(--color-border)',
              color: 'var(--color-text)',
            }}
          />
          {canCancel ? (
            <button
              onClick={onCancel}
              className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer"
              style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)' }}
              title="Cancel"
            >
              <Square className="w-3.5 h-3.5 text-red-400" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--color-accent-bg, rgba(245, 158, 11, 0.15))' }}
              title="Send"
            >
              {sending ? (
                <Loader2 className="w-3.5 h-3.5 text-honey-500 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5 text-honey-500" />
              )}
            </button>
          )}
        </div>

        {/* Mode indicator + hint */}
        <div className="flex items-center gap-2 mt-1.5">
          <span
            className="inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
          >
            <ModeIcon className="w-2.5 h-2.5" />
            {modeInfo.label}
          </span>
          <span className="text-2xs" style={{ color: (streamError || sendError) ? 'var(--color-text-error, #ef4444)' : 'var(--color-text-muted)' }}>
            {sendError ? `Send failed: ${sendError}`
              : streamError ? `Error: ${streamError}`
              : isStreaming ? 'Agent is responding...'
              : status === 'connecting' ? 'Connecting to agent...'
              : status === 'detecting' ? 'Detecting channel...'
              : status === 'error' ? 'Connection error — sending via mail fallback'
              : MODE_HINTS[mode]
            }
          </span>
        </div>
      </div>
    </div>
  );
}
