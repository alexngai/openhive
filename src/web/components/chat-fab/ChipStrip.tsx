/**
 * ChipStrip — horizontal strip of staged context chips above the composer.
 *
 * See §4.6 / §6.2 of docs/CHAT_CONTEXT_INJECTION_DESIGN.md:
 * - 5 visible max; tail collapses into `+N` chip → popover listing rest
 * - `×` removes a chip; composer text untouched
 * - Hover a chip → passive popover with the rendered fenced block
 * - Preview dismisses on pointer-leave OR Escape
 * - Mouse-first; keyboard-only hover preview is a follow-up (§8.2)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  useChatFabStagedChipsStore,
  type ChatFabStagedChip,
} from './chat-fab-staged-chips-store';
import { formatContextItem } from './ContextFormatter';

const MAX_VISIBLE = 5;

function getChipIcon(item: ChatFabStagedChip['item']): string {
  const map: Record<string, string> = {
    spec: '📄',
    tasks: '📋',
    dispatch: '🚀',
    swarm: '⚡',
    session: '💬',
    task: '☑️',
  };
  return map[item.type] ?? '📎';
}

function ChipButton({
  chip,
  onRemove,
  onHoverIn,
  onHoverOut,
}: {
  chip: ChatFabStagedChip;
  onRemove: (chipId: string) => void;
  onHoverIn?: (chipId: string, el: HTMLElement) => void;
  onHoverOut?: (chipId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const icon = getChipIcon(chip.item);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={`Staged context: ${chip.item.label}`}
      data-chip-id={chip.chipId}
      onPointerEnter={() => ref.current && onHoverIn?.(chip.chipId, ref.current)}
      onPointerLeave={() => onHoverOut?.(chip.chipId)}
      className="flex items-center gap-1 px-2 py-0.5 text-2xs rounded-full border"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-elevated)',
        color: 'var(--color-text)',
        maxWidth: '160px',
      }}
    >
      <span aria-hidden="true">{icon}</span>
      <span className="truncate" style={{ maxWidth: '110px' }}>
        {chip.item.label}
      </span>
      <button
        type="button"
        aria-label={`Remove chip ${chip.item.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(chip.chipId);
        }}
        className="flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        style={{ color: 'var(--color-text-muted)', width: 14, height: 14 }}
      >
        <X size={10} />
      </button>
    </div>
  );
}

interface HoverPreviewProps {
  chip: ChatFabStagedChip;
  anchor: HTMLElement;
  onDismiss: () => void;
}

function HoverPreview({ chip, anchor, onDismiss }: HoverPreviewProps) {
  // Screen-edge aware: compute preferred position above the anchor, flip
  // below if there's no room, and shift horizontally to stay on-screen.
  const [pos, setPos] = useState<{ left: number; bottom: number | null; top: number | null }>(
    () => {
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const left = Math.max(8, Math.min(vw - 436, rect.left));
      return { left, bottom: window.innerHeight - rect.top + 6, top: null };
    },
  );

  useEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(vw - 436, rect.left));
    // Prefer above; if no room, flip below.
    if (rect.top > 180) {
      setPos({ left, bottom: vh - rect.top + 6, top: null });
    } else {
      setPos({ left, bottom: null, top: rect.bottom + 6 });
    }
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const body = useMemo(() => {
    try {
      return formatContextItem(chip.item);
    } catch (err) {
      return `(failed to format: ${(err as Error)?.message ?? String(err)})`;
    }
  }, [chip]);

  return (
    <div
      role="tooltip"
      data-testid="chip-hover-preview"
      className="fixed z-50 rounded-md border shadow-xl overflow-hidden"
      style={{
        left: pos.left,
        bottom: pos.bottom ?? undefined,
        top: pos.top ?? undefined,
        width: 'min(420px, calc(100vw - 16px))',
        maxHeight: '60vh',
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-elevated)',
      }}
    >
      <pre
        className="text-2xs whitespace-pre-wrap break-words p-3 overflow-auto"
        style={{
          color: 'var(--color-text)',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          maxHeight: '60vh',
        }}
      >
        {body}
      </pre>
    </div>
  );
}

export function ChipStrip() {
  const stagedChips = useChatFabStagedChipsStore((s) => s.stagedChips);
  const removeChip = useChatFabStagedChipsStore((s) => s.removeChip);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [hoverChipId, setHoverChipId] = useState<string | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<HTMLElement | null>(null);

  const onHoverIn = useCallback((chipId: string, el: HTMLElement) => {
    setHoverChipId(chipId);
    setHoverAnchor(el);
  }, []);
  const onHoverOut = useCallback(
    (chipId: string) => {
      if (hoverChipId === chipId) {
        setHoverChipId(null);
        setHoverAnchor(null);
      }
    },
    [hoverChipId],
  );
  const dismissHover = useCallback(() => {
    setHoverChipId(null);
    setHoverAnchor(null);
  }, []);

  if (stagedChips.length === 0) return null;

  const visible = stagedChips.slice(0, MAX_VISIBLE);
  const overflow = stagedChips.slice(MAX_VISIBLE);
  const hoverChip = hoverChipId
    ? stagedChips.find((c) => c.chipId === hoverChipId) ?? null
    : null;

  return (
    <div
      data-testid="chip-strip"
      className="flex flex-wrap items-center gap-1 pb-1"
    >
      {visible.map((chip) => (
        <ChipButton
          key={chip.chipId}
          chip={chip}
          onRemove={removeChip}
          onHoverIn={onHoverIn}
          onHoverOut={onHoverOut}
        />
      ))}

      {overflow.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOverflowOpen((v) => !v)}
            aria-label={`Show ${overflow.length} more chips`}
            className="flex items-center px-2 py-0.5 text-2xs rounded-full border hover:bg-white/5"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text-muted)',
            }}
          >
            +{overflow.length}
          </button>
          {overflowOpen && (
            <div
              role="dialog"
              data-testid="chip-overflow-popover"
              className="absolute bottom-full left-0 mb-1 w-56 rounded-md border shadow-lg p-1 overflow-auto"
              style={{
                borderColor: 'var(--color-border-subtle)',
                backgroundColor: 'var(--color-elevated)',
                maxHeight: '240px',
              }}
            >
              {overflow.map((chip) => (
                <div
                  key={chip.chipId}
                  className="flex items-center gap-1 px-2 py-1"
                >
                  <span aria-hidden="true" className="mr-1">
                    {getChipIcon(chip.item)}
                  </span>
                  <span
                    className="truncate flex-1 text-xs"
                    style={{ color: 'var(--color-text)' }}
                  >
                    {chip.item.label}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove chip ${chip.item.label}`}
                    onClick={() => removeChip(chip.chipId)}
                    className="flex items-center justify-center rounded hover:bg-white/10 transition-colors"
                    style={{
                      color: 'var(--color-text-muted)',
                      width: 16,
                      height: 16,
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {hoverChip && hoverAnchor && (
        <HoverPreview
          chip={hoverChip}
          anchor={hoverAnchor}
          onDismiss={dismissHover}
        />
      )}
    </div>
  );
}
