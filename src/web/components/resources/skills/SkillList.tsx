import { useState, useMemo } from 'react';
import { Wrench, ChevronRight, Tag, ArrowLeft, AlertTriangle, CheckCircle, Clock, Zap, FlaskConical, Archive, GitBranch, Network, Plus } from 'lucide-react';
import { useSkillsList, useSkillDetail, useSkillSearch } from '../../../hooks/useApi';
import { Markdown } from '../../common/Markdown';
import { SkillEditor } from './SkillEditor';
import clsx from 'clsx';
import type { SkillSummary } from '../../../lib/api';

const STATUS_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  active: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  draft: { icon: Clock, color: 'text-blue-400', bg: 'bg-blue-500/10' },
  experimental: { icon: FlaskConical, color: 'text-amber-400', bg: 'bg-amber-500/10' },
  deprecated: { icon: Archive, color: 'text-gray-400', bg: 'bg-gray-500/10' },
};

function StatusBadge({ status }: { status: string | null }) {
  const config = STATUS_CONFIG[status || ''] || STATUS_CONFIG.draft;
  const Icon = config.icon;
  return (
    <span className={`text-2xs px-1.5 py-0.5 rounded flex items-center gap-1 ${config.bg} ${config.color}`}>
      <Icon className="w-2.5 h-2.5" />
      {status || 'unknown'}
    </span>
  );
}

const RELATION_STYLES: Record<string, string> = {
  depends_on: 'text-red-400',
  extends: 'text-blue-400',
  alternative: 'text-amber-400',
  related: 'text-gray-400',
  derived_from: 'text-purple-400',
  fork: 'text-teal-400',
};

function SkillCard({ skill, onClick }: { skill: SkillSummary; onClick: () => void }) {
  const hasRelationships = (skill.relationships?.length || 0) > 0 || (skill.related?.length || 0) > 0;
  const hasTaxonomy = skill.taxonomy?.primaryPath?.length;

  return (
    <button onClick={onClick} className="w-full card card-hover px-3 py-2.5 text-left cursor-pointer group">
      <div className="flex items-start gap-2.5">
        <div className="w-7 h-7 rounded flex items-center justify-center shrink-0 mt-0.5" style={{ backgroundColor: 'var(--color-elevated)' }}>
          <Wrench className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-medium truncate group-hover:text-honey-500 transition-colors">{skill.name || skill.id}</h3>
            {skill.version && (
              <span className="text-2xs font-mono px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>v{skill.version}</span>
            )}
            <StatusBadge status={skill.status} />
          </div>
          {skill.description && (
            <p className="text-xs line-clamp-2 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>{skill.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {skill.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="text-2xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>{tag}</span>
            ))}
            {hasTaxonomy && (
              <span className="text-2xs" style={{ color: 'var(--color-accent)' }}>{skill.taxonomy!.primaryPath.join(' / ')}</span>
            )}
            {hasRelationships && (
              <span className="flex items-center gap-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                <Network className="w-2.5 h-2.5" />
                {(skill.relationships?.length || 0) + (skill.related?.length || 0)} links
              </span>
            )}
            {(skill.parentVersion || skill.forks?.length) && (
              <span className="flex items-center gap-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                <GitBranch className="w-2.5 h-2.5" />
                {skill.forks?.length ? `${skill.forks.length} forks` : `from ${skill.parentVersion}`}
              </span>
            )}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 shrink-0 mt-1 opacity-0 group-hover:opacity-50 transition-opacity" />
      </div>
    </button>
  );
}

