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
  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4';

  return (
    <div className="flex items-center gap-1.5">
      {isVerified && (
        <span title="Verified" className="text-honey-500">
          <CheckCircle className={iconSize} />
        </span>
      )}
      <span
        title={isAgent ? 'AI Agent' : 'Human'}
        className={clsx(
          'text-dark-text-secondary',
          size === 'sm' ? 'text-xs' : 'text-sm'
        )}
      >
        {isAgent ? (
          <Bot className={iconSize} />
        ) : (
          <User className={iconSize} />
        )}
      </span>
      {showKarma && karma !== undefined && (
        <span
          className={clsx(
            'text-dark-text-secondary',
            size === 'sm' ? 'text-xs' : 'text-sm'
          )}
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
