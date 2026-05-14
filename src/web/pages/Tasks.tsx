/**
 * Tasks Page — Lists all OpenTasks resources with management options.
 */

import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ListTodo, Network, ChevronRight, Clock, AlertTriangle, ArrowLeft,
  CheckCircle2, Activity, XCircle, Zap, Plus, Trash2, FolderOpen, X,
  ChevronDown, Settings, Radio, Upload,
} from 'lucide-react';
import { useResourcesByType, useOpenTasksSummary, useCreateTaskResource, useUpdateTaskResource, useDeleteTaskResource, useSwarmKitProjects, useConnectedTaskGraphs, useGitSyncStatus, useGitPush } from '../hooks/useApi';
import { useTasksRealtime } from '../hooks/useMapTasks';
import { useResourcesRealtime } from '../hooks/useRealtimeInvalidation';
import { Dialog } from '../components/common/Dialog';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { EmptyState } from '../components/common/EmptyState';
import { StatusChip, type StatusTone } from '../components/common/StatusChip';
import type { SyncableResource } from '../lib/api';

// ============================================================================
// Status styling
// ============================================================================

export function taskStatusToChip(status: string): { tone: StatusTone; label: string; Icon: React.ElementType } {
  switch (status) {
    case 'open':        return { tone: 'info',    label: 'open',        Icon: ListTodo };
    case 'in_progress': return { tone: 'warning', label: 'in progress', Icon: Activity };
    case 'blocked':     return { tone: 'danger',  label: 'blocked',     Icon: AlertTriangle };
    case 'completed':   return { tone: 'success', label: 'completed',   Icon: CheckCircle2 };
    case 'closed':      return { tone: 'success', label: 'closed',      Icon: CheckCircle2 };
    case 'failed':      return { tone: 'danger',  label: 'failed',      Icon: XCircle };
    default:            return { tone: 'neutral', label: status,         Icon: ListTodo };
  }
}

// ============================================================================
// Add Task Repo Form
// ============================================================================

function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center justify-between cursor-pointer group">
      <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-8 h-[18px] rounded-full transition-colors ${checked ? 'bg-honey-500' : 'bg-white/10'}`}
      >
        <span className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${checked ? 'translate-x-[14px]' : ''}`} />
      </button>
    </label>
  );
}

