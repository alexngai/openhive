import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { FileText, GitBranch, ListTodo, Send, Clock } from 'lucide-react';
import clsx from 'clsx';
import { useCascadeDAG, type StreamDAGNode } from '../../hooks/useApi';
import { useDispatch, useDispatchList, type Dispatch } from '../../hooks/useDispatch';
import { useSchedules, getPayloadKind, type Schedule } from '../../hooks/useSchedules';
import { useSpec } from '../../hooks/useSpecs';

type LineageStage = 'spec' | 'job' | 'task' | 'change' | 'schedule';

export type PipelineLineageAnchor =
  | { kind: 'spec'; resourceId: string; specId: string; title?: string | null }
  | { kind: 'dispatch'; dispatchId: string }
  | { kind: 'task'; resourceId: string; nodeId: string; title?: string | null }
  | { kind: 'stream'; node: StreamDAGNode };

interface Segment {
  stage: LineageStage;
  label: string;
  value: string;
  to?: string;
  missing?: boolean;
  active?: boolean;
}

const STAGE_ICON = {
  spec: FileText,
  job: Send,
  task: ListTodo,
  change: GitBranch,
  schedule: Clock,
} satisfies Record<LineageStage, typeof FileText>;

function shortId(value: string | null | undefined, size = 10): string {
  if (!value) return 'None';
  return value.length > size ? `${value.slice(0, size)}...` : value;
}

function scheduleSpecRef(schedule: Schedule) {
  if (getPayloadKind(schedule.payload) !== 'dispatch_spec') return null;
  return schedule.payload.spec_ref;
}

function firstDispatch(dispatches: Dispatch[] | undefined): Dispatch | undefined {
  return dispatches?.[0];
}

