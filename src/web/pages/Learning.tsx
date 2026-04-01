import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Brain, BookOpen, Lightbulb, Activity, Zap, Settings, ChevronRight, AlertCircle, CheckCircle2, Clock, Database, Wrench, RefreshCw } from 'lucide-react';
import {
  useLearningStats,
  useLearningHealth,
  useLearningPlaybooks,
  useLearningKnowledge,
  useLearningExperiences,
  useLearningActivity,
  useTriggerBatch,
  useTriggerMaintenance,
  type Playbook,
  type Experience,
  type LearningActivityEvent,
} from '../hooks/useLearningApi';
import { useLearningRealtime } from '../hooks/useRealtimeInvalidation';

type Tab = 'overview' | 'playbooks' | 'knowledge' | 'experiences';

export function Learning() {
  const [tab, setTab] = useState<Tab>('overview');

  // Real-time invalidation
  useLearningRealtime();

  // Data queries
  const { data: health, isLoading: healthLoading } = useLearningHealth();
  const { data: stats } = useLearningStats();

  if (healthLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-5 h-5 animate-spin text-text-muted" />
      </div>
    );
  }

  if (!health?.available) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Brain className="w-5 h-5 text-honey-500" />
          Learning
        </h1>
        <div className="card px-4 py-8 flex flex-col items-center gap-3 text-center">
          <AlertCircle className="w-8 h-8 text-text-muted" />
          <p className="text-sm font-medium">Learning engine is not available</p>
          <p className="text-2xs text-text-muted max-w-md">
            {health?.reason || 'Enable learning in openhive.config.js by setting learning.enabled to true.'}
          </p>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; icon: typeof Brain }[] = [
    { id: 'overview', label: 'Overview', icon: Activity },
    { id: 'playbooks', label: 'Playbooks', icon: BookOpen },
    { id: 'knowledge', label: 'Knowledge', icon: Lightbulb },
    { id: 'experiences', label: 'Experiences', icon: Database },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Brain className="w-5 h-5 text-honey-500" />
          Learning
        </h1>
        {health.agentic_compute && (
          <span className="flex items-center gap-1 text-2xs text-honey-500">
            <Zap className="w-3 h-3" />
            Agentic compute active
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-honey-500 text-honey-500'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
            onClick={() => setTab(t.id)}
          >
            <span className="flex items-center gap-1.5">
              <t.icon className="w-3.5 h-3.5" />
              {t.label}
            </span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && <OverviewTab health={health} stats={stats} />}
      {tab === 'playbooks' && <PlaybooksTab />}
      {tab === 'knowledge' && <KnowledgeTab />}
      {tab === 'experiences' && <ExperiencesTab />}
    </div>
  );
}

// ── Overview Tab ──

