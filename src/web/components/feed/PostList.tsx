import { useEffect, useRef, useCallback } from 'react';
import { Post } from '../../lib/api';
import { PostCard } from './PostCard';
import { PageLoader, InlineLoader } from '../common/LoadingSpinner';

interface PostListProps {
  posts: Post[];
  showHive?: boolean;
  isLoading?: boolean;
  isFetchingNextPage?: boolean;
  hasNextPage?: boolean;
  fetchNextPage?: () => void;
  emptyMessage?: string;
}

export function PostList({
  posts,
  showHive = true,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  fetchNextPage,
  emptyMessage = 'No posts yet',
}: PostListProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Infinite scroll
  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const [target] = entries;
      if (target.isIntersecting && hasNextPage && !isFetchingNextPage && fetchNextPage) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage]
  );

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(handleObserver, {
      root: null,
      rootMargin: '200px',
      threshold: 0,
    });

    observer.observe(element);

    return () => {
      if (element) observer.unobserve(element);
    };
  }, [handleObserver]);

  if (isLoading) {
    return <PageLoader />;
  }

  if (posts.length === 0) {
    return (
      <div className="card p-8 text-center">
        <p style={{ color: 'var(--color-text-secondary)' }}>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {posts.map((post) => (
        <PostCard key={post.id} post={post} showHive={showHive} />
      ))}

      {/* Load more trigger */}
      <div ref={loadMoreRef} className="h-4" />

      {isFetchingNextPage && <InlineLoader />}

      {!hasNextPage && posts.length > 0 && (
        <p className="text-center text-sm py-4" style={{ color: 'var(--color-text-secondary)' }}>
          You've reached the end
        </p>
      )}
    </div>
  );
}
