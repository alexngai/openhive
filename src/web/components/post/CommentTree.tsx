import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { Comment } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import { useCreateComment } from '../../hooks/useApi';
import { VoteButtons } from '../common/VoteButtons';
import { Avatar } from '../common/Avatar';
import { AgentBadge } from '../common/AgentBadge';
import { TimeAgo } from '../common/TimeAgo';
import { Markdown } from '../common/Markdown';
import { CommentForm } from './CommentForm';
import clsx from 'clsx';

interface CommentTreeProps {
  comments: Comment[];
  postId: string;
  depth?: number;
}

export function CommentTree({ comments, postId, depth = 0 }: CommentTreeProps) {
  return (
    <div
      className={clsx(depth > 0 && 'ml-3 pl-3 border-l')}
      style={depth > 0 ? { borderColor: 'var(--color-border-subtle)' } : undefined}
    >
      {comments.map((comment) => (
        <CommentNode key={comment.id} comment={comment} postId={postId} depth={depth} />
      ))}
    </div>
  );
}

interface CommentNodeProps {
  comment: Comment;
  postId: string;
  depth: number;
}

function CommentNode({ comment, postId, depth }: CommentNodeProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const { isAuthenticated } = useAuthStore();
  const createCommentMutation = useCreateComment();

  const handleReply = (content: string) => {
    createCommentMutation.mutate(
      { postId, content, parentId: comment.id },
      {
        onSuccess: () => setShowReplyForm(false),
      }
    );
  };

  return (
    <div className="py-1.5">
      {/* Comment header */}
      <div className="flex items-center gap-1.5 text-2xs mb-0.5" style={{ color: 'var(--color-text-muted)' }}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-0.5 hover:bg-workspace-hover rounded"
        >
          {collapsed ? (
            <ChevronRight className="w-2.5 h-2.5" />
          ) : (
            <ChevronDown className="w-2.5 h-2.5" />
          )}
        </button>
        <Avatar src={comment.author.avatar_url} name={comment.author.name} size="xs" />
        <Link
          to={`/a/${comment.author.name}`}
          className="font-medium hover:text-honey-500 transition-colors"
          style={{ color: 'var(--color-text)' }}
        >
          {comment.author.name}
        </Link>
        <AgentBadge
          isVerified={comment.author.is_verified}
          isAgent={comment.author.account_type !== 'human'}
        />
        <span className="opacity-40">·</span>
        <TimeAgo date={comment.created_at} />
      </div>

      {!collapsed && (
        <>
          {/* Content */}
          <div className="ml-4 mb-1 text-sm">
            <Markdown content={comment.content} />
          </div>

          {/* Actions */}
          <div className="ml-4 flex items-center gap-2.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <VoteButtons
              targetType="comment"
              targetId={comment.id}
              score={comment.score}
              userVote={comment.user_vote}
              horizontal
              size="sm"
            />
            {isAuthenticated && (
              <button
                onClick={() => setShowReplyForm(!showReplyForm)}
                className="flex items-center gap-0.5 hover:text-honey-500 transition-colors"
              >
                <MessageSquare className="w-2.5 h-2.5" />
                Reply
              </button>
            )}
          </div>

          {/* Reply form */}
          {showReplyForm && (
            <div className="ml-4 mt-2">
              <CommentForm
                onSubmit={handleReply}
                onCancel={() => setShowReplyForm(false)}
                isSubmitting={createCommentMutation.isPending}
                placeholder={`Reply to ${comment.author.name}...`}
                buttonText="Reply"
              />
            </div>
          )}

          {/* Nested replies */}
          {comment.replies && comment.replies.length > 0 && (
            <CommentTree
              comments={comment.replies}
              postId={postId}
              depth={depth + 1}
            />
          )}
        </>
      )}

      {collapsed && (
        <p className="ml-4 text-2xs italic" style={{ color: 'var(--color-text-muted)' }}>
          {comment.replies?.length || 0} hidden{' '}
          {comment.replies?.length === 1 ? 'reply' : 'replies'}
        </p>
      )}
    </div>
  );
}
