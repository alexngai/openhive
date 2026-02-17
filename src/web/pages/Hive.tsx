import { useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Users, Calendar, Plus } from 'lucide-react';
import { useHive, usePosts, useJoinHive, useLeaveHive } from '../hooks/useApi';
import { useHiveFeedUpdates } from '../hooks/useRealtimeUpdates';
import { useAuthStore } from '../stores/auth';
import { PostList } from '../components/feed/PostList';
import { FeedControls } from '../components/feed/FeedControls';
import { NewPostsIndicator } from '../components/feed/NewPostsIndicator';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';

export function Hive() {
  const { hiveName } = useParams<{ hiveName: string }>();
  const [sort, setSort] = useState<'hot' | 'new' | 'top'>('hot');
  const { isAuthenticated } = useAuthStore();

  const { data: hive, isLoading: hiveLoading } = useHive(hiveName!);
  const joinMutation = useJoinHive();
  const leaveMutation = useLeaveHive();

  const {
    data: postsData,
    isLoading: postsLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = usePosts({ hive: hiveName, sort });

  useHiveFeedUpdates(hive?.id || '');

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const posts = postsData?.pages.flatMap((page) => page.data) || [];

  const handleJoinLeave = () => {
    if (!hiveName) return;
    if (hive?.is_member) {
      leaveMutation.mutate(hiveName);
    } else {
      joinMutation.mutate(hiveName);
    }
  };

  if (hiveLoading) {
    return <PageLoader />;
  }

  if (!hive) {
    return (
      <div className="py-8 text-center">
        <h2 className="text-lg font-semibold mb-1">Hive not found</h2>
        <p className="text-sm mb-3" style={{ color: 'var(--color-text-secondary)' }}>
          #{hiveName} doesn't exist or has been removed.
        </p>
        <Link to="/hives" className="btn btn-primary text-xs">
          Browse Hives
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Hive Header */}
      <div className="card mb-3 overflow-hidden">
        {hive.banner_url && (
          <div
            className="h-24 bg-cover bg-center"
            style={{ backgroundImage: `url(${hive.banner_url})` }}
          />
        )}
        <div className="px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold">#{hive.name}</h1>
              {hive.description && (
                <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  {hive.description}
                </p>
              )}
              <div className="flex items-center gap-4 mt-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                <span className="flex items-center gap-1">
                  <Users className="w-3 h-3" />
                  {hive.member_count} members
                </span>
                <span className="flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  Created <TimeAgo date={hive.created_at} />
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {isAuthenticated && (
                <>
                  <button
                    onClick={handleJoinLeave}
                    disabled={joinMutation.isPending || leaveMutation.isPending}
                    className={`${hive.is_member ? 'btn btn-secondary' : 'btn btn-primary'} text-xs`}
                  >
                    {hive.is_member ? 'Joined' : 'Join'}
                  </button>
                  <Link
                    to={`/h/${hiveName}/submit`}
                    className="btn btn-primary flex items-center gap-1 text-xs"
                  >
                    <Plus className="w-3 h-3" />
                    Post
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Feed */}
      <FeedControls sort={sort} onSortChange={setSort} />
      <NewPostsIndicator hiveId={hive.id} onRefresh={handleRefresh} className="mb-2" />
      <PostList
        posts={posts}
        showHive={false}
        isLoading={postsLoading}
        isFetchingNextPage={isFetchingNextPage}
        hasNextPage={hasNextPage}
        fetchNextPage={fetchNextPage}
        emptyMessage={`No posts in #${hiveName} yet. Be the first!`}
      />
    </div>
  );
}
