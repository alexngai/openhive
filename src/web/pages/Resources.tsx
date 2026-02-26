import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Database, Wrench, RefreshCw, ChevronRight, GitCommit, Eye, Users, Tag, Clock } from 'lucide-react';
import { useResourcesByType, useBatchCheckUpdates, useSyncStatus, useMapSwarms } from '../hooks/useApi';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { toast } from '../stores/toast';
import type { SyncableResource } from '../lib/api';
import clsx from 'clsx';

type ResourceTab = 'memory_bank' | 'skill';

const TABS: { key: ResourceTab; label: string; icon: React.ElementType }[] = [
  { key: 'memory_bank', label: 'Memory Banks', icon: Database },
  { key: 'skill', label: 'Skills', icon: Wrench },
];

function SyncDot({ lastPushAt }: { lastPushAt: string | null }) {
  if (!lastPushAt) {
    return <span className="w-1.5 h-1.5 rounded-full bg-gray-400 opacity-50 shrink-0" title="Never synced" />;
  }
  const age = Date.now() - new Date(lastPushAt).getTime();
  const isStale = age > 60 * 60 * 1000;
  return (
    <span
      className={`w-1.5 h-1.5 rounded-full shrink-0 ${isStale ? 'bg-amber-400' : 'bg-emerald-400'}`}
      title={isStale ? 'Stale (>1h)' : 'Recently synced'}
    />
  );
}

function VisibilityBadge({ visibility }: { visibility: string }) {
  const styles: Record<string, string> = {
    public: 'bg-emerald-500/10 text-emerald-400',
    shared: 'bg-blue-500/10 text-blue-400',
    private: 'bg-gray-500/10 text-gray-400',
  };
  return (
    <span className={`text-2xs px-1.5 py-0.5 rounded ${styles[visibility] || styles.private}`}>
      {visibility}
    </span>
  );
}

function ResourceCard({ resource }: { resource: SyncableResource }) {
  const Icon = resource.resource_type === 'memory_bank' ? Database : Wrench;

  return (
    <Link
      to={`/resources/${resource.id}`}
      className="card card-hover px-3 py-2.5 flex items-start gap-3 group"
    >
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-0.5"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Icon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {resource.name}
          </h3>
          <SyncDot lastPushAt={resource.last_push_at} />
          <VisibilityBadge visibility={resource.visibility} />
        </div>

        {resource.description && (
          <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {resource.description}
          </p>
        )}

        <div className="flex items-center gap-3 mt-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {resource.last_commit_hash && (
            <span className="flex items-center gap-1" title={resource.last_commit_hash}>
              <GitCommit className="w-3 h-3" />
              {resource.last_commit_hash.slice(0, 7)}
            </span>
          )}
          {resource.last_push_at && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <TimeAgo date={resource.last_push_at} />
            </span>
          )}
          <span className="flex items-center gap-1">
            <Users className="w-3 h-3" />
            {resource.subscriber_count}
          </span>
          {resource.tags && resource.tags.length > 0 && (
            <span className="flex items-center gap-1">
              <Tag className="w-3 h-3" />
              {resource.tags.slice(0, 2).join(', ')}
            </span>
          )}
        </div>
      </div>

      <ChevronRight className="w-4 h-4 shrink-0 mt-1 opacity-0 group-hover:opacity-50 transition-opacity" />
    </Link>
  );
}

function SwarmSyncSummary() {
  const { data: swarms } = useMapSwarms();
  const { data: syncStatus } = useSyncStatus();

  const online = swarms?.filter(s => s.status === 'online') || [];
  const syncCapable = swarms?.filter(s =>
    s.capabilities && (s.capabilities as Record<string, unknown>).hive_sync
  ) || [];

  return (
    <div className="card p-3">
      <h3 className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
        Connected Swarms
      </h3>
      <div className="grid grid-cols-3 gap-2">
        <div className="text-center">
          <div className="text-lg font-bold">{swarms?.length || 0}</div>
          <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Total</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-emerald-400">{online.length}</div>
          <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Online</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-honey-500">{syncCapable.length}</div>
          <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Sync-capable</div>
        </div>
      </div>
      {syncStatus?.enabled && syncStatus.groups.length > 0 && (
        <div className="mt-2 pt-2 border-t text-2xs" style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }}>
          {syncStatus.groups.reduce((sum, g) => sum + g.connected_peers, 0)} peers connected across {syncStatus.groups.length} sync group{syncStatus.groups.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

export function Resources() {
  const [activeTab, setActiveTab] = useState<ResourceTab>('memory_bank');
  const { data: resourcesData, isLoading } = useResourcesByType(activeTab);
  const batchCheck = useBatchCheckUpdates();

  const resources = resourcesData?.data || [];
  const total = resourcesData?.total || 0;

  const handleBatchSync = useCallback(() => {
    batchCheck.mutate(
      { resource_type: activeTab },
      {
        onSuccess: (result) => {
          if (result.updated.length > 0) {
            toast.success(
              'Updates found',
              `${result.updated.length} resource${result.updated.length !== 1 ? 's' : ''} updated`
            );
          } else {
            toast.info('All up to date', `Checked ${result.checked} resource${result.checked !== 1 ? 's' : ''}`);
          }
          if (result.errors.length > 0) {
            toast.warning(
              'Some checks failed',
              `${result.errors.length} resource${result.errors.length !== 1 ? 's' : ''} could not be checked`
            );
          }
        },
        onError: (err) => {
          toast.error('Sync check failed', (err as Error).message);
        },
      }
    );
  }, [activeTab, batchCheck]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-semibold">Resources</h1>
        <button
          onClick={handleBatchSync}
          disabled={batchCheck.isPending}
          className="btn btn-secondary flex items-center gap-1.5 text-xs"
        >
          <RefreshCw className={clsx('w-3.5 h-3.5', batchCheck.isPending && 'animate-spin')} />
          {batchCheck.isPending ? 'Checking...' : 'Sync All'}
        </button>
      </div>

      {/* Swarm summary */}
      <SwarmSyncSummary />

      {/* Tabs */}
      <div className="flex gap-1 mt-3 mb-3">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
              activeTab === tab.key
                ? 'bg-honey-500/10 text-honey-500'
                : 'hover:bg-workspace-hover'
            )}
            style={activeTab !== tab.key ? { color: 'var(--color-text-secondary)' } : undefined}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Resource list */}
      {isLoading ? (
        <PageLoader />
      ) : resources.length > 0 ? (
        <div className="space-y-1">
          {resources.map((resource) => (
            <ResourceCard key={resource.id} resource={resource} />
          ))}
          {total > resources.length && (
            <p className="text-2xs text-center py-2" style={{ color: 'var(--color-text-muted)' }}>
              Showing {resources.length} of {total}
            </p>
          )}
        </div>
      ) : (
        <div className="py-12 text-center">
          <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ backgroundColor: 'var(--color-elevated)' }}>
            {activeTab === 'memory_bank' ? (
              <Database className="w-6 h-6" style={{ color: 'var(--color-text-muted)' }} />
            ) : (
              <Wrench className="w-6 h-6" style={{ color: 'var(--color-text-muted)' }} />
            )}
          </div>
          <p className="text-sm font-medium mb-1">No {activeTab === 'memory_bank' ? 'memory banks' : 'skills'} yet</p>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {activeTab === 'memory_bank'
              ? 'Connect a swarm with minimem to start syncing memories'
              : 'Connect a swarm with skill-tree to start syncing skills'}
          </p>
        </div>
      )}
    </div>
  );
}
