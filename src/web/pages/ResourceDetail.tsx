import { useParams, Link, useNavigate } from 'react-router-dom';
import { useState, useCallback } from 'react';
import {
  Database, Wrench, ArrowLeft, RefreshCw, GitCommit, Clock, Eye, Users,
  Tag, ChevronDown, ChevronUp, ExternalLink, Shield, Copy, Check,
} from 'lucide-react';
import { useResource, useResourceEvents, useCheckUpdates, useMapSwarms } from '../hooks/useApi';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { toast } from '../stores/toast';
import { MemoryBrowser } from '../components/resources/MemoryBrowser';
import { SkillBrowser } from '../components/resources/SkillBrowser';
import type { SyncableResource, ResourceSyncEvent } from '../lib/api';
import clsx from 'clsx';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="p-0.5 rounded hover:bg-workspace-hover transition-colors cursor-pointer"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />}
    </button>
  );
}

function SyncStatusBadge({ resource }: { resource: SyncableResource }) {
  if (!resource.last_push_at) {
    return (
      <span className="text-2xs px-2 py-0.5 rounded-full bg-gray-500/10 text-gray-400">
        Never synced
      </span>
    );
  }

  const age = Date.now() - new Date(resource.last_push_at).getTime();
  const isStale = age > 60 * 60 * 1000;

  return (
    <span className={`text-2xs px-2 py-0.5 rounded-full ${isStale ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
      {isStale ? 'Stale' : 'Synced'}
    </span>
  );
}

function MetadataRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs w-28 shrink-0" style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <div className="text-xs flex-1 min-w-0">{children}</div>
    </div>
  );
}

function SyncEventRow({ event }: { event: ResourceSyncEvent }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-workspace-hover transition-colors">
      <GitCommit className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
      <span className="text-xs font-mono truncate" title={event.commit_hash}>
        {event.commit_hash.slice(0, 7)}
      </span>
      {event.commit_message && (
        <span className="text-xs truncate flex-1" style={{ color: 'var(--color-text-secondary)' }}>
          {event.commit_message}
        </span>
      )}
      {!event.commit_message && <span className="flex-1" />}
      {event.pusher && (
        <span className="text-2xs shrink-0 px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
          {event.pusher}
        </span>
      )}
      <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
        <TimeAgo date={event.created_at} />
      </span>
    </div>
  );
}

function SwarmSyncList({ resource }: { resource: SyncableResource }) {
  const { data: swarms } = useMapSwarms();
  const checkUpdates = useCheckUpdates();

  // Find swarms that have hive_sync capability
  const syncableSwarms = swarms?.filter(s =>
    s.capabilities && (s.capabilities as Record<string, unknown>).hive_sync
  ) || [];

  const handleSyncSwarm = useCallback((swarmId: string) => {
    checkUpdates.mutate(
      { resourceId: resource.id },
      {
        onSuccess: (result) => {
          if (result.has_updates) {
            toast.success('Update found', `New commit: ${result.current_commit.slice(0, 7)}`);
          } else {
            toast.info('Up to date', 'No new updates available');
          }
        },
        onError: (err) => {
          toast.error('Check failed', (err as Error).message);
        },
      }
    );
  }, [resource.id, checkUpdates]);

  if (syncableSwarms.length === 0) {
    return (
      <div className="text-xs text-center py-4" style={{ color: 'var(--color-text-muted)' }}>
        No sync-capable swarms connected
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {syncableSwarms.map((swarm) => (
        <div
          key={swarm.id}
          className="flex items-center gap-2 px-2 py-1.5 rounded-md"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${swarm.status === 'online' ? 'bg-emerald-400' : 'bg-gray-400'}`}
          />
          <span className="text-xs truncate flex-1">{swarm.name}</span>
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {swarm.status}
          </span>
          <button
            onClick={() => handleSyncSwarm(swarm.id)}
            disabled={swarm.status !== 'online' || checkUpdates.isPending}
            className={clsx(
              'text-2xs px-2 py-0.5 rounded flex items-center gap-1 cursor-pointer transition-colors',
              swarm.status === 'online'
                ? 'bg-honey-500/10 text-honey-500 hover:bg-honey-500/20'
                : 'opacity-40 cursor-not-allowed'
            )}
          >
            <RefreshCw className={clsx('w-2.5 h-2.5', checkUpdates.isPending && 'animate-spin')} />
            Sync
          </button>
        </div>
      ))}
    </div>
  );
}

