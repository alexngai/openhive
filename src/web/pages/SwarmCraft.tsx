import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { SwarmCraftApp } from 'swarmcraft/ui/embed';
import 'swarmcraft/ui/embed.css';
import { useMapSwarms, useSessionsList } from '../hooks/useApi';
import { Activity, Zap, Brain, Wrench, ListTodo } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

// Derive API/WS URLs relative to current host (works in dev proxy and production)
function useSwarmCraftConfig() {
  return useMemo(() => ({
    apiUrl: '/api/swarmcraft',
    wsUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/swarmcraft`,
  }), []);
}

function BridgeStatusBar() {
  const { data: mapSwarms } = useMapSwarms();
  const { data: sessions } = useSessionsList();
  const { data: memoryRes } = useQuery({
    queryKey: ['resources-memory-count'],
    queryFn: () => api.get('/resources?type=memory_bank&limit=1'),
    select: (d: { total?: number }) => d.total ?? 0,
    staleTime: 30_000,
  });
  const { data: skillRes } = useQuery({
    queryKey: ['resources-skill-count'],
    queryFn: () => api.get('/resources?type=skill&limit=1'),
    select: (d: { total?: number }) => d.total ?? 0,
    staleTime: 30_000,
  });
  const { data: taskRes } = useQuery({
    queryKey: ['resources-task-count'],
    queryFn: () => api.get('/resources?type=task&limit=1'),
    select: (d: { total?: number }) => d.total ?? 0,
    staleTime: 30_000,
  });

  const onlineSwarms = mapSwarms?.filter(s => s.status === 'online').length ?? 0;
  const totalSwarms = mapSwarms?.length ?? 0;
  const sessionCount = sessions?.total ?? 0;

  return (
    <div
      className="flex items-center gap-4 px-4 py-2 text-2xs border-b shrink-0"
      style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-surface)', color: 'var(--color-text-muted)' }}
    >
      <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>Data Sources</span>
      <Link to="/swarms" className="flex items-center gap-1 hover:text-honey-500 transition-colors">
        <Zap className="w-3 h-3" />
        <span>{onlineSwarms}/{totalSwarms} swarms</span>
      </Link>
      <Link to="/sessions" className="flex items-center gap-1 hover:text-honey-500 transition-colors">
        <Activity className="w-3 h-3" />
        <span>{sessionCount} sessions</span>
      </Link>
      {(memoryRes ?? 0) > 0 && (
        <Link to="/memory" className="flex items-center gap-1 hover:text-honey-500 transition-colors">
          <Brain className="w-3 h-3" />
          <span>{memoryRes} memories</span>
        </Link>
      )}
      {(skillRes ?? 0) > 0 && (
        <Link to="/skills" className="flex items-center gap-1 hover:text-honey-500 transition-colors">
          <Wrench className="w-3 h-3" />
          <span>{skillRes} skills</span>
        </Link>
      )}
      {(taskRes ?? 0) > 0 && (
        <Link to="/tasks" className="flex items-center gap-1 hover:text-honey-500 transition-colors">
          <ListTodo className="w-3 h-3" />
          <span>{taskRes} tasks</span>
        </Link>
      )}
    </div>
  );
}

export function SwarmCraft() {
  const config = useSwarmCraftConfig();
  return (
    <div className="flex flex-col h-full">
      <BridgeStatusBar />
      <div className="flex-1 min-h-0">
        <SwarmCraftApp config={config} autoConnect defaultPanelOpen />
      </div>
    </div>
  );
}
