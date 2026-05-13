/**
 * Repos page — lists repo syncable resources with origin / visibility / status filters.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { GitBranch, ChevronRight, Globe, Lock, Server, Archive, GitMerge, EyeOff, Plus } from 'lucide-react';
import { useRepos, type RepoMetadata } from '../hooks/useApi';
import { useReposRealtime } from '../hooks/useRealtimeInvalidation';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { ListFilters, useDebouncedValue, matchesSearch } from '../components/common/ListFilters';
import { EmptyState } from '../components/common/EmptyState';
import { RegisterRepoModal } from '../components/repos/RegisterRepoModal';
import type { SyncableResource } from '../lib/api';

type RepoVisibility = 'private' | 'hub_local' | 'federated';
type RepoOrigin = 'user_defined' | 'agent_declared' | 'trajectory_inferred';
type RepoStatus = 'active' | 'redacted_remote' | 'archived' | 'merged_into';

const VISIBILITY_OPTIONS: Array<{ value: RepoVisibility | 'all'; label: string }> = [
  { value: 'all', label: 'All visibilities' },
  { value: 'private', label: 'Private' },
  { value: 'hub_local', label: 'Hub-local' },
  { value: 'federated', label: 'Federated' },
];

const ORIGIN_OPTIONS: Array<{ value: RepoOrigin | 'all'; label: string }> = [
  { value: 'all', label: 'All origins' },
  { value: 'user_defined', label: 'User-defined' },
  { value: 'agent_declared', label: 'Agent-declared' },
  { value: 'trajectory_inferred', label: 'Trajectory-inferred' },
];

const STATUS_OPTIONS: Array<{ value: RepoStatus | 'all'; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
  { value: 'merged_into', label: 'Merged' },
  { value: 'redacted_remote', label: 'Redacted (remote)' },
  { value: 'all', label: 'All statuses' },
];

function VisibilityIcon({ vis }: { vis: RepoVisibility }) {
  if (vis === 'federated') return <Globe className="w-3 h-3" />;
  if (vis === 'private') return <Lock className="w-3 h-3" />;
  return <Server className="w-3 h-3" />;
}

function StatusBadge({ status }: { status: RepoStatus }) {
  if (status === 'active') return null;
  const config = {
    archived: { icon: Archive, label: 'archived', cls: 'bg-amber-500/10 text-amber-400' },
    merged_into: { icon: GitMerge, label: 'merged', cls: 'bg-purple-500/10 text-purple-400' },
    redacted_remote: { icon: EyeOff, label: 'redacted', cls: 'bg-rose-500/10 text-rose-400' },
  }[status];
  if (!config) return null;
  const Icon = config.icon;
  return (
    <span className={`text-2xs px-1.5 py-0.5 rounded flex items-center gap-1 ${config.cls}`}>
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  );
}

function RepoCard({ repo }: { repo: SyncableResource }) {
  const meta = (repo.metadata ?? {}) as RepoMetadata;
  const status = ((repo as SyncableResource & { status?: RepoStatus }).status ?? 'active') as RepoStatus;
  const visibility = (meta.visibility ?? 'hub_local') as RepoVisibility;
  const displayName = meta.name ?? repo.name;

  return (
    <Link
      to={`/repos/${repo.id}`}
      className="card card-hover p-4 flex items-start gap-4 group"
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <GitBranch className="w-5 h-5 text-honey-500" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {displayName}
          </h3>
          <span
            className="text-2xs px-1.5 py-0.5 rounded flex items-center gap-1"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
          >
            <VisibilityIcon vis={visibility} />
            {visibility}
          </span>
          <StatusBadge status={status} />
        </div>

        <p className="text-xs mt-0.5 truncate font-mono" style={{ color: 'var(--color-text-secondary)' }}>
          {repo.git_remote_url}
        </p>

        <div className="flex items-center gap-3 mt-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {meta.default_branch && (
            <span className="font-mono">{meta.default_branch}</span>
          )}
          {meta.origin && <span>{meta.origin.replace('_', ' ')}</span>}
          <span>
            updated <TimeAgo date={repo.updated_at} />
          </span>
        </div>
      </div>

      <ChevronRight
        className="w-4 h-4 shrink-0 mt-1 opacity-0 group-hover:opacity-50 transition-opacity"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}

export function Repos() {
  useReposRealtime();
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState<RepoOrigin | 'all'>('all');
  const [visibility, setVisibility] = useState<RepoVisibility | 'all'>('all');
  const [status, setStatus] = useState<RepoStatus | 'all'>('active');
  const [registerOpen, setRegisterOpen] = useState(false);
  const q = useDebouncedValue(search);

  const { data, isLoading } = useRepos({
    ...(origin !== 'all' && { origin }),
    ...(visibility !== 'all' && { visibility }),
    ...(status !== 'all' && { status }),
    limit: 200,
  });

  const repos = data?.data ?? [];
  const filtered = useMemo(
    () =>
      repos.filter((r) => {
        const meta = (r.metadata ?? {}) as RepoMetadata;
        return matchesSearch(q, r.name, r.git_remote_url, meta.description ?? '', meta.default_branch ?? '');
      }),
    [repos, q],
  );

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h1 className="text-lg font-bold">Repos</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Federated repositories declared by agents or registered manually. Workspaces (per-agent
            bindings) live under each repo's detail page.
          </p>
        </div>
        <button
          onClick={() => setRegisterOpen(true)}
          className="btn btn-primary text-xs flex items-center gap-1 shrink-0"
        >
          <Plus className="w-3 h-3" />
          Register repo
        </button>
      </div>

      <RegisterRepoModal open={registerOpen} onClose={() => setRegisterOpen(false)} />

      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={origin}
          onChange={(e) => setOrigin(e.target.value as RepoOrigin | 'all')}
          className="input text-xs py-1.5"
        >
          {ORIGIN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as RepoVisibility | 'all')}
          className="input text-xs py-1.5"
        >
          {VISIBILITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as RepoStatus | 'all')}
          className="input text-xs py-1.5"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {repos.length > 0 && (
        <ListFilters
          search={search}
          onSearchChange={setSearch}
          placeholder="Search by name or URL…"
          count={{ visible: filtered.length, total: repos.length, noun: 'repo' }}
        />
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title={repos.length === 0 ? 'No repos yet' : 'No repos match the current filters.'}
          description={repos.length === 0 ? 'Connected agents will declare them automatically when the workspace capability is enabled.' : undefined}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => (
            <RepoCard key={r.id} repo={r} />
          ))}
        </div>
      )}
    </div>
  );
}
