import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FlaskConical, ArrowUp, ArrowDown } from 'lucide-react';
import clsx from 'clsx';
import {
  useExperiments,
  type Experiment,
  type ExperimentStatus,
} from '../hooks/useExperiments';
import { useExperimentsRealtime } from '../hooks/useExperimentsRealtime';
import { experimentStatusTone } from '../components/experiments/tones';
import { VerifiabilityBadges } from '../components/experiments/VerifiabilityBadges';
import { TimeAgo } from '../components/common/TimeAgo';
import { ListFilters, useDebouncedValue, matchesSearch } from '../components/common/ListFilters';
import { StatusChip } from '../components/common/StatusChip';
import { EmptyState } from '../components/common/EmptyState';
import { PageLoader } from '../components/common/LoadingSpinner';

const STATUS_FILTERS: Array<'all' | ExperimentStatus> = [
  'all',
  'active',
  'paused',
  'draft',
  'archived',
];

export function Experiments() {
  const [statusFilter, setStatusFilter] = useState<'all' | ExperimentStatus>('all');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search);

  useExperimentsRealtime();

  const { data, isLoading, error } = useExperiments({
    status: statusFilter === 'all' ? undefined : statusFilter,
  });

  const experiments = data?.data ?? [];

  const filtered = useMemo(
    () =>
      experiments.filter((e) =>
        matchesSearch(q, e.id, e.name, e.objective_metric, e.content_hash ?? undefined),
      ),
    [experiments, q],
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-4">
        <h1
          className="flex items-center gap-2 text-2xl font-bold"
          style={{ color: 'var(--color-text)' }}
        >
          <FlaskConical className="h-6 w-6 text-honey-500" />
          Experiments
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Harness-optimization lines. The runner decides keep/discard — this view monitors
          what it reported.
        </p>
      </div>

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        placeholder="Search experiments…"
        count={{ visible: filtered.length, total: experiments.length, noun: 'experiment' }}
        right={
          <div className="flex items-center gap-1.5 text-xs">
            {STATUS_FILTERS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setStatusFilter(v)}
                className={clsx(
                  'rounded-md px-2.5 py-1 transition-colors',
                  statusFilter === v
                    ? 'bg-honey-500/15 text-honey-300 ring-1 ring-honey-500/30'
                    : 'hover:opacity-100',
                )}
                style={statusFilter !== v ? { color: 'var(--color-text-muted)' } : undefined}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        }
      />

      {isLoading && <PageLoader />}
      {error && (
        <div
          className="mt-6 rounded-md border p-3 text-sm"
          style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
        >
          Failed to load experiments: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon={FlaskConical}
            title={
              experiments.length === 0
                ? 'No experiments yet'
                : 'No experiments match the current filters.'
            }
            description={
              experiments.length === 0
                ? 'Experiments appear here once a run is launched from the autonomation control plane.'
                : undefined
            }
          />
        </div>
      )}

      {!isLoading && !error && filtered.length > 0 && (
        <div
          className="mt-6 overflow-x-auto rounded-lg border"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left text-xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Provenance</th>
                <th className="px-3 py-2 font-medium">Objective</th>
                <th className="px-3 py-2 font-medium">Incumbent</th>
                <th className="px-3 py-2 font-medium">Runs</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <ExperimentRow key={e.id} experiment={e} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExperimentRow({ experiment: e }: { experiment: Experiment }) {
  const ArrowIcon = e.objective_direction === 'increase' ? ArrowUp : ArrowDown;
  return (
    <tr
      className="border-t transition-colors hover:bg-hover"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <td className="px-3 py-2.5">
        <Link to={`/experiments/${e.id}`} className="block min-w-0">
          <span className="font-medium" style={{ color: 'var(--color-text)' }}>
            {e.name}
          </span>
          <span className="ml-2 font-mono text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {e.id}
          </span>
        </Link>
      </td>
      <td className="px-3 py-2.5">
        <StatusChip {...experimentStatusTone(e.status)} />
      </td>
      <td className="px-3 py-2.5">
        <VerifiabilityBadges source={{ content_hash: e.content_hash }} compact />
      </td>
      <td className="px-3 py-2.5">
        <span className="inline-flex items-center gap-1 font-mono text-xs" style={{ color: 'var(--color-text-secondary)' }}>
          <ArrowIcon className="h-3 w-3 shrink-0" />
          {e.objective_metric}
        </span>
      </td>
      <td className="px-3 py-2.5" style={{ color: 'var(--color-text-secondary)' }}>
        {e.incumbent_candidate_id ? (
          <span className="font-mono text-2xs">set</span>
        ) : (
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            —
          </span>
        )}
      </td>
      <td className="px-3 py-2.5" style={{ color: 'var(--color-text-secondary)' }}>
        <RunCountCell experimentId={e.id} />
      </td>
      <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
        <TimeAgo date={e.updated_at} />
      </td>
    </tr>
  );
}

/**
 * The list endpoint doesn't carry per-experiment run counts, so we don't
 * fan out N detail requests from the list (that would be N+1). The run count
 * lives on the detail page; here we show a neutral placeholder link target.
 */
function RunCountCell({ experimentId }: { experimentId: string }) {
  return (
    <Link
      to={`/experiments/${experimentId}`}
      className="text-2xs text-honey-400 hover:text-honey-300"
    >
      view runs
    </Link>
  );
}
