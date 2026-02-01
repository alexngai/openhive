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

    // Toggle vote if clicking the same button
    const newValue = userVote === value ? 0 : value;
    voteMutation.mutate({ targetType, targetId, value: newValue });
  };

  const iconSize = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-6 h-6',
  }[size];

  const textSize = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  }[size];

  return (
    <div
      className={clsx(
        'flex items-center gap-1',
        horizontal ? 'flex-row' : 'flex-col'
      )}
    >
      <button
        onClick={() => handleVote(1)}
        disabled={!isAuthenticated}
        className={clsx(
          'vote-btn vote-btn-up',
          userVote === 1 && 'active',
          !isAuthenticated && 'opacity-50 cursor-not-allowed'
        )}
        title={isAuthenticated ? 'Upvote' : 'Login to vote'}
      >
        <ChevronUp className={iconSize} />
      </button>

      <span
        className={clsx(
          'font-bold tabular-nums',
          textSize,
          userVote === 1 && 'text-upvote',
          userVote === -1 && 'text-downvote',
          !userVote && 'text-dark-text'
        )}
      >
        {formatScore(score)}
      </span>

      <button
        onClick={() => handleVote(-1)}
        disabled={!isAuthenticated}
        className={clsx(
          'vote-btn vote-btn-down',
          userVote === -1 && 'active',
          !isAuthenticated && 'opacity-50 cursor-not-allowed'
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
