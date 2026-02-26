import { useState, useMemo } from 'react';
import { Wrench, ChevronRight, Tag, ArrowLeft, AlertTriangle, CheckCircle, Clock, Zap, FlaskConical, Archive } from 'lucide-react';
import { useSkillsList, useSkillDetail } from '../../hooks/useApi';
import { Markdown } from '../common/Markdown';
import clsx from 'clsx';
import type { SkillSummary } from '../../lib/api';

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

function SkillCard({ skill, onClick }: { skill: SkillSummary; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full card card-hover px-3 py-2.5 text-left cursor-pointer group"
    >
      <div className="flex items-start gap-2.5">
        <div
          className="w-7 h-7 rounded flex items-center justify-center shrink-0 mt-0.5"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <Wrench className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-medium truncate group-hover:text-honey-500 transition-colors">
              {skill.name || skill.id}
            </h3>
            {skill.version && (
              <span className="text-2xs font-mono px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
                v{skill.version}
              </span>
            )}
            <StatusBadge status={skill.status} />
          </div>
          {skill.description && (
            <p className="text-xs line-clamp-2 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
              {skill.description}
            </p>
          )}
          {skill.tags.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {skill.tags.slice(0, 5).map((tag) => (
                <span
                  key={tag}
                  className="text-2xs px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
                >
                  {tag}
                </span>
              ))}
              {skill.tags.length > 5 && (
                <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  +{skill.tags.length - 5}
                </span>
              )}
            </div>
          )}
        </div>
        <ChevronRight className="w-4 h-4 shrink-0 mt-1 opacity-0 group-hover:opacity-50 transition-opacity" />
      </div>
    </button>
  );
}

function SkillSection({ title, icon: Icon, content }: { title: string; icon: React.ElementType; content: string | null }) {
  if (!content) return null;
  return (
    <div className="mt-3">
      <h4 className="text-xs font-semibold flex items-center gap-1.5 mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
        <Icon className="w-3.5 h-3.5" />
        {title}
      </h4>
      <div className="text-xs rounded-md p-3" style={{ backgroundColor: 'var(--color-elevated)' }}>
        <Markdown content={content} />
      </div>
    </div>
  );
}

function SkillDetailView({ resourceId, skillId, onBack }: { resourceId: string; skillId: string; onBack: () => void }) {
  const { data: skill, isLoading } = useSkillDetail(resourceId, skillId);

  if (isLoading) {
    return <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading skill...</div>;
  }

  if (!skill) {
    return <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Skill not found</div>;
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-2xs mb-2 hover:text-honey-500 transition-colors cursor-pointer"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="w-3 h-3" />
        Back to skills
      </button>

      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div
          className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <Wrench className="w-4.5 h-4.5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold">{skill.name || skill.id}</h3>
            {skill.version && (
              <span className="text-2xs font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
                v{skill.version}
              </span>
            )}
            <StatusBadge status={skill.status} />
          </div>
          {skill.description && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
              {skill.description}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {skill.author && (
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                by {skill.author}
              </span>
            )}
            {skill.tags.length > 0 && (
              <div className="flex items-center gap-1">
                {skill.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-2xs px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sections */}
      <SkillSection title="Problem" icon={AlertTriangle} content={skill.problem} />
      <SkillSection title="Trigger Conditions" icon={Zap} content={skill.triggerConditions} />
      <SkillSection title="Solution" icon={CheckCircle} content={skill.solution} />
      <SkillSection title="Verification" icon={CheckCircle} content={skill.verification} />
      <SkillSection title="Examples" icon={FlaskConical} content={skill.examples} />
      <SkillSection title="Notes" icon={Tag} content={skill.notes} />
    </div>
  );
}

export function SkillBrowser({ resourceId }: { resourceId: string }) {
  const { data: skills, isLoading } = useSkillsList(resourceId);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const filteredSkills = useMemo(() => {
    if (!skills) return [];
    if (!filter) return skills;
    const lower = filter.toLowerCase();
    return skills.filter(
      (s) =>
        (s.name || s.id).toLowerCase().includes(lower) ||
        s.description?.toLowerCase().includes(lower) ||
        s.tags.some((t) => t.toLowerCase().includes(lower))
    );
  }, [skills, filter]);

  // Group by status
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

  if (selectedSkill) {
    return (
      <div className="card p-4">
        <SkillDetailView
          resourceId={resourceId}
          skillId={selectedSkill}
          onBack={() => setSelectedSkill(null)}
        />
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
          Skill Tree Contents
        </h2>
        <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {skills?.length || 0} skill{skills?.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Filter */}
      {skills && skills.length > 3 && (
        <div className="relative mb-3">
          <Wrench className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter skills..."
            className="input w-full pl-7 text-xs"
          />
        </div>
      )}

      {isLoading ? (
        <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading skills...</div>
      ) : filteredSkills.length > 0 ? (
        <div className="space-y-3">
          {statusOrder.map((status) => {
            const group = grouped[status];
            if (!group || group.length === 0) return null;
            return (
              <div key={status}>
                {Object.keys(grouped).length > 1 && (
                  <div className="text-2xs font-medium mb-1 px-1" style={{ color: 'var(--color-text-muted)' }}>
                    {status.charAt(0).toUpperCase() + status.slice(1)} ({group.length})
                  </div>
                )}
                <div className="space-y-1">
                  {group.map((skill) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      onClick={() => setSelectedSkill(skill.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="py-8 text-center">
          <Wrench className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {filter ? `No skills matching "${filter}"` : 'No skills found'}
          </p>
          {!filter && (
            <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Expected: skills/*/SKILL.md or .skilltree/skills/*/SKILL.md
            </p>
          )}
        </div>
      )}
    </div>
  );
}
