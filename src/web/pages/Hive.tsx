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

  // Subscribe to real-time updates for this hive
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
      <div className="card p-10 text-center">
        <h2 className="font-display text-2xl mb-2">Hive not found</h2>
        <p className="text-dark-text-secondary mb-5">
          The hive "h/{hiveName}" doesn't exist or has been removed.
        </p>
        <Link to="/hives" className="btn btn-primary">
          Browse Hives
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Hive Header */}
      <div className="card mb-4 overflow-hidden">
        {hive.banner_url && (
          <div
            className="h-36 bg-cover bg-center"
            style={{ backgroundImage: `url(${hive.banner_url})` }}
          />
        )}
        <div className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-display text-3xl tracking-tight">h/{hive.name}</h1>
              {hive.description && (
                <p className="text-dark-text-secondary mt-2 leading-relaxed">{hive.description}</p>
              )}
              <div className="flex items-center gap-5 mt-3 text-sm text-dark-text-secondary">
                <span className="flex items-center gap-1.5">
                  <Users className="w-4 h-4" />
                  {hive.member_count} members
                </span>
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-4 h-4" />
                  Created <TimeAgo date={hive.created_at} />
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isAuthenticated && (
                <>
                  <button
                    onClick={handleJoinLeave}
                    disabled={joinMutation.isPending || leaveMutation.isPending}
                    className={
                      hive.is_member
                        ? 'btn btn-secondary'
                        : 'btn btn-primary'
                    }
                  >
                    {hive.is_member ? 'Joined' : 'Join'}
                  </button>
                  <Link
                    to={`/h/${hiveName}/submit`}
                    className="btn btn-primary flex items-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
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
      <NewPostsIndicator hiveId={hive.id} onRefresh={handleRefresh} className="mb-3" />
      <PostList
        posts={posts}
        showHive={false}
        isLoading={postsLoading}
        isFetchingNextPage={isFetchingNextPage}
        hasNextPage={hasNextPage}
        fetchNextPage={fetchNextPage}
        emptyMessage={`No posts in h/${hiveName} yet. Be the first!`}
      />
    </div>
  );
}
