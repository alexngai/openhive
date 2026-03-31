import { useState } from 'react';
import { GitBranch, GitCommit, ChevronRight, Wrench } from 'lucide-react';
import { useSkillsList, useSkillVersions } from '../../../hooks/useApi';
import type { SkillSummary } from '../../../lib/api';

function VersionTimeline({ resourceId, skillId, skillName }: { resourceId: string; skillId: string; skillName: string }) {
  const { data, isLoading } = useSkillVersions(resourceId, skillId);

  if (isLoading) return <div className="py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading versions...</div>;

  const versions = data?.versions || [];

  if (versions.length === 0) {
    return (
      <div className="py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
        No version history for {skillName}
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-xs font-semibold mb-2">{skillName}</h3>
      <div className="relative pl-4 border-l" style={{ borderColor: 'var(--color-border-subtle)' }}>
        {versions.map((v, i) => (
          <div key={v.version} className="relative mb-3 last:mb-0">
            {/* Dot on the line */}
            <div
              className="absolute -left-[21px] w-2.5 h-2.5 rounded-full border-2"
              style={{
                backgroundColor: i === 0 ? 'var(--color-honey-500)' : 'var(--color-surface)',
                borderColor: i === 0 ? 'var(--color-honey-500)' : 'var(--color-border)',
              }}
            />

            <div className="rounded-md p-2.5" style={{ backgroundColor: i === 0 ? 'var(--color-elevated)' : 'transparent' }}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-medium">v{v.version}</span>
                {v.status && (
                  <span className="text-2xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
                    {v.status}
                  </span>
                )}
                {v.createdAt && (
                  <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                    {new Date(v.createdAt).toLocaleDateString()}
                  </span>
                )}
                {i === 0 && (
                  <span className="text-2xs px-1 py-0.5 rounded bg-honey-500/10 text-honey-500">current</span>
                )}
              </div>
              {v.changelog && (
                <p className="text-xs mt-1" style={{ color: 'var(--color-text-secondary)' }}>{v.changelog}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkillVersions({ resourceId }: { resourceId: string }) {
  const { data: skills, isLoading } = useSkillsList(resourceId);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);

  if (isLoading) return <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading skills...</div>;

  if (!skills?.length) {
    return (
      <div className="py-8 text-center">
        <GitBranch className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No skills to show versions for</p>
      </div>
    );
  }

  if (selectedSkill) {
    const skill = skills.find(s => s.id === selectedSkill);
    return (
      <div>
        <button
          onClick={() => setSelectedSkill(null)}
          className="flex items-center gap-1 text-2xs mb-3 hover:text-honey-500 transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ChevronRight className="w-3 h-3 rotate-180" />
          All skills
        </button>
        <VersionTimeline resourceId={resourceId} skillId={selectedSkill} skillName={skill?.name || selectedSkill} />
      </div>
    );
  }

  // Show skill picker
  return (
    <div>
      <div className="text-2xs mb-2" style={{ color: 'var(--color-text-muted)' }}>Select a skill to view its version history</div>
      <div className="space-y-0.5">
        {skills.map((skill) => (
          <button
            key={skill.id}
            onClick={() => setSelectedSkill(skill.id)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-workspace-hover transition-colors text-left cursor-pointer group"
          >
            <Wrench className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
            <span className="text-xs truncate flex-1 group-hover:text-honey-500 transition-colors">{skill.name || skill.id}</span>
            {skill.version && (
              <span className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>v{skill.version}</span>
            )}
            {(skill.parentVersion || skill.forks?.length) && (
              <GitBranch className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
            )}
            <ChevronRight className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-50 transition-opacity" />
          </button>
        ))}
      </div>
    </div>
  );
}
