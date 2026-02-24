import { Database, BookOpen, Wrench, MessageSquare } from 'lucide-react';
import { useResources, useSyncStatus } from '../../hooks/useApi';
import { TimeAgo } from '../common/TimeAgo';

const TYPE_ICONS: Record<string, React.ElementType> = {
  memory_bank: Database,
  task: MessageSquare,
  skill: Wrench,
  session: BookOpen,
};

function SyncDot({ lastPushAt }: { lastPushAt: string | null }) {
  if (!lastPushAt) {
    return <span className="w-1.5 h-1.5 rounded-full bg-gray-400 opacity-50 shrink-0" title="Never synced" />;
  }

  const age = Date.now() - new Date(lastPushAt).getTime();
  const isStale = age > 60 * 60 * 1000; // > 1 hour

  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${isStale ? 'bg-amber-400' : 'bg-emerald-400'}`}
      title={isStale ? 'Stale' : 'Synced'}
    />
  );
}

export function SyncResourcesStatus() {
  const { data: resourcesData } = useResources({ limit: 8 });
  const { data: syncStatus } = useSyncStatus();

  const resources = resourcesData?.data || [];

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>Sync Resources</h2>
        {syncStatus?.enabled && (
          <span className="text-2xs px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
            sync active
          </span>
        )}
      </div>

      {resources.length === 0 ? (
        <p className="text-xs text-center py-4" style={{ color: 'var(--color-text-muted)' }}>No resources registered</p>
      ) : (
        <div className="space-y-1">
          {resources.map((resource) => {
            const Icon = TYPE_ICONS[resource.resource_type] || Database;
            return (
              <div
                key={resource.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md"
              >
                <Icon className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                <span className="text-xs truncate flex-1">{resource.name}</span>
                <SyncDot lastPushAt={resource.last_push_at} />
                {resource.last_push_at ? (
                  <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    <TimeAgo date={resource.last_push_at} />
                  </span>
                ) : (
                  <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>never</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {syncStatus?.groups && syncStatus.groups.length > 0 && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            Hive sync: {syncStatus.groups.reduce((sum, g) => sum + g.connected_peers, 0)}/{syncStatus.groups.reduce((sum, g) => sum + g.peer_count, 0)} peers connected
          </div>
        </div>
      )}
    </div>
  );
}
