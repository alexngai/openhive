import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Stethoscope,
  Check,
  X,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import { api } from '../../lib/api';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import clsx from 'clsx';

interface DoctorCheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  fix?: string;
}

export function SwarmKitDoctor({
  projectRoot,
}: {
  projectRoot: string | null;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(false);

  const { data, isLoading } = useQuery<{ results: DoctorCheckResult[] }>({
    queryKey: ['swarmkit-doctor', projectRoot],
    queryFn: () =>
      api.get(
        projectRoot
          ? `/admin/swarmkit/doctor?projectRoot=${encodeURIComponent(projectRoot)}`
          : '/admin/swarmkit/doctor',
      ),
    enabled,
  });

  const results = data?.results ?? [];
  const failCount = results.filter((r) => r.status === 'fail').length;
  const warnCount = results.filter((r) => r.status === 'warn').length;

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        ) : (
          <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        )}
        <Stethoscope className="w-3.5 h-3.5" style={{ color: 'var(--color-text-secondary)' }} />
        <span className="text-xs font-medium">Health Check</span>
        {enabled && results.length > 0 && (
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {failCount > 0 && <span className="text-red-500">{failCount} fail</span>}
            {failCount > 0 && warnCount > 0 && ', '}
            {warnCount > 0 && <span className="text-amber-500">{warnCount} warn</span>}
            {failCount === 0 && warnCount === 0 && (
              <span className="text-green-500">all pass</span>
            )}
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-3">
          {!enabled ? (
            <button
              onClick={() => setEnabled(true)}
              className="flex items-center gap-1.5 text-2xs px-2 py-1 rounded bg-honey-500/10 text-honey-500 hover:bg-honey-500/20"
            >
              <Play className="w-3 h-3" />
              Run Health Check
            </button>
          ) : isLoading ? (
            <div className="flex items-center gap-2 py-2">
              <LoadingSpinner />
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                Running diagnostics...
              </span>
            </div>
          ) : (
            <div className="space-y-1.5">
              {results.map((result) => (
                <div key={result.name} className="flex items-start gap-2">
                  <div className="mt-0.5">
                    {result.status === 'pass' ? (
                      <Check className="w-3 h-3 text-green-500" />
                    ) : result.status === 'fail' ? (
                      <X className="w-3 h-3 text-red-500" />
                    ) : (
                      <AlertTriangle className="w-3 h-3 text-amber-500" />
                    )}
                  </div>
                  <div className="flex-1">
                    <p
                      className={clsx(
                        'text-2xs',
                        result.status === 'pass' && 'text-green-500',
                        result.status === 'fail' && 'text-red-500',
                        result.status === 'warn' && 'text-amber-500',
                      )}
                    >
                      {result.message}
                    </p>
                    {result.fix && (
                      <code
                        className="block mt-0.5 text-2xs p-1 rounded"
                        style={{
                          backgroundColor: 'var(--color-elevated)',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        {result.fix}
                      </code>
                    )}
                  </div>
                </div>
              ))}

              <button
                onClick={() => {
                  queryClient.invalidateQueries({ queryKey: ['swarmkit-doctor', projectRoot] });
                }}
                className="flex items-center gap-1 mt-2 text-2xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <RefreshCw className="w-3 h-3" />
                Re-run
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
