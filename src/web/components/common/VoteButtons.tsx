import { ChevronUp, ChevronDown } from 'lucide-react';
import { useVote } from '../../hooks/useApi';
import { useAuthStore } from '../../stores/auth';
import clsx from 'clsx';

interface VoteButtonsProps {
  targetType: 'post' | 'comment';
  targetId: string;
  score: number;
  userVote?: 1 | -1 | null;
  size?: 'sm' | 'md' | 'lg';
  horizontal?: boolean;
}

export function VoteButtons({
  targetType,
  targetId,
  score,
  userVote,
  size = 'md',
  horizontal = false,
}: VoteButtonsProps) {
  const { isAuthenticated } = useAuthStore();
  const voteMutation = useVote();

  const handleVote = (value: 1 | -1) => {
    if (!isAuthenticated) return;
    const newValue = userVote === value ? 0 : value;
    voteMutation.mutate({ targetType, targetId, value: newValue });
  };

  const iconSize = {
    sm: 'w-3.5 h-3.5',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  }[size];

  const textSize = {
    sm: 'text-2xs',
    md: 'text-xs',
    lg: 'text-sm',
  }[size];

  return (
    <div
      className={clsx(
        'flex items-center',
        horizontal ? 'flex-row gap-0.5' : 'flex-col gap-0'
      )}
    >
      <button
        onClick={() => handleVote(1)}
        disabled={!isAuthenticated}
        className={clsx(
          'vote-btn vote-btn-up',
          userVote === 1 && 'active',
          !isAuthenticated && 'opacity-40 cursor-not-allowed'
        )}
        title={isAuthenticated ? 'Upvote' : 'Login to vote'}
      >
        <ChevronUp className={iconSize} />
      </button>

      <span
        className={clsx(
          'font-bold tabular-nums text-center min-w-[1.5em]',
          textSize,
          userVote === 1 && 'text-upvote',
          userVote === -1 && 'text-downvote',
        )}
        style={!userVote ? { color: 'var(--color-text-secondary)' } : undefined}
      >
        {formatScore(score)}
      </span>

      <button
        onClick={() => handleVote(-1)}
        disabled={!isAuthenticated}
        className={clsx(
          'vote-btn vote-btn-down',
          userVote === -1 && 'active',
          !isAuthenticated && 'opacity-40 cursor-not-allowed'
        )}
        title={isAuthenticated ? 'Downvote' : 'Login to vote'}
      >
        <ChevronDown className={iconSize} />
      </button>
    </div>
  );
}

function formatScore(score: number): string {
  if (Math.abs(score) >= 10000) {
    return (score / 1000).toFixed(1) + 'k';
  }
  if (Math.abs(score) >= 1000) {
    return (score / 1000).toFixed(1) + 'k';
  }
  return score.toString();
}
