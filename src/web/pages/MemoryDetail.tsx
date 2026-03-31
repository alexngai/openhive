/**
 * MemoryDetail Page — Full memory bank view with timeline, graph, and file browser.
 */

import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Brain, Clock, Tag } from 'lucide-react';
import { useResource } from '../hooks/useApi';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { MemoryBrowser } from '../components/resources/MemoryBrowser';

export function MemoryDetail() {
  const { resourceId } = useParams<{ resourceId: string }>();
  const { data: resource, isLoading, error } = useResource(resourceId!);

  if (isLoading) return <PageLoader />;

  if (error || !resource) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <Link to="/memory" className="flex items-center gap-1 text-xs mb-4 hover:text-honey-500 transition-colors" style={{ color: 'var(--color-text-muted)' }}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Memory
        </Link>
        <div className="card p-8 text-center">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Memory bank not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div>
        <Link to="/memory" className="flex items-center gap-1 text-xs mb-3 hover:text-honey-500 transition-colors" style={{ color: 'var(--color-text-muted)' }}>
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Memory
        </Link>

        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            <Brain className="w-5 h-5 text-honey-500" />
          </div>
          <div>
            <h1 className="text-lg font-bold">{resource.name}</h1>
            {resource.description && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>{resource.description}</p>
            )}
          </div>
        </div>

        {/* Meta pills */}
        <div className="flex items-center gap-3 mt-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          <span className="flex items-center gap-1">
            <Tag className="w-3 h-3" />
            {resource.scope} / {resource.sync_strategy}
          </span>
          {resource.last_push_at && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              synced <TimeAgo date={resource.last_push_at} />
            </span>
          )}
        </div>
      </div>

      {/* Memory Browser (tabbed: Timeline | Graph | Files) */}
      <MemoryBrowser resourceId={resource.id} />
    </div>
  );
}
