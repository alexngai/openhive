import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, FlaskConical, X, AlertTriangle } from 'lucide-react';
import {
  useExperiment,
  useExperimentRun,
  useExperimentCandidates,
  useExperimentRunEvents,
  useCancelRun,
  type ExperimentRun,
  type ExperimentCandidate,
  type ExperimentEvent,
} from '../hooks/useExperiments';
import { useExperimentsRealtime } from '../hooks/useExperimentsRealtime';
import { runStatusTone, candidateStatusTone } from '../components/experiments/tones';
import { VerifiabilityBadges } from '../components/experiments/VerifiabilityBadges';
import { ObjectiveCurve } from '../components/experiments/ObjectiveCurve';
import { LineageStrip } from '../components/experiments/LineageStrip';
import { CandidateRow } from './ExperimentDetail';
import { TimeAgo } from '../components/common/TimeAgo';
import { StatusChip } from '../components/common/StatusChip';
import { PageLoader } from '../components/common/LoadingSpinner';
import { ApiClientError } from '../lib/api';

export function ExperimentRunDetail() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  useExperimentsRealtime(id);

  const expQuery = useExperiment(id);
  const runQuery = useExperimentRun(id, runId);
  const candidatesQuery = useExperimentCandidates(id);
  const eventsQuery = useExperimentRunEvents(id, runId);

  if (runQuery.isLoading) return <PageLoader />;

  if (runQuery.error) {
    const notFound = runQuery.error instanceof ApiClientError && runQuery.error.status === 404;
    return (
      <BackShell experimentId={id}>
        <ErrorCard
          message={
            notFound
              ? 'Run not found.'
              : `Failed to load run: ${(runQuery.error as Error).message}`
          }
        />
      </BackShell>
    );
  }

  const run = runQuery.data?.run;
  if (!run) {
    return (
      <BackShell experimentId={id}>
        <ErrorCard message="Run not found." />
      </BackShell>
    );
  }

  const experimentName = expQuery.data?.experiment.name;
  // Candidates scoped to this run (the candidates endpoint is experiment-wide).
  const runCandidates = (candidatesQuery.data?.data ?? []).filter((c) => c.run_id === run.id);
  const events = eventsQuery.data?.data ?? [];

  const isRunning = run.status === 'running' || run.status === 'queued';
  const pendingFinalization = isRunning && !run.content_hash && !run.claim_strength;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to={`/experiments/${id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm hover:opacity-80"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to experiment
      </Link>

      <Header
        run={run}
        experimentId={id!}
        experimentName={experimentName}
        pendingFinalization={pendingFinalization}
      />

      <MetricCards candidates={runCandidates} />

      <OverfitCallout run={run} candidates={runCandidates} />

      <section
        className="mb-6 rounded-lg border p-5"
        style={{
          borderColor: 'var(--color-border-subtle)',
          backgroundColor: 'var(--color-elevated)',
        }}
      >
        <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Objective curve
        </h2>
        <ObjectiveCurve candidates={runCandidates} />
      </section>

      <section
        className="mb-6 rounded-lg border p-5"
        style={{
          borderColor: 'var(--color-border-subtle)',
          backgroundColor: 'var(--color-elevated)',
        }}
      >
        <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Candidate lineage
        </h2>
        <LineageStrip
          candidates={runCandidates}
          incumbentId={expQuery.data?.experiment.incumbent_candidate_id}
          className="mb-4"
        />
        {runCandidates.length > 0 && (
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
                {runCandidates.map((c) => (
                  <CandidateRow key={c.id} candidate={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <EventTail events={events} loading={eventsQuery.isLoading} />
    </div>
  );
}

function Header({
  run,
  experimentId,
  experimentName,
  pendingFinalization,
}: {
  run: ExperimentRun;
  experimentId: string;
  experimentName?: string;
  pendingFinalization: boolean;
}) {
  const cancel = useCancelRun(experimentId, run.id);
  const canCancel = run.status === 'running' || run.status === 'queued';

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
            className="flex flex-wrap items-center gap-2 text-lg font-semibold"
            style={{ color: 'var(--color-text)' }}
          >
            <FlaskConical className="h-5 w-5 text-honey-500 shrink-0" />
            <span className="truncate">{experimentName ?? experimentId}</span>
            <StatusChip {...runStatusTone(run.status)} />
          </h1>
          <p className="mt-1 font-mono text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {run.id}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            <span>cycles: {run.cycles}</span>
            <span>·</span>
            <span>
              {run.started_at ? <>started <TimeAgo date={run.started_at} /></> : 'not started'}
            </span>
            {run.finished_at && (
              <>
                <span>·</span>
                <span>finished <TimeAgo date={run.finished_at} /></span>
              </>
            )}
          </div>

          <div className="mt-3">
            <VerifiabilityBadges
              source={{
                content_hash: run.content_hash,
                claim_strength: run.claim_strength,
                env_fingerprint: run.env_fingerprint,
              }}
            />
          </div>

          {pendingFinalization && (
            <p className="mt-2 text-2xs italic" style={{ color: 'var(--color-text-muted)' }}>
              Pending finalization — claim regime, content hash, and the train/held-out
              seesaw arrive when the run finalizes.
            </p>
          )}

          {run.stop_reason && (
            <p className="mt-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Stopped: <code>{run.stop_reason}</code>
              {run.stop_message ? ` — ${run.stop_message}` : ''}
            </p>
          )}
        </div>

        {canCancel && (
          <button
            type="button"
            onClick={() => {
              if (confirm('Cancel this run? The worker process will be killed.')) cancel.mutate();
            }}
            disabled={cancel.isPending}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-hover disabled:opacity-50"
            style={{
              borderColor: 'var(--color-danger-border)',
              color: 'var(--color-danger)',
            }}
          >
            <X className="h-3.5 w-3.5" />
            Cancel run
          </button>
        )}
      </div>
    </div>
  );
}

/** Best train + held-out across this run's candidates (the seesaw). */
function bestScores(candidates: ExperimentCandidate[]): {
  train: number | null;
  heldOut: number | null;
} {
  let train: number | null = null;
  let heldOut: number | null = null;
  for (const c of candidates) {
    if (c.score_train != null) train = train == null ? c.score_train : Math.max(train, c.score_train);
    if (c.score_held_out != null)
      heldOut = heldOut == null ? c.score_held_out : Math.max(heldOut, c.score_held_out);
  }
  return { train, heldOut };
}

function MetricCards({ candidates }: { candidates: ExperimentCandidate[] }) {
  const { train, heldOut } = bestScores(candidates);
  const gap = train != null && heldOut != null ? train - heldOut : null;
  const gapMaterial = gap != null && gap > 0.05;

  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <MetricCard label="Held-out" value={heldOut} accent />
      <MetricCard label="Train" value={train} />
      <MetricCard
        label="Overfit gap (train − held-out)"
        value={gap}
        flagged={gapMaterial}
      />
    </div>
  );
}

function MetricCard({
  label,
  value,
  accent,
  flagged,
}: {
  label: string;
  value: number | null;
  accent?: boolean;
  flagged?: boolean;
}) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{
        borderColor: flagged ? 'var(--color-danger-border)' : 'var(--color-border-subtle)',
        backgroundColor: flagged ? 'var(--color-danger-bg)' : 'var(--color-surface)',
      }}
    >
      <div className="text-2xs uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
        {label}
      </div>
      <div
        className="mt-1 font-mono text-lg font-semibold"
        style={{
          color: flagged
            ? 'var(--color-danger)'
            : accent
              ? 'var(--color-accent)'
              : 'var(--color-text)',
        }}
      >
        {value != null ? value.toFixed(3) : <span style={{ color: 'var(--color-text-muted)' }}>not available</span>}
      </div>
    </div>
  );
}

function OverfitCallout({ run, candidates }: { run: ExperimentRun; candidates: ExperimentCandidate[] }) {
  const { train, heldOut } = bestScores(candidates);
  const gap = train != null && heldOut != null ? train - heldOut : null;
  const overopt =
    typeof run.stop_reason === 'string' && /overopt|overfit/i.test(run.stop_reason);
  const trainOutpaces = gap != null && gap > 0.05;

  if (!overopt && !trainOutpaces) return null;

  return (
    <div
      className="mb-6 flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs"
      style={{
        borderColor: 'var(--color-danger-border)',
        backgroundColor: 'var(--color-danger-bg)',
        color: 'var(--color-danger)',
      }}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        {overopt ? (
          <span>The runner stopped on an over-optimization signal ({run.stop_reason}). </span>
        ) : null}
        {trainOutpaces ? (
          <span>
            Train outpaces held-out by {gap!.toFixed(3)} — the gain may not generalize.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function EventTail({ events, loading }: { events: ExperimentEvent[]; loading: boolean }) {
  // Newest-first.
  const ordered = [...events].sort((a, b) => b.seq - a.seq);

  return (
    <section
      className="rounded-lg border p-5"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-elevated)',
      }}
    >
      <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        Live event tail
      </h2>
      {loading && events.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading events…</p>
      ) : ordered.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No events reported yet.</p>
      ) : (
        <div
          className="max-h-96 overflow-y-auto rounded-md font-mono text-2xs"
          style={{ backgroundColor: 'var(--color-surface)' }}
        >
          {ordered.map((e) => (
            <div
              key={e.id}
              className="flex flex-wrap items-baseline gap-x-2 border-b px-3 py-1.5 last:border-b-0"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              <span style={{ color: 'var(--color-text-muted)' }}>#{e.seq}</span>
              <span style={{ color: 'var(--color-accent)' }}>{e.type}</span>
              {e.candidate_ref && (
                <span style={{ color: 'var(--color-text-secondary)' }}>{e.candidate_ref}</span>
              )}
              {e.metric && (
                <span style={{ color: 'var(--color-text-secondary)' }}>
                  {e.metric}
                  {e.score != null ? `=${e.score}` : ''}
                </span>
              )}
              {e.message && (
                <span style={{ color: 'var(--color-text)' }}>{e.message}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function BackShell({ experimentId, children }: { experimentId?: string; children: React.ReactNode }) {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to={experimentId ? `/experiments/${experimentId}` : '/experiments'}
        className="mb-4 inline-flex items-center gap-1 text-sm hover:opacity-80"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to experiment
      </Link>
      {children}
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div
      className="rounded-md border p-4 text-sm"
      style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
    >
      {message}
    </div>
  );
}
