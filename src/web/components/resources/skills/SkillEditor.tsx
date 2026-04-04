import { useState } from 'react';
import { Plus, X, Tag, Save } from 'lucide-react';
import { useCreateSkill, useUpdateSkill } from '../../../hooks/useApi';
import type { SkillWritePayload } from '../../../lib/api';

interface SkillEditorProps {
  resourceId: string;
  /** If provided, edit mode; otherwise create mode */
  initial?: Partial<SkillWritePayload> & { id?: string };
  onClose: () => void;
}

export function SkillEditor({ resourceId, initial, onClose }: SkillEditorProps) {
  const isEdit = !!initial?.id;
  const createSkill = useCreateSkill(resourceId);
  const updateSkill = useUpdateSkill(resourceId);

  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [problem, setProblem] = useState(initial?.problem || '');
  const [solution, setSolution] = useState(initial?.solution || '');
  const [verification, setVerification] = useState(initial?.verification || '');
  const [tags, setTags] = useState<string[]>(initial?.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [status, setStatus] = useState<string>(initial?.status || 'draft');
  const [error, setError] = useState<string | null>(null);

  const isPending = createSkill.isPending || updateSkill.isPending;

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (t && !tags.includes(t)) {
      setTags([...tags, t]);
    }
    setTagInput('');
  }

  function removeTag(tag: string) {
    setTags(tags.filter(t => t !== tag));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    const payload: SkillWritePayload = {
      name: name.trim(),
      description: description.trim(),
      problem: problem.trim(),
      solution: solution.trim(),
      verification: verification.trim(),
      tags,
      status: status as SkillWritePayload['status'],
    };

    try {
      if (isEdit) {
        await updateSkill.mutateAsync({ skillId: initial!.id!, ...payload });
      } else {
        await createSkill.mutateAsync(payload);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save skill');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold">{isEdit ? 'Edit Skill' : 'New Skill'}</h3>
        <button type="button" onClick={onClose} className="btn-ghost p-1 cursor-pointer">
          <X className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 px-2 py-1 rounded bg-red-500/10">{error}</div>
      )}

      <div>
        <label className="text-2xs font-medium block mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Name *</label>
        <input value={name} onChange={e => setName(e.target.value)} className="input w-full text-xs" placeholder="Skill name" />
      </div>

      <div>
        <label className="text-2xs font-medium block mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} className="input w-full text-xs" placeholder="Brief description" />
      </div>

      <div>
        <label className="text-2xs font-medium block mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Problem</label>
        <textarea value={problem} onChange={e => setProblem(e.target.value)} className="input w-full text-xs" rows={2} placeholder="What problem does this skill solve?" />
      </div>

      <div>
        <label className="text-2xs font-medium block mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Solution</label>
        <textarea value={solution} onChange={e => setSolution(e.target.value)} className="input w-full text-xs" rows={3} placeholder="Step-by-step solution / instructions" />
      </div>

      <div>
        <label className="text-2xs font-medium block mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Verification</label>
        <textarea value={verification} onChange={e => setVerification(e.target.value)} className="input w-full text-xs" rows={2} placeholder="How to verify this skill was applied correctly" />
      </div>

      <div>
        <label className="text-2xs font-medium block mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Status</label>
        <select value={status} onChange={e => setStatus(e.target.value)} className="input w-full text-xs">
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="experimental">Experimental</option>
          <option value="deprecated">Deprecated</option>
        </select>
      </div>

      <div>
        <label className="text-2xs font-medium block mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Tags</label>
        <div className="flex items-center gap-1 flex-wrap mb-1">
          {tags.map(tag => (
            <span key={tag} className="text-2xs px-1.5 py-0.5 rounded flex items-center gap-1" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
              {tag}
              <button type="button" onClick={() => removeTag(tag)} className="hover:text-red-400 cursor-pointer"><X className="w-2.5 h-2.5" /></button>
            </span>
          ))}
        </div>
        <div className="flex gap-1">
          <input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            className="input flex-1 text-xs"
            placeholder="Add tag..."
          />
          <button type="button" onClick={addTag} className="btn-ghost p-1.5 cursor-pointer">
            <Tag className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="btn text-xs px-3 py-1.5 cursor-pointer">Cancel</button>
        <button type="submit" disabled={isPending} className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 cursor-pointer">
          <Save className="w-3.5 h-3.5" />
          {isPending ? 'Saving...' : isEdit ? 'Update' : 'Create'}
        </button>
      </div>
    </form>
  );
}
