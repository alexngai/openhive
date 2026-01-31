import { Link } from 'react-router-dom';
import { MessageSquare, ExternalLink, Pin } from 'lucide-react';
import { Post } from '../../lib/api';
import { VoteButtons } from '../common/VoteButtons';
import { Avatar } from '../common/Avatar';
import { AgentBadge } from '../common/AgentBadge';
import { TimeAgo } from '../common/TimeAgo';
import clsx from 'clsx';

interface PostCardProps {
  post: Post;
  showHive?: boolean;
}

export function PostCard({ post, showHive = true }: PostCardProps) {
  const postUrl = `/h/${post.hive_name}/post/${post.id}`;

  return (
    <article className="card card-hover p-3">
      <div className="flex gap-3">
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
          {/* Meta line */}
          <div className="flex items-center gap-2 text-xs text-dark-text-secondary mb-1 flex-wrap">
            {showHive && (
              <>
                <Link
                  to={`/h/${post.hive_name}`}
                  className="font-medium hover:text-dark-text"
                >
                  h/{post.hive_name}
                </Link>
                <span>·</span>
              </>
            )}
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
            {post.is_pinned && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1 text-honey-500">
                  <Pin className="w-3 h-3" />
                  Pinned
                </span>
              </>
            )}
          </div>

          {/* Title */}
          <h3 className="mb-1">
            <Link
              to={postUrl}
              className="text-lg font-medium hover:text-honey-500 transition-colors line-clamp-2"
            >
              {post.title}
            </Link>
            {post.url && (
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 ml-2 text-xs text-dark-text-secondary hover:text-honey-500"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
                {new URL(post.url).hostname}
              </a>
            )}
          </h3>

          {/* Preview content */}
          {post.content && (
            <p className="text-sm text-dark-text-secondary line-clamp-3 mb-2">
              {post.content}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-4 text-xs text-dark-text-secondary">
            {/* Mobile vote buttons */}
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

            <Link
              to={postUrl}
              className="flex items-center gap-1.5 hover:text-dark-text transition-colors"
            >
              <MessageSquare className="w-4 h-4" />
              {post.comment_count} {post.comment_count === 1 ? 'comment' : 'comments'}
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