function AddTaskRepoDialog({
  open,
  onClose,
  existingPaths,
}: {
  open: boolean;
  onClose: () => void;
  existingPaths: Set<string>;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [locationMode, setLocationMode] = useState<'project' | 'custom' | 'remote'>('project');

  const { data: projectsData } = useSwarmKitProjects();
  const projectRoots = projectsData?.projectRoots ?? [];

  // Filter to projects that don't already have an opentasks resource
  const availableProjects = projectRoots.filter(
    (p) => !existingPaths.has(p + '/.opentasks') && !existingPaths.has(p),
  );

  // When a project is selected, auto-fill name and path
  const selectProject = (projectPath: string) => {
    setPath(projectPath + '/.opentasks');
    if (!name) {
      const dirName = projectPath.split('/').pop() || 'tasks';
      setName(dirName + '-tasks');
    }
    setLocationMode('project');
  };

  const isRemote = locationMode === 'remote';

  // Git sync (for remote repos)
  const [gitSyncEnabled, setGitSyncEnabled] = useState(false);
  const [autoCommit, setAutoCommit] = useState(true);
  const [autoPush, setAutoPush] = useState(false);
  const [autoPull, setAutoPull] = useState(false);

  // Check if the entered path/URL already has a task resource
  const isDuplicate = path.trim() !== '' && existingPaths.has(path.trim());

  // Advanced: Daemon
  const [daemonAutoStart, setDaemonAutoStart] = useState(true);
  const [flushInterval, setFlushInterval] = useState(1000);

  // Advanced: Providers
  const [claudeTasksEnabled, setClaudeTasksEnabled] = useState(true);
  const [beadsEnabled, setBeadsEnabled] = useState(false);
  const [sessionlogEnabled, setSessionlogEnabled] = useState(false);
  const [mapEnabled, setMapEnabled] = useState(false);
  const [mapServer, setMapServer] = useState('');

  // Advanced: Logging
  const [logLevel, setLogLevel] = useState('info');

  const createRepo = useCreateTaskResource();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) return;

    const config: Record<string, unknown> = {
      daemon: { autoStart: daemonAutoStart, flushInterval },
      providers: {
        claudeTasks: { enabled: claudeTasksEnabled },
        beads: { enabled: beadsEnabled },
        sessionlog: { enabled: sessionlogEnabled },
        ...(mapEnabled && mapServer ? { map: { enabled: true, server: mapServer } } : {}),
      },
      logging: { level: logLevel },
      ...(isRemote && gitSyncEnabled ? {
        sync: {
          git: {
            enabled: true,
            autoCommit,
            autoPush,
            autoPull,
            pullOnStartup: true,
          },
        },
      } : {}),
    };

    createRepo.mutate(
      {
        name: name.trim(),
        path: path.trim(),
        description: description.trim() || undefined,
        config,
        syncStrategy: isRemote ? 'ls-remote' : 'metadata',
      },
      {
        onSuccess: () => {
          setName('');
          setPath('');
          setDescription('');
          setShowAdvanced(false);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="max-w-md">
      <form onSubmit={handleSubmit}>
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-border-subtle)]">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-honey-500" />
            <span className="text-sm font-semibold">Add Task Graph</span>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-white/5">
            <X className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="text-xs font-medium block mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project-tasks"
              className="input w-full text-sm"
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs font-medium block mb-1.5">Location</label>

            {/* Mode tabs */}
            <div className="flex gap-1 mb-3 text-2xs">
              {availableProjects.length > 0 && (
                <button
                  type="button"
                  onClick={() => { setLocationMode('project'); setPath(''); }}
                  className={`px-2.5 py-1 rounded-md transition-colors ${
                    locationMode === 'project' ? 'bg-honey-500/15 text-honey-500' : 'hover:bg-white/5'
                  }`}
                  style={locationMode !== 'project' ? { color: 'var(--color-text-muted)' } : {}}
                >
                  Project
                </button>
              )}
              <button
                type="button"
                onClick={() => { setLocationMode('custom'); setPath(''); }}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  locationMode === 'custom' ? 'bg-honey-500/15 text-honey-500' : 'hover:bg-white/5'
                }`}
                style={locationMode !== 'custom' ? { color: 'var(--color-text-muted)' } : {}}
              >
                Local Path
              </button>
              <button
                type="button"
                onClick={() => { setLocationMode('remote'); setPath(''); }}
                className={`px-2.5 py-1 rounded-md transition-colors ${
                  locationMode === 'remote' ? 'bg-honey-500/15 text-honey-500' : 'hover:bg-white/5'
                }`}
                style={locationMode !== 'remote' ? { color: 'var(--color-text-muted)' } : {}}
              >
                Remote Repo
              </button>
            </div>

            {/* Project selection */}
            {locationMode === 'project' && (
              <div className="space-y-1.5">
                {availableProjects.map((p) => {
                  const dirName = p.split('/').pop() || p;
                  const isSelected = path === p + '/.opentasks';
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => selectProject(p)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors flex items-center gap-2 ${
                        isSelected
                          ? 'bg-honey-500/15 border border-honey-500/30'
                          : 'bg-white/5 border border-transparent hover:bg-white/10'
                      }`}
                    >
                      <FolderOpen className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-honey-500' : ''}`} style={isSelected ? {} : { color: 'var(--color-text-muted)' }} />
                      <span className="font-medium truncate">{dirName}</span>
                      <span className="font-mono text-2xs truncate ml-auto" style={{ color: 'var(--color-text-muted)' }}>
                        {p}
                      </span>
                    </button>
                  );
                })}
                {availableProjects.length === 0 && (
                  <p className="text-2xs px-1" style={{ color: 'var(--color-text-muted)' }}>
                    All known projects already have task graphs.
                  </p>
                )}
              </div>
            )}

            {/* Custom local path */}
            {locationMode === 'custom' && (
              <div>
                <input
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/project/.opentasks"
                  className="input w-full text-sm font-mono"
                />
                <p className="text-2xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
                  Path to an .opentasks directory. Will be created if it doesn't exist.
                </p>
              </div>
            )}

            {/* Remote git repo */}
            {locationMode === 'remote' && (
              <div className="space-y-3">
                <div>
                  <input
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="https://github.com/org/tasks-repo.git"
                    className="input w-full text-sm font-mono"
                  />
                  <p className="text-2xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
                    Git repository URL containing an .opentasks directory. Cloned on first query.
                  </p>
                </div>

                <div className="space-y-2 p-3 rounded-lg bg-white/[0.02] border border-[var(--color-border-subtle)]">
                  <ToggleSwitch
                    checked={gitSyncEnabled}
                    onChange={setGitSyncEnabled}
                    label="Enable edits (git sync)"
                  />
                  {!gitSyncEnabled && (
                    <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                      Clone is read-only. Enable to commit and push changes back.
                    </p>
                  )}
                  {gitSyncEnabled && (
                    <div className="space-y-2 pt-1">
                      <ToggleSwitch
                        checked={autoCommit}
                        onChange={setAutoCommit}
                        label="Auto-commit on save"
                      />
                      <ToggleSwitch
                        checked={autoPush}
                        onChange={setAutoPush}
                        label="Auto-push to remote"
                      />
                      {!autoPush && (
                        <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                          Changes are committed locally. Push manually when ready.
                        </p>
                      )}
                      <ToggleSwitch
                        checked={autoPull}
                        onChange={setAutoPull}
                        label="Auto-pull from remote"
                      />
                      {autoPull && (
                        <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                          Automatically pulls remote changes when detected.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="text-xs font-medium block mb-1.5">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="input w-full text-sm"
            />
          </div>

          {/* Advanced section */}
          <div className="border-t border-[var(--color-border-subtle)] pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-xs font-medium w-full group"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <Settings className="w-3.5 h-3.5" />
              Advanced Configuration
              <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-4">
                {/* Daemon settings */}
                <div className="space-y-2.5">
                  <h4 className="text-2xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                    Daemon
                  </h4>
                  <ToggleSwitch
                    checked={daemonAutoStart}
                    onChange={setDaemonAutoStart}
                    label="Auto-start daemon"
                  />
                  <div>
                    <label className="text-xs block mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                      Flush interval (ms)
                    </label>
                    <input
                      type="number"
                      value={flushInterval}
                      onChange={(e) => setFlushInterval(Math.max(100, parseInt(e.target.value) || 1000))}
                      min={100}
                      step={100}
                      className="input w-full text-sm font-mono"
                    />
                  </div>
                </div>

                {/* Provider toggles */}
                <div className="space-y-2.5">
                  <h4 className="text-2xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                    Providers
                  </h4>
                  <ToggleSwitch
                    checked={claudeTasksEnabled}
                    onChange={setClaudeTasksEnabled}
                    label="Claude Tasks"
                  />
                  <p className="text-2xs -mt-1 pl-0" style={{ color: 'var(--color-text-muted)' }}>
                    Sync Claude Code native tasks into the graph
                  </p>
                  <ToggleSwitch
                    checked={beadsEnabled}
                    onChange={setBeadsEnabled}
                    label="Beads"
                  />
                  <ToggleSwitch
                    checked={sessionlogEnabled}
                    onChange={setSessionlogEnabled}
                    label="Sessionlog"
                  />
                  <p className="text-2xs -mt-1" style={{ color: 'var(--color-text-muted)' }}>
                    Link sessions to tasks automatically
                  </p>
                  <ToggleSwitch
                    checked={mapEnabled}
                    onChange={setMapEnabled}
                    label="MAP (cross-system tasks)"
                  />
                  {mapEnabled && (
                    <div className="pl-0">
                      <label className="text-xs block mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                        MAP server URL
                      </label>
                      <input
                        type="text"
                        value={mapServer}
                        onChange={(e) => setMapServer(e.target.value)}
                        placeholder="ws://localhost:7836/ws/map"
                        className="input w-full text-sm font-mono"
                      />
                    </div>
                  )}
                </div>

                {/* Logging */}
                <div className="space-y-2.5">
                  <h4 className="text-2xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                    Logging
                  </h4>
                  <div>
                    <label className="text-xs block mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                      Log level
                    </label>
                    <select
                      value={logLevel}
                      onChange={(e) => setLogLevel(e.target.value)}
                      className="input w-full text-sm"
                    >
                      <option value="error">Error</option>
                      <option value="warn">Warn</option>
                      <option value="info">Info</option>
                      <option value="debug">Debug</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {isDuplicate && (
            <p className="text-xs text-amber-400">A task graph already exists for this location.</p>
          )}

          {createRepo.error && (
            <p className="text-xs text-red-400">{(createRepo.error as Error).message}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-border-subtle)]">
          <button type="button" onClick={onClose} className="btn btn-ghost text-xs">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || !path.trim() || isDuplicate || createRepo.isPending}
            className="btn btn-primary text-xs"
          >
            {createRepo.isPending ? 'Adding...' : 'Add Task Graph'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ============================================================================
// Git Sync Section (used inside settings dialog)
// ============================================================================

function GitSyncSection({ resourceId }: { resourceId: string }) {
  const { data: status } = useGitSyncStatus(resourceId, true);
  const gitPush = useGitPush(resourceId);

  if (!status) return null;

  const hasChanges = status.hasUncommittedChanges || status.unpushedCommits > 0;

  return (
    <div className="border-t border-[var(--color-border-subtle)] pt-4 mt-4">
      <h4 className="text-xs font-medium mb-2 flex items-center gap-1.5">
        <Upload className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        Git Sync
      </h4>
      <div className="text-2xs space-y-1.5" style={{ color: 'var(--color-text-secondary)' }}>
        {status.hasUncommittedChanges && (
          <p className="text-amber-400">Uncommitted changes in graph</p>
        )}
        {status.unpushedCommits > 0 && (
          <p className="text-amber-400">
            {status.unpushedCommits} unpushed commit{status.unpushedCommits !== 1 ? 's' : ''}
          </p>
        )}
        {!hasChanges && (
          <p style={{ color: 'var(--color-text-muted)' }}>Up to date with remote</p>
        )}
      </div>
      {hasChanges && (
        <button
          onClick={() => gitPush.mutate()}
          disabled={gitPush.isPending}
          className="btn text-xs mt-2 flex items-center gap-1.5 bg-honey-500/10 text-honey-500 hover:bg-honey-500/20"
        >
          <Upload className="w-3.5 h-3.5" />
          {gitPush.isPending ? 'Pushing...' : 'Commit & Push'}
        </button>
      )}
      {gitPush.isSuccess && (
        <p className="text-2xs text-emerald-400 mt-1.5">Pushed successfully</p>
      )}
      {gitPush.error && (
        <p className="text-2xs text-red-400 mt-1.5">{(gitPush.error as Error).message}</p>
      )}
    </div>
  );
}

// ============================================================================
// Task Graph Settings Dialog
// ============================================================================

function TaskGraphSettingsDialog({
  open,
  onClose,
  resource,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  resource: SyncableResource;
  onDelete: () => void;
}) {
  const meta = resource.metadata as Record<string, unknown> | null;
  const otConfig = (meta?.opentasks_config ?? {}) as Record<string, unknown>;

  const [name, setName] = useState(resource.name);
  const [description, setDescription] = useState(resource.description || '');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const updateResource = useUpdateTaskResource();
  const isRemoteClone = resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror';
  const savedGitSync = (otConfig.sync as Record<string, unknown>)?.git as Record<string, unknown> | undefined;

  const [gitSyncEnabled, setGitSyncEnabled] = useState(!!savedGitSync?.enabled);
  const [autoCommit, setAutoCommit] = useState(savedGitSync?.autoCommit !== false);
  const [autoPush, setAutoPush] = useState(!!savedGitSync?.autoPush);
  const [autoPull, setAutoPull] = useState(!!savedGitSync?.autoPull);

  const gitSyncChanged = isRemoteClone && (
    gitSyncEnabled !== !!savedGitSync?.enabled ||
    (gitSyncEnabled && autoCommit !== (savedGitSync?.autoCommit !== false)) ||
    (gitSyncEnabled && autoPush !== !!savedGitSync?.autoPush) ||
    (gitSyncEnabled && autoPull !== !!savedGitSync?.autoPull)
  );

  const hasChanges = name !== resource.name || description !== (resource.description || '') || gitSyncChanged;

  const handleSave = () => {
    if (!name.trim()) return;
    const data: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || null,
    };

    if (gitSyncChanged) {
      const updatedConfig = {
        ...otConfig,
        sync: gitSyncEnabled
          ? { git: { enabled: true, autoCommit, autoPush, autoPull, pullOnStartup: true } }
          : undefined,
      };
      data.metadata = { ...meta, opentasks_config: updatedConfig };
    }

    updateResource.mutate(
      { resourceId: resource.id, data },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="max-w-md">
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-border-subtle)]">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-honey-500" />
          <span className="text-sm font-semibold">Task Graph Settings</span>
        </div>
        <button type="button" onClick={onClose} className="p-1 rounded hover:bg-white/5">
          <X className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Name */}
        <div>
          <label className="text-xs font-medium block mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input w-full text-sm"
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-xs font-medium block mb-1.5">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            className="input w-full text-sm"
          />
        </div>

        {/* Location (read-only) */}
        <div>
          <label className="text-xs font-medium block mb-1.5">Location</label>
          <div className="text-sm font-mono px-3 py-2 rounded-lg bg-white/5 space-y-1" style={{ color: 'var(--color-text-secondary)' }}>
            <p className="truncate">{resource.git_remote_url}</p>
            {isRemoteClone && resource.local_path && (
              <p className="text-2xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                Clone: {resource.local_path}
              </p>
            )}
          </div>
        </div>

        {/* Sync config */}
        <div>
          <label className="text-xs font-medium block mb-1.5">Sync</label>
          {isRemoteClone ? (
            <div className="space-y-2 p-3 rounded-lg bg-white/[0.02] border border-[var(--color-border-subtle)]">
              <ToggleSwitch
                checked={gitSyncEnabled}
                onChange={setGitSyncEnabled}
                label="Enable edits (git sync)"
              />
              {!gitSyncEnabled && (
                <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  Clone is read-only. Enable to commit and push changes back.
                </p>
              )}
              {gitSyncEnabled && (
                <div className="space-y-2 pt-1">
                  <ToggleSwitch checked={autoCommit} onChange={setAutoCommit} label="Auto-commit on save" />
                  <ToggleSwitch checked={autoPush} onChange={setAutoPush} label="Auto-push to remote" />
                  {!autoPush && (
                    <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                      Changes are committed locally. Push manually when ready.
                    </p>
                  )}
                  <ToggleSwitch checked={autoPull} onChange={setAutoPull} label="Auto-pull from remote" />
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs px-3 py-2 rounded-lg bg-white/5 font-mono" style={{ color: 'var(--color-text-secondary)' }}>
              {resource.sync_strategy || 'metadata'} (local)
            </p>
          )}
        </div>

        {/* Save button */}
        {hasChanges && (
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={!name.trim() || updateResource.isPending}
              className="btn btn-primary text-xs"
            >
              {updateResource.isPending ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}

        {updateResource.error && (
          <p className="text-xs text-red-400">{(updateResource.error as Error).message}</p>
        )}

        {/* Git sync status + push (for remote clones with sync enabled) */}
        {isRemoteClone && gitSyncEnabled && (
          <GitSyncSection resourceId={resource.id} />
        )}

        {/* Danger zone */}
        <div className="border-t border-[var(--color-border-subtle)] pt-4 mt-4">
          <h4 className="text-xs font-medium text-red-400 mb-2">Danger Zone</h4>
          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="btn text-xs text-red-400 bg-red-500/10 hover:bg-red-500/20 flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Remove Task Graph
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <p className="text-xs text-red-400">Are you sure? This cannot be undone.</p>
              <button
                onClick={() => { onDelete(); onClose(); }}
                className="btn text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30"
              >
                Delete
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="btn btn-ghost text-xs"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ============================================================================
// Task Resource Card (persistent OpenTasks graphs)
// ============================================================================

function CardWrapper({ resourceId, onNavigate, children }: { resourceId: string; onNavigate?: (id: string) => void; children: React.ReactNode }) {
  if (onNavigate) {
    return <div onClick={() => onNavigate(resourceId)} className="flex-1 flex items-start gap-4 p-4 cursor-pointer">{children}</div>;
  }
  return <Link to={`/tasks?g=${resourceId}`} className="flex-1 flex items-start gap-4 p-4">{children}</Link>;
}

function TaskResourceCard({
  resource,
  onDelete,
  onNavigate,
}: {
  resource: SyncableResource;
  onDelete: (id: string) => void;
  onNavigate?: (id: string) => void;
}) {
  const { data: summary, isError } = useOpenTasksSummary(resource.id);
  const meta = resource.metadata as Record<string, unknown> | null;
  const counts = summary?.task_counts;
  const remoteInfo = (summary as Record<string, unknown> | undefined)?.remote_info as
    { swarm_id?: string; swarm_name?: string; swarm_path?: string; connected_at?: string } | undefined;
  const [showSettings, setShowSettings] = useState(false);

  const isRemoteWithSync = (resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror') &&
    !!(meta?.opentasks_config as Record<string, unknown> | undefined)?.sync;
  const { data: gitStatus } = useGitSyncStatus(resource.id, isRemoteWithSync);
  const gitPush = useGitPush(resource.id);
  const hasUnpushedCommits = gitStatus && gitStatus.unpushedCommits > 0;
  const hasUncommitted = gitStatus && gitStatus.hasUncommittedChanges;
  const needsPush = hasUnpushedCommits || hasUncommitted;

  const isEmpty = summary && summary.node_count === 0;
  const isConnected = summary?.daemon_connected === true;
  const isRemoteClone = resource.sync_strategy === 'ls-remote' || resource.sync_strategy === 'mirror';
  const otConfig = (meta?.opentasks_config ?? {}) as Record<string, unknown>;
  const gitSyncConfig = (otConfig.sync as Record<string, unknown>)?.git as Record<string, unknown> | undefined;
  const hasGitSync = !!gitSyncConfig?.enabled;

  // Status: green = connected with data, amber = connected but empty, gray = unreachable
  const statusColor = isError
    ? 'bg-zinc-500'
    : isConnected && !isEmpty
      ? 'bg-emerald-400'
      : isConnected && isEmpty
        ? 'bg-amber-400'
        : summary
          ? 'bg-amber-400'
          : 'bg-zinc-700';

  const statusTitle = isError
    ? 'Unreachable — daemon could not start'
    : isConnected && isEmpty
      ? 'Connected — empty graph (needs initialization)'
      : isConnected
        ? 'Daemon connected'
        : summary
          ? 'Daemon offline'
          : 'Loading...';

  return (
    <div className="card card-hover flex items-start gap-4 group relative">
      <CardWrapper resourceId={resource.id} onNavigate={onNavigate}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
              {resource.name}
            </h3>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} title={statusTitle} />
          </div>

          {resource.description && (
            <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
              {resource.description}
            </p>
          )}

          {resource.git_remote_url && (
            <p className="text-2xs font-mono truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              {resource.git_remote_url}
            </p>
          )}

          {/* Show remote swarm location when connected */}
          {remoteInfo && (
            <p className="text-2xs truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              {remoteInfo.swarm_name && (
                <span className="font-medium">{remoteInfo.swarm_name}</span>
              )}
              {remoteInfo.swarm_path && (
                <span className="font-mono ml-1">{remoteInfo.swarm_path}</span>
              )}
            </p>
          )}

          {isError && (
            <p className="text-2xs mt-1 text-red-400">
              Could not connect — run <code className="font-mono bg-white/5 px-1 rounded">opentasks init</code> in the project directory
            </p>
          )}

          {isConnected && isEmpty && (
            <p className="text-2xs mt-1 text-amber-400">
              Empty graph — create tasks or connect a swarm
            </p>
          )}

          {isRemoteClone && !hasGitSync && (
            <span className="text-2xs mt-1 inline-block px-1.5 py-0.5 rounded bg-white/5" style={{ color: 'var(--color-text-muted)' }}>
              read-only
            </span>
          )}

          {/* Status counts row */}
          {counts && (
            <div className="flex items-center gap-3 mt-2">
              {Object.entries(counts).map(([status, count]) => {
                if (!count) return null;
                const chip = taskStatusToChip(status);
                return (
                  <StatusChip
                    key={status}
                    label={`${count} ${chip.label}`}
                    tone={chip.tone}
                    icon={chip.Icon}
                    shape="square"
                    size="sm"
                  />
                );
              })}
            </div>
          )}

          {/* Meta row — use live summary data, fall back to stale metadata */}
          <div className="flex items-center gap-3 mt-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {(summary?.node_count ?? meta?.node_count as number | undefined) != null && (
              <span className="flex items-center gap-1">
                <Network className="w-3 h-3" />
                {summary?.node_count ?? meta?.node_count} nodes
              </span>
            )}
            {(summary?.edge_count ?? meta?.edge_count as number | undefined) != null && (
              <span className="flex items-center gap-1">
                <Zap className="w-3 h-3" />
                {summary?.edge_count ?? meta?.edge_count} edges
              </span>
            )}
            {summary?.ready_count != null && summary.ready_count > 0 &&
              summary.ready_count !== (counts?.open ?? 0) && (
              <span className="flex items-center gap-1 text-emerald-400">
                <Zap className="w-3 h-3" />
                {summary.ready_count} ready
              </span>
            )}
            {resource.last_push_at && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <TimeAgo date={resource.last_push_at} />
              </span>
            )}
          </div>
        </div>

        <ChevronRight
          className="w-4 h-4 shrink-0 mt-1 opacity-0 group-hover:opacity-50 transition-opacity"
          style={{ color: 'var(--color-text-muted)' }}
        />
      </CardWrapper>

      {/* Card actions (top-right) */}
      <div className="absolute top-3 right-3 flex items-center gap-1">
        {needsPush && (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); gitPush.mutate(); }}
            disabled={gitPush.isPending}
            className="p-1.5 rounded text-amber-400 hover:bg-amber-500/10 transition-opacity cursor-pointer"
            title={hasUnpushedCommits
              ? `${gitStatus!.unpushedCommits} unpushed commit${gitStatus!.unpushedCommits !== 1 ? 's' : ''} — click to push`
              : 'Uncommitted changes — click to commit & push'}
          >
            <Upload className={`w-3.5 h-3.5 ${gitPush.isPending ? 'animate-pulse' : ''}`} />
          </button>
        )}
        <button
          onClick={(e) => { e.preventDefault(); setShowSettings(true); }}
          className="p-1.5 rounded hover:bg-white/10 cursor-pointer"
          title="Task graph settings"
        >
          <Settings className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </button>
      </div>

      {/* Settings dialog */}
      <TaskGraphSettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        resource={resource}
        onDelete={() => onDelete(resource.id)}
      />
    </div>
  );
}

// ============================================================================
// Tasks Page
// ============================================================================

const LAST_GRAPH_KEY = 'openhive-last-task-graph';

// ============================================================================
// TaskGraphList — reusable list of task graphs (used standalone and in dialog)
// ============================================================================

export function TaskGraphList({ onNavigate }: { onNavigate?: (id: string) => void }) {
  const [showAddForm, setShowAddForm] = useState(false);
  const { data: resourcesData, isLoading: resourcesLoading } = useResourcesByType('task');
  const { data: connectedGraphs } = useConnectedTaskGraphs();
  const deleteResource = useDeleteTaskResource();
  useResourcesRealtime();
  useTasksRealtime();

  const allResources = resourcesData?.data || [];
  const resources = allResources.filter(
    (r) => !r.git_remote_url.startsWith('remote://') && !r.git_remote_url.startsWith('map://'),
  );
  const liveGraphs = connectedGraphs?.data || [];

  if (resourcesLoading) return <PageLoader />;

  const hasContent = resources.length > 0 || liveGraphs.length > 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-8">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/tasks" className="btn-ghost p-1" title="Back to workspace">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold">Task Graphs</h1>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Manage OpenTasks resources.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowAddForm(true)}
          className={`btn text-xs flex items-center gap-1.5 ${!hasContent ? 'btn-primary' : 'btn-ghost'}`}
        >
          <Plus className="w-3.5 h-3.5" />
          Add Task Graph
        </button>
      </div>

      {/* Add dialog */}
      <AddTaskRepoDialog
        open={showAddForm}
        onClose={() => setShowAddForm(false)}
        existingPaths={new Set(resources.map((r) => r.git_remote_url))}
      />

      {/* Persistent task resources */}
      <section>
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Network className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          Task Graphs
          {resources.length > 0 && (
            <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
              {resources.length} resource{resources.length !== 1 ? 's' : ''}
            </span>
          )}
        </h2>

        {resources.length === 0 && !showAddForm ? (
          <EmptyState
            icon={Network}
            title="No task graphs yet"
            description="Add an OpenTasks directory to get started, or connect a swarm with task support."
            action={
              <button
                onClick={() => setShowAddForm(true)}
                className="btn btn-primary text-xs inline-flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Task Graph
              </button>
            }
          />
        ) : (
          <div className="space-y-2">
            {resources.map((resource) => (
              <TaskResourceCard
                key={resource.id}
                resource={resource}
                onDelete={(id) => deleteResource.mutate(id)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
      </section>

      {/* Connected swarm task graphs (ephemeral) */}
      {liveGraphs.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Radio className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
            Connected Swarms
            <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
              {liveGraphs.length} live
            </span>
          </h2>
          <div className="space-y-2">
            {liveGraphs.map((graph) => (
              <div
                key={graph.swarm_id}
                className="card p-4 flex items-start gap-4"
              >
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                  style={{ backgroundColor: 'var(--color-elevated)' }}
                >
                  <Radio className="w-5 h-5 text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-sm truncate">
                      {graph.swarm_name || graph.swarm_id}
                    </h3>
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Connected" />
                  </div>
                  {graph.path && (
                    <p className="text-2xs font-mono truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                      {graph.path}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                    {graph.location_hash && (
                      <span className="font-mono">{graph.location_hash}</span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <TimeAgo date={graph.connected_at} />
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

