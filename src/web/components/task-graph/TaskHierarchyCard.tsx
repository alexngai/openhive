/**
 * TaskHierarchyCard — React Flow custom-node renderer for the Hierarchy view.
 *
 * Two visual variants on one component:
 *   - regular task → wraps the path-A `TaskNodeCard` so both views share DNA.
 *   - leaf-cluster → distinct "+N more" pill; click toggles expansion.
 *
 * Hover/select are driven by React Flow's built-in `selected` + custom events
 * lifted to `TaskHierarchyView`. Handles are hidden — edges anchor to the
 * card body, no connection UI in v1.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Layers } from 'lucide-react';
import type { OpenTasksGraphNode, MapSwarm } from '../../lib/api';
import { TaskNodeCard, type TaskCardSwarmInfo } from './TaskNodeCard';
import { STATUS_COLORS } from './useTaskGraph';
import { CLUSTER_NODE_TYPE } from './layout/leafClustering';
import {
  HIERARCHY_CARD_WIDTH,
  HIERARCHY_CARD_HEIGHT,
  HIERARCHY_CLUSTER_HEIGHT,
} from './layout/elkHierarchyLayout';

export interface TaskHierarchyCardData {
  node: OpenTasksGraphNode;
  swarm: TaskCardSwarmInfo | null;
  sourceColor?: string | null;
  colorMode: 'status' | 'swarm';
  /** Cluster expansion handler — only meaningful for cluster nodes. */
  onToggleCluster?: (clusterId: string) => void;
}

function TaskHierarchyCardInner({ data, selected }: NodeProps<TaskHierarchyCardData>) {
  const node = data.node;
  if (node.type === CLUSTER_NODE_TYPE) {
    return <ClusterCard data={data} selected={!!selected} />;
  }
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        style={{ opacity: 0, background: 'transparent', border: 'none' }}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0, background: 'transparent', border: 'none' }}
        isConnectable={false}
      />
      <div style={{ width: HIERARCHY_CARD_WIDTH, height: HIERARCHY_CARD_HEIGHT }}>
        <TaskNodeCard
          node={node}
          selected={selected}
          sourceColor={data.sourceColor ?? null}
          swarm={data.swarm}
          swarmColored={data.colorMode === 'swarm'}
        />
      </div>
    </>
  );
}

function ClusterCard({
  data,
  selected,
}: {
  data: TaskHierarchyCardData;
  selected: boolean;
}) {
  const node = data.node;
  const status = node.status ?? 'open';
  const stripeColor = STATUS_COLORS[status] ?? STATUS_COLORS.open;
  const onToggle = data.onToggleCluster;
  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        style={{ opacity: 0, background: 'transparent', border: 'none' }}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0, background: 'transparent', border: 'none' }}
        isConnectable={false}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.(node.id);
        }}
        style={{
          width: HIERARCHY_CARD_WIDTH,
          height: HIERARCHY_CLUSTER_HEIGHT,
          background: 'var(--color-elevated)',
          borderRadius: 6,
          borderStyle: 'dashed',
          borderWidth: selected ? 2 : 1,
          borderColor: selected
            ? 'var(--color-accent)'
            : 'var(--color-border)',
          color: 'var(--color-text)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          cursor: 'pointer',
          fontSize: 12,
        }}
        title="Click to expand"
      >
        <span
          style={{
            width: 3,
            height: 32,
            background: stripeColor,
            marginLeft: -12,
            marginRight: 6,
            borderRadius: 2,
          }}
        />
        <Layers size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span style={{ fontWeight: 600 }}>{node.title || node.id}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: 'var(--color-text-muted)',
          }}
        >
          expand
        </span>
      </button>
    </>
  );
}

export const TaskHierarchyCard = memo(TaskHierarchyCardInner);

/** Resolver for the source-color border accent (multi-graph mode). */
export function resolveSourceColor(
  node: OpenTasksGraphNode,
): string | null {
  const sc = (node as { _sourceColor?: string })._sourceColor;
  return sc ?? null;
}

/** Reused from the path-A overlay — same palette so cards across views match. */
const SWARM_PALETTE = [
  '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6',
  '#ec4899', '#06b6d4', '#ef4444', '#84cc16',
  '#f97316', '#14b8a6',
];
const SWARM_UNASSIGNED_COLOR = '#4b5563';

export function swarmColorFor(swarmId: string): string {
  let h = 0;
  for (let i = 0; i < swarmId.length; i++) {
    h = ((h << 5) - h + swarmId.charCodeAt(i)) | 0;
  }
  return SWARM_PALETTE[Math.abs(h) % SWARM_PALETTE.length];
}

export { SWARM_UNASSIGNED_COLOR };
