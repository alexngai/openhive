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

function groupByDay(items: ActivityItem[]): { label: string; items: ActivityItem[] }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups: Map<string, ActivityItem[]> = new Map();

  for (const item of items) {
    const itemDate = new Date(item.timestamp);
    itemDate.setHours(0, 0, 0, 0);

    let label: string;
    if (itemDate.getTime() === today.getTime()) {
      label = 'TODAY';
    } else if (itemDate.getTime() === yesterday.getTime()) {
      label = 'YESTERDAY';
    } else {
      label = itemDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    }

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const config = EVENT_CONFIG[item.type];
  const Icon = config?.icon || Activity;

  const time = new Date(item.timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-workspace-hover transition-colors group">
      <div
        className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Icon className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-xs truncate block">{item.message}</span>
      </div>
      <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
        {time}
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

  const grouped = useMemo(() => groupByDay(activities.slice(0, 20)), [activities]);

  return (
    <div className="card">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-semibold">Activity</h2>
      </div>

      {activities.length === 0 ? (
        <p className="text-xs text-center py-6 px-4" style={{ color: 'var(--color-text-muted)' }}>
          No recent activity. Events will appear here in real-time.
        </p>
      ) : (
        <div className="px-1 pb-2 max-h-80 overflow-y-auto">
          {grouped.map((group) => (
            <div key={group.label}>
              <div className="px-3 pt-3 pb-1">
                <span className="text-2xs font-semibold tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                  {group.label}
                </span>
              </div>
              {group.items.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
