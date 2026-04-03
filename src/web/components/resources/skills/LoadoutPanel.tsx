import { useState } from 'react';
import { Zap, ChevronDown, ChevronUp, Copy, RotateCcw, Hash, Eye, EyeOff } from 'lucide-react';
import {
  useLoadoutProfiles,
  useLoadoutState,
  useLoadoutRender,
  useCompileLoadout,
  useExpandLoadoutSkill,
  useCollapseLoadoutSkill,
  useClearLoadout,
} from '../../../hooks/useApi';
import clsx from 'clsx';

export function LoadoutPanel({ resourceId }: { resourceId: string }) {
  const { data: profiles } = useLoadoutProfiles(resourceId);
  const { data: state } = useLoadoutState(resourceId);
  const compileLoadout = useCompileLoadout(resourceId);
  const expandSkill = useExpandLoadoutSkill(resourceId);
  const collapseSkill = useCollapseLoadoutSkill(resourceId);
  const clearLoadout = useClearLoadout(resourceId);

  const [selectedProfile, setSelectedProfile] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [showRender, setShowRender] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasLoadout = state && state.available.length > 0;
  const { data: renderData } = useLoadoutRender(resourceId, showRender && !!hasLoadout);

  async function handleCompile() {
    if (selectedProfile) {
      await compileLoadout.mutateAsync({ profile: selectedProfile });
    } else if (taskDesc.trim()) {
      await compileLoadout.mutateAsync({ taskDescription: taskDesc.trim() });
    }
  }

  function handleCopy() {
    if (renderData?.content) {
      navigator.clipboard.writeText(renderData.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="space-y-4">
      {/* Compile controls */}
      <div className="space-y-2">
        <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Compile Loadout</div>

        <div className="flex gap-2">
          <select
            value={selectedProfile}
            onChange={e => { setSelectedProfile(e.target.value); setTaskDesc(''); }}
            className="input flex-1 text-xs"
          >
            <option value="">Select a profile...</option>
            {profiles?.map(p => (
              <option key={p.name} value={p.name}>{p.name}{p.builtIn ? ' (built-in)' : ''}</option>
            ))}
          </select>

          <button
            onClick={handleCompile}
            disabled={(!selectedProfile && !taskDesc.trim()) || compileLoadout.isPending}
            className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <Zap className="w-3.5 h-3.5" />
            {compileLoadout.isPending ? 'Compiling...' : 'Compile'}
          </button>
        </div>

        <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>or describe the task:</div>
        <input
          value={taskDesc}
          onChange={e => { setTaskDesc(e.target.value); setSelectedProfile(''); }}
          className="input w-full text-xs"
          placeholder="e.g. implementing a REST API with authentication..."
          onKeyDown={e => { if (e.key === 'Enter') handleCompile(); }}
        />
      </div>

      {/* Current loadout */}
      {hasLoadout && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
              Active Loadout
              <span className="ml-1.5 font-normal">
                ({state.available.length} skills, {state.expanded.length} expanded)
              </span>
            </div>
            <button
              onClick={() => clearLoadout.mutate()}
              className="text-2xs flex items-center gap-1 hover:text-red-400 transition-colors cursor-pointer"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <RotateCcw className="w-3 h-3" />
              Clear
            </button>
          </div>

          {state.source.type !== 'manual' && (
            <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              Source: {state.source.type}
              {state.source.profileName && ` (${state.source.profileName})`}
              {state.source.taskDescription && ` — "${state.source.taskDescription.slice(0, 60)}..."`}
            </div>
          )}

          <div className="space-y-1">
            {state.available.map(skill => {
              const isExpanded = state.expanded.includes(skill.id);
              return (
                <div
                  key={skill.id}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-md"
                  style={{ backgroundColor: isExpanded ? 'var(--color-elevated)' : 'transparent' }}
                >
                  <button
                    onClick={() => isExpanded
                      ? collapseSkill.mutate(skill.id)
                      : expandSkill.mutate(skill.id)
                    }
                    className="shrink-0 cursor-pointer"
                    style={{ color: isExpanded ? 'var(--color-honey-500)' : 'var(--color-text-muted)' }}
                  >
                    {isExpanded ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs truncate block">{skill.name}</span>
                    {skill.description && (
                      <span className="text-2xs truncate block" style={{ color: 'var(--color-text-muted)' }}>{skill.description}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {skill.tags.slice(0, 2).map(tag => (
                      <span key={tag} className="text-2xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>{tag}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {state.pending.length > 0 && (
            <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              {state.pending.length} pending approval: {state.pending.join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Rendered output */}
      {hasLoadout && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setShowRender(!showRender)}
              className="text-2xs font-medium flex items-center gap-1 cursor-pointer hover:text-honey-500 transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {showRender ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              System Prompt Preview
            </button>
            {renderData && (
              <div className="flex items-center gap-2">
                <span className="text-2xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
                  <Hash className="w-3 h-3" />
                  ~{renderData.estimatedTokens.toLocaleString()} tokens
                </span>
                <button onClick={handleCopy} className="text-2xs flex items-center gap-1 hover:text-honey-500 transition-colors cursor-pointer" style={{ color: 'var(--color-text-muted)' }}>
                  <Copy className="w-3 h-3" />
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
          </div>
          {showRender && renderData && (
            <pre
              className="rounded-md p-3 text-2xs overflow-x-auto font-mono"
              style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text-secondary)', maxHeight: 300 }}
            >
              {renderData.content}
            </pre>
          )}
        </div>
      )}

      {/* Empty state */}
      {!hasLoadout && !compileLoadout.isPending && (
        <div className="py-6 text-center">
          <Zap className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No loadout active</p>
          <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Select a profile or describe a task to compile a skill loadout for agent use.
          </p>
        </div>
      )}
    </div>
  );
}
