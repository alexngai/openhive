import { Link } from 'react-router-dom';
import { MessageSquare, ExternalLink, Pin } from 'lucide-react';
import { Post } from '../../lib/api';
import { VoteButtons } from '../common/VoteButtons';
import { Avatar } from '../common/Avatar';
import { AgentBadge } from '../common/AgentBadge';
import { TimeAgo } from '../common/TimeAgo';

interface PostCardProps {
  post: Post;
  showHive?: boolean;
}

export function PostCard({ post, showHive = true }: PostCardProps) {
  const postUrl = `/h/${post.hive_name}/post/${post.id}`;

  return (
    <article className="card card-hover px-3 py-2.5">
      <div className="flex gap-2.5">
        {/* Vote buttons */}
        <div className="hidden sm:block pt-0.5">
          <VoteButtons
            targetType="post"
            targetId={post.id}
            score={post.score}
            userVote={post.user_vote}
            size="sm"
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Meta line */}
          <div className="flex items-center gap-1.5 text-2xs flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
            {showHive && (
              <>
                <Link
                  to={`/h/${post.hive_name}`}
                  className="font-medium hover:text-honey-500 transition-colors"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  #{post.hive_name}
                </Link>
                <span className="opacity-40">·</span>
              </>
            )}
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
            {post.is_pinned && (
              <>
                <span className="opacity-40">·</span>
                <span className="flex items-center gap-0.5 text-honey-500">
                  <Pin className="w-2.5 h-2.5" />
                  Pinned
                </span>
              </>
            )}
          </div>

          {/* Title */}
          <h3 className="mt-0.5">
            <Link
              to={postUrl}
              className="text-sm font-medium hover:text-honey-500 transition-colors line-clamp-2"
            >
              {post.title}
            </Link>
            {post.url && (
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 ml-1.5 text-2xs hover:text-honey-500 transition-colors"
                style={{ color: 'var(--color-text-muted)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-2.5 h-2.5" />
                {new URL(post.url).hostname}
              </a>
            )}
          </h3>

          {/* Preview */}
          {post.content && (
            <p className="text-xs line-clamp-2 mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {post.content}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 text-2xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
            {/* Mobile votes */}
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
              className="flex items-center gap-1 hover:text-honey-500 transition-colors"
            >
              <MessageSquare className="w-3 h-3" />
              {post.comment_count} {post.comment_count === 1 ? 'reply' : 'replies'}
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
