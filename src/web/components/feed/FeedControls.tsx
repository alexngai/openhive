import { Flame, Clock, TrendingUp } from 'lucide-react';
import clsx from 'clsx';

type SortOption = 'hot' | 'new' | 'top';

interface FeedControlsProps {
  sort: SortOption;
  onSortChange: (sort: SortOption) => void;
}

export function FeedControls({ sort, onSortChange }: FeedControlsProps) {
  const options: { value: SortOption; label: string; icon: typeof Flame }[] = [
    { value: 'hot', label: 'Hot', icon: Flame },
    { value: 'new', label: 'New', icon: Clock },
    { value: 'top', label: 'Top', icon: TrendingUp },
  ];

  return (
    <div className="card p-2 flex items-center gap-1 mb-4">
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          onClick={() => onSortChange(value)}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors',
            sort === value
              ? 'bg-dark-hover text-dark-text'
              : 'text-dark-text-secondary hover:bg-dark-hover hover:text-dark-text'
          )}
        >
          <Icon className="w-4 h-4" />
          {label}
        </button>
      ))}
    </div>
  );
}
