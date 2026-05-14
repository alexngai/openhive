import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, FileText } from 'lucide-react';
import { SpecEditor, type SpecDraft } from '../components/specs/SpecEditor';
import { useCreateSpec } from '../hooks/useSpecs';
import { useResourcesByType } from '../hooks/useApi';

const DRAFT_KEY = 'openhive:spec-draft';

interface DraftEnvelope extends SpecDraft {
  resource_id?: string;
  saved_at: number;
}

function loadDraft(): DraftEnvelope | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DraftEnvelope;
  } catch {
    return null;
  }
}

function saveDraft(d: DraftEnvelope) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* ignore quota etc */
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

export function SpecNew() {
  const navigate = useNavigate();
  const restored = useMemo(() => loadDraft(), []);
  const [resourceId, setResourceId] = useState<string>(restored?.resource_id ?? '');
  const [error, setError] = useState<string | null>(null);

  const { data: resourcesData } = useResourcesByType('task');
  const opentasksResources = useMemo(
    () =>
      (resourcesData?.data ?? []).filter((r) => {
        const meta = r.metadata as Record<string, unknown> | null;
        return !!meta?.opentasks;
      }),
    [resourcesData],
  );

  // Default to first resource once loaded, if none restored
  useEffect(() => {
    if (!resourceId && opentasksResources.length > 0) {
      setResourceId(opentasksResources[0]!.id);
    }
  }, [resourceId, opentasksResources]);

  const create = useCreateSpec();

  const handleChange = (draft: SpecDraft) => {
    saveDraft({ ...draft, resource_id: resourceId, saved_at: Date.now() });
  };

  const handleSave = async (draft: SpecDraft) => {
    if (!resourceId) {
      setError('Pick a task graph to host this spec.');
      return;
    }
    setError(null);
    try {
      const result = await create.mutateAsync({
        resource_id: resourceId,
        title: draft.title,
        content: draft.content,
        priority: draft.priority,
      });
      clearDraft();
      navigate(`/specs/${resourceId}/${result.spec.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDiscard = () => {
    clearDraft();
    navigate('/specs');
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to="/specs"
        className="inline-flex items-center gap-1 text-sm mb-4 hover:opacity-80"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to specs
      </Link>

      <h1
        className="flex items-center gap-2 text-2xl font-bold mb-1"
        style={{ color: 'var(--color-text)' }}
      >
        <FileText className="h-6 w-6 text-honey-500" />
        New spec
      </h1>
      <p className="text-sm mb-6" style={{ color: 'var(--color-text-muted)' }}>
        Markdown body. Drafts autosave locally until you save or discard.
      </p>

      {/* Resource picker */}
      <div className="mb-4">
        <label htmlFor="task-graph-select" className="block text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
          Task graph
        </label>
        {opentasksResources.length === 0 ? (
          <div
            className="rounded-md border p-3 text-sm"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text-muted)',
            }}
          >
            No OpenTasks task graphs are accessible. Connect or create one to author specs here.
          </div>
        ) : (
          <select
            id="task-graph-select"
            value={resourceId}
            onChange={(e) => {
              setResourceId(e.target.value);
              const current = loadDraft();
              if (current) {
                saveDraft({ ...current, resource_id: e.target.value, saved_at: Date.now() });
              }
            }}
            className="w-full px-3 py-2 rounded-md border bg-transparent text-sm outline-none"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text)',
            }}
          >
            {opentasksResources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {restored && (
        <div
          className="mb-4 rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text-muted)',
          }}
        >
          Restored a draft saved {new Date(restored.saved_at).toLocaleString()}.
        </div>
      )}

      <SpecEditor
        initial={
          restored
            ? { title: restored.title, content: restored.content, priority: restored.priority }
            : undefined
        }
        showDiscard
        saving={create.isPending}
        saveLabel="Create spec"
        onSave={handleSave}
        onCancel={() => navigate('/specs')}
        onDiscardDraft={handleDiscard}
        onChange={handleChange}
        errorMessage={error}
      />
    </div>
  );
}