function OverviewTab({ health, stats }: { health: any; stats: any }) {
  const triggerBatch = useTriggerBatch();
  const triggerMaintenance = useTriggerMaintenance();

  return (
    <div className="space-y-4">
      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard label="Experiences" value={health.experience_count ?? 0} icon={Database} />
        <StatCard label="Playbooks" value={health.playbook_count ?? 0} icon={BookOpen} />
        <StatCard label="Trajectories" value={health.trajectories_processed ?? 0} icon={Activity} />
        <StatCard label="Pending" value={health.pending_trajectories ?? 0} icon={Clock} />
      </div>

      {/* Session Banks */}
      <div className="card px-3 py-2.5">
        <h3 className="text-xs font-medium text-text-secondary mb-2 flex items-center gap-1.5">
          <Settings className="w-3 h-3" />
          Session Banks
        </h3>
        {health.session_banks.length === 0 ? (
          <p className="text-2xs text-text-muted">No session banks configured</p>
        ) : (
          <div className="space-y-1">
            {health.session_banks.map((sb: any) => (
              <div key={sb.index} className="flex items-center gap-2 text-2xs">
                {sb.available ? (
                  <CheckCircle2 className="w-3 h-3 text-green-500" />
                ) : (
                  <AlertCircle className="w-3 h-3 text-text-muted" />
                )}
                <span className="text-text-secondary">Bank {sb.index}</span>
                <span className="text-text-muted">{sb.processed} processed</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Maintenance */}
      <div className="card px-3 py-2.5">
        <h3 className="text-xs font-medium text-text-secondary mb-2 flex items-center gap-1.5">
          <Wrench className="w-3 h-3" />
          Maintenance
        </h3>
        <div className="flex items-center gap-4 text-2xs text-text-muted">
          <span>
            {health.maintenance.scheduled ? (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-green-500" />
                Scheduled: {health.maintenance.schedule}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                Not scheduled
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            className="btn btn-secondary text-xs"
            onClick={() => triggerBatch.mutate()}
            disabled={triggerBatch.isPending}
          >
            {triggerBatch.isPending ? (
              <RefreshCw className="w-3 h-3 animate-spin mr-1.5" />
            ) : (
              <Zap className="w-3 h-3 mr-1.5" />
            )}
            Run Batch Learning
          </button>
          <button
            className="btn btn-secondary text-xs"
            onClick={() => triggerMaintenance.mutate()}
            disabled={triggerMaintenance.isPending}
          >
            {triggerMaintenance.isPending ? (
              <RefreshCw className="w-3 h-3 animate-spin mr-1.5" />
            ) : (
              <Wrench className="w-3 h-3 mr-1.5" />
            )}
            Run Maintenance
          </button>
        </div>
        {triggerBatch.isError && (
          <p className="text-2xs text-red-400">Batch learning failed: {(triggerBatch.error as Error)?.message || 'Unknown error'}</p>
        )}
        {triggerMaintenance.isError && (
          <p className="text-2xs text-red-400">Maintenance failed: {(triggerMaintenance.error as Error)?.message || 'Unknown error'}</p>
        )}
        {triggerBatch.isSuccess && (
          <p className="text-2xs text-green-400">Batch learning completed</p>
        )}
        {triggerMaintenance.isSuccess && (
          <p className="text-2xs text-green-400">Maintenance completed</p>
        )}
      </div>

      {/* Activity Timeline */}
      <ActivityTimeline />
    </div>
  );
}

function ActivityTimeline() {
  const { data, isLoading } = useLearningActivity({ limit: 20 });

  if (isLoading) return <LoadingPlaceholder />;

  const events = data?.data ?? [];

  if (events.length === 0) {
    return (
      <div className="card px-3 py-2.5">
        <h3 className="text-xs font-medium text-text-secondary mb-2 flex items-center gap-1.5">
          <Activity className="w-3 h-3" />
          Recent Activity
        </h3>
        <p className="text-2xs text-text-muted">No learning activity yet</p>
      </div>
    );
  }

  const typeColors: Record<string, string> = {
    instant: 'bg-blue-500',
    batch: 'bg-honey-500',
    maintenance: 'bg-purple-500',
    ingestion: 'bg-green-500',
  };

  const typeLabels: Record<string, string> = {
    instant: 'Instant',
    batch: 'Batch',
    maintenance: 'Maintenance',
    ingestion: 'Ingestion',
  };

  return (
    <div className="card px-3 py-2.5">
      <h3 className="text-xs font-medium text-text-secondary mb-2 flex items-center gap-1.5">
        <Activity className="w-3 h-3" />
        Recent Activity
      </h3>
      <div className="space-y-1.5">
        {events.map((event: LearningActivityEvent) => (
          <div key={event.id} className="flex items-start gap-2 text-2xs">
            <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${typeColors[event.type] || 'bg-text-muted'}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-text-secondary">{event.summary}</span>
                <span className="px-1 py-0.5 rounded bg-elevated text-text-muted">{typeLabels[event.type] || event.type}</span>
              </div>
              {event.data && Object.keys(event.data).length > 0 && (
                <div className="text-text-muted mt-0.5">
                  {Object.entries(event.data).map(([k, v]) => (
                    <span key={k} className="mr-2">{k}: {String(v)}</span>
                  ))}
                </div>
              )}
            </div>
            <span className="text-text-muted flex-shrink-0">
              {formatTimeAgo(event.timestamp)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTimeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatCard({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Brain }) {
  return (
    <div className="card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-2xs text-text-muted mb-1">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className="text-lg font-semibold">{value.toLocaleString()}</div>
    </div>
  );
}

// ── Playbooks Tab ──

function PlaybooksTab() {
  const [sort, setSort] = useState<'confidence' | 'recency' | 'usage'>('confidence');
  const { data, isLoading } = useLearningPlaybooks({ sort });

  if (isLoading) return <LoadingPlaceholder />;

  const playbooks = data?.data ?? [];

  if (playbooks.length === 0) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No playbooks yet"
        description="Playbooks are extracted from trajectories during batch learning. Process more trajectories to generate playbooks."
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-2xs text-text-muted">Sort by:</span>
        {(['confidence', 'recency', 'usage'] as const).map(s => (
          <button
            key={s}
            className={`text-2xs px-1.5 py-0.5 rounded ${
              sort === s ? 'bg-elevated text-text' : 'text-text-muted hover:text-text-secondary'
            }`}
            onClick={() => setSort(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        {playbooks.map((pb: Playbook) => (
          <PlaybookCard key={pb.id} playbook={pb} />
        ))}
      </div>
    </div>
  );
}

function PlaybookCard({ playbook }: { playbook: Playbook }) {
  const successRate = playbook.evolution.successCount + playbook.evolution.failureCount > 0
    ? Math.round((playbook.evolution.successCount / (playbook.evolution.successCount + playbook.evolution.failureCount)) * 100)
    : null;

  return (
    <Link to={`/learning/playbooks/${playbook.id}`} className="group card card-hover px-3 py-2.5 flex items-start gap-3">
      <div className="w-7 h-7 rounded-md bg-honey-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
        <BookOpen className="w-3.5 h-3.5 text-honey-500" />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-medium text-sm truncate">{playbook.name}</h3>
        <p className="text-2xs text-text-muted mt-0.5 line-clamp-1">{playbook.guidance.strategy}</p>
        <div className="flex items-center gap-3 mt-1.5">
          <span className="text-2xs text-text-muted flex items-center gap-1">
            <Zap className="w-3 h-3" />
            {Math.round(playbook.confidence * 100)}% confidence
          </span>
          {playbook.applicability.domains.length > 0 && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-elevated text-text-muted">
              {playbook.applicability.domains[0]}
            </span>
          )}
          {successRate !== null && (
            <span className="text-2xs text-text-muted">
              {successRate}% success ({playbook.evolution.successCount + playbook.evolution.failureCount} uses)
            </span>
          )}
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-text-muted mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

// ── Knowledge Tab ──

function KnowledgeTab() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const { data, isLoading } = useLearningKnowledge({ search: debouncedSearch || undefined });

  if (isLoading) return <LoadingPlaceholder />;

  const notes = data?.data ?? [];

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder="Search knowledge notes..."
        className="input w-full text-xs"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      {notes.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title={search ? 'No matches' : 'No knowledge notes yet'}
          description="Knowledge notes are extracted from trajectories during learning. They contain observations, entity descriptions, and domain summaries."
        />
      ) : (
        <div className="space-y-1.5">
          {notes.map((note: any, i: number) => (
            <div key={note.frontmatter?.id || i} className="card px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-2xs px-1.5 py-0.5 rounded ${
                  note.frontmatter?.type === 'entity' ? 'bg-blue-500/10 text-blue-400' :
                  note.frontmatter?.type === 'domain-summary' ? 'bg-purple-500/10 text-purple-400' :
                  'bg-elevated text-text-muted'
                }`}>
                  {note.frontmatter?.type || 'observation'}
                </span>
                {note.frontmatter?.domain?.map((d: string) => (
                  <span key={d} className="text-2xs text-text-muted">{d}</span>
                ))}
                <span className="text-2xs text-text-muted ml-auto">
                  {Math.round((note.frontmatter?.confidence ?? 0) * 100)}% confidence
                </span>
              </div>
              <p className="text-xs text-text-secondary line-clamp-2">{note.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Experiences Tab ──

function ExperiencesTab() {
  const { data, isLoading } = useLearningExperiences({ limit: 50 });

  if (isLoading) return <LoadingPlaceholder />;

  const experiences = data?.data ?? [];

  if (experiences.length === 0) {
    return (
      <EmptyState
        icon={Database}
        title="No experiences yet"
        description="Experiences are stored each time a trajectory is processed. They record what happened and how it went."
      />
    );
  }

  return (
    <div className="space-y-1.5">
      {experiences.map((exp: Experience) => (
        <div key={exp.id} className="card px-3 py-2.5 flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
            exp.outcome?.success ? 'bg-green-500' : 'bg-red-500'
          }`} />
          <div className="flex-1 min-w-0">
            <p className="text-xs truncate">{exp.task?.description || exp.id}</p>
            <div className="flex items-center gap-2 mt-0.5 text-2xs text-text-muted">
              <span>{exp.task?.domain}</span>
              {exp.agentId && <span>{exp.agentId}</span>}
              {exp.totalTokens > 0 && <span>{exp.totalTokens.toLocaleString()} tokens</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Shared Components ──

function EmptyState({ icon: Icon, title, description }: { icon: typeof Brain; title: string; description: string }) {
  return (
    <div className="card px-4 py-8 flex flex-col items-center gap-3 text-center">
      <Icon className="w-8 h-8 text-text-muted" />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-2xs text-text-muted max-w-md">{description}</p>
    </div>
  );
}

function LoadingPlaceholder() {
  return (
    <div className="flex items-center justify-center py-12">
      <RefreshCw className="w-4 h-4 animate-spin text-text-muted" />
    </div>
  );
}
