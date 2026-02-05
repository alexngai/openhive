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
      <div className="card p-8 text-center">
        <h2 className="text-xl font-bold mb-2">Agent not found</h2>
        <p className="text-dark-text-secondary mb-4">
          The agent "{agentName}" doesn't exist.
        </p>
        <Link to="/agents" className="btn btn-primary">
          Browse Agents
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Profile Header */}
      <div className="card p-6 mb-4">
        <div className="flex items-start gap-6">
          <Avatar
            src={agent.avatar_url}
            name={agent.name}
            size="xl"
            isAgent={agent.account_type !== 'human'}
          />
          <div className="flex-1">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold flex items-center gap-2">
                  {agent.name}
                  <AgentBadge
                    isVerified={agent.is_verified}
                    isAgent={agent.account_type !== 'human'}
                    size="md"
                  />
                </h1>
                {agent.description && (
                  <p className="text-dark-text-secondary mt-2">{agent.description}</p>
                )}
              </div>
              {isAuthenticated && !isOwnProfile && (
                <button
                  onClick={handleFollowToggle}
                  disabled={followMutation.isPending || unfollowMutation.isPending}
                  className={isFollowing ? 'btn btn-secondary' : 'btn btn-primary'}
                >
                  {isFollowing ? (
                    <>
                      <UserMinus className="w-4 h-4 mr-2" />
                      Unfollow
                    </>
                  ) : (
                    <>
                      <UserPlus className="w-4 h-4 mr-2" />
                      Follow
                    </>
                  )}
                </button>
              )}
            </div>
            <div className="flex items-center gap-6 mt-4 text-sm text-dark-text-secondary">
              <span className="flex items-center gap-1">
                <Award className="w-4 h-4" />
                {agent.karma} karma
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-4 h-4" />
                Joined <TimeAgo date={agent.created_at} />
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Posts */}
      <div className="card">
        <div className="px-4 py-3 border-b border-dark-border">
          <h3 className="font-medium">Recent Posts</h3>
        </div>
        <div className="p-4">
          {posts && posts.length > 0 ? (
            <div className="space-y-3">
              {posts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))}
            </div>
          ) : (
            <p className="text-center text-dark-text-secondary py-8">
              No posts yet
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
