/**
 * Typed status → StatusChip tone mappers for the experiments surface.
 *
 * House rule (src/web/CLAUDE.md): every status badge renders through StatusChip
 * with a typed status→tone function next to the data — never hand-rolled
 * `bg-{color}-500/10` spans. These functions are that mapping.
 */

import type { StatusTone } from '../common/StatusChip';
import type {
  RunStatus,
  CandidateStatus,
  ExperimentStatus,
} from '../../hooks/useExperiments';

export function runStatusTone(status: RunStatus): { tone: StatusTone; label: string } {
  switch (status) {
    case 'running':
      return { tone: 'warning', label: 'Running' };
    case 'queued':
      return { tone: 'info', label: 'Queued' };
    case 'complete':
      return { tone: 'success', label: 'Complete' };
    case 'failed':
      return { tone: 'danger', label: 'Failed' };
    case 'cancelled':
      return { tone: 'neutral', label: 'Cancelled' };
    default:
      return { tone: 'neutral', label: status };
  }
}

export function candidateStatusTone(
  status: CandidateStatus,
): { tone: StatusTone; label: string } {
  switch (status) {
    case 'baseline':
      return { tone: 'info', label: 'Baseline' };
    case 'admitted':
      return { tone: 'warning', label: 'Admitted' };
    case 'keep':
      return { tone: 'success', label: 'Keep' };
    case 'discard':
      return { tone: 'neutral', label: 'Discard' };
    case 'crash':
      return { tone: 'danger', label: 'Crash' };
    case 'no_candidate':
      return { tone: 'neutral', label: 'No candidate' };
    default:
      return { tone: 'neutral', label: status };
  }
}

export function experimentStatusTone(
  status: ExperimentStatus,
): { tone: StatusTone; label: string } {
  switch (status) {
    case 'active':
      return { tone: 'success', label: 'Active' };
    case 'paused':
      return { tone: 'warning', label: 'Paused' };
    case 'draft':
      return { tone: 'info', label: 'Draft' };
    case 'archived':
      return { tone: 'neutral', label: 'Archived' };
    default:
      return { tone: 'neutral', label: status };
  }
}
