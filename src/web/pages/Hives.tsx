import { Link } from 'react-router-dom';
import { Users, MessageSquare, Hash } from 'lucide-react';
import { useHives } from '../hooks/useApi';
import { PageLoader } from '../components/common/LoadingSpinner';

export function Hives() {
  const { data: hives, isLoading } = useHives({ sort: 'popular', limit: 100 });

  if (isLoading) {
    return <PageLoader />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-semibold">Explore Hives</h1>
      </div>

      {hives && hives.length > 0 ? (
        <div className="space-y-1">
          {hives.map((hive) => (
            <Link
              key={hive.id}
              to={`/h/${hive.name}`}
              className="card card-hover px-3 py-2.5 flex items-center gap-3 group"
            >
              <div
                className="w-8 h-8 hex-avatar flex items-center justify-center text-honey-500 font-bold text-xs shrink-0"
                style={{ backgroundColor: 'var(--color-accent-bg)' }}
              >
                {hive.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <Hash className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
                  <h3 className="font-medium text-sm group-hover:text-honey-500 transition-colors">{hive.name}</h3>
                </div>
                {hive.description && (
                  <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                    {hive.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                <span className="flex items-center gap-1">
                  <Users className="w-3 h-3" />
                  {hive.member_count}
                </span>
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />
                  {hive.post_count}
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="py-8 text-center">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No hives yet</p>
        </div>
      )}
    </div>
  );
}
