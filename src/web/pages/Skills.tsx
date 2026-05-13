/**
 * Skills Page — Lists all skill resources with summaries.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wrench, ChevronRight, Clock, Tag, CheckCircle, FlaskConical, Archive, FolderOpen,
} from 'lucide-react';
import { useResourcesByType, useSkillsList } from '../hooks/useApi';
import { useResourcesRealtime } from '../hooks/useRealtimeInvalidation';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { ListFilters, useDebouncedValue, matchesSearch } from '../components/common/ListFilters';
import { EmptyState } from '../components/common/EmptyState';
import type { SyncableResource } from '../lib/api';

function SkillResourceCard({ resource }: { resource: SyncableResource }) {
  const { data: skills } = useSkillsList(resource.id);

  const activeCount = skills?.filter(s => s.status === 'active').length || 0;
  const totalCount = skills?.length || 0;

  return (
    <Link
      to={`/skills/${resource.id}`}
      className="card card-hover p-4 flex items-start gap-4 group"
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Wrench className="w-5 h-5 text-honey-500" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {resource.name}
          </h3>
        </div>

        {resource.description && (
          <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {resource.description}
          </p>
        )}

        {totalCount > 0 && (
          <div className="flex items-center gap-3 mt-2">
            <span className="text-2xs px-1.5 py-0.5 rounded flex items-center gap-1 bg-emerald-500/10 text-emerald-400">
              <CheckCircle className="w-3 h-3" />
              {activeCount} active
            </span>
            {totalCount > activeCount && (
              <span className="text-2xs px-1.5 py-0.5 rounded flex items-center gap-1 bg-blue-500/10 text-blue-400">
                <FlaskConical className="w-3 h-3" />
                {totalCount - activeCount} other
              </span>
            )}
          </div>
        )}

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
        {(resource.local_path || resource.git_remote_url) && (
          <div className="flex items-center gap-1 mt-1 text-2xs font-mono truncate" style={{ color: 'var(--color-text-muted)' }}>
            <FolderOpen className="w-3 h-3 shrink-0" />
            <span className="truncate">{resource.local_path || resource.git_remote_url}</span>
          </div>
        )}
      </div>

      <ChevronRight
        className="w-4 h-4 shrink-0 mt-1 opacity-0 group-hover:opacity-50 transition-opacity"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}

export function Skills() {
  const { data: resourcesData, isLoading } = useResourcesByType('skill');
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
        <h1 className="text-lg font-bold">Skills</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
          Skill libraries from connected agents and swarms.
        </p>
      </div>

      {resources.length > 0 && (
        <ListFilters
          search={search}
          onSearchChange={setSearch}
          placeholder="Search skills…"
          count={{ visible: filtered.length, total: resources.length, noun: 'library' }}
        />
      )}

      {resources.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No skill libraries yet"
          description="Skills appear when discovered locally or registered by connected swarms."
        />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-center py-8" style={{ color: 'var(--color-text-muted)' }}>
          No skills match “{q}”.
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((resource) => (
            <SkillResourceCard key={resource.id} resource={resource} />
          ))}
        </div>
      )}
    </div>
  );
}
