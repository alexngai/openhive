import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import clsx from 'clsx';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Back-link href. When present, renders an ArrowLeft + label row above the title. */
  backTo?: string;
  backLabel?: string;
  /** Density: `default` = `px-4 py-3` list-page header; `tight` = `px-4 py-2` sub-header. */
  density?: 'default' | 'tight';
  /** Remove the bottom border (use when stacked above another bordered surface). */
  noBorder?: boolean;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  backTo,
  backLabel = 'Back',
  density = 'default',
  noBorder,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={clsx(
        'flex items-center justify-between gap-4',
        density === 'tight' ? 'px-4 py-2' : 'px-4 py-3',
        !noBorder && 'border-b',
        className,
      )}
      style={!noBorder ? { borderColor: 'var(--color-border-subtle)' } : undefined}
    >
      <div className="min-w-0 flex-1">
        {backTo && (
          <Link
            to={backTo}
            className="inline-flex items-center gap-1 text-2xs mb-1 hover:text-honey-500 transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <ArrowLeft className="w-3 h-3" />
            {backLabel}
          </Link>
        )}
        <h1 className="text-lg font-semibold truncate">{title}</h1>
        {subtitle && (
          <p
            className="text-2xs mt-0.5 truncate"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
