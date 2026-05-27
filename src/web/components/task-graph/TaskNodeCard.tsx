/**
 * TaskNodeCard — shared visual primitive for task nodes.
 *
 * Used by:
 *   - Path A: HTML overlay on top of the sigma Network view (always-visible
 *     cards instead of bare colored dots).
 *   - Path B (planned): React Flow nodes in the Hierarchy view.
 *
 * Pure presentational — the host is responsible for positioning (absolute via
 * transform for A, React Flow's layout for B). All hover / selection /
 * dimming state arrives as props.
 */

import { memo } from 'react';
import { AlertTriangle, Flag, Hash, User as UserIcon, Zap } from 'lucide-react';
import type { OpenTasksGraphNode, MapSwarm } from '../../lib/api';
import { STATUS_COLORS } from './useTaskGraph';

export const CARD_WIDTH = 224;
// Bumped from 64 → 88 so every text row can sit at the project's 11/12px
// floor without clipping. Keeps the card readable and WCAG-friendly at the
// cost of a slightly taller node — layout passes (dagre/elk noverlap) already
// read these constants, so changing them here flows through everywhere.
export const CARD_HEIGHT = 88;

/** Resolved swarm passed in from the host so the card itself does no lookups. */
export interface TaskCardSwarmInfo {
  id: string;
  name: string;
  color: string;
}

export interface TaskNodeCardProps {
  node: OpenTasksGraphNode;
  selected?: boolean;
  hovered?: boolean;
  /** True when another node is hovered and this card is not a neighbor. */
  dimmed?: boolean;
  /** Hex color for the source-graph border accent (multi-graph mode). */
  sourceColor?: string | null;
  /** Resolved swarm when colorMode='swarm' or for the swarm chip. */
  swarm?: TaskCardSwarmInfo | null;
  /** When true, the left status stripe is colored by swarm instead of status. */
  swarmColored?: boolean;
  /** True when this card is only in scope because it's an upstream blocker
   *  of an active task (not active itself). Renders at reduced opacity + a
   *  small "blocker" badge so the user knows why it appears. */
  isAncestor?: boolean;
}

const PRIORITY_LABELS: Record<number, { letter: string; tone: string }> = {
  1: { letter: 'P1', tone: '#6b7280' }, // low → gray
  2: { letter: 'P2', tone: '#3b82f6' }, // medium → blue
  3: { letter: 'P3', tone: '#f59e0b' }, // high → amber
  4: { letter: 'P4', tone: '#ef4444' }, // critical → red
};

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  completed: 'Done',
  failed: 'Failed',
};

const TYPE_BADGE: Record<string, string | null> = {
  task: null,
  milestone: 'Milestone',
  note: 'Note',
  context: 'Context',
  feedback: 'Feedback',
  external: 'External',
};

