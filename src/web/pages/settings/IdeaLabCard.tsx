import { useState } from 'react';
import { Lightbulb, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import {
  useIdeaLabStatus,
  useSetupIdeaLab,
  useTeardownIdeaLab,
} from '../../hooks/useIdeaLab';
import { useMapSwarmsForPicker } from '../../hooks/useApi';

/**
 * Admin-only setup for the idea-lab. Drives the whole lab (git-synced graph,
 * objectives, role schedules) through `POST /admin/idea-lab/setup`
 * (provisionIdeaLab) — the lab is a workload loaded here, not hub config.
 */
export function IdeaLabCard({ isAdmin }: { isAdmin: boolean }) {
  const { data: status } = useIdeaLabStatus();
  const setup = useSetupIdeaLab();
  const teardown = useTeardownIdeaLab();
  const { data: swarms = [] } = useMapSwarmsForPicker();

  const [selectedSwarmIds, setSelectedSwarmIds] = useState<string[]>([]);
  const [gitRemote, setGitRemote] = useState('');
  const [objectivesText, setObjectivesText] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin) return null;

  const loaded = status?.loaded ?? false;
  const onlineSwarms = swarms.filter((s) => s.status === 'online');

  const toggleSwarm = (id: string) =>
    setSelectedSwarmIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const onSetup = async () => {
    setError(null);
    setFeedback(null);
    const objectives = objectivesText
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
    try {
      const s = await setup.mutateAsync({
        targetSwarmIds: selectedSwarmIds,
        gitRemote: gitRemote.trim() || undefined,
        objectives: objectives.length ? objectives : undefined,
      });
      const parts = [
        `${s.schedules.created} created`,
        s.schedules.updated ? `${s.schedules.updated} updated` : null,
        s.schedules.paused ? `${s.schedules.paused} paused — no target swarms` : null,
      ].filter(Boolean);
      setFeedback(
        `Lab set up: ${parts.join(', ')}.${s.warnings.length ? ' ' + s.warnings.join('; ') : ''}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onTeardown = async () => {
    setError(null);
    setFeedback(null);
    try {
      const r = await teardown.mutateAsync();
      setFeedback(`Torn down: ${r.paused} role schedule${r.paused === 1 ? '' : 's'} paused.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full p-1.5 shrink-0 bg-honey-500/10 text-honey-400">
          <Lightbulb className="w-4 h-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              Idea lab
            </h3>
            {loaded && (
              <span
                className={clsx(
                  'text-2xs px-2 py-0.5 rounded',
                  status?.paused ? 'bg-zinc-500/15 text-zinc-300' : 'bg-emerald-500/15 text-emerald-300',
                )}
              >
                {status?.paused ? 'paused' : 'running'} · {status?.roles.length} roles
              </span>
            )}
          </div>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Autonomous brainstorm-and-work loop — provisions a git-synced idea graph, seed
            objectives, and recurring role dispatches (ideator, skeptic, judge, …).
          </p>

          <div className="mt-3 space-y-2.5">
            <div>
              <label className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                Target swarms
              </label>
              <div className="flex flex-wrap gap-1 mt-1">
                {onlineSwarms.length === 0 ? (
                  <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                    No online swarms — the lab will be created paused.
                  </span>
                ) : (
                  onlineSwarms.map((s) => {
                    const on = selectedSwarmIds.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleSwarm(s.id)}
                        className={clsx(
                          'text-2xs px-2 py-0.5 rounded border transition-colors',
                          on
                            ? 'border-honey-500/40 bg-honey-500/15 text-honey-200'
                            : 'hover:bg-white/5',
                        )}
                        style={!on ? { borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' } : undefined}
                      >
                        {s.name}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div>
              <label className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                Git remote{' '}
                <span style={{ color: 'var(--color-text-muted)' }}>(blank = hub-local graph)</span>
              </label>
              <input
                type="text"
                value={gitRemote}
                onChange={(e) => setGitRemote(e.target.value)}
                placeholder="git@host:org/idea-lab.git — leave blank for a hub-local graph"
                className="input w-full mt-1 text-xs"
              />
            </div>

            <div>
              <label className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                Objectives <span style={{ color: 'var(--color-text-muted)' }}>(one per line)</span>
              </label>
              <textarea
                value={objectivesText}
                onChange={(e) => setObjectivesText(e.target.value)}
                placeholder={'Reduce cold-start latency below 200ms\nNovel retrieval strategies for long context'}
                className="input w-full mt-1 h-16 text-xs"
              />
            </div>
          </div>

          {feedback && (
            <div className="mt-2 text-2xs" style={{ color: 'var(--color-text-secondary)' }}>
              {feedback}
            </div>
          )}
          {error && (
            <div className="mt-2 text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
              <AlertTriangle className="w-3 h-3" />
              {error}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={onSetup}
              disabled={setup.isPending}
              className="rounded-md bg-honey-500 px-3 py-1.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-honey-400 disabled:opacity-50"
            >
              {setup.isPending ? 'Setting up…' : loaded ? 'Re-apply' : 'Set up lab'}
            </button>
            {loaded && (
              <button
                type="button"
                onClick={onTeardown}
                disabled={teardown.isPending}
                className="rounded px-3 py-1.5 text-xs font-medium border transition-colors disabled:opacity-50 hover:bg-white/5"
                style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-secondary)' }}
              >
                {teardown.isPending ? '…' : 'Tear down'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
