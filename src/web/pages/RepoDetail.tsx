/**
 * Repo detail page — metadata, active bindings, visibility editor,
 * archive / unarchive / merge actions.
 */

import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  GitBranch, Archive, ArchiveRestore, GitMerge, Globe, Lock, Server,
  ChevronLeft, AlertTriangle,
} from 'lucide-react';
import {
  useRepo,
  useRepoWorkspaces,
  useUpdateRepo,
  useArchiveRepo,
  useUnarchiveRepo,
  useMergeRepo,
  type RepoMetadata,
  type Workspace,
} from '../hooks/useApi';
import { useRepoRealtime } from '../hooks/useRealtimeInvalidation';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import type { SyncableResource } from '../lib/api';

type RepoVisibility = 'private' | 'hub_local' | 'federated';
type RepoStatus = 'active' | 'redacted_remote' | 'archived' | 'merged_into';

function VisibilityPill({ vis }: { vis: RepoVisibility }) {
  const Icon = vis === 'federated' ? Globe : vis === 'private' ? Lock : Server;
  return (
    <span
      className="text-xs px-2 py-0.5 rounded inline-flex items-center gap-1"
      style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
    >
      <Icon className="w-3 h-3" />
      {vis}
    </span>
  );
}

function WorkspaceRow({ ws }: { ws: Workspace }) {
  return (
    <div
      className="card p-3 flex items-center justify-between gap-3"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono truncate">{ws.local_path}</span>
          {ws.dirty === 1 && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
              dirty
            </span>
          )}
          <VisibilityPill vis={ws.visibility as RepoVisibility} />
        </div>
        <div className="flex items-center gap-3 mt-1 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {ws.current_branch && (
            <span className="font-mono">{ws.current_branch}</span>
          )}
          {ws.head_sha && (
            <span className="font-mono">{ws.head_sha.slice(0, 8)}</span>
          )}
          <span>
            seen <TimeAgo date={ws.last_seen_at} />
          </span>
        </div>
      </div>
      <Link
        to={`/swarms/${ws.swarm_id}`}
        className="text-xs text-honey-500 hover:underline shrink-0"
      >
        swarm →
      </Link>
    </div>
  );
}

