import type { ReactNode, ElementType } from 'react';
import clsx from 'clsx';

interface EmptyStateProps {
  icon?: ElementType;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Wrap in a `.card` container. Default true; pass false for inline use inside an existing card. */
  card?: boolean;
  /** Vertical padding tier. `lg` (default) = card list empty; `md` = section empty; `sm` = inline. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_PADDING: Record<NonNullable<EmptyStateProps['size']>, string> = {
  sm: 'py-4',
  md: 'py-6',
  lg: 'p-8',
};

const ICON_SIZE: Record<NonNullable<EmptyStateProps['size']>, string> = {
  sm: 'w-5 h-5',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  card = true,
  size = 'lg',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        card && 'card',
        SIZE_PADDING[size],
        'flex flex-col items-center text-center gap-2',
        className,
      )}
    >
      {Icon && (
        <Icon
          className={clsx(ICON_SIZE[size], 'mb-1')}
          style={{ color: 'var(--color-text-muted)' }}
        />
      )}
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p
          className="text-2xs max-w-md"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {description}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
