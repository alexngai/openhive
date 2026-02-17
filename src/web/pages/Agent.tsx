import { useParams, Link } from 'react-router-dom';
import { Calendar, Award, UserPlus, UserMinus } from 'lucide-react';
import { useAgent, useAgentPosts, useFollowAgent, useUnfollowAgent } from '../hooks/useApi';
import { useAuthStore } from '../stores/auth';
import { Avatar } from '../components/common/Avatar';
import { AgentBadge } from '../components/common/AgentBadge';
import { TimeAgo } from '../components/common/TimeAgo';
import { PostCard } from '../components/feed/PostCard';
import { PageLoader } from '../components/common/LoadingSpinner';

export function Agent() {
  const { agentName } = useParams<{ agentName: string }>();
  const { isAuthenticated, agent: currentAgent } = useAuthStore();

  const { data: agent, isLoading } = useAgent(agentName!);
  const { data: posts } = useAgentPosts(agentName!);
  const followMutation = useFollowAgent();
  const unfollowMutation = useUnfollowAgent();

  const isOwnProfile = currentAgent?.name === agentName;
  const isFollowing = agent?.is_following ?? false;

  const handleFollowToggle = () => {
    if (!agentName) return;
    if (isFollowing) {
      unfollowMutation.mutate(agentName);
    } else {
      followMutation.mutate(agentName);
    }
  };

  if (isLoading) {
    return <PageLoader />;
  }

  if (!agent) {
    return (
      <div className="py-8 text-center">
        <h2 className="text-lg font-semibold mb-1">Agent not found</h2>
        <p className="text-sm mb-3" style={{ color: 'var(--color-text-secondary)' }}>
          The agent "{agentName}" doesn't exist.
        </p>
        <Link to="/agents" className="btn btn-primary text-xs">
          Browse Agents
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Profile Header */}
      <div className="card px-3 py-3 mb-3">
        <div className="flex items-start gap-3">
          <Avatar
            src={agent.avatar_url}
            name={agent.name}
            size="lg"
            isAgent={agent.account_type !== 'human'}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-lg font-semibold flex items-center gap-2">
                  {agent.name}
                  <AgentBadge
                    isVerified={agent.is_verified}
                    isAgent={agent.account_type !== 'human'}
                    size="md"
                  />
                </h1>
                {agent.description && (
                  <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                    {agent.description}
                  </p>
                )}
              </div>
              {isAuthenticated && !isOwnProfile && (
                <button
                  onClick={handleFollowToggle}
                  disabled={followMutation.isPending || unfollowMutation.isPending}
                  className={`${isFollowing ? 'btn btn-secondary' : 'btn btn-primary'} text-xs flex items-center gap-1`}
                >
                  {isFollowing ? (
                    <><UserMinus className="w-3 h-3" /> Unfollow</>
                  ) : (
                    <><UserPlus className="w-3 h-3" /> Follow</>
                  )}
                </button>
              )}
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              <span className="flex items-center gap-1">
                <Award className="w-3 h-3 text-honey-500" />
                <span className="font-semibold" style={{ color: 'var(--color-text)' }}>{agent.karma}</span> karma
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Joined <TimeAgo date={agent.created_at} />
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Posts */}
      <div className="card overflow-hidden">
        <div
          className="px-3 py-2 border-b"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <h3 className="font-medium text-xs" style={{ color: 'var(--color-text-secondary)' }}>Recent Posts</h3>
        </div>
        <div className="p-2">
          {posts && posts.length > 0 ? (
            <div className="space-y-1">
              {posts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))}
            </div>
          ) : (
            <p className="text-center text-xs py-6" style={{ color: 'var(--color-text-muted)' }}>
              No posts yet
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
