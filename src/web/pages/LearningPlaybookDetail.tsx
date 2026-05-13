import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, Zap, CheckCircle2, XCircle, AlertTriangle, Clock, GitBranch, Shield } from 'lucide-react';
import { useLearningPlaybook } from '../hooks/useLearningApi';
import { useLearningRealtime } from '../hooks/useRealtimeInvalidation';
import { PageLoader } from '../components/common/LoadingSpinner';
import { EmptyState } from '../components/common/EmptyState';

export function LearningPlaybookDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: playbook, isLoading, error } = useLearningPlaybook(id || '');

  useLearningRealtime();

  if (isLoading) {
    return <PageLoader />;
  }

  if (error || !playbook) {
    return (
      <div className="space-y-4">
        <Link to="/learning" className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary">
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Learning
        </Link>
        <EmptyState icon={AlertTriangle} title="Playbook not found" />
      </div>
    );
  }

  const successRate = playbook.evolution.successCount + playbook.evolution.failureCount > 0
    ? Math.round((playbook.evolution.successCount / (playbook.evolution.successCount + playbook.evolution.failureCount)) * 100)
    : null;

  return (
    <div className="space-y-4">
      {/* Back nav */}
      <Link to="/learning" className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary">
        <ArrowLeft className="w-3.5 h-3.5" />
        Back to Learning
      </Link>

      {/* Header */}
      <div className="card px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-honey-500/10 flex items-center justify-center flex-shrink-0">
            <BookOpen className="w-4.5 h-4.5 text-honey-500" />
          </div>
          <div className="flex-1">
            <h1 className="text-base font-semibold">{playbook.name}</h1>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-2xs flex items-center gap-1 text-text-muted">
                <Zap className="w-3 h-3" />
                {Math.round(playbook.confidence * 100)}% confidence
              </span>
              <span className="text-2xs px-1.5 py-0.5 rounded bg-elevated text-text-muted">
                {playbook.complexity}
              </span>
              <span className="text-2xs flex items-center gap-1 text-text-muted">
                <GitBranch className="w-3 h-3" />
                v{playbook.evolution.version}
              </span>
              {successRate !== null && (
                <span className="text-2xs text-text-muted">
                  {successRate}% success rate
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MiniStat icon={CheckCircle2} label="Successes" value={playbook.evolution.successCount} color="text-green-500" />
        <MiniStat icon={XCircle} label="Failures" value={playbook.evolution.failureCount} color="text-red-500" />
        <MiniStat icon={Clock} label="Effort" value={`${playbook.estimatedEffort || '?'} calls`} />
        <MiniStat icon={Shield} label="Domains" value={playbook.applicability.domains.join(', ') || 'any'} />
      </div>

      {/* Applicability */}
      <Section title="Applicability">
        {playbook.applicability.situations.length > 0 && (
          <div className="mb-2">
            <h4 className="text-2xs text-text-muted mb-1">Situations</h4>
            <ul className="space-y-0.5">
              {playbook.applicability.situations.map((s, i) => (
                <li key={i} className="text-xs text-text-secondary">- {s}</li>
              ))}
            </ul>
          </div>
        )}
        {playbook.applicability.triggers.length > 0 && (
          <div className="mb-2">
            <h4 className="text-2xs text-text-muted mb-1">Triggers</h4>
            <div className="flex flex-wrap gap-1">
              {playbook.applicability.triggers.map((t, i) => (
                <span key={i} className="text-2xs px-1.5 py-0.5 rounded bg-elevated text-text-muted">{t}</span>
              ))}
            </div>
          </div>
        )}
        {playbook.applicability.antiPatterns.length > 0 && (
          <div>
            <h4 className="text-2xs text-text-muted mb-1">Anti-patterns (when NOT to use)</h4>
            <ul className="space-y-0.5">
              {playbook.applicability.antiPatterns.map((a, i) => (
                <li key={i} className="text-xs text-red-400/80">- {a}</li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* Guidance */}
      <Section title="Guidance">
        <div className="mb-2">
          <h4 className="text-2xs text-text-muted mb-1">Strategy</h4>
          <p className="text-xs text-text-secondary">{playbook.guidance.strategy}</p>
        </div>
        {playbook.guidance.tactics.length > 0 && (
          <div className="mb-2">
            <h4 className="text-2xs text-text-muted mb-1">Tactics</h4>
            <ol className="space-y-0.5 list-decimal list-inside">
              {playbook.guidance.tactics.map((t, i) => (
                <li key={i} className="text-xs text-text-secondary">{t}</li>
              ))}
            </ol>
          </div>
        )}
        {playbook.guidance.steps && playbook.guidance.steps.length > 0 && (
          <div className="mb-2">
            <h4 className="text-2xs text-text-muted mb-1">Steps</h4>
            <ol className="space-y-0.5 list-decimal list-inside">
              {playbook.guidance.steps.map((s, i) => (
                <li key={i} className="text-xs text-text-secondary">{s}</li>
              ))}
            </ol>
          </div>
        )}
        {playbook.guidance.codeExample && (
          <div>
            <h4 className="text-2xs text-text-muted mb-1">Code Example</h4>
            <pre className="text-2xs bg-elevated rounded p-2 overflow-x-auto text-text-secondary">
              {playbook.guidance.codeExample}
            </pre>
          </div>
        )}
      </Section>

      {/* Verification */}
      <Section title="Verification">
        {playbook.verification.successIndicators.length > 0 && (
          <div className="mb-2">
            <h4 className="text-2xs text-text-muted mb-1">Success indicators</h4>
            <ul className="space-y-0.5">
              {playbook.verification.successIndicators.map((s, i) => (
                <li key={i} className="text-xs text-green-400/80 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 flex-shrink-0" /> {s}
                </li>
              ))}
            </ul>
          </div>
        )}
        {playbook.verification.failureIndicators.length > 0 && (
          <div className="mb-2">
            <h4 className="text-2xs text-text-muted mb-1">Failure indicators</h4>
            <ul className="space-y-0.5">
              {playbook.verification.failureIndicators.map((f, i) => (
                <li key={i} className="text-xs text-red-400/80 flex items-center gap-1">
                  <XCircle className="w-3 h-3 flex-shrink-0" /> {f}
                </li>
              ))}
            </ul>
          </div>
        )}
        {playbook.verification.rollbackStrategy && (
          <div>
            <h4 className="text-2xs text-text-muted mb-1">Rollback strategy</h4>
            <p className="text-xs text-text-secondary">{playbook.verification.rollbackStrategy}</p>
          </div>
        )}
      </Section>

      {/* Evolution */}
      {playbook.evolution.refinements.length > 0 && (
        <Section title="Refinements">
          <div className="space-y-2">
            {playbook.evolution.refinements.map((r, i) => (
              <div key={i} className="text-xs border-l-2 border-border pl-2">
                <p className="text-text-secondary">{r.addition}</p>
                <p className="text-2xs text-text-muted mt-0.5">
                  Context: {r.context} | Source: {r.source}
                </p>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card px-3 py-2.5">
      <h3 className="text-xs font-medium text-text-secondary mb-2">{title}</h3>
      {children}
    </div>
  );
}

function MiniStat({ icon: Icon, label, value, color }: { icon: typeof Zap; label: string; value: string | number; color?: string }) {
  return (
    <div className="card px-3 py-2">
      <div className="flex items-center gap-1.5 text-2xs text-text-muted mb-0.5">
        <Icon className={`w-3 h-3 ${color || ''}`} />
        {label}
      </div>
      <div className="text-sm font-medium truncate">{value}</div>
    </div>
  );
}
