import { Link } from 'react-router-dom';
import { Activity, ChevronRight, Clock, Cpu, FileText, User } from 'lucide-react';
import { useSessionsList } from '../hooks/useApi';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader } from '../components/common/LoadingSpinner';
import type { SessionListItem } from '../lib/api';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function SessionCard({ session }: { session: SessionListItem }) {
  const totalTokens = session.total_input_tokens + session.total_output_tokens;

  return (
    <Link
      to={`/sessions/${session.id}`}
      className="card card-hover px-3 py-2.5 flex items-start gap-3 group"
    >
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-0.5"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Activity className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {session.name}
          </h3>
          {session.total_checkpoints > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Active" />
          )}
          <span className={`text-2xs px-1.5 py-0.5 rounded ${
            session.visibility === 'public' ? 'bg-emerald-500/10 text-emerald-400'
              : session.visibility === 'shared' ? 'bg-blue-500/10 text-blue-400'
              : 'bg-gray-500/10 text-gray-400'
          }`}>
            {session.visibility}
          </span>
        </div>

        {session.description && (
          <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {session.description}
          </p>
        )}

        <div className="flex items-center gap-3 mt-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {session.latest_agent && (
            <span className="flex items-center gap-1" title="Latest agent">
              <User className="w-3 h-3" />
              {session.latest_agent}
            </span>
          )}
          <span className="flex items-center gap-1" title="Checkpoints">
            <Activity className="w-3 h-3" />
            {session.total_checkpoints}
          </span>
          {totalTokens > 0 && (
            <span className="flex items-center gap-1" title="Total tokens">
              <Cpu className="w-3 h-3" />
              {formatTokens(totalTokens)}
            </span>
          )}
          {session.last_synced_at && (
            <span className="flex items-center gap-1" title="Last synced">
              <Clock className="w-3 h-3" />
              <TimeAgo date={session.last_synced_at} />
            </span>
          )}
        </div>
      </div>

      <ChevronRight
        className="w-4 h-4 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-1"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}

export function Sessions() {
  const { data, isLoading } = useSessionsList();
  const sessions = data?.data ?? [];
  const total = data?.total ?? 0;

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Activity className="w-5 h-5 text-honey-500" />
          Sessions
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
          Agent session trajectories synced via MAP. {total > 0 && `${total} session${total !== 1 ? 's' : ''} tracked.`}
        </p>
      </div>

      {/* Session list */}
      {sessions.length > 0 ? (
        <div className="space-y-1.5">
          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      ) : (
        <div
          className="card px-6 py-12 text-center"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
            No session data yet
          </p>
          <p className="text-xs">
            Connect a swarm with session trajectory sync enabled to see activity here.
          </p>
        </div>
      )}
    </div>
  );
}
