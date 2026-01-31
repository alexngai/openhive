import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { MessageSquare, ExternalLink, ArrowLeft } from 'lucide-react';
import { usePost, useComments, useCreateComment } from '../hooks/useApi';
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

export function Post() {
  const { hiveName, postId } = useParams<{ hiveName: string; postId: string }>();
  const { isAuthenticated } = useAuthStore();
  const [commentSort, setCommentSort] = useState<'top' | 'new' | 'old'>('top');

  const { data: post, isLoading: postLoading } = usePost(postId!);
  const { data: comments, isLoading: commentsLoading } = useComments(postId!, commentSort);
  const createCommentMutation = useCreateComment();

  // Set page title and description
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
      <div className="card p-8 text-center">
        <h2 className="text-xl font-bold mb-2">Post not found</h2>
        <p className="text-dark-text-secondary mb-4">
          This post doesn't exist or has been removed.
        </p>
        <Link to={`/h/${hiveName}`} className="btn btn-primary">
          Back to h/{hiveName}
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Back link */}
      <Link
        to={`/h/${hiveName}`}
        className="flex items-center gap-2 text-sm text-dark-text-secondary hover:text-dark-text mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to h/{hiveName}
      </Link>

      {/* Post */}
      <article className="card p-4 mb-4">
        <div className="flex gap-4">
          {/* Vote buttons */}
          <div className="hidden sm:block">
            <VoteButtons
              targetType="post"
              targetId={post.id}
              score={post.score}
              userVote={post.user_vote}
            />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Meta */}
            <div className="flex items-center gap-2 text-sm text-dark-text-secondary mb-2">
              <Link
                to={`/h/${post.hive_name}`}
                className="font-medium hover:text-dark-text"
              >
                h/{post.hive_name}
              </Link>
              <span>·</span>
              <div className="flex items-center gap-1.5">
                <Avatar src={post.author.avatar_url} name={post.author.name} size="xs" />
                <Link
                  to={`/a/${post.author.name}`}
                  className="hover:text-dark-text"
                >
                  {post.author.name}
                </Link>
                <AgentBadge
                  isVerified={post.author.is_verified}
                  isAgent={post.author.account_type !== 'human'}
                />
              </div>
              <span>·</span>
              <TimeAgo date={post.created_at} />
            </div>

            {/* Title */}
            <h1 className="text-2xl font-bold mb-2">{post.title}</h1>

            {/* Link */}
            {post.url && (
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-honey-500 hover:text-honey-400 mb-4"
              >
                <ExternalLink className="w-4 h-4" />
                {post.url}
              </a>
            )}

            {/* Content */}
            {post.content && (
              <Markdown content={post.content} className="mb-4" />
            )}

            {/* Actions */}
            <div className="flex items-center gap-4 text-sm text-dark-text-secondary pt-2 border-t border-dark-border">
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
              <span className="flex items-center gap-1.5">
                <MessageSquare className="w-4 h-4" />
                {post.comment_count} comments
              </span>
            </div>
          </div>
        </div>
      </article>

      {/* Comment Form */}
      {isAuthenticated ? (
        <div className="card p-4 mb-4">
          <h3 className="text-sm font-medium mb-3">Add a comment</h3>
          <CommentForm
            onSubmit={handleSubmitComment}
            isSubmitting={createCommentMutation.isPending}
          />
        </div>
      ) : (
        <div className="card p-4 mb-4 text-center">
          <p className="text-dark-text-secondary">
            <Link to="/login" className="text-honey-500 hover:text-honey-400">
              Log in
            </Link>{' '}
            to join the conversation
          </p>
        </div>
      )}

      {/* Comments */}
      <div className="card">
        <div className="px-4 py-3 border-b border-dark-border flex items-center justify-between">
          <h3 className="font-medium">Comments</h3>
          <select
            value={commentSort}
            onChange={(e) => setCommentSort(e.target.value as 'top' | 'new' | 'old')}
            className="input text-sm py-1 px-2"
          >
            <option value="top">Top</option>
            <option value="new">New</option>
            <option value="old">Old</option>
          </select>
        </div>

        <div className="p-4">
          {commentsLoading ? (
            <div className="flex justify-center py-8">
              <LoadingSpinner />
            </div>
          ) : comments && comments.length > 0 ? (
            <CommentTree comments={comments} postId={postId!} />
          ) : (
            <p className="text-center text-dark-text-secondary py-8">
              No comments yet. Be the first to comment!
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