export function RepoDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useRepoRealtime(id);

  const { data: repoData, isLoading } = useRepo(id);
  const { data: workspacesData } = useRepoWorkspaces(id);

  const updateRepo = useUpdateRepo();
  const archiveRepo = useArchiveRepo();
  const unarchiveRepo = useUnarchiveRepo();
  const mergeRepo = useMergeRepo();

  const [editing, setEditing] = useState(false);
  // Seed from the loaded repo's current visibility when available; falls
  // through to 'hub_local' only if the repo hasn't loaded yet (which can't
  // actually happen while the edit form is visible — `startEdit` reseeds
  // before flipping `editing` true — but the lazy init is tidier than
  // a hardcoded literal that's stale until first edit).
  const [editVisibility, setEditVisibility] = useState<RepoVisibility>(
    () => ((repoData?.repo?.metadata as RepoMetadata | undefined)?.visibility as RepoVisibility | undefined) ?? 'hub_local',
  );
  const [editBranch, setEditBranch] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [showMerge, setShowMerge] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  if (isLoading) return <PageLoader />;
  if (!repoData?.repo) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <Link to="/repos" className="flex items-center gap-1 text-xs mb-4 hover:text-honey-500 transition-colors" style={{ color: 'var(--color-text-muted)' }}>
          <ChevronLeft className="w-3.5 h-3.5" />
          All repos
        </Link>
        <div className="card p-8 text-center">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Repo not found.</p>
        </div>
      </div>
    );
  }

  const repo: SyncableResource = repoData.repo;
  const meta = (repo.metadata ?? {}) as RepoMetadata;
  const status = ((repo as SyncableResource & { status?: RepoStatus }).status ?? 'active') as RepoStatus;
  const visibility = (meta.visibility ?? 'hub_local') as RepoVisibility;
  const bindings = workspacesData?.data ?? [];

  function startEdit() {
    setEditVisibility(visibility);
    setEditBranch(meta.default_branch ?? '');
    setEditDescription(meta.description ?? '');
    setSaveError(null);
    setEditing(true);
  }

  async function saveEdit() {
    setSaveError(null);
    try {
      await updateRepo.mutateAsync({
        id: repo.id,
        visibility: editVisibility,
        ...(editBranch && editBranch !== meta.default_branch && { default_branch: editBranch }),
        ...(editDescription !== (meta.description ?? '') && { description: editDescription }),
      });
      setEditing(false);
    } catch (err) {
      setSaveError((err as Error).message || 'Failed to save changes');
    }
  }

  async function handleArchive() {
    setLifecycleError(null);
    try {
      await archiveRepo.mutateAsync(repo.id);
    } catch (err) {
      setLifecycleError((err as Error).message || 'Failed to archive repo');
    }
  }

  async function handleUnarchive() {
    setLifecycleError(null);
    try {
      await unarchiveRepo.mutateAsync(repo.id);
    } catch (err) {
      setLifecycleError((err as Error).message || 'Failed to unarchive repo');
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div>
        <button
          onClick={() => navigate('/repos')}
          className="text-xs text-honey-500 hover:underline inline-flex items-center gap-1 mb-2"
        >
          <ChevronLeft className="w-3 h-3" /> All repos
        </button>

        <div className="flex items-start gap-4">
          <div
            className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            <GitBranch className="w-6 h-6 text-honey-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate">{meta.name ?? repo.name}</h1>
            <p
              className="text-xs font-mono mt-0.5 truncate"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {repo.git_remote_url}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <VisibilityPill vis={visibility} />
              {status !== 'active' && (
                <span
                  className="text-xs px-2 py-0.5 rounded inline-flex items-center gap-1"
                  style={{
                    backgroundColor: 'var(--color-elevated)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {status}
                </span>
              )}
              {meta.origin && (
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  · {meta.origin.replace('_', ' ')}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {status === 'merged_into' && meta.merged_into_canonical_url && (
        <div
          className="card p-3 flex items-center gap-3"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <GitMerge className="w-4 h-4 text-purple-400 shrink-0" />
          <div className="text-xs">
            Merged into{' '}
            <span className="font-mono">{meta.merged_into_canonical_url}</span>
            {meta.archived_at && (
              <span style={{ color: 'var(--color-text-muted)' }}>
                {' '}
                · <TimeAgo date={meta.archived_at} />
              </span>
            )}
          </div>
        </div>
      )}

      {/* Metadata + edit form */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Metadata</h2>
          {!editing && status === 'active' && (
            <button onClick={startEdit} className="btn btn-ghost text-xs">Edit</button>
          )}
        </div>

        {!editing ? (
          <div className="card p-4 space-y-3 text-xs">
            <div className="grid grid-cols-[100px_1fr] gap-y-2">
              <span style={{ color: 'var(--color-text-muted)' }}>Default branch</span>
              <span className="font-mono">{meta.default_branch ?? '—'}</span>

              <span style={{ color: 'var(--color-text-muted)' }}>Description</span>
              <span>{meta.description ?? '—'}</span>

              <span style={{ color: 'var(--color-text-muted)' }}>Binding policy</span>
              <span>{meta.binding_policy ?? 'open'}</span>

              <span style={{ color: 'var(--color-text-muted)' }}>Created</span>
              <span><TimeAgo date={repo.created_at} /></span>

              <span style={{ color: 'var(--color-text-muted)' }}>Updated</span>
              <span><TimeAgo date={repo.updated_at} /></span>
            </div>
          </div>
        ) : (
          <div className="card p-4 space-y-3">
            <div>
              <label className="text-2xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                Visibility
              </label>
              <select
                value={editVisibility}
                onChange={(e) => setEditVisibility(e.target.value as RepoVisibility)}
                className="input text-sm py-1.5 w-full"
              >
                <option value="private">Private (owner only)</option>
                <option value="hub_local">Hub-local (visible on this hub)</option>
                <option value="federated">Federated (replicated to peer hubs)</option>
              </select>
              {visibility === 'federated' && editVisibility !== 'federated' && (
                <p className="text-2xs mt-1 text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  Downgrading from federated will emit a redaction to peers.
                </p>
              )}
            </div>
            <div>
              <label className="text-2xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                Default branch
              </label>
              <input
                type="text"
                value={editBranch}
                onChange={(e) => setEditBranch(e.target.value)}
                placeholder="main"
                className="input text-sm py-1.5 w-full font-mono"
              />
            </div>
            <div>
              <label className="text-2xs font-medium block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                Description
              </label>
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={2}
                className="input text-sm py-1.5 w-full"
              />
            </div>
            {saveError && (
              <div
                className="flex items-start gap-2 p-2 rounded text-2xs"
                style={{ backgroundColor: 'var(--color-danger-bg)', color: 'var(--color-text)' }}
              >
                <AlertTriangle className="w-3 h-3 text-rose-400 shrink-0 mt-0.5" />
                <span>{saveError}</span>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => { setEditing(false); setSaveError(null); }}
                className="btn btn-ghost text-xs"
                disabled={updateRepo.isPending}
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                className="btn btn-primary text-xs"
                disabled={updateRepo.isPending}
              >
                {updateRepo.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Bindings */}
      <section>
        <h2 className="text-sm font-semibold mb-3">
          Workspaces <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
            ({bindings.length} active)
          </span>
        </h2>
        {bindings.length === 0 ? (
          <div className="card p-6 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
            No agents have attached this repo yet.
          </div>
        ) : (
          <div className="space-y-2">
            {bindings.map((ws) => <WorkspaceRow key={ws.id} ws={ws} />)}
          </div>
        )}
      </section>

      {/* Lifecycle actions */}
      {status === 'active' && (
        <section className="pt-4 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <h2 className="text-sm font-semibold mb-3">Lifecycle</h2>
          {lifecycleError && (
            <div
              className="flex items-start gap-2 p-2 rounded text-2xs mb-2"
              style={{ backgroundColor: 'var(--color-danger-bg)', color: 'var(--color-text)' }}
            >
              <AlertTriangle className="w-3 h-3 text-rose-400 shrink-0 mt-0.5" />
              <span>{lifecycleError}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleArchive}
              disabled={archiveRepo.isPending}
              className="btn btn-ghost text-xs flex items-center gap-1"
            >
              <Archive className="w-3 h-3" />
              {archiveRepo.isPending ? 'Archiving…' : 'Archive'}
            </button>
            <button
              onClick={() => setShowMerge(!showMerge)}
              className="btn btn-ghost text-xs flex items-center gap-1"
            >
              <GitMerge className="w-3 h-3" />
              Merge into…
            </button>
          </div>

          {showMerge && (
            <div className="card p-3 mt-3 space-y-2">
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Mark this repo as a duplicate of another. The source becomes a forwarding tombstone;
                no data is destroyed.
              </p>
              <input
                type="text"
                value={mergeTargetId}
                onChange={(e) => { setMergeTargetId(e.target.value); setMergeError(null); }}
                placeholder="Target repo id (repo_…)"
                className="input text-xs py-1.5 w-full font-mono"
              />
              {mergeError && (
                <div
                  className="flex items-start gap-2 p-2 rounded text-2xs"
                  style={{ backgroundColor: 'var(--color-danger-bg)', color: 'var(--color-text)' }}
                >
                  <AlertTriangle className="w-3 h-3 text-rose-400 shrink-0 mt-0.5" />
                  <span>{mergeError}</span>
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => { setShowMerge(false); setMergeTargetId(''); setMergeError(null); }}
                  className="btn btn-ghost text-xs"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    if (!mergeTargetId) return;
                    setMergeError(null);
                    try {
                      await mergeRepo.mutateAsync({ sourceId: repo.id, into: mergeTargetId });
                      setShowMerge(false);
                      setMergeTargetId('');
                    } catch (err) {
                      setMergeError((err as Error).message || 'Merge failed');
                    }
                  }}
                  disabled={!mergeTargetId || mergeRepo.isPending}
                  className="btn btn-primary text-xs"
                >
                  {mergeRepo.isPending ? 'Merging…' : 'Merge'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {status === 'archived' && (
        <section className="pt-4 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <button
            onClick={handleUnarchive}
            disabled={unarchiveRepo.isPending}
            className="btn btn-ghost text-xs flex items-center gap-1"
          >
            <ArchiveRestore className="w-3 h-3" />
            {unarchiveRepo.isPending ? 'Unarchiving…' : 'Unarchive'}
          </button>
          {lifecycleError && (
            <div
              className="flex items-start gap-2 p-2 rounded text-2xs mt-2"
              style={{ backgroundColor: 'var(--color-danger-bg)', color: 'var(--color-text)' }}
            >
              <AlertTriangle className="w-3 h-3 text-rose-400 shrink-0 mt-0.5" />
              <span>{lifecycleError}</span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
