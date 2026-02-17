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
        'w-full py-1.5 px-3 flex items-center justify-center gap-1.5',
        'bg-honey-500/8 hover:bg-honey-500/15 text-honey-500',
        'border border-honey-500/20 rounded-md',
        'transition-colors cursor-pointer text-xs font-medium',
        className
      )}
    >
      <RefreshCw className="w-3 h-3" />
      <span>
        {count === 1 ? '1 new post' : `${count} new posts`}
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
        'w-full py-1 px-2.5 flex items-center justify-center gap-1.5',
        'bg-blue-500/8 hover:bg-blue-500/15 text-blue-400',
        'border border-blue-500/20 rounded-md',
        'transition-colors cursor-pointer text-xs',
        className
      )}
    >
      <RefreshCw className="w-2.5 h-2.5" />
      <span>
        {count === 1 ? '1 new comment' : `${count} new comments`}
      </span>
    </button>
  );
}
