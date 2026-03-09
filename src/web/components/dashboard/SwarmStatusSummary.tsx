import { Link } from 'react-router-dom';
import { Cpu, Globe, ArrowRight, ChevronRight } from 'lucide-react';
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

function SwarmInitial({ name }: { name: string }) {
  return (
    <div
      className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 text-2xs font-semibold uppercase"
      style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
    >
      {name.charAt(0)}
    </div>
  );
}

export function SwarmStatusSummary() {
  const { data: hostedSwarms } = useHostedSwarms();
  const { data: mapSwarms } = useMapSwarms();

  const unified: UnifiedSwarm[] = [
    ...(hostedSwarms || []).map((s): UnifiedSwarm => ({
      source: 'hosted', id: s.id, name: s.name, state: s.state, created_at: s.created_at,
    })),
    ...(mapSwarms || []).map((s): UnifiedSwarm => ({
      source: 'map', id: s.id, name: s.name, status: s.status, agent_count: s.agent_count, created_at: s.created_at,
    })),
  ].sort((a, b) => (STATE_PRIORITY[getStatusKey(a)] ?? 9) - (STATE_PRIORITY[getStatusKey(b)] ?? 9))
   .slice(0, 6);

  const total = (hostedSwarms?.length || 0) + (mapSwarms?.length || 0);

  return (
    <div className="card">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="text-sm font-semibold">Swarms</h2>
        <Link
          to="/swarms"
          className="w-7 h-7 rounded-md flex items-center justify-center transition-colors"
          style={{ border: '1px solid var(--color-border)' }}
        >
          <ArrowRight className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </Link>
      </div>

      {total === 0 ? (
        <div className="px-4 pb-4">
          <p className="text-xs py-4 text-center" style={{ color: 'var(--color-text-muted)' }}>
            No swarms connected
          </p>
          <Link to="/swarms" className="text-2xs text-honey-500 hover:text-honey-400 transition-colors">
            Connect a swarm
          </Link>
        </div>
      ) : (
        <div className="pb-2">
          {unified.map((swarm) => (
            <Link
              key={`${swarm.source}-${swarm.id}`}
              to="/swarms"
              className="flex items-center gap-3 px-4 py-2 hover:bg-workspace-hover transition-colors group"
            >
              <SwarmInitial name={swarm.name} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{swarm.name}</div>
                <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  {swarm.source === 'hosted' ? 'hosted' : `${swarm.agent_count} agents`}
                </div>
              </div>
              <ChevronRight
                className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ color: 'var(--color-text-muted)' }}
              />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
