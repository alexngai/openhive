import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Send, Zap, FileText, User, Bot, Ban, AlertCircle, GitBranch, GitCommit,
  ListChecks, CheckCircle2, Circle,
} from 'lucide-react';
import { useDispatch, useCancelDispatch } from '../hooks/useDispatch';
import {
  useDispatchRealtime,
  useCancelAckWarnings,
  useMaterializationWarnings,
} from '../hooks/useDispatchRealtime';
import { useMapSwarm, useSessionsList, useCascadeDAG } from '../hooks/useApi';
import { useSpec } from '../hooks/useSpecs';
import { DispatchStatusChip } from '../components/dispatch/DispatchStatusChip';
import { AttemptsTimeline } from '../components/dispatch/AttemptsTimeline';
import { StreamStatusDot } from '../components/streams/shared';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import { usePageContext } from '../components/chat-fab/usePageContext';
import {
  dispatchContextItem,
  specContextItem,
  tasksContextItem,
} from '../components/chat-fab/context-types';
import type { ChatFabContextItem } from '../components/chat-fab/chat-fab-item';

export function DispatchDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useDispatch(id);
  const { data: swarm } = useMapSwarm(data?.dispatch.target_swarm_id ?? '');
  const { data: specResp } = useSpec(data?.dispatch.spec_resource_id, data?.dispatch.spec_id);
  const cancel = useCancelDispatch();
  const [cancelError, setCancelError] = useState<string | null>(null);
  useDispatchRealtime();
  const { warned: cancelNotAcked, dismiss: dismissCancelWarning } = useCancelAckWarnings(id);
  const { error: materializationError, dismiss: dismissMaterializationWarning } =
    useMaterializationWarnings(id);

  // Sessions + cascade streams on this swarm — used to compute which changes
  // (if any) were opened by agents that ran this dispatch. Heuristic match:
  // session.acp_target_agent_id (set when the dispatch spawned an ACP stream)
  // ∩ cascade.source_agent_id for streams on the same swarm.
  const { data: sessionsResp } = useSessionsList({
    swarm_id: data?.dispatch.target_swarm_id,
    limit: 100,
  });
  const { data: cascadeResp } = useCascadeDAG({
    source_swarm_id: data?.dispatch.target_swarm_id,
  });

  const relatedChanges = useMemo(() => {
    if (!data || !sessionsResp || !cascadeResp?.data) return [];
    const sessionIds = new Set(data.dispatch.session_ids);
    const agentIds = new Set<string>();
    for (const s of sessionsResp.data) {
      if (sessionIds.has(s.id) && s.acp_target_agent_id) {
        agentIds.add(s.acp_target_agent_id);
      }
    }
    if (agentIds.size === 0) return [];
    return cascadeResp.data.nodes.filter((n) => agentIds.has(n.source_agent_id));
  }, [data, sessionsResp, cascadeResp]);

  // Declare this page's chat context items. Re-runs when the dispatch,
  // source spec, or linked tasks change; cleared on unmount. Must stay
  // unconditional so hook order is stable across loading/error returns.
  const dispatchRec = data?.dispatch;
  const sourceSpec = specResp?.spec;
  const linkedTasks = data?.linked_tasks;
  usePageContext(
    () => {
      if (!dispatchRec) return [];
      const latest = dispatchRec.attempts_history?.length
        ? dispatchRec.attempts_history[dispatchRec.attempts_history.length - 1]
        : undefined;
      const items: ChatFabContextItem[] = [
        dispatchContextItem(
          {
            id: dispatchRec.id,
            spec_id: dispatchRec.spec_id,
            target_swarm_id: dispatchRec.target_swarm_id,
            status: dispatchRec.status,
            created_at: dispatchRec.created_at,
            latest_attempt: latest
              ? {
                  attempt: latest.attempt,
                  status: latest.status,
                  started_at: latest.started_at,
                  error: latest.error,
                }
              : undefined,
          },
          { primary: true },
        ),
      ];
      if (sourceSpec) {
        items.push(
          specContextItem({
            id: sourceSpec.id,
            resource_id: sourceSpec.resource_id,
            title: sourceSpec.title,
            content: sourceSpec.content ?? '',
          }),
        );
      }
      // `linked_tasks` on the dispatch carries `{ resource_id, node_id }`
      // refs — best-effort mapping to the TaskRef shape the registry
      // expects. Titles/statuses aren't on the payload without a new
      // fetch, so the block renders ids alone.
      if (linkedTasks && linkedTasks.length > 0) {
        items.push(
          tasksContextItem(
            linkedTasks.map((t) => ({ id: t.node_id })),
          ),
        );
      }
      return items;
    },
    [dispatchRec, sourceSpec, linkedTasks],
  );

  if (isLoading) return <PageLoader />;

  if (error || !data) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link
          to="/dispatch"
          className="inline-flex items-center gap-1 text-sm mb-4"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dispatch
        </Link>
        <div
          className="rounded-md border p-4 text-sm"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          {error ? `Failed to load: ${error instanceof Error ? error.message : String(error)}` : 'Dispatch not found'}
        </div>
      </div>
    );
  }

  const d = data.dispatch;
  const InitiatorIcon = d.initiator_type === 'agent' ? Bot : User;
  const isCancellable = d.status === 'queued' || d.status === 'running';

  const handleCancel = async () => {
    if (!d.id) return;
    setCancelError(null);
    try {
      await cancel.mutateAsync(d.id);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to="/dispatch"
        className="inline-flex items-center gap-1 text-sm mb-4 hover:opacity-80"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Dispatch
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <Send className="h-4 w-4 text-honey-500" />
          <span className="font-mono">{d.id}</span>
          <span>·</span>
          <TimeAgo date={d.created_at} />
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <DispatchStatusChip status={d.status} />
          </div>
          {isCancellable && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancel.isPending}
              className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Ban className="h-4 w-4" />
              {cancel.isPending ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>

        {cancelError && (
          <div
            className="mt-2 rounded-md border p-2 text-sm flex items-start gap-2"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text)',
            }}
          >
            <AlertCircle className="h-4 w-4 mt-0.5 text-red-400" />
            <div>{cancelError}</div>
          </div>
        )}

        {cancelNotAcked && (
          <div
            className="mt-2 rounded-md border p-2 text-sm flex items-start gap-2"
            style={{
              borderColor: 'rgba(245, 158, 11, 0.4)',
              backgroundColor: 'rgba(245, 158, 11, 0.05)',
              color: 'var(--color-text)',
            }}
          >
            <AlertCircle className="h-4 w-4 mt-0.5 text-amber-400" />
            <div className="flex-1">
              <div className="font-medium">Agent did not acknowledge cancel</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                The target swarm was unreachable or dropped the cancel signal. The hub
                still marked this dispatch as cancelled; the agent may have continued
                working until its stream closed.
              </div>
            </div>
            <button
              type="button"
              onClick={dismissCancelWarning}
              className="text-xs opacity-70 hover:opacity-100"
              style={{ color: 'var(--color-text-muted)' }}
            >
              dismiss
            </button>
          </div>
        )}

        {materializationError && (
          <div
            className="mt-2 rounded-md border p-2 text-sm flex items-start gap-2"
            style={{
              borderColor: 'rgba(245, 158, 11, 0.4)',
              backgroundColor: 'rgba(245, 158, 11, 0.05)',
              color: 'var(--color-text)',
            }}
          >
            <AlertCircle className="h-4 w-4 mt-0.5 text-amber-400" />
            <div className="flex-1">
              <div className="font-medium">Loadout materialization failed</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                The bound loadout could not be resolved
                {materializationError !== 'unknown error' ? (
                  <> (<span className="font-mono">{materializationError}</span>)</>
                ) : null}
                . The dispatch is proceeding without it — the agent will run with
                its default permissions and skill set.
              </div>
            </div>
            <button
              type="button"
              onClick={dismissMaterializationWarning}
              className="text-xs opacity-70 hover:opacity-100"
              style={{ color: 'var(--color-text-muted)' }}
            >
              dismiss
            </button>
          </div>
        )}
      </div>

      {/* Metadata grid */}
      <div
        className="grid gap-3 md:grid-cols-2 rounded-md border p-4 mb-6"
        style={{
          borderColor: 'var(--color-border-subtle)',
          backgroundColor: 'var(--color-surface)',
        }}
      >
        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Spec
          </div>
          <Link
            to={`/specs/${d.spec_resource_id}/${d.spec_id}`}
            className="inline-flex items-center gap-1 hover:opacity-80 min-w-0"
            style={{ color: 'var(--color-text)' }}
          >
            <FileText className="h-4 w-4 text-honey-500 shrink-0" />
            <span className="text-sm truncate">
              {specResp?.spec.title ?? d.spec_id}
            </span>
          </Link>
        </div>

        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Target swarm
          </div>
          <Link
            to={`/swarms/${d.target_swarm_id}`}
            className="inline-flex items-center gap-1 hover:opacity-80"
            style={{ color: 'var(--color-text)' }}
          >
            <Zap className="h-4 w-4 text-honey-500" />
            <span className="text-sm">{swarm?.name ?? d.target_swarm_id}</span>
          </Link>
        </div>

        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Initiator
          </div>
          <span
            className="inline-flex items-center gap-1 text-sm"
            style={{ color: 'var(--color-text)' }}
          >
            <InitiatorIcon className="h-4 w-4" />
            <span>{d.initiator_type}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>·</span>
            <span className="font-mono text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {d.initiator_id}
            </span>
          </span>
        </div>

        <div>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Spec captured at
          </div>
          <span className="text-sm" style={{ color: 'var(--color-text)' }}>
            {d.spec_captured_at ? <TimeAgo date={d.spec_captured_at} /> : '—'}
          </span>
        </div>

        {(d.acp_lifecycle || d.mail_lifecycle) && (
          <div className="md:col-span-2">
            <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Routing
            </div>
            <div className="flex flex-wrap gap-3 text-sm" style={{ color: 'var(--color-text)' }}>
              {d.acp_lifecycle && (
                <LifecycleChip transport="ACP" value={d.acp_lifecycle} />
              )}
              {d.mail_lifecycle && (
                <LifecycleChip transport="Mail" value={d.mail_lifecycle} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Prompt override */}
      {d.prompt_override && (
        <div
          className="rounded-md border p-4 mb-6"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Additional instructions
          </div>
          <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--color-text)' }}>
            {d.prompt_override}
          </p>
        </div>
      )}

      {/* Sessions */}
      {d.session_ids.length > 0 && (
        <div
          className="rounded-md border p-4 mb-6"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Sessions
          </div>
          <ul className="space-y-1">
            {d.session_ids.map((sid) => (
              <li key={sid}>
                <Link
                  to={`/threads/${sid}`}
                  className="text-sm font-mono hover:opacity-80"
                  style={{ color: 'var(--color-text)' }}
                >
                  {sid}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Changes opened during this dispatch — heuristic match on agent id. */}
      {relatedChanges.length > 0 && (
        <div
          className="rounded-md border p-4 mb-6"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
              <GitBranch className="h-3.5 w-3.5 text-honey-500" />
              Changes opened
            </div>
            <Link
              to="/changes"
              className="text-2xs hover:opacity-80"
              style={{ color: 'var(--color-text-muted)' }}
            >
              View all →
            </Link>
          </div>
          <ul className="space-y-1.5">
            {relatedChanges.map((n) => (
              <li key={n.id}>
                <Link
                  to="/changes"
                  className="flex items-center gap-2 text-sm hover:opacity-80"
                  style={{ color: 'var(--color-text)' }}
                >
                  <StreamStatusDot status={n.status} />
                  <span className="truncate">{n.name || n.stream_id}</span>
                  <code
                    className="text-2xs font-mono px-1 py-0.5 rounded shrink-0"
                    style={{ backgroundColor: 'var(--color-elevated)' }}
                  >
                    {n.stream_id.slice(0, 8)}
                  </code>
                  <span
                    className="text-2xs flex items-center gap-1 shrink-0"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <GitCommit className="h-3 w-3" />
                    {n.commit_count}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Linked tasks — captured at dispatch creation; `advanced_on_start`
          reflects whether the orchestrator bumped the task `open` → `in_progress`. */}
      {data.linked_tasks && data.linked_tasks.length > 0 && (
        <div
          className="rounded-md border p-4 mb-6"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div className="text-xs mb-2 flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
            <ListChecks className="h-3.5 w-3.5 text-honey-500" />
            Linked tasks
          </div>
          <ul className="space-y-1.5">
            {data.linked_tasks.map((t) => {
              const advanced = Boolean(t.advanced_on_start);
              const Icon = advanced ? CheckCircle2 : Circle;
              return (
                <li key={`${t.resource_id}:${t.node_id}`}>
                  <Link
                    to={`/tasks/${t.resource_id}/${t.node_id}`}
                    className="flex items-center gap-2 text-sm hover:opacity-80"
                    style={{ color: 'var(--color-text)' }}
                  >
                    <Icon
                      className="h-3.5 w-3.5 shrink-0"
                      style={{ color: advanced ? 'var(--color-honey-500, #f59e0b)' : 'var(--color-text-muted)' }}
                    />
                    <code
                      className="text-2xs font-mono px-1 py-0.5 rounded shrink-0"
                      style={{ backgroundColor: 'var(--color-elevated)' }}
                    >
                      {t.node_id}
                    </code>
                    <span
                      className="text-2xs shrink-0"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {advanced ? 'advanced on start' : 'not advanced'}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Outcome */}
      {d.outcome && (
        <div
          className="rounded-md border p-4"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <div className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
            Outcome
          </div>
          {d.outcome.summary && (
            <p className="text-sm mb-2" style={{ color: 'var(--color-text)' }}>
              {d.outcome.summary}
            </p>
          )}
          {d.outcome.error && (
            <p className="text-sm mb-2 text-red-300">{d.outcome.error}</p>
          )}
          {d.outcome.artifacts && d.outcome.artifacts.length > 0 && (
            <ul className="space-y-1 text-sm">
              {d.outcome.artifacts.map((a, i) => {
                // cascade_stream refs are `${swarm_id}/${stream_id}` — the
                // Changes page groups streams fleet-wide; there's no
                // per-stream detail route so we link there.
                const isCascadeStream = a.kind === 'cascade_stream';
                const streamId = isCascadeStream ? a.ref.split('/').slice(1).join('/') : null;
                const body = (
                  <>
                    <span className="font-mono text-xs mr-2">{a.kind}</span>
                    {isCascadeStream ? (
                      <span className="inline-flex items-center gap-1">
                        <GitBranch className="h-3 w-3" />
                        <span>{streamId || a.ref}</span>
                      </span>
                    ) : (
                      <span>{a.ref}</span>
                    )}
                  </>
                );
                return (
                  <li key={i} style={{ color: 'var(--color-text-secondary)' }}>
                    {isCascadeStream ? (
                      <Link to="/changes" className="hover:opacity-80">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Attempt timeline — populated by the orchestrator event bridge. */}
      {d.attempts_history && d.attempts_history.length > 0 && (
        <AttemptsTimeline attempts={d.attempts_history} turnCount={d.turn_count} />
      )}

      {d.status === 'running' && d.session_ids.length === 0 && (
        <div
          className="rounded-md border p-3 text-xs flex items-start gap-2"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text-muted)',
          }}
        >
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <span>
            The dispatch orchestrator is managing this work. It will retry on failure
            and update the status automatically.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Compact display of an `acp_lifecycle` / `mail_lifecycle` hint. `fresh` means
 * the transport spawns a new agent for this dispatch (loadout permissions
 * enforced at spawn); `reuse` means it routes to an existing agent and the
 * loadout is advisory.
 */
function LifecycleChip({
  transport,
  value,
}: {
  transport: 'ACP' | 'Mail';
  value: 'fresh' | 'reuse';
}) {
  const tone =
    value === 'fresh'
      ? { color: 'var(--color-honey-500, #f59e0b)' }
      : { color: 'var(--color-text-muted)' };
  const explanation =
    value === 'fresh'
      ? 'spawns a new agent per dispatch with loadout permissions enforced at spawn'
      : 'routes to an existing agent; loadout is advisory only';
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm"
      title={explanation}
    >
      <span style={{ color: 'var(--color-text-muted)' }}>{transport}</span>
      <span className="font-mono text-xs" style={tone}>
        {value}
      </span>
    </span>
  );
}
