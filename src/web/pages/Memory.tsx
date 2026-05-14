/**
 * Memory Page — Lists all memory bank resources with summaries.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Brain, FileText, ChevronRight, Clock, Network, Tag,
} from 'lucide-react';
import { useResourcesByType, useMemoryFiles, useKnowledgeGraphFull } from '../hooks/useApi';
import { useResourcesRealtime } from '../hooks/useRealtimeInvalidation';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { ListFilters, useDebouncedValue, matchesSearch } from '../components/common/ListFilters';
import { EmptyState } from '../components/common/EmptyState';
import type { SyncableResource } from '../lib/api';

function MemoryResourceCard({ resource }: { resource: SyncableResource }) {
  const { data: files } = useMemoryFiles(resource.id);
  const { data: knowledge } = useKnowledgeGraphFull(resource.id);

  const fileCount = files?.length || 0;
  const knowledgeCount = knowledge?.results?.filter(r => r.frontmatter?.id)?.length || 0;

  return (
    <Link
      to={`/memory/${resource.id}`}
      className="card card-hover p-4 flex items-start gap-4 group"
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Brain className="w-5 h-5 text-honey-500" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {resource.name}
          </h3>
          {resource.sync_strategy === 'local' && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Local" />
          )}
        </div>

        {resource.description && (
          <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {resource.description}
          </p>
        )}

        {/* Stats row */}
        <div className="flex items-center gap-3 mt-2">
          {fileCount > 0 && (
            <span className="text-2xs px-1.5 py-0.5 rounded flex items-center gap-1 bg-blue-500/10 text-blue-400">
              <FileText className="w-3 h-3" />
              {fileCount} file{fileCount !== 1 ? 's' : ''}
            </span>
          )}
          {knowledgeCount > 0 && (
            <span className="text-2xs px-1.5 py-0.5 rounded flex items-center gap-1 bg-emerald-500/10 text-emerald-400">
              <Network className="w-3 h-3" />
              {knowledgeCount} knowledge note{knowledgeCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-3 mt-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          <span className="flex items-center gap-1">
            <Tag className="w-3 h-3" />
            {resource.scope}
          </span>
          {resource.last_push_at && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <TimeAgo date={resource.last_push_at} />
            </span>
          )}
        </div>
      </div>

      <ChevronRight
        className="w-4 h-4 shrink-0 mt-1 opacity-0 group-hover:opacity-50 transition-opacity"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}

export function Memory() {
  const { data: resourcesData, isLoading } = useResourcesByType('memory_bank');
  useResourcesRealtime();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search);

  const resources = resourcesData?.data || [];
  const filtered = useMemo(
    () => resources.filter((r) => matchesSearch(q, r.name, r.description, r.scope)),
    [resources, q],
  );

  if (isLoading) return <PageLoader />;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-lg font-bold">Memory</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
          Memory banks from connected agents and swarms.
        </p>
      </div>

      {resources.length > 0 && (
        <ListFilters
          search={search}
          onSearchChange={setSearch}
          placeholder="Search memory banks…"
          count={{ visible: filtered.length, total: resources.length, noun: 'bank' }}
        />
      )}

      {resources.length === 0 ? (
        <EmptyState
          icon={Brain}
          title="No memory banks yet"
          description="Memory banks appear when discovered locally or registered by connected swarms."
        />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-center py-8" style={{ color: 'var(--color-text-muted)' }}>
          No memory banks match “{q}”.
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((resource) => (
            <MemoryResourceCard key={resource.id} resource={resource} />
          ))}
        </div>
      )}
    </div>
  );
}