export function usePipelineLineage(anchor: PipelineLineageAnchor): Segment[] {
  const dispatchId = anchor.kind === 'dispatch' ? anchor.dispatchId : undefined;
  const anchorTask =
    anchor.kind === 'task'
      ? { resourceId: anchor.resourceId, nodeId: anchor.nodeId, title: anchor.title }
      : anchor.kind === 'stream' && anchor.node.task_resource_id && anchor.node.task_node_id
        ? {
            resourceId: anchor.node.task_resource_id,
            nodeId: anchor.node.task_node_id,
            title: null,
          }
        : null;
  const anchorSpec =
    anchor.kind === 'spec'
      ? { resourceId: anchor.resourceId, specId: anchor.specId, title: anchor.title }
      : null;

  const dispatchDetail = useDispatch(dispatchId);
  const dispatchFromDetail = dispatchDetail.data?.dispatch;
  const linkedTasks = dispatchDetail.data?.linked_tasks ?? [];
  const linkedTask = linkedTasks[0];
  const taskForLookup = anchorTask || linkedTask
    ? {
        resourceId: anchorTask?.resourceId ?? linkedTask?.resource_id,
        nodeId: anchorTask?.nodeId ?? linkedTask?.node_id,
        title: anchorTask?.title ?? null,
      }
    : null;

  const dispatchesByTask = useDispatchList({
    task_resource_id: taskForLookup?.resourceId,
    task_node_id: taskForLookup?.nodeId,
    limit: 10,
    enabled: !!taskForLookup?.resourceId && !!taskForLookup?.nodeId && anchor.kind !== 'dispatch',
  });

  const dispatchSeed = dispatchFromDetail ?? firstDispatch(dispatchesByTask.data?.data);
  const specResourceId = anchorSpec?.resourceId ?? dispatchSeed?.spec_resource_id ?? undefined;
  const specId = anchorSpec?.specId ?? dispatchSeed?.spec_id ?? undefined;

  const specDetail = useSpec(specResourceId, specId);
  const dispatchesBySpec = useDispatchList({
    spec_resource_id: specResourceId,
    spec_id: specId,
    limit: 10,
    enabled: !!specResourceId && !!specId && anchor.kind === 'spec',
  });
  const selectedDispatch = dispatchSeed ?? firstDispatch(dispatchesBySpec.data?.data);

  const schedules = useSchedules({
    limit: 200,
    enabled: !!specResourceId && !!specId,
  });

  const cascade = useCascadeDAG({
    task_resource_id: taskForLookup?.resourceId,
    enabled: !!taskForLookup?.resourceId,
  });

  return useMemo(() => {
    const specTitle = anchorSpec?.title
      ?? specDetail.data?.spec.title
      ?? specId
      ?? 'No spec';
    const matchingSchedule = schedules.data?.data.find((s) => {
      const ref = scheduleSpecRef(s);
      return ref?.resource_id === specResourceId && ref?.spec_id === specId;
    });
    const taskNodes = selectedDispatch
      ? linkedTasks
      : taskForLookup
        ? [{ resource_id: taskForLookup.resourceId, node_id: taskForLookup.nodeId }]
        : specDetail.data?.linked.tasks.map((t) => ({
            resource_id: specResourceId ?? '',
            node_id: t.id,
          })) ?? [];
    const streamNode =
      anchor.kind === 'stream'
        ? anchor.node
        : cascade.data?.data.nodes.find((n) =>
            taskNodes.some((t) => t.resource_id === n.task_resource_id && t.node_id === n.task_node_id),
          );

    return [
      {
        stage: 'spec',
        label: 'Spec',
        value: specTitle,
        to: specResourceId && specId ? `/specs/${specResourceId}/${specId}` : undefined,
        missing: !specResourceId || !specId,
        active: anchor.kind === 'spec',
      },
      {
        stage: 'job',
        label: 'Job',
        value: selectedDispatch ? shortId(selectedDispatch.id, 12) : 'No job',
        to: selectedDispatch ? `/dispatch/${selectedDispatch.id}` : undefined,
        missing: !selectedDispatch,
        active: anchor.kind === 'dispatch',
      },
      {
        stage: 'task',
        label: taskNodes.length === 1 ? 'Task' : 'Tasks',
        value: taskNodes.length === 0
          ? 'No task'
          : taskNodes.length === 1
            ? shortId(taskNodes[0].node_id, 12)
            : `${taskNodes.length} tasks`,
        to: taskNodes.length === 1
          ? `/tasks/${taskNodes[0].resource_id}/${taskNodes[0].node_id}`
          : undefined,
        missing: taskNodes.length === 0,
        active: anchor.kind === 'task',
      },
      {
        stage: 'change',
        label: 'Change',
        value: streamNode ? (streamNode.name || shortId(streamNode.stream_id, 12)) : 'No change',
        to: streamNode ? `/changes?stream=${encodeURIComponent(streamNode.id)}` : undefined,
        missing: !streamNode,
        active: anchor.kind === 'stream',
      },
      {
        stage: 'schedule',
        label: 'Schedule',
        value: matchingSchedule ? shortId(matchingSchedule.id, 12) : 'Not scheduled',
        to: matchingSchedule ? `/schedules/${matchingSchedule.id}` : undefined,
        missing: !matchingSchedule,
      },
    ] satisfies Segment[];
  }, [
    anchor,
    anchorSpec,
    cascade.data,
    linkedTasks,
    schedules.data,
    selectedDispatch,
    specDetail.data,
    specId,
    specResourceId,
    taskForLookup,
  ]);
}

export function LineageRail({ anchor, className }: {
  anchor: PipelineLineageAnchor;
  className?: string;
}) {
  const segments = usePipelineLineage(anchor);

  return (
    <nav
      aria-label="Pipeline lineage"
      className={clsx(
        'flex items-center gap-1 overflow-x-auto rounded-md border px-2 py-1.5 text-2xs',
        className,
      )}
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      {segments.map((segment, index) => {
        const Icon = STAGE_ICON[segment.stage];
        const body = (
          <span
            className={clsx(
              'inline-flex items-center gap-1 rounded px-1.5 py-1 whitespace-nowrap',
              segment.active && 'font-semibold',
            )}
            style={{
              color: segment.missing
                ? 'var(--color-text-muted)'
                : segment.active
                  ? 'var(--color-accent)'
                  : 'var(--color-text-secondary)',
              backgroundColor: segment.active ? 'var(--color-accent-bg)' : 'transparent',
            }}
            title={`${segment.label}: ${segment.value}`}
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span className="font-medium">{segment.label}</span>
            <span className="truncate max-w-[12rem]">{segment.value}</span>
          </span>
        );
        return (
          <span key={segment.stage} className="inline-flex items-center gap-1 shrink-0">
            {index > 0 && <span style={{ color: 'var(--color-text-muted)' }}>›</span>}
            {segment.to && !segment.active ? (
              <Link to={segment.to} className="hover:opacity-80">
                {body}
              </Link>
            ) : body}
          </span>
        );
      })}
    </nav>
  );
}
