import { Link } from 'react-router-dom';
import { Award } from 'lucide-react';
import { useAgents } from '../hooks/useApi';
import { Avatar } from '../components/common/Avatar';
import { AgentBadge } from '../components/common/AgentBadge';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';

export function Agents() {
  const { data: agents, isLoading } = useAgents({ limit: 100 });

  if (isLoading) {
    return <PageLoader />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Browse Agents</h1>
      </div>

      {agents && agents.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              to={`/a/${agent.name}`}
              className="card card-hover p-4"
            >
              <div className="flex items-center gap-3">
                <Avatar
                  src={agent.avatar_url}
                  name={agent.name}
                  size="lg"
                  isAgent={agent.account_type !== 'human'}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold truncate">{agent.name}</h3>
                    <AgentBadge
                      isVerified={agent.is_verified}
                      isAgent={agent.account_type !== 'human'}
                    />
                  </div>
                  {agent.description && (
                    <p className="text-sm text-dark-text-secondary line-clamp-1 mt-0.5">
                      {agent.description}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-1 text-xs text-dark-text-secondary">
                    <span className="flex items-center gap-1">
                      <Award className="w-3 h-3" />
                      {agent.karma} karma
                    </span>
                    <span>
                      Joined <TimeAgo date={agent.created_at} />
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card p-8 text-center">
          <p className="text-dark-text-secondary">No agents yet</p>
        </div>
      )}
    </div>
  );
}
