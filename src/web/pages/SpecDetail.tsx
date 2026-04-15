import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, FileText, ListTodo, MessageSquare, Layers, GitBranch, Zap, Pencil,
  Archive, ArchiveRestore,
} from 'lucide-react';
import clsx from 'clsx';
import { useSpec, useUpdateSpec } from '../hooks/useSpecs';
import { useSpecsRealtime } from '../hooks/useSpecsRealtime';
import { SpecMarkdown } from '../components/specs/SpecMarkdown';
import { SpecEditor } from '../components/specs/SpecEditor';
import { LinkedNodesPanel } from '../components/specs/LinkedNodesPanel';
import { PageLoader } from '../components/common/LoadingSpinner';

const PRIORITY_COLORS: Record<number, string> = {
  0: 'bg-red-600',
  1: 'bg-orange-600',
  2: 'bg-yellow-600',
  3: 'bg-blue-600',
  4: 'bg-gray-600',
};

const PRIORITY_LABELS: Record<number, string> = {
  0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4',
};

export function SpecDetail() {
  const { resourceId, specId } = useParams<{ resourceId: string; specId: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useSpec(resourceId, specId);
  const updateSpec = useUpdateSpec(resourceId ?? '', specId ?? '');
  const [editing, setEditing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useSpecsRealtime();

  if (isLoading) return <PageLoader />;

  if (error) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <Link
          to="/specs"
          className="inline-flex items-center gap-1 text-sm mb-4"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to specs
        </Link>
        <div
          className="rounded-md border p-4 text-sm"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          Failed to load spec: {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  if (!data) return null;
  const { spec, linked } = data;

  const handleArchiveToggle = async () => {
    try {
      await updateSpec.mutateAsync({ archived: !spec.archived });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Link
        to="/specs"
        className="inline-flex items-center gap-1 text-sm mb-4 hover:opacity-80"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to specs
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <FileText className="h-4 w-4 text-honey-500" />
          <span className="font-mono">{spec.id}</span>
          <span>·</span>
          <span>{spec.resource_name}</span>
          {spec.swarm_name && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Zap className="h-3 w-3 text-honey-500" />
                {spec.swarm_name}
              </span>
            </>
          )}
          {spec.archived && (
            <>
              <span>·</span>
              <span className="px-1.5 py-0.5 rounded bg-white/5">archived</span>
            </>
          )}
        </div>

        <div className="flex items-start justify-between gap-3">
          <h1 className="text-2xl font-bold" style={{ color: 'var(--color-text)' }}>
            {spec.title || 'Untitled spec'}
          </h1>
          <div className="flex items-center gap-2 shrink-0">
            {spec.priority !== undefined && spec.priority <= 3 && (
              <span
                className={clsx(
                  'rounded-full px-2 py-1 text-xs font-medium text-white',
                  PRIORITY_COLORS[spec.priority],
                )}
              >
                {PRIORITY_LABELS[spec.priority]}
              </span>
            )}
            {!editing && (
              <>
                <button
                  type="button"
                  onClick={handleArchiveToggle}
                  disabled={updateSpec.isPending}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/5"
                  style={{ color: 'var(--color-text-muted)' }}
                  title={spec.archived ? 'Restore' : 'Archive'}
                >
                  {spec.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSaveError(null);
                    setEditing(true);
                  }}
                  className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded hover:bg-white/5"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {saveError && (
        <div
          className="mb-4 rounded-md border p-3 text-sm"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          {saveError}
        </div>
      )}

      {/* Two-column layout: content + sidebar */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Markdown body / editor */}
        {editing ? (
          <SpecEditor
            initial={{
              title: spec.title,
              content: spec.content ?? '',
              priority: spec.priority,
            }}
            saving={updateSpec.isPending}
            saveLabel="Save changes"
            onSave={async (draft) => {
              setSaveError(null);
              try {
                await updateSpec.mutateAsync({
                  title: draft.title,
                  content: draft.content,
                  priority: draft.priority ?? null,
                });
                setEditing(false);
              } catch (err) {
                setSaveError(err instanceof Error ? err.message : String(err));
              }
            }}
            onCancel={() => {
              setEditing(false);
              setSaveError(null);
            }}
            errorMessage={saveError}
          />
        ) : (
          <div
            className="rounded-md border p-6"
            style={{
              borderColor: 'var(--color-border-subtle)',
              backgroundColor: 'var(--color-surface)',
            }}
          >
            <SpecMarkdown content={spec.content || ''} />
          </div>
        )}

        {/* Sidebar — linked nodes */}
        <div className="space-y-4">
          <LinkedNodesPanel
            title="Tasks"
            icon={<ListTodo className="h-4 w-4 text-honey-500" />}
            nodes={linked.tasks}
            variant="task"
            emptyMessage="No tasks linked"
            onNodeClick={(n) => navigate(`/tasks?node=${encodeURIComponent(n.id)}`)}
          />
          <LinkedNodesPanel
            title="Feedback"
            icon={<MessageSquare className="h-4 w-4 text-honey-500" />}
            nodes={linked.feedback}
            variant="feedback"
            emptyMessage="No feedback yet"
          />
          <LinkedNodesPanel
            title="Contexts"
            icon={<Layers className="h-4 w-4 text-honey-500" />}
            nodes={linked.contexts}
            variant="context"
            emptyMessage="No contexts linked"
          />
          {linked.specs.length > 0 && (
            <LinkedNodesPanel
              title="Related specs"
              icon={<FileText className="h-4 w-4 text-honey-500" />}
              nodes={linked.specs}
              variant="spec"
              onNodeClick={(n) =>
                navigate(`/specs/${encodeURIComponent(spec.resource_id)}/${encodeURIComponent(n.id)}`)
              }
            />
          )}
          {linked.issues.length > 0 && (
            <LinkedNodesPanel
              title="Issues"
              icon={<GitBranch className="h-4 w-4 text-honey-500" />}
              nodes={linked.issues}
              variant="issue"
            />
          )}
        </div>
      </div>
    </div>
  );
}
