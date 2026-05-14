import type { ElementType, ReactNode } from 'react';
import clsx from 'clsx';

export interface TabDef<Id extends string = string> {
  id: Id;
  label: ReactNode;
  icon?: ElementType;
  /** Optional small badge next to the label (e.g. count). */
  badge?: ReactNode;
  disabled?: boolean;
}

interface TabsProps<Id extends string = string> {
  tabs: ReadonlyArray<TabDef<Id>>;
  activeId: Id;
  onChange: (id: Id) => void;
  /** Border-bottom underline style (default). Used for page-level tabs. */
  variant?: 'underline' | 'pill';
  /** Add bottom border under the row. Defaults true for underline, false for pill. */
  bordered?: boolean;
  className?: string;
}

export function Tabs<Id extends string = string>({
  tabs,
  activeId,
  onChange,
  variant = 'underline',
  bordered,
  className,
}: TabsProps<Id>) {
  const showBorder = bordered ?? variant === 'underline';

  return (
    <div
      className={clsx(
        'flex',
        variant === 'underline' ? 'gap-0 px-4' : 'gap-1',
        showBorder && 'border-b',
        className,
      )}
      style={showBorder ? { borderColor: 'var(--color-border-subtle)' } : undefined}
      role="tablist"
    >
      {tabs.map((t) => {
        const active = t.id === activeId;
        if (variant === 'pill') {
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={t.disabled}
              onClick={() => onChange(t.id)}
              className={clsx(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium transition-colors',
                active
                  ? 'bg-honey-500/15 text-honey-500'
                  : 'hover:bg-[var(--color-hover)]',
                t.disabled && 'opacity-50 cursor-not-allowed',
              )}
              style={!active && !t.disabled ? { color: 'var(--color-text-muted)' } : undefined}
            >
              {t.icon && <t.icon className="w-3 h-3" />}
              {t.label}
              {t.badge != null && <span className="ml-0.5">{t.badge}</span>}
            </button>
          );
        }
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            className={clsx(
              'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
              active
                ? 'border-honey-500 text-honey-500'
                : 'border-transparent hover:text-[var(--color-text-secondary)]',
              t.disabled && 'opacity-50 cursor-not-allowed',
            )}
            style={!active && !t.disabled ? { color: 'var(--color-text-muted)' } : undefined}
          >
            {t.icon && <t.icon className="w-3.5 h-3.5" />}
            {t.label}
            {t.badge != null && <span className="ml-0.5">{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
