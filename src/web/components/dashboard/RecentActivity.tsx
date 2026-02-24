import { useCallback, useMemo } from 'react';
import {
  Zap, Globe, Users, Database, Wrench, Square, Activity,
} from 'lucide-react';
import { useSubscribe, useWSEvent } from '../../hooks/useWebSocket';
import { useDashboardStore, type ActivityItem } from '../../stores/dashboard';
import { TimeAgo } from '../common/TimeAgo';

const EVENT_CONFIG: Record<string, { icon: React.ElementType; format: (data: Record<string, unknown>) => string }> = {
  swarm_registered:   { icon: Globe,    format: (d) => `Swarm "${d.name || d.swarm_id || 'unknown'}" registered` },
  swarm_offline:      { icon: Square,   format: (d) => `Swarm "${d.name || d.swarm_id || 'unknown'}" went offline` },
  node_registered:    { icon: Users,    format: (d) => `Agent "${d.name || d.node_id || 'unknown'}" joined a swarm` },
  node_state_changed: { icon: Activity, format: (d) => `Agent "${d.name || d.node_id || 'unknown'}" → ${d.state || 'unknown'}` },
  swarm_spawned:      { icon: Zap,      format: (d) => `Hosted swarm "${d.name || d.id || 'unknown'}" spawned` },
  swarm_stopped:      { icon: Square,   format: (d) => `Hosted swarm "${d.name || d.id || 'unknown'}" stopped` },
  'memory:sync':      { icon: Database, format: (d) => `Memory synced${d.resource_id ? ` (${d.resource_id})` : ''}` },
  'skill:sync':       { icon: Wrench,   format: (d) => `Skill synced${d.resource_id ? ` (${d.resource_id})` : ''}` },
  resource_updated:   { icon: Database, format: (d) => `Resource "${d.name || d.resource_id || 'unknown'}" updated` },
  resource_created:   { icon: Database, format: (d) => `Resource "${d.name || d.resource_id || 'unknown'}" created` },
};

const EVENT_TYPES = Object.keys(EVENT_CONFIG);

function ActivityRow({ item }: { item: ActivityItem }) {
  const config = EVENT_CONFIG[item.type];
  const Icon = config?.icon || Activity;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md">
      <Icon className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
      <span className="text-xs truncate flex-1">{item.message}</span>
      <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
        <TimeAgo date={item.timestamp} />
      </span>
    </div>
  );
}

export function RecentActivity() {
  const activities = useDashboardStore((s) => s.activities);
  const addActivity = useDashboardStore((s) => s.addActivity);

  const channels = useMemo(() => ['global', 'map:discovery'], []);
  useSubscribe(channels);

  const handleEvent = useCallback((event: string) => {
    return (data: unknown) => {
      const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      const eventData = (d.data && typeof d.data === 'object' ? d.data : d) as Record<string, unknown>;
      const config = EVENT_CONFIG[event];
      if (!config) return;

      addActivity({
        id: `${event}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: event,
        message: config.format(eventData),
        timestamp: new Date().toISOString(),
      });
    };
  }, [addActivity]);

  // Register a listener for each event type
  // We need individual useWSEvent calls since each needs its own stable callback
  const handlers = useMemo(() =>
    EVENT_TYPES.reduce((acc, event) => {
      acc[event] = handleEvent(event);
      return acc;
    }, {} as Record<string, (data: unknown) => void>),
    [handleEvent]
  );

  useWSEvent('swarm_registered', handlers.swarm_registered);
  useWSEvent('swarm_offline', handlers.swarm_offline);
  useWSEvent('node_registered', handlers.node_registered);
  useWSEvent('node_state_changed', handlers.node_state_changed);
  useWSEvent('swarm_spawned', handlers.swarm_spawned);
  useWSEvent('swarm_stopped', handlers.swarm_stopped);
  useWSEvent('memory:sync', handlers['memory:sync']);
  useWSEvent('skill:sync', handlers['skill:sync']);
  useWSEvent('resource_updated', handlers.resource_updated);
  useWSEvent('resource_created', handlers.resource_created);

  return (
    <div className="card p-4">
      <h2 className="text-xs font-semibold mb-3" style={{ color: 'var(--color-text-secondary)' }}>Recent Activity</h2>

      {activities.length === 0 ? (
        <p className="text-xs text-center py-4" style={{ color: 'var(--color-text-muted)' }}>
          No recent activity. Events will appear here in real-time.
        </p>
      ) : (
        <div className="space-y-0.5 max-h-64 overflow-y-auto">
          {activities.slice(0, 20).map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
