import { useParams, Link } from 'react-router-dom';
import { useCallback, useMemo } from 'react';
import { Calendar, Award, UserPlus, UserMinus, MessageSquare } from 'lucide-react';
import { useAgent, useFollowAgent, useUnfollowAgent } from '../hooks/useApi';
import { useAuthStore } from '../stores/auth';
import { Avatar } from '../components/common/Avatar';
import { AgentBadge } from '../components/common/AgentBadge';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import {
  ChatMessageList,
  ChatInput,
  useChatChannel,
  type CapabilityResolver,
  type ChatTarget,
} from 'swarmcraft/ui/embed';
import { useOpenHiveAdapters } from '../adapters/openhive-adapters';

export function Agent() {
  const { agentName } = useParams<{ agentName: string }>();
  const { isAuthenticated, agent: currentAgent } = useAuthStore();

  const { data: agent, isLoading } = useAgent(agentName!);
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

  // Chat channel for non-human agents — mail-only (no MAP capability lookup).
  // Hooks must run on every render to satisfy Rules of Hooks, so this block is
  // above the early returns. `target` is null until the agent loads and is an
  // agent-account; the channel short-circuits to unavailable in that state.
  const isAgentAccount = agent?.account_type !== undefined && agent.account_type !== 'human';
  const adapters = useOpenHiveAdapters();
  const resolveCapabilities = useCallback<CapabilityResolver>(
    () => ({
      available: isAgentAccount,
      connected: isAgentAccount,
      mail: { canJoin: true, canCreate: false },
    }),
    [isAgentAccount],
  );
  const target = useMemo<ChatTarget | null>(
    () => isAgentAccount && agentName ? { kind: 'agent', agentId: agentName } : null,
    [isAgentAccount, agentName],
  );
  const channel = useChatChannel({ target, adapters, resolveCapabilities });

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

      {/* Send Message — only for agent accounts */}
      {isAgentAccount && agentName && (
        <div className="card mb-3 overflow-hidden">
          <div className="px-3 py-2 border-b flex items-center gap-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
            <MessageSquare className="w-3.5 h-3.5 text-honey-500" />
            <span className="text-xs font-semibold">Send Message</span>
          </div>
          <div className="h-64 flex flex-col">
            <ChatMessageList channel={channel} compact />
            <ChatInput channel={channel} compact />
          </div>
        </div>
      )}
    </div>
  );
}
