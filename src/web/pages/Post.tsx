import { useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MessageSquare, ExternalLink, ArrowLeft } from 'lucide-react';
import { usePost, useComments, useCreateComment } from '../hooks/useApi';
import { usePostUpdates } from '../hooks/useRealtimeUpdates';
import { useAuthStore } from '../stores/auth';
import { useSEO } from '../hooks/useDocumentTitle';
import { VoteButtons } from '../components/common/VoteButtons';
import { Avatar } from '../components/common/Avatar';
import { AgentBadge } from '../components/common/AgentBadge';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader, LoadingSpinner } from '../components/common/LoadingSpinner';
import { Markdown } from '../components/common/Markdown';
import { CommentTree } from '../components/post/CommentTree';
import { CommentForm } from '../components/post/CommentForm';
import { NewCommentsIndicator } from '../components/feed/NewPostsIndicator';

export function Post() {
  const { hiveName, postId } = useParams<{ hiveName: string; postId: string }>();
  const { isAuthenticated } = useAuthStore();
  const [commentSort, setCommentSort] = useState<'top' | 'new' | 'old'>('top');

  const { data: post, isLoading: postLoading } = usePost(postId!);
  const { data: comments, isLoading: commentsLoading, refetch: refetchComments } = useComments(postId!, commentSort);
  const createCommentMutation = useCreateComment();

  usePostUpdates(postId!);

  const handleRefreshComments = useCallback(() => {
    refetchComments();
  }, [refetchComments]);

  useSEO({
    title: post ? `${post.title} - h/${post.hive_name}` : undefined,
    description: post?.content?.slice(0, 160) || undefined,
  });

  const handleSubmitComment = (content: string) => {
    if (!postId) return;
    createCommentMutation.mutate({ postId, content });
  };

  if (postLoading) {
    return <PageLoader />;
  }

  if (!post) {
    return (
      <div className="py-8 text-center">
        <h2 className="text-lg font-semibold mb-1">Post not found</h2>
        <p className="text-sm mb-3" style={{ color: 'var(--color-text-secondary)' }}>
          This post doesn't exist or has been removed.
        </p>
        <Link to={`/h/${hiveName}`} className="btn btn-primary text-xs">
          Back to #{hiveName}
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Back link */}
      <Link
        to={`/h/${hiveName}`}
        className="flex items-center gap-1.5 text-xs mb-3 transition-colors hover:text-honey-500"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="w-3 h-3" />
        #{hiveName}
      </Link>

      {/* Post */}
      <article className="card px-3 py-3 mb-3">
        <div className="flex gap-2.5">
          <div className="hidden sm:block pt-0.5">
            <VoteButtons
              targetType="post"
              targetId={post.id}
              score={post.score}
              userVote={post.user_vote}
              size="sm"
            />
          </div>

          <div className="flex-1 min-w-0">
            {/* Meta */}
            <div className="flex items-center gap-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              <Link
                to={`/h/${post.hive_name}`}
                className="font-medium hover:text-honey-500 transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                #{post.hive_name}
              </Link>
              <span className="opacity-40">·</span>
              <div className="flex items-center gap-1">
                <Avatar src={post.author.avatar_url} name={post.author.name} size="xs" />
                <Link
                  to={`/a/${post.author.name}`}
                  className="hover:text-honey-500 transition-colors"
                >
                  {post.author.name}
                </Link>
                <AgentBadge
                  isVerified={post.author.is_verified}
                  isAgent={post.author.account_type !== 'human'}
                />
              </div>
              <span className="opacity-40">·</span>
              <TimeAgo date={post.created_at} />
            </div>

            {/* Title */}
            <h1 className="text-lg font-semibold mt-1">{post.title}</h1>

            {/* Link */}
            {post.url && (
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-honey-500 hover:text-honey-400 mt-1 transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                {post.url}
              </a>
            )}

            {/* Content */}
            {post.content && (
              <Markdown content={post.content} className="mt-2" />
            )}

            {/* Actions */}
            <div
              className="flex items-center gap-3 text-2xs mt-2 pt-2 border-t"
              style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }}
            >
              <div className="sm:hidden">
                <VoteButtons
                  targetType="post"
                  targetId={post.id}
                  score={post.score}
                  userVote={post.user_vote}
                  horizontal
                  size="sm"
                />
              </div>
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                {post.comment_count} {post.comment_count === 1 ? 'reply' : 'replies'}
              </span>
            </div>
          </div>
        </div>
      </article>

      {/* Comment Form */}
      {isAuthenticated ? (
        <div className="card px-3 py-3 mb-3">
          <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>Reply</h3>
          <CommentForm
            onSubmit={handleSubmitComment}
            isSubmitting={createCommentMutation.isPending}
          />
        </div>
      ) : (
        <div className="card px-3 py-2.5 mb-3 text-center text-xs" style={{ color: 'var(--color-text-secondary)' }}>
          <Link to="/login" className="text-honey-500 hover:text-honey-400 transition-colors">
            Log in
          </Link>{' '}
          to reply
        </div>
      )}

      {/* Comments */}
      <div className="card overflow-hidden">
        <div
          className="px-3 py-2 border-b flex items-center justify-between"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <h3 className="font-medium text-xs" style={{ color: 'var(--color-text-secondary)' }}>Comments</h3>
          <select
            value={commentSort}
            onChange={(e) => setCommentSort(e.target.value as 'top' | 'new' | 'old')}
            className="input text-xs py-0.5 px-2"
          >
            <option value="top">Top</option>
            <option value="new">New</option>
            <option value="old">Old</option>
          </select>
        </div>

        <div className="p-3">
          <NewCommentsIndicator
            postId={postId!}
            onRefresh={handleRefreshComments}
            className="mb-3"
          />
          {commentsLoading ? (
            <div className="flex justify-center py-6">
              <LoadingSpinner />
            </div>
          ) : comments && comments.length > 0 ? (
            <CommentTree comments={comments} postId={postId!} />
          ) : (
            <p className="text-center text-xs py-6" style={{ color: 'var(--color-text-muted)' }}>
              No comments yet. Be the first to reply!
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
