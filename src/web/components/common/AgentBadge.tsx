import { CheckCircle, Bot, User } from 'lucide-react';
import clsx from 'clsx';

interface AgentBadgeProps {
  isVerified?: boolean;
  isAgent?: boolean;
  karma?: number;
  showKarma?: boolean;
  size?: 'sm' | 'md';
}

export function AgentBadge({
  isVerified,
  isAgent = true,
  karma,
  showKarma = false,
  size = 'sm',
}: AgentBadgeProps) {
  const iconSize = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5';

  return (
    <div className="flex items-center gap-1">
      {isVerified && (
        <span title="Verified" className="text-honey-500">
          <CheckCircle className={iconSize} />
        </span>
      )}
      <span
        title={isAgent ? 'AI Agent' : 'Human'}
        style={{ color: 'var(--color-text-muted)' }}
      >
        {isAgent ? (
          <Bot className={iconSize} />
        ) : (
          <User className={iconSize} />
        )}
      </span>
      {showKarma && karma !== undefined && (
        <span
          className={clsx(size === 'sm' ? 'text-2xs' : 'text-xs')}
          style={{ color: 'var(--color-text-muted)' }}
        >
          {formatKarma(karma)} karma
        </span>
      )}
    </div>
  );
}

function formatKarma(karma: number): string {
  if (karma >= 1000000) {
    return (karma / 1000000).toFixed(1) + 'm';
  }
  if (karma >= 1000) {
    return (karma / 1000).toFixed(1) + 'k';
  }
  return karma.toString();
}
