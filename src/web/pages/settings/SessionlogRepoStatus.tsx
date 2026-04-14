import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, AlertCircle, GitBranch, Folder, Wifi, WifiOff, Clock, ArrowDownToLine, ArrowUpFromLine, Download } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { TimeAgo } from '../../components/common/TimeAgo';

interface ActionResult {
  ok: boolean;
  error: string | null;
  stderr: string | null;
  status: RepoStatus;
}

type RepoStatus =
  | { state: 'not-configured' }
  | {
      state: 'configured';
      remote: string;
      clonePath: string;
      clonePathExplicit: boolean;
      cloneExists: boolean;
      lastFetchedAt: string | null;
      remoteReachable: boolean | null;
      checkpointsBranch: string | null;
      ahead: number | null;
      behind: number | null;
      autoPush: boolean;
      lastError: string | null;
    };

/**
 * Read-only panel showing the live state of sessionlog's session repo:
 * clone existence, remote reachability, ahead/behind, last fetch.
 *
 * Rendered inside the sessionlog package card when the project has
 * sessionRepo.remote configured.
 */
export function SessionlogRepoStatus({ projectRoot }: { projectRoot: string | null }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<RepoStatus>({
    queryKey: ['sessionlog-repo-status', projectRoot],
    queryFn: () =>
      api.get(
        `/admin/swarmkit/sessionlog/repo-status?projectRoot=${encodeURIComponent(projectRoot ?? '')}`,
      ),
    enabled: !!projectRoot,
    refetchInterval: 30_000,
  });

  const runAction = useMutation({
    mutationFn: ({ action }: { action: 'fetch' | 'push' | 'clone' }) =>
      api.post<ActionResult>(`/admin/swarmkit/sessionlog/repo/${action}`, { projectRoot }),
    onSuccess: (result, { action }) => {
      queryClient.invalidateQueries({ queryKey: ['sessionlog-repo-status', projectRoot] });
      if (result.ok) {
        toast.success(`${action} succeeded`);
      } else {
        toast.error(`${action} failed: ${result.error ?? 'unknown'}`);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Request failed');
    },
  });

  if (!projectRoot || isLoading) return null;
  if (error || !data) return null;
  if (data.state === 'not-configured') return null;

  const pending = runAction.isPending;

  return (
    <div
      className="mt-3 rounded border p-2 space-y-1.5"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-elevated)' }}
    >
      <div className="flex items-center justify-between mb-1">
        <div
          className="text-2xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--color-text-muted)', fontSize: '9px' }}
        >
          Session repo status
        </div>
        <div className="flex items-center gap-1">
          {!data.cloneExists && (
            <ActionButton
              icon={<Download className="w-3 h-3" />}
              label="Clone"
              onClick={() => runAction.mutate({ action: 'clone' })}
              disabled={pending}
            />
          )}
          {data.cloneExists && (
            <ActionButton
              icon={<ArrowDownToLine className="w-3 h-3" />}
              label="Fetch"
              onClick={() => runAction.mutate({ action: 'fetch' })}
              disabled={pending}
            />
          )}
          {data.cloneExists && data.checkpointsBranch && (
            <ActionButton
              icon={<ArrowUpFromLine className="w-3 h-3" />}
              label="Push"
              onClick={() => runAction.mutate({ action: 'push' })}
              disabled={pending || data.ahead === 0}
              title={data.ahead === 0 ? 'Nothing to push' : undefined}
            />
          )}
        </div>
      </div>

      <StatusRow
        icon={data.cloneExists ? <CheckCircle2 className="w-3 h-3 text-green-500" /> : <XCircle className="w-3 h-3 text-amber-500" />}
        label="Local clone"
        value={
          <span className="flex items-center gap-1">
            <Folder className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
            <span className="font-mono" style={{ fontSize: '10px' }}>{data.clonePath}</span>
            {!data.clonePathExplicit && (
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)', fontSize: '9px' }}>
                (auto)
              </span>
            )}
          </span>
        }
        hint={data.cloneExists ? null : 'not yet cloned'}
      />

      <StatusRow
        icon={
          data.remoteReachable === true
            ? <Wifi className="w-3 h-3 text-green-500" />
            : data.remoteReachable === false
              ? <WifiOff className="w-3 h-3 text-red-500" />
              : <AlertCircle className="w-3 h-3 text-amber-500" />
        }
        label="Remote"
        value={
          <span className="font-mono" style={{ fontSize: '10px' }}>{data.remote}</span>
        }
        hint={
          data.remoteReachable === true
            ? 'reachable'
            : data.remoteReachable === false
              ? 'unreachable (or auth missing)'
              : 'unknown'
        }
      />

      {data.lastFetchedAt && (
        <StatusRow
          icon={<Clock className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />}
          label="Last fetch"
          value={<TimeAgo date={data.lastFetchedAt} />}
          hint={null}
        />
      )}

      {data.checkpointsBranch && (
        <StatusRow
          icon={<GitBranch className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />}
          label="Checkpoints branch"
          value={<span className="font-mono" style={{ fontSize: '10px' }}>{data.checkpointsBranch}</span>}
          hint={
            data.ahead !== null && data.behind !== null
              ? `${data.ahead} ahead, ${data.behind} behind`
              : !data.cloneExists
                ? null
                : 'not yet compared'
          }
        />
      )}

      {data.autoPush && (
        <div className="text-2xs pl-4" style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}>
          Auto-push is on — sessionlog pushes checkpoints after each commit.
        </div>
      )}

      {data.lastError && (
        <div
          className="text-2xs pl-4 mt-1"
          style={{ color: 'rgb(239, 68, 68)', fontSize: '10px' }}
        >
          {data.lastError}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded bg-honey-500/10 text-honey-500 hover:bg-honey-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ fontSize: '10px' }}
    >
      {icon}
      {label}
    </button>
  );
}

function StatusRow({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint: string | null;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="pt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div
          className="text-2xs"
          style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}
        >
          {label}
        </div>
        <div className="text-2xs break-all">{value}</div>
        {hint && (
          <div
            className="text-2xs"
            style={{ color: 'var(--color-text-muted)', fontSize: '9px' }}
          >
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}
