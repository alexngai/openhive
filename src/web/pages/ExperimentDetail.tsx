import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  FlaskConical,
  ArrowUp,
  ArrowDown,
  Play,
  Pause,
  Archive,
  Calendar,
  Trophy,
} from 'lucide-react';
import {
  useExperiment,
  useExperimentCandidates,
  useCreateRun,
  usePauseExperiment,
  useResumeExperiment,
  useArchiveExperiment,
  type Experiment,
  type ExperimentRun,
  type ExperimentCandidate,
} from '../hooks/useExperiments';
import { useExperimentsRealtime } from '../hooks/useExperimentsRealtime';
import { experimentStatusTone, runStatusTone, candidateStatusTone } from '../components/experiments/tones';
import { VerifiabilityBadges } from '../components/experiments/VerifiabilityBadges';
import { LineageStrip } from '../components/experiments/LineageStrip';
import { TimeAgo } from '../components/common/TimeAgo';
import { StatusChip } from '../components/common/StatusChip';
import { PageLoader } from '../components/common/LoadingSpinner';
import { EmptyState } from '../components/common/EmptyState';
import { api, ApiClientError } from '../lib/api';

export function ExperimentDetail() {
  const { id } = useParams<{ id: string }>();
  useExperimentsRealtime(id);

  const { data, isLoading, error } = useExperiment(id);
  const { data: candidatesData } = useExperimentCandidates(id);

  if (isLoading) return <PageLoader />;

  if (error) {
    const notFound = error instanceof ApiClientError && error.status === 404;
    return (
      <BackShell>
        <div
          className="rounded-md border p-4 text-sm"
          style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
        >
          {notFound ? 'Experiment not found.' : `Failed to load experiment: ${(error as Error).message}`}
        </div>
      </BackShell>
    );
  }

  if (!data) {
    return (
      <BackShell>
        <div
          className="rounded-md border p-4 text-sm"
          style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
        >
          Experiment not found.
        </div>
      </BackShell>
    );
  }

  const { experiment, runs } = data;
  const candidates = candidatesData?.data ?? [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to="/experiments"
        className="mb-4 inline-flex items-center gap-1 text-sm hover:opacity-80"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to experiments
      </Link>

      <Header experiment={experiment} runs={runs} />

      <RunsSection experimentId={experiment.id} runs={runs} />

      <CandidateLineageSection
        candidates={candidates}
        incumbentId={experiment.incumbent_candidate_id}
      />
    </div>
  );
}

function BackShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to="/experiments"
        className="mb-4 inline-flex items-center gap-1 text-sm hover:opacity-80"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to experiments
      </Link>
      {children}
    </div>
  );
}

