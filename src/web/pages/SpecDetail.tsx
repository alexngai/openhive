import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, FileText, ListTodo, MessageSquare, Layers, GitBranch, Zap, List,
  Archive, ArchiveRestore, PanelRightClose, PanelRightOpen,
} from 'lucide-react';
import clsx from 'clsx';
import { useSpec, useUpdateSpec, useLinkSpec, useUnlinkSpec } from '../hooks/useSpecs';
import type { EdgeType } from '../hooks/useSpecs';
import { usePageContext } from '../components/chat-fab/usePageContext';
import {
  specContextItem,
  tasksContextItem,
} from '../components/chat-fab/context-types';
import type { ChatFabContextItem } from '../components/chat-fab/chat-fab-item';
import { useSpecsRealtime } from '../hooks/useSpecsRealtime';
import { TiptapSpecEditor, type TocItem } from '../components/specs/TiptapSpecEditor';
import { SpecTableOfContents } from '../components/specs/SpecTableOfContents';
import { LinkedNodesPanel } from '../components/specs/LinkedNodesPanel';
import { DispatchModal } from '../components/dispatch/DispatchModal';
import { SpecDispatchPanel } from '../components/dispatch/SpecDispatchPanel';
import { PageLoader } from '../components/common/LoadingSpinner';
import { StatusChip } from '../components/common/StatusChip';
import { PRIORITY_MAP } from '../components/specs/specPriority';

const TOC_PANEL_KEY = 'openhive:specs:showTocPanel';
const SIDEBAR_PANEL_KEY = 'openhive:specs:showSidebarPanel';
const AUTO_SAVE_DEBOUNCE_MS = 1000;

