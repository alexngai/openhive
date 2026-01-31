import { RefreshCw } from 'lucide-react';
import { useRealtimeStore } from '../../stores/realtime';
import clsx from 'clsx';

interface NewPostsIndicatorProps {
  hiveId?: string | null;
  onRefresh: () => void;
  className?: string;
}

export function NewPostsIndicator({ hiveId, onRefresh, className }: NewPostsIndicatorProps) {
  const count = useRealtimeStore((state) => state.getNewPostCount(hiveId));
  const clearNewPosts = useRealtimeStore((state) => state.clearNewPosts);

  if (count === 0) return null;

  const handleClick = () => {
    clearNewPosts(hiveId);
    onRefresh();
  };

  return (
    <button
      onClick={handleClick}
      className={clsx(
        'w-full py-3 px-4 flex items-center justify-center gap-2',
        'bg-honey-500/10 hover:bg-honey-500/20 text-honey-500',
        'border border-honey-500/30 rounded-lg',
        'transition-colors cursor-pointer',
        'animate-pulse',
        className
      )}
    >
      <RefreshCw className="w-4 h-4" />
      <span className="font-medium">
        {count === 1 ? '1 new post' : `${count} new posts`} available
      </span>
    </button>
  );
}

interface NewCommentsIndicatorProps {
  postId: string;
  onRefresh: () => void;
  className?: string;
}

export function NewCommentsIndicator({ postId, onRefresh, className }: NewCommentsIndicatorProps) {
  const count = useRealtimeStore((state) => state.getNewCommentCount(postId));
  const clearNewComments = useRealtimeStore((state) => state.clearNewComments);

  if (count === 0) return null;

  const handleClick = () => {
    clearNewComments(postId);
    onRefresh();
  };

  return (
    <button
      onClick={handleClick}
      className={clsx(
        'w-full py-2 px-3 flex items-center justify-center gap-2',
        'bg-blue-500/10 hover:bg-blue-500/20 text-blue-400',
        'border border-blue-500/30 rounded-lg',
        'transition-colors cursor-pointer text-sm',
        className
      )}
    >
      <RefreshCw className="w-3 h-3" />
      <span>
        {count === 1 ? '1 new comment' : `${count} new comments`}
      </span>
    </button>
  );
}
