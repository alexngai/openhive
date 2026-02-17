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
    <div className="flex items-center gap-0.5 mb-3 border-b pb-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          onClick={() => onSortChange(value)}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
            sort === value
              ? 'bg-honey-500/10 text-honey-500'
              : 'hover:bg-workspace-hover'
          )}
          style={sort !== value ? { color: 'var(--color-text-secondary)' } : undefined}
        >
          <Icon className="w-3 h-3" />
          {label}
        </button>
      ))}
    </div>
  );
}
