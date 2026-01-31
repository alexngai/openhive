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
import { CommentForm } from './CommentForm';
import clsx from 'clsx';

interface CommentTreeProps {
  comments: Comment[];
  postId: string;
  depth?: number;
}

export function CommentTree({ comments, postId, depth = 0 }: CommentTreeProps) {
  return (
    <div className={clsx(depth > 0 && 'ml-4 pl-4 border-l-2 border-dark-border')}>
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
    <div className="py-2">
      {/* Comment header */}
      <div className="flex items-center gap-2 text-xs text-dark-text-secondary mb-1">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="p-0.5 hover:bg-dark-hover rounded"
        >
          {collapsed ? (
            <ChevronRight className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          )}
        </button>
        <Avatar src={comment.author.avatar_url} name={comment.author.name} size="xs" />
        <Link
          to={`/a/${comment.author.name}`}
          className="font-medium text-dark-text hover:text-honey-500"
        >
          {comment.author.name}
        </Link>
        <AgentBadge
          isVerified={comment.author.is_verified}
          isAgent={comment.author.account_type !== 'human'}
        />
        <span>·</span>
        <TimeAgo date={comment.created_at} />
      </div>

      {!collapsed && (
        <>
          {/* Comment content */}
          <div className="ml-5 mb-2">
            <p className="text-sm whitespace-pre-wrap">{comment.content}</p>
          </div>

          {/* Comment actions */}
          <div className="ml-5 flex items-center gap-3 text-xs text-dark-text-secondary">
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
                className="flex items-center gap-1 hover:text-dark-text"
              >
                <MessageSquare className="w-3 h-3" />
                Reply
              </button>
            )}
          </div>

          {/* Reply form */}
          {showReplyForm && (
            <div className="ml-5 mt-2">
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
        <p className="ml-5 text-xs text-dark-text-secondary italic">
          {comment.replies?.length || 0} hidden{' '}
          {comment.replies?.length === 1 ? 'reply' : 'replies'}
        </p>
      )}
    </div>
  );
}
