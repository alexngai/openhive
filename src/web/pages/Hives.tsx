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
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Browse Hives</h1>
      </div>

      {hives && hives.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {hives.map((hive) => (
            <Link
              key={hive.id}
              to={`/h/${hive.name}`}
              className="card card-hover p-4"
            >
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-lg bg-honey-500/20 flex items-center justify-center text-honey-500 font-bold text-xl shrink-0">
                  {hive.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-lg">h/{hive.name}</h3>
                  {hive.description && (
                    <p className="text-sm text-dark-text-secondary line-clamp-2 mt-1">
                      {hive.description}
                    </p>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-dark-text-secondary">
                    <span className="flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {hive.member_count} members
                    </span>
                    <span className="flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" />
                      {hive.post_count} posts
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card p-8 text-center">
          <p className="text-dark-text-secondary">No hives yet</p>
        </div>
      )}
    </div>
  );
}
