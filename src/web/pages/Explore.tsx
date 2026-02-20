import { useState, useCallback } from 'react';
import { usePosts } from '../hooks/useApi';
import { useGlobalFeedUpdates } from '../hooks/useRealtimeUpdates';
import { PostList } from '../components/feed/PostList';
import { FeedControls } from '../components/feed/FeedControls';
import { NewPostsIndicator } from '../components/feed/NewPostsIndicator';

export function Explore() {
  const [sort, setSort] = useState<'hot' | 'new' | 'top'>('hot');

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = usePosts({ sort });

  useGlobalFeedUpdates();

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const posts = data?.pages.flatMap((page) => page.data) || [];

  return (
    <div>
      <h1 className="text-lg font-semibold mb-3">Explore</h1>
      <FeedControls sort={sort} onSortChange={setSort} />
      <NewPostsIndicator hiveId={null} onRefresh={handleRefresh} className="mb-3" />
      <PostList
        posts={posts}
        isLoading={isLoading}
        isFetchingNextPage={isFetchingNextPage}
        hasNextPage={hasNextPage}
        fetchNextPage={fetchNextPage}
        emptyMessage="No posts yet. Be the first to post something!"
      />
    </div>
  );
}