function TaskNodeCardInner({
  node,
  selected,
  hovered,
  dimmed,
  sourceColor,
  swarm,
  swarmColored,
  isAncestor,
}: TaskNodeCardProps) {
  const status = node.status ?? 'open';
  const statusColor = STATUS_COLORS[status] ?? STATUS_COLORS.open;
  const stripeColor = swarmColored && swarm ? swarm.color : statusColor;
  const isMilestone = node.type === 'milestone';
  const isAuxiliary =
    node.type === 'note' ||
    node.type === 'context' ||
    node.type === 'feedback' ||
    node.type === 'external';
  const priorityInfo =
    node.priority && node.priority > 0 ? PRIORITY_LABELS[node.priority] : null;
  const typeBadge = TYPE_BADGE[node.type] ?? null;
  const title = node.title || node.id;
  const shortId = (() => {
    const id = node.id;
    const tail = id.includes(':') ? id.split(':').pop()! : id;
    return tail.length > 12 ? tail.slice(0, 12) : tail;
  })();

  return (
    <div
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        background: 'var(--color-surface)',
        borderRadius: 6,
        borderWidth: selected || hovered ? 2 : 1,
        borderStyle: 'solid',
        borderColor: selected
          ? 'var(--color-accent)'
          : hovered
            ? 'var(--color-accent)'
            : sourceColor
              ? sourceColor
              : isAuxiliary
                ? 'var(--color-border-subtle)'
                : 'var(--color-border)',
        boxShadow: selected
          ? '0 0 0 2px var(--color-accent), 0 4px 10px rgba(0,0,0,0.25)'
          : hovered
            ? '0 4px 12px rgba(0,0,0,0.3)'
            : '0 1px 2px rgba(0,0,0,0.15)',
        opacity: dimmed ? 0.25 : isAncestor ? 0.65 : isAuxiliary ? 0.85 : 1,
        transition: 'opacity 120ms, box-shadow 120ms, border-color 120ms',
        overflow: 'hidden',
        display: 'flex',
        // Left status/swarm stripe = a 3px inset border via box-shadow on the inner row.
      }}
    >
      {/* Left stripe (status or swarm color) */}
      <div
        style={{
          width: 3,
          height: '100%',
          background: stripeColor,
          flexShrink: 0,
        }}
      />

      {/* Content */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: '6px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          color: 'var(--color-text)',
        }}
      >
        {/* Row 1: title (truncated) + priority chip */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            minWidth: 0,
          }}
        >
          {isMilestone && (
            <Flag
              size={10}
              style={{ flexShrink: 0, color: 'var(--color-accent)' }}
            />
          )}
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flex: 1,
              fontStyle: isAuxiliary ? 'italic' : undefined,
            }}
            title={title}
          >
            {title}
          </span>
          {priorityInfo && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: '0 4px',
                borderRadius: 3,
                background: `${priorityInfo.tone}1f`,
                color: priorityInfo.tone,
                flexShrink: 0,
              }}
              title={`Priority ${priorityInfo.letter}`}
            >
              {priorityInfo.letter}
            </span>
          )}
          {isAncestor && (
            <span
              style={{
                fontSize: 11,
                padding: '0 4px',
                borderRadius: 3,
                background: 'var(--color-elevated)',
                color: 'var(--color-text-muted)',
                flexShrink: 0,
                textTransform: 'uppercase',
                letterSpacing: 0.3,
              }}
              title="In scope because an active task depends on it"
            >
              blocker
            </span>
          )}
          {status === 'blocked' && (
            <AlertTriangle
              size={10}
              style={{ color: 'var(--color-danger)', flexShrink: 0 }}
            />
          )}
        </div>

        {/* Row 2: short id · status (or type for non-task) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: 'var(--color-text-muted)',
            minWidth: 0,
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              flexShrink: 0,
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
            title={node.id}
          >
            <Hash size={9} />
            {shortId}
          </span>
          {typeBadge ? (
            <span
              style={{
                padding: '0 4px',
                borderRadius: 3,
                background: 'var(--color-elevated)',
                color: 'var(--color-text-muted)',
                flexShrink: 0,
              }}
            >
              {typeBadge}
            </span>
          ) : (
            <span
              style={{
                color: statusColor,
                flexShrink: 0,
              }}
            >
              {STATUS_LABELS[status] ?? status.replace('_', ' ')}
            </span>
          )}
        </div>

        {/* Row 3: assignee · swarm */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: 'var(--color-text-muted)',
            minWidth: 0,
          }}
        >
          {node.assignee ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                minWidth: 0,
                overflow: 'hidden',
              }}
              title={`Assignee: ${node.assignee}`}
            >
              <UserIcon size={9} style={{ flexShrink: 0 }} />
              <span
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {node.assignee}
              </span>
            </span>
          ) : (
            <span style={{ opacity: 0.5 }}>unassigned</span>
          )}
          {swarm && (
            <span
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                minWidth: 0,
                overflow: 'hidden',
              }}
              title={`Swarm: ${swarm.name}`}
            >
              <Zap size={9} style={{ color: swarm.color, flexShrink: 0 }} />
              <span
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {swarm.name}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export const TaskNodeCard = memo(TaskNodeCardInner);