export function SpecDetail() {
  const { resourceId, specId } = useParams<{ resourceId: string; specId: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useSpec(resourceId, specId);
  const updateSpec = useUpdateSpec(resourceId ?? '', specId ?? '');
  const linkSpec = useLinkSpec(resourceId ?? '', specId ?? '');
  const unlinkSpec = useUnlinkSpec(resourceId ?? '', specId ?? '');
  useSpecsRealtime();

  // Declare this page's chat context items. Re-runs on spec/tasks change;
  // cleared on unmount. Registry-backed formatting lives in context-types.
  const pageSpec = data?.spec;
  const pageTasks = data?.linked.tasks;
  usePageContext(
    () => {
      if (!pageSpec) return [];
      const items: ChatFabContextItem[] = [
        specContextItem(
          {
            id: pageSpec.id,
            resource_id: pageSpec.resource_id,
            title: pageSpec.title,
            content: pageSpec.content ?? '',
          },
          { primary: true },
        ),
      ];
      if (pageTasks && pageTasks.length > 0) {
        items.push(tasksContextItem(pageTasks));
      }
      return items;
    },
    [pageSpec, pageTasks],
  );

  const [saveError, setSaveError] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);

  // Editable fields — local state so we can auto-save debounced without
  // bouncing on every server round trip.
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [priority, setPriority] = useState<number | undefined>(undefined);
  const [hasChanges, setHasChanges] = useState(false);

  // Table-of-contents items, emitted by the Tiptap extension whenever the
  // doc changes or scroll position crosses a heading.
  const [tocItems, setTocItems] = useState<TocItem[]>([]);

  const [showToc, setShowToc] = useState(() => {
    const stored = localStorage.getItem(TOC_PANEL_KEY);
    return stored !== null ? JSON.parse(stored) : true;
  });
  const [showSidebar, setShowSidebar] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_PANEL_KEY);
    return stored !== null ? JSON.parse(stored) : true;
  });

  useEffect(() => {
    localStorage.setItem(TOC_PANEL_KEY, JSON.stringify(showToc));
  }, [showToc]);
  useEffect(() => {
    localStorage.setItem(SIDEBAR_PANEL_KEY, JSON.stringify(showSidebar));
  }, [showSidebar]);

  // Refs for stale-closure-safe auto-save. Mirrors sudocode's pattern so a
  // pending save always sees the current values even after the spec id
  // changes or the mutation identity shifts.
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateSpecRef = useRef(updateSpec);
  const latestValuesRef = useRef({ title, content, priority, hasChanges });
  const currentSpecIdRef = useRef(specId);
  const editorContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    updateSpecRef.current = updateSpec;
  }, [updateSpec]);

  useEffect(() => {
    latestValuesRef.current = { title, content, priority, hasChanges };
  }, [title, content, priority, hasChanges]);

  useEffect(() => {
    currentSpecIdRef.current = specId;
  }, [specId]);

  // Clear any pending save when navigating to a different spec so stale
  // drafts don't write against the new spec.
  useEffect(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    setHasChanges(false);
  }, [specId]);

  // Seed form state when the server data arrives.
  useEffect(() => {
    if (data?.spec) {
      setTitle(data.spec.title);
      setContent(data.spec.content ?? '');
      setPriority(data.spec.priority);
      setHasChanges(false);
    }
  }, [data]);

  // Debounced auto-save.
  useEffect(() => {
    if (!hasChanges) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      updateSpecRef
        .current
        .mutateAsync({
          title,
          content,
          priority: priority ?? null,
        })
        .catch((err) => setSaveError(err instanceof Error ? err.message : String(err)));
      setHasChanges(false);
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [title, content, priority, hasChanges]);

  // Flush pending changes on unmount so a quick nav-away doesn't drop them.
  useEffect(() => {
    return () => {
      const latest = latestValuesRef.current;
      if (latest.hasChanges && currentSpecIdRef.current && updateSpecRef.current) {
        updateSpecRef.current.mutate({
          title: latest.title,
          content: latest.content,
          priority: latest.priority ?? null,
        });
      }
    };
  }, []);

  const handleContentChange = useCallback((markdown: string) => {
    setContent(markdown);
    setHasChanges(true);
  }, []);

  const handleTitleChange = useCallback((value: string) => {
    setTitle(value);
    setHasChanges(true);
  }, []);

  const handlePriorityChange = useCallback((value: number | undefined) => {
    setPriority(value);
    setHasChanges(true);
  }, []);

  const handleTocUpdate = useCallback((items: TocItem[]) => {
    setTocItems(items);
  }, []);

  const handleTocItemClick = useCallback((headingId: string) => {
    const el = editorContainerRef.current?.querySelector(`#${CSS.escape(headingId)}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

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

  if (!data) {
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
          style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
        >
          Spec not found.
        </div>
      </div>
    );
  }
  const { spec, linked, edges } = data;

  const handleLink = async (targetId: string, edgeType: EdgeType, direction: 'inbound' | 'outbound') => {
    await linkSpec.mutateAsync({ target_id: targetId, type: edgeType, direction });
  };

  const handleUnlink = async (targetId: string, edgeType: EdgeType) => {
    await unlinkSpec.mutateAsync({ target_id: targetId, type: edgeType });
  };

  const handleArchiveToggle = async () => {
    try {
      await updateSpec.mutateAsync({ archived: !spec.archived });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const saving = updateSpec.isPending || hasChanges;
  const saveStatus = saving ? 'Saving…' : 'Saved';

  return (
    <>
      <div className="flex h-[calc(100vh-4rem)] flex-col">
        {/* Sticky header */}
        <div
          className="flex shrink-0 flex-col border-b"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-bg)',
          }}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <Link
              to="/specs"
              className="shrink-0 rounded p-1 hover:opacity-80"
              style={{ color: 'var(--color-text-muted)' }}
              title="Back to specs"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>

            <span
              className="shrink-0 font-mono text-xs px-2 py-1 rounded"
              style={{
                color: 'var(--color-text-muted)',
                backgroundColor: 'var(--color-surface)',
              }}
            >
              {spec.id}
            </span>

            <input
              type="text"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Untitled spec"
              className="min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none placeholder:opacity-50"
              style={{ color: 'var(--color-text)' }}
              maxLength={500}
            />

            <span className="shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {saveStatus}
            </span>

            {/* Priority picker */}
            <div className="shrink-0 flex items-center gap-1">
              {priority !== undefined && PRIORITY_MAP[priority] && (
                <StatusChip
                  tone={PRIORITY_MAP[priority].tone}
                  label={PRIORITY_MAP[priority].label}
                />
              )}
              <select
                value={priority === undefined ? '' : String(priority)}
                onChange={(e) =>
                  handlePriorityChange(e.target.value === '' ? undefined : Number(e.target.value))
                }
                className="rounded border bg-transparent text-xs px-1.5 py-1 outline-none"
                style={{
                  borderColor: 'var(--color-border-subtle)',
                  color: 'var(--color-text-secondary)',
                }}
                title="Priority"
              >
                <option value="">—</option>
                <option value="0">P0</option>
                <option value="1">P1</option>
                <option value="2">P2</option>
                <option value="3">P3</option>
                <option value="4">P4</option>
              </select>
            </div>

            <button
              type="button"
              onClick={handleArchiveToggle}
              disabled={updateSpec.isPending}
              className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80"
              style={{ color: 'var(--color-text-muted)' }}
              title={spec.archived ? 'Restore spec' : 'Archive spec'}
              aria-label={spec.archived ? 'Restore spec' : 'Archive spec'}
            >
              {spec.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={() => setShowSidebar(!showSidebar)}
              className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80"
              style={{ color: 'var(--color-text-muted)' }}
              title={showSidebar ? 'Hide dispatch panel' : 'Show dispatch panel'}
              aria-label={showSidebar ? 'Hide dispatch panel' : 'Show dispatch panel'}
            >
              {showSidebar
                ? <PanelRightClose className="h-4 w-4" />
                : <PanelRightOpen className="h-4 w-4" />}
            </button>
          </div>

          {/* Sub-header meta row */}
          <div
            className="flex items-center gap-2 px-4 pb-2 text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <FileText className="h-3 w-3 text-honey-500" />
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
                <span className="px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>archived</span>
              </>
            )}
          </div>
        </div>

        {saveError && (
          <div
            className="mx-4 mt-2 shrink-0 rounded-md border p-2 text-sm"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text)',
            }}
          >
            {saveError}
          </div>
        )}

        {/* Body: TOC · content · sidebar */}
        <div className="flex flex-1 overflow-hidden">
          {showToc ? (
            <aside className="hidden xl:flex w-60 shrink-0">
              <SpecTableOfContents
                items={tocItems}
                onItemClick={handleTocItemClick}
                onCollapse={() => setShowToc(false)}
                className="w-full"
              />
            </aside>
          ) : (
            // Thin rail holds the expand-TOC FAB so content never sits under
            // it. Only rendered when there's an outline worth navigating.
            tocItems.length > 0 && (
              <aside className="hidden xl:flex w-12 shrink-0 items-start justify-center pt-3">
                <button
                  type="button"
                  onClick={() => setShowToc(true)}
                  className="flex h-9 w-9 items-center justify-center rounded-full border shadow transition-colors hover:bg-white/10"
                  style={{
                    borderColor: 'var(--color-border-subtle)',
                    backgroundColor: 'var(--color-surface)',
                    color: 'var(--color-text-secondary)',
                  }}
                  title="Show table of contents"
                >
                  <List className="h-4 w-4" />
                </button>
              </aside>
            )
          )}

          {/* Center content — full width between the two panels with
              responsive padding. Caps at 128rem on ultra-wide screens so
              lines don't stretch unreadably. */}
          <main className="flex-1 overflow-y-auto">
            <div
              ref={editorContainerRef}
              className="w-full px-4 py-5"
            >
              <TiptapSpecEditor
                content={content}
                onChange={handleContentChange}
                onTocUpdate={handleTocUpdate}
                placeholder="Write the spec in markdown — goals, acceptance criteria, out-of-scope. Changes save automatically."
              />
            </div>
          </main>

          {/* Right sidebar */}
          {showSidebar && (
            <aside className="hidden lg:flex w-80 shrink-0 flex-col overflow-y-auto p-4 gap-4">
              <SpecDispatchPanel
                resourceId={spec.resource_id}
                specId={spec.id}
                onDispatch={() => setDispatchOpen(true)}
                dispatchDisabled={spec.archived}
                dispatchDisabledReason="Can't dispatch an archived spec"
              />

              <LinkedNodesPanel
                title="Tasks"
                icon={<ListTodo className="h-4 w-4 text-honey-500" />}
                nodes={linked.tasks}
                variant="task"
                emptyMessage="No tasks linked"
                onNodeClick={(n) => navigate(`/tasks?node=${encodeURIComponent(n.id)}`)}
                onLink={handleLink}
                onUnlink={handleUnlink}
                edges={edges}
                specId={spec.id}
              />
              <LinkedNodesPanel
                title="Feedback"
                icon={<MessageSquare className="h-4 w-4 text-honey-500" />}
                nodes={linked.feedback}
                variant="feedback"
                emptyMessage="No feedback yet"
                onLink={handleLink}
                onUnlink={handleUnlink}
                edges={edges}
                specId={spec.id}
              />
              <LinkedNodesPanel
                title="Contexts"
                icon={<Layers className="h-4 w-4 text-honey-500" />}
                nodes={linked.contexts}
                variant="context"
                emptyMessage="No contexts linked"
                onLink={handleLink}
                onUnlink={handleUnlink}
                edges={edges}
                specId={spec.id}
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
            </aside>
          )}
        </div>

        <DispatchModal
          open={dispatchOpen}
          onClose={() => setDispatchOpen(false)}
          spec={spec}
        />
      </div>
    </>
  );
}