export function ResourceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: resource, isLoading } = useResource(id!);
  const { data: eventsData } = useResourceEvents(id!);
  const checkUpdates = useCheckUpdates();
  const [showEvents, setShowEvents] = useState(true);

  const events = eventsData?.data || [];

  const handleCheckUpdates = useCallback(() => {
    if (!id) return;
    checkUpdates.mutate(
      { resourceId: id },
      {
        onSuccess: (result) => {
          if (result.has_updates) {
            toast.success('Update found', `New commit: ${result.current_commit.slice(0, 7)}`);
          } else {
            toast.info('Up to date', 'No new updates available');
          }
        },
        onError: (err) => {
          toast.error('Check failed', (err as Error).message);
        },
      }
    );
  }, [id, checkUpdates]);

  if (isLoading) {
    return <PageLoader />;
  }

  if (!resource) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Resource not found</p>
        <button onClick={() => navigate('/resources')} className="text-xs text-honey-500 hover:text-honey-400 mt-2 cursor-pointer">
          Back to Resources
        </button>
      </div>
    );
  }

  const Icon = resource.resource_type === 'memory_bank' ? Database : Wrench;
  const typeLabel = resource.resource_type === 'memory_bank' ? 'Memory Bank' : 'Skill Tree';

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-2xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
        <Link to="/resources" className="hover:text-honey-500 transition-colors flex items-center gap-1">
          <ArrowLeft className="w-3 h-3" />
          Resources
        </Link>
        <span>/</span>
        <span>{resource.name}</span>
      </div>

      {/* Header */}
      <div className="card p-4 mb-3">
        <div className="flex items-start gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            <Icon className="w-5 h-5" style={{ color: 'var(--color-text-muted)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-semibold">{resource.name}</h1>
              <SyncStatusBadge resource={resource} />
              <span className="text-2xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
                {typeLabel}
              </span>
            </div>
            {resource.description && (
              <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                {resource.description}
              </p>
            )}
          </div>
          <button
            onClick={handleCheckUpdates}
            disabled={checkUpdates.isPending}
            className="btn btn-primary flex items-center gap-1.5 text-xs shrink-0"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', checkUpdates.isPending && 'animate-spin')} />
            {checkUpdates.isPending ? 'Checking...' : 'Check for Updates'}
          </button>
        </div>
      </div>

      {/* Content Browser */}
      {resource.resource_type === 'memory_bank' && (
        <div className="mb-3">
          <MemoryBrowser resourceId={resource.id} />
        </div>
      )}
      {resource.resource_type === 'skill' && (
        <div className="mb-3">
          <SkillBrowser resourceId={resource.id} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Details */}
        <div className="md:col-span-2 space-y-3">
          {/* Metadata */}
          <div className="card p-4">
            <h2 className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              Details
            </h2>
            <div className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
              <MetadataRow label="Type">
                <div className="flex items-center gap-1.5">
                  <Icon className="w-3 h-3" />
                  {typeLabel}
                </div>
              </MetadataRow>
              <MetadataRow label="Visibility">
                <div className="flex items-center gap-1.5">
                  <Eye className="w-3 h-3" />
                  {resource.visibility}
                </div>
              </MetadataRow>
              {resource.git_remote_url && (
                <MetadataRow label="Git Remote">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono truncate">{resource.git_remote_url}</span>
                    <CopyButton text={resource.git_remote_url} />
                  </div>
                </MetadataRow>
              )}
              {resource.last_commit_hash && (
                <MetadataRow label="Last Commit">
                  <div className="flex items-center gap-1.5">
                    <GitCommit className="w-3 h-3" />
                    <span className="font-mono">{resource.last_commit_hash.slice(0, 12)}</span>
                    <CopyButton text={resource.last_commit_hash} />
                  </div>
                </MetadataRow>
              )}
              <MetadataRow label="Last Push">
                {resource.last_push_at ? (
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3 h-3" />
                    <TimeAgo date={resource.last_push_at} />
                    {resource.last_push_by && (
                      <span style={{ color: 'var(--color-text-muted)' }}>by {resource.last_push_by}</span>
                    )}
                  </div>
                ) : (
                  <span style={{ color: 'var(--color-text-muted)' }}>Never</span>
                )}
              </MetadataRow>
              <MetadataRow label="Subscribers">
                <div className="flex items-center gap-1.5">
                  <Users className="w-3 h-3" />
                  {resource.subscriber_count}
                </div>
              </MetadataRow>
              {resource.my_permission && (
                <MetadataRow label="Your Permission">
                  <div className="flex items-center gap-1.5">
                    <Shield className="w-3 h-3" />
                    {resource.my_permission}
                  </div>
                </MetadataRow>
              )}
              {resource.tags && resource.tags.length > 0 && (
                <MetadataRow label="Tags">
                  <div className="flex flex-wrap gap-1">
                    {resource.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-2xs px-1.5 py-0.5 rounded"
                        style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </MetadataRow>
              )}
            </div>
          </div>

          {/* Sync Events */}
          <div className="card p-4">
            <button
              onClick={() => setShowEvents(!showEvents)}
              className="flex items-center justify-between w-full cursor-pointer"
            >
              <h2 className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
                Sync History
              </h2>
              <div className="flex items-center gap-2">
                {eventsData && (
                  <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                    {eventsData.total} event{eventsData.total !== 1 ? 's' : ''}
                  </span>
                )}
                {showEvents ? (
                  <ChevronUp className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
                )}
              </div>
            </button>

            {showEvents && (
              <div className="mt-2">
                {events.length > 0 ? (
                  <div className="space-y-0.5">
                    {events.map((event) => (
                      <SyncEventRow key={event.id} event={event} />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-center py-4" style={{ color: 'var(--color-text-muted)' }}>
                    No sync events yet
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-3">
          {/* Sync Controls */}
          <div className="card p-4">
            <h2 className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              Swarm Sync
            </h2>
            <SwarmSyncList resource={resource} />
          </div>

          {/* Quick Info */}
          <div className="card p-4">
            <h2 className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
              About {resource.resource_type === 'memory_bank' ? 'Memory Banks' : 'Skills'}
            </h2>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
              {resource.resource_type === 'memory_bank' ? (
                <>
                  Memory banks store agent knowledge as Markdown files with semantic search.
                  Sync propagates changes between connected swarms via git push notifications.
                </>
              ) : (
                <>
                  Skills capture reusable agent patterns with versioning and lineage tracking.
                  Federation allows importing and sharing skills across swarm boundaries.
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
