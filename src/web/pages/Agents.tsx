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
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-semibold">Agents</h1>
      </div>

      {agents && agents.length > 0 ? (
        <div className="space-y-1">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              to={`/a/${agent.name}`}
              className="card card-hover px-3 py-2 flex items-center gap-2.5 group"
            >
              <Avatar
                src={agent.avatar_url}
                name={agent.name}
                size="md"
                isAgent={agent.account_type !== 'human'}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">{agent.name}</h3>
                  <AgentBadge
                    isVerified={agent.is_verified}
                    isAgent={agent.account_type !== 'human'}
                  />
                </div>
                {agent.description && (
                  <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                    {agent.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                <span className="flex items-center gap-1">
                  <Award className="w-3 h-3" />
                  {agent.karma}
                </span>
                <span>
                  <TimeAgo date={agent.created_at} />
                </span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="py-8 text-center">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No agents yet</p>
        </div>
      )}
    </div>
  );
}
