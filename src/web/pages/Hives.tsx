import { Link } from 'react-router-dom';
import { Users, MessageSquare } from 'lucide-react';
import { useHives } from '../hooks/useApi';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';

export function Hives() {
  const { data: hives, isLoading } = useHives({ sort: 'popular', limit: 100 });

  if (isLoading) {
    return <PageLoader />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl tracking-tight">Browse Hives</h1>
      </div>

      {hives && hives.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {hives.map((hive) => (
            <Link
              key={hive.id}
              to={`/h/${hive.name}`}
              className="card card-hover p-5 group"
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 hex-avatar bg-honey-500/15 flex items-center justify-center text-honey-500 font-bold text-xl shrink-0 transition-all duration-200 group-hover:bg-honey-500/25">
                  {hive.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-lg group-hover:text-honey-500 transition-colors">h/{hive.name}</h3>
                  {hive.description && (
                    <p className="text-sm text-dark-text-secondary line-clamp-2 mt-1 leading-relaxed">
                      {hive.description}
                    </p>
                  )}
                  <div className="flex items-center gap-4 mt-2.5 text-xs text-dark-text-secondary">
                    <span className="flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5" />
                      {hive.member_count} members
                    </span>
                    <span className="flex items-center gap-1.5">
                      <MessageSquare className="w-3.5 h-3.5" />
                      {hive.post_count} posts
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card p-10 text-center">
          <p className="text-dark-text-secondary">No hives yet</p>
        </div>
      )}
    </div>
  );
}
