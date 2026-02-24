import { Link } from 'react-router-dom';
import { Cpu, Globe, ChevronRight } from 'lucide-react';
import { useHostedSwarms, useMapSwarms } from '../../hooks/useApi';
import { HostedStateBadge, MapStatusBadge } from '../swarm/StatusBadges';
import type { HostedSwarm, MapSwarm } from '../../lib/api';

type UnifiedSwarm =
  | { source: 'hosted'; id: string; name: string; state: HostedSwarm['state']; created_at: string }
  | { source: 'map'; id: string; name: string; status: MapSwarm['status']; agent_count: number; created_at: string };

const STATE_PRIORITY: Record<string, number> = {
  running: 0, online: 0,
  starting: 1, provisioning: 1, unhealthy: 2,
  offline: 3, unreachable: 3,
  stopping: 4, stopped: 5, failed: 5,
};

function getStatusKey(s: UnifiedSwarm): string {
  return s.source === 'hosted' ? s.state : s.status;
}

export function SwarmStatusSummary() {
  const { data: hostedSwarms } = useHostedSwarms();
  const { data: mapSwarms } = useMapSwarms();

  const unified: UnifiedSwarm[] = [
    ...(hostedSwarms || []).map((s): UnifiedSwarm => ({
      source: 'hosted', id: s.id, name: s.id, state: s.state, created_at: s.created_at,
    })),
    ...(mapSwarms || []).map((s): UnifiedSwarm => ({
      source: 'map', id: s.id, name: s.name, status: s.status, agent_count: s.agent_count, created_at: s.created_at,
    })),
  ].sort((a, b) => (STATE_PRIORITY[getStatusKey(a)] ?? 9) - (STATE_PRIORITY[getStatusKey(b)] ?? 9))
   .slice(0, 8);

  const total = (hostedSwarms?.length || 0) + (mapSwarms?.length || 0);

  if (total === 0) {
    return (
      <div className="card p-4">
        <h2 className="text-xs font-semibold mb-3" style={{ color: 'var(--color-text-secondary)' }}>Swarm Status</h2>
        <p className="text-xs text-center py-4" style={{ color: 'var(--color-text-muted)' }}>No swarms connected</p>
        <Link to="/swarms" className="text-2xs text-honey-500 hover:text-honey-400 transition-colors">
          Connect a swarm
        </Link>
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>Swarm Status</h2>
        <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>{total} total</span>
      </div>

      <div className="space-y-1">
        {unified.map((swarm) => (
          <div
            key={`${swarm.source}-${swarm.id}`}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-workspace-hover transition-colors"
          >
            {swarm.source === 'hosted' ? (
              <Cpu className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
            ) : (
              <Globe className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
            )}
            <span className="text-xs truncate flex-1">{swarm.name}</span>
            {swarm.source === 'hosted' ? (
              <HostedStateBadge state={swarm.state} />
            ) : (
              <MapStatusBadge status={swarm.status} />
            )}
            <span className="text-2xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
              {swarm.source === 'hosted' ? 'hosted' : 'registered'}
            </span>
          </div>
        ))}
      </div>

      <Link
        to="/swarms"
        className="flex items-center gap-1 mt-3 text-2xs text-honey-500 hover:text-honey-400 transition-colors"
      >
        View all swarms <ChevronRight className="w-3 h-3" />
      </Link>
    </div>
  );
}