function SkillDetailView({ resourceId, skillId, onBack }: { resourceId: string; skillId: string; onBack: () => void }) {
  const { data: skill, isLoading } = useSkillDetail(resourceId, skillId);

  if (isLoading) return <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading skill...</div>;
  if (!skill) return <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Skill not found</div>;

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1 text-2xs mb-2 hover:text-honey-500 transition-colors cursor-pointer" style={{ color: 'var(--color-text-muted)' }}>
        <ArrowLeft className="w-3 h-3" />Back to skills
      </button>

      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: 'var(--color-elevated)' }}>
          <Wrench className="w-4.5 h-4.5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold">{skill.name || skill.id}</h3>
            {skill.version && <span className="text-2xs font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>v{skill.version}</span>}
            <StatusBadge status={skill.status} />
          </div>
          {skill.description && <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>{skill.description}</p>}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {skill.author && <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>by {skill.author}</span>}
            {skill.tags.map((tag) => (
              <span key={tag} className="text-2xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>{tag}</span>
            ))}
            {skill.taxonomy && <span className="text-2xs" style={{ color: 'var(--color-accent)' }}>{skill.taxonomy.primaryPath.join(' / ')}</span>}
          </div>
        </div>
      </div>

      {/* Instructions */}
      {skill.instructions && (
        <div className="rounded-md p-3 mb-3" style={{ backgroundColor: 'var(--color-elevated)' }}>
          <div className="prose-sm"><Markdown content={skill.instructions} /></div>
        </div>
      )}

      {/* Relationships */}
      {(skill.relationships?.length || 0) > 0 && (
        <div className="mb-3">
          <h4 className="text-xs font-semibold mb-1.5 flex items-center gap-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            <Network className="w-3.5 h-3.5" />Relationships
          </h4>
          <div className="space-y-1">
            {skill.relationships!.map((rel, i) => (
              <div key={i} className="text-xs flex items-center gap-2 px-2 py-1 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>
                <span className={clsx('text-2xs font-mono', RELATION_STYLES[rel.type] || 'text-gray-400')}>{rel.type}</span>
                <span className="font-mono">{rel.targetId}</span>
                {rel.confidence && <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>{(rel.confidence * 100).toFixed(0)}%</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lineage */}
      {(skill.parentVersion || skill.derivedFrom?.length || skill.forks?.length) && (
        <div className="mb-3">
          <h4 className="text-xs font-semibold mb-1.5 flex items-center gap-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            <GitBranch className="w-3.5 h-3.5" />Lineage
          </h4>
          <div className="text-xs space-y-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {skill.parentVersion && <div>Parent version: <span className="font-mono">{skill.parentVersion}</span></div>}
            {skill.derivedFrom?.map(id => <div key={id}>Derived from: <span className="font-mono">{id}</span></div>)}
            {skill.forks?.map(id => <div key={id}>Fork: <span className="font-mono">{id}</span></div>)}
          </div>
        </div>
      )}

    </div>
  );
}

function SearchResults({ resourceId, query }: { resourceId: string; query: string }) {
  const { data, isLoading } = useSkillSearch(resourceId, query);

  if (isLoading) return <div className="py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Searching...</div>;
  if (!data || data.results.length === 0) return <div className="py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>No results for "{query}"</div>;

  return (
    <div className="space-y-1">
      <div className="text-2xs mb-2" style={{ color: 'var(--color-text-muted)' }}>{data.total} result{data.total !== 1 ? 's' : ''}</div>
      {data.results.map((r) => (
        <div key={r.id} className="rounded-md p-2.5" style={{ backgroundColor: 'var(--color-elevated)' }}>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{r.name || r.id}</span>
            {r.score != null && <span className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>{typeof r.score === 'number' && r.score <= 1 ? `${(r.score * 100).toFixed(0)}%` : ''}</span>}
          </div>
          {r.description && <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>{r.description}</p>}
        </div>
      ))}
    </div>
  );
}

export function SkillList({ resourceId, searchQuery }: { resourceId: string; searchQuery: string }) {
  const { data: skills, isLoading } = useSkillsList(resourceId);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const filteredSkills = useMemo(() => {
    if (!skills) return [];
    if (!searchQuery) return skills;
    const lower = searchQuery.toLowerCase();
    return skills.filter(s =>
      (s.name || s.id).toLowerCase().includes(lower) ||
      s.description?.toLowerCase().includes(lower) ||
      s.tags.some(t => t.toLowerCase().includes(lower))
    );
  }, [skills, searchQuery]);

  const grouped = useMemo(() => {
    const groups: Record<string, SkillSummary[]> = {};
    for (const skill of filteredSkills) {
      const status = skill.status || 'unknown';
      if (!groups[status]) groups[status] = [];
      groups[status].push(skill);
    }
    return groups;
  }, [filteredSkills]);

  const statusOrder = ['active', 'experimental', 'draft', 'deprecated', 'unknown'];

  if (showEditor) {
    return <SkillEditor resourceId={resourceId} onClose={() => setShowEditor(false)} />;
  }

  if (searchQuery.length >= 2) {
    return <SearchResults resourceId={resourceId} query={searchQuery} />;
  }

  if (selectedSkill) {
    return <SkillDetailView resourceId={resourceId} skillId={selectedSkill} onBack={() => setSelectedSkill(null)} />;
  }

  if (isLoading) return <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading skills...</div>;

  if (filteredSkills.length === 0) {
    return (
      <div className="py-8 text-center">
        <Wrench className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No skills found</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>{skills?.length || 0} skills</div>
        <button
          onClick={() => setShowEditor(true)}
          className="text-2xs flex items-center gap-1 px-2 py-1 rounded hover:bg-workspace-hover transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Plus className="w-3 h-3" />
          New Skill
        </button>
      </div>
      {statusOrder.map((status) => {
        const group = grouped[status];
        if (!group?.length) return null;
        return (
          <div key={status}>
            {Object.keys(grouped).length > 1 && (
              <div className="text-2xs font-medium mb-1 px-1" style={{ color: 'var(--color-text-muted)' }}>
                {status.charAt(0).toUpperCase() + status.slice(1)} ({group.length})
              </div>
            )}
            <div className="space-y-1">
              {group.map((skill) => <SkillCard key={skill.id} skill={skill} onClick={() => setSelectedSkill(skill.id)} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