function Header({ experiment, runs }: { experiment: Experiment; runs: ExperimentRun[] }) {
  const ArrowIcon = experiment.objective_direction === 'increase' ? ArrowUp : ArrowDown;
  // Launch is admin-only; we create a queued run then launch it. A failure
  // (e.g. non-admin, or autonomation not installed) surfaces on the button.
  const { launchAndCreate, launching, launchError } = useLaunchFlow(experiment.id);

  const pause = usePauseExperiment(experiment.id);
  const resume = useResumeExperiment(experiment.id);
  const archive = useArchiveExperiment(experiment.id);

  // Use the most recent run's finalization telemetry as the experiment-level
  // verifiability snapshot (claim regime + env fingerprint live on runs).
  const latestRun = runs[0];

  return (
    <div
      className="mb-6 rounded-lg border p-5"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-elevated)',
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1
            className="flex items-center gap-2 text-xl font-semibold"
            style={{ color: 'var(--color-text)' }}
          >
            <FlaskConical className="h-5 w-5 text-honey-500 shrink-0" />
            <span className="truncate">{experiment.name}</span>
            <StatusChip {...experimentStatusTone(experiment.status)} />
          </h1>
          <p className="mt-1 font-mono text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {experiment.id}
          </p>

          <div className="mt-3">
            <VerifiabilityBadges
              source={{
                content_hash: experiment.content_hash,
                claim_strength: latestRun?.claim_strength,
                env_fingerprint: latestRun?.env_fingerprint,
              }}
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <MetaRow label="Objective">
              <span className="inline-flex items-center gap-1 font-mono" style={{ color: 'var(--color-text)' }}>
                <ArrowIcon className="h-3 w-3 shrink-0" />
                {experiment.objective_metric}
              </span>
            </MetaRow>
            <MetaRow label="Min delta">
              <code style={{ color: 'var(--color-text)' }}>{experiment.objective_min_delta}</code>
            </MetaRow>
            <MetaRow label="Incumbent">
              {experiment.incumbent_candidate_id ? (
                <span className="inline-flex items-center gap-1 font-mono" style={{ color: 'var(--color-text)' }}>
                  <Trophy className="h-3 w-3" style={{ color: 'var(--color-accent)' }} />
                  {experiment.incumbent_candidate_id}
                </span>
              ) : (
                <span style={{ color: 'var(--color-text-muted)' }}>none yet</span>
              )}
            </MetaRow>
            <MetaRow label="Provenance">
              {experiment.content_hash ? (
                <code className="break-all" style={{ color: 'var(--color-text)' }}>
                  {experiment.content_hash}
                </code>
              ) : (
                <span style={{ color: 'var(--color-text-muted)' }}>exploratory (no lock)</span>
              )}
            </MetaRow>
            <MetaRow label="Created">
              <TimeAgo date={experiment.created_at} />
            </MetaRow>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={launchAndCreate}
            disabled={launching}
            className="flex items-center gap-1.5 rounded-md bg-honey-500 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-honey-400 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {launching ? 'Launching…' : 'Launch run'}
          </button>

          <Link
            to="/schedules"
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-hover"
            style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
          >
            <Calendar className="h-3.5 w-3.5" />
            Schedule
          </Link>

          {experiment.status === 'paused' ? (
            <button
              type="button"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-hover disabled:opacity-50"
              style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </button>
          ) : experiment.status !== 'archived' ? (
            <button
              type="button"
              onClick={() => pause.mutate()}
              disabled={pause.isPending}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-hover disabled:opacity-50"
              style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </button>
          ) : null}

          {experiment.status !== 'archived' && (
            <button
              type="button"
              onClick={() => {
                if (confirm('Archive this experiment?')) archive.mutate();
              }}
              disabled={archive.isPending}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-hover disabled:opacity-50"
              style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }}
            >
              <Archive className="h-3.5 w-3.5" />
              Archive
            </button>
          )}
        </div>
      </div>

      {launchError && (
        <div
          className="mt-3 rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: 'var(--color-danger-border)',
            backgroundColor: 'var(--color-danger-bg)',
            color: 'var(--color-danger)',
          }}
        >
          Couldn't launch a run — {launchError}
        </div>
      )}
    </div>
  );
}

/**
 * "Launch run" = create a queued run, then launch it. The launch route needs a
 * concrete runId (not known until the create resolves), so we POST launch
 * through the `api` singleton inside the create mutation's onSuccess and
 * invalidate the detail keys — rather than building a useLaunchRun hook bound
 * to an empty id. Surfaces a pending flag + the first failure of either step.
 */
function useLaunchFlow(experimentId: string): {
  launchAndCreate: () => void;
  launching: boolean;
  launchError: string | null;
} {
  const qc = useQueryClient();
  const createRun = useCreateRun(experimentId);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const launchAndCreate = () => {
    setLaunchError(null);
    setLaunching(true);
    createRun.mutate(undefined, {
      onSuccess: async (data) => {
        try {
          await api.post(
            `/experiments/${experimentId}/runs/${data.run.id}/launch`,
            undefined,
          );
        } catch (e) {
          setLaunchError((e as Error).message);
        } finally {
          qc.invalidateQueries({ queryKey: ['experiment', experimentId] });
          qc.invalidateQueries({ queryKey: ['experiment-runs', experimentId] });
          setLaunching(false);
        }
      },
      onError: (e) => {
        setLaunchError((e as Error).message);
        setLaunching(false);
      },
    });
  };

  return { launchAndCreate, launching, launchError };
}

function RunsSection({
  experimentId,
  runs,
}: {
  experimentId: string;
  runs: ExperimentRun[];
}) {
  return (
    <section
      className="mb-6 rounded-lg border p-5"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-elevated)',
      }}
    >
      <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        Runs
      </h2>
      {runs.length === 0 ? (
        <EmptyState
          icon={Play}
          size="md"
          card={false}
          title="No runs yet"
          description="Launch a run to start an optimization loop."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <th className="px-2 py-1.5 font-medium">Run</th>
                <th className="px-2 py-1.5 font-medium">Status</th>
                <th className="px-2 py-1.5 font-medium">Started</th>
                <th className="px-2 py-1.5 font-medium">Train → held-out</th>
                <th className="px-2 py-1.5 font-medium">Claim</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  className="border-t transition-colors hover:bg-hover"
                  style={{ borderColor: 'var(--color-border-subtle)' }}
                >
                  <td className="px-2 py-2">
                    <Link
                      to={`/experiments/${experimentId}/runs/${r.id}`}
                      className="font-mono text-2xs text-honey-400 hover:text-honey-300"
                    >
                      {r.id}
                    </Link>
                  </td>
                  <td className="px-2 py-2">
                    <StatusChip {...runStatusTone(r.status)} />
                  </td>
                  <td className="px-2 py-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {r.started_at ? <TimeAgo date={r.started_at} /> : '—'}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    <RunScores run={r} />
                  </td>
                  <td className="px-2 py-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    {r.claim_strength?.strength ?? (
                      <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RunScores({ run }: { run: ExperimentRun }) {
  // Run-level train/held-out aren't stored as scalars on the run row — they
  // live on candidates. Here we surface the run's promotion count as a proxy
  // and defer the seesaw to the run detail page (honest: don't invent a number).
  if (run.total_promoted > 0) {
    return <span>{run.total_promoted} promoted</span>;
  }
  return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;
}

function CandidateLineageSection({
  candidates,
  incumbentId,
}: {
  candidates: ExperimentCandidate[];
  incumbentId: string | null;
}) {
  return (
    <section
      className="rounded-lg border p-5"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-elevated)',
      }}
    >
      <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        Candidate lineage
      </h2>

      <LineageStrip candidates={candidates} incumbentId={incumbentId} className="mb-4" />

      {candidates.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs" style={{ color: 'var(--color-text-muted)' }}>
                <th className="px-2 py-1.5 font-medium">Candidate</th>
                <th className="px-2 py-1.5 font-medium">Parent</th>
                <th className="px-2 py-1.5 font-medium">Status</th>
                <th className="px-2 py-1.5 font-medium">Train</th>
                <th className="px-2 py-1.5 font-medium">Held-out</th>
                <th className="px-2 py-1.5 font-medium">Changed paths</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <CandidateRow key={c.id} candidate={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function CandidateRow({ candidate: c }: { candidate: ExperimentCandidate }) {
  return (
    <tr className="border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <td className="px-2 py-2 font-mono text-2xs" style={{ color: 'var(--color-text)' }}>
        {c.candidate_ref}
      </td>
      <td className="px-2 py-2 font-mono text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        {c.parent_candidate_id ?? '—'}
      </td>
      <td className="px-2 py-2">
        <StatusChip {...candidateStatusTone(c.status)} />
      </td>
      <td className="px-2 py-2 font-mono text-xs" style={{ color: 'var(--color-text-secondary)' }}>
        {c.score_train != null ? c.score_train.toFixed(3) : '—'}
      </td>
      <td className="px-2 py-2 font-mono text-xs" style={{ color: 'var(--color-text-secondary)' }}>
        {c.score_held_out != null ? c.score_held_out.toFixed(3) : '—'}
      </td>
      <td className="px-2 py-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        {c.changed_paths && c.changed_paths.length > 0 ? (
          <span className="font-mono">
            {c.changed_paths.length === 1
              ? c.changed_paths[0]
              : `${c.changed_paths.length} files`}
          </span>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div style={{ color: 'var(--color-text-muted)' }}>{label}</div>
      <div style={{ color: 'var(--color-text)' }}>{children}</div>
    </>
  );
}
