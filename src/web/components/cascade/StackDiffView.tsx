/**
 * StackDiffView — two-pane diff viewer for stream-level and stack-level
 * ranges (`base..head`).
 *
 *   Top-level fetch is `files_only: true` — gives us the file tree without
 *   loading content for files the user never opens. Clicking a file in the
 *   left pane lazy-fetches `?file=...` and renders the unified diff in the
 *   right pane via the existing `DiffView` component.
 *
 * Used by:
 *   - Changes.tsx "View stream diff" (one stream — `?mode='stream'`)
 *   - Changes.tsx "View stack diff" (linear stack from a root — `?mode='stack'`)
 *
 * Non-linear stack 400 response renders as an inline notice instead of the
 * file tree, with the branching detail surfaced.
 */

import { useState, useMemo, type ReactNode } from 'react';
import {
  AlertTriangle,
  FileText,
  Folder,
  Loader2,
  ListTree,
} from 'lucide-react';
import {
  useCascadeStreamDiff,
  useCascadeStackDiff,
  useCascadeStreamDiffSmart,
  useCascadeStackDiffSmart,
  extractFileFromUnifiedDiff,
  type CascadeLinearStack,
  type CascadeRangeSmartResult,
} from '../../hooks/useCascadeDiff';

type Mode = 'stream' | 'stack';

interface StackDiffViewProps {
  mode: Mode;
  /** For `mode='stream'`: the stream row id. For `mode='stack'`: the root row id. */
  rowId: string;
  /** Optional title for the panel; defaults derived from mode. */
  title?: string;
  /** Optional close handler — renders a dismiss control when set. */
  onClose?: () => void;
}

export function StackDiffView({ mode, rowId, title, onClose }: StackDiffViewProps) {
  const headerTitle = title ?? (mode === 'stack' ? 'Stack diff' : 'Stream diff');
  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-md overflow-hidden">
      <PanelHeader title={headerTitle} onClose={onClose} />
      <div className="flex-1 min-h-0 flex">
        {mode === 'stack' ? (
          <StackBody rowId={rowId} />
        ) : (
          <StreamBody rowId={rowId} />
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Stream-mode body
// ───────────────────────────────────────────────────────────────────────

function StreamBody({ rowId }: { rowId: string }) {
  // Smart variant: files_only first, fall back to cached full-diff on 5xx
  // (sidecar offline). `data.fullDiff` is populated only when the
  // fallback fired — used for in-memory per-file slicing below.
  const filesQuery = useCascadeStreamDiffSmart(rowId);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  return (
    <TwoPane
      isLoading={filesQuery.isLoading}
      error={filesQuery.error}
      files={filesQuery.data?.files_touched ?? []}
      smartData={filesQuery.data}
      selectedFile={selectedFile}
      onSelectFile={setSelectedFile}
      sidebar={null}
      filePane={
        selectedFile ? (
          <StreamFileDiff
            rowId={rowId}
            file={selectedFile}
            smartData={filesQuery.data}
          />
        ) : (
          <EmptyFilePane />
        )
      }
    />
  );
}

function StreamFileDiff({
  rowId,
  file,
  smartData,
}: {
  rowId: string;
  file: string;
  smartData: CascadeRangeSmartResult | null;
}) {
  // In-memory slice path: when the smart hook fell back to the cached
  // full-diff (sidecar offline), we already have every file's content
  // locally — skip the per-file network round-trip and render directly.
  const inMemoryChunk = useMemo(
    () =>
      smartData?.usedFallback && smartData.fullDiff
        ? extractFileFromUnifiedDiff(smartData.fullDiff, file)
        : null,
    [smartData?.usedFallback, smartData?.fullDiff, file],
  );

  // Hooks must run unconditionally — call the per-file query every
  // render but disable it when we already have the chunk in memory.
  const q = useCascadeStreamDiff(rowId, {
    file,
    enabled: inMemoryChunk === null,
  });

  if (inMemoryChunk !== null && smartData) {
    return (
      <InlineFileDiff blob={inMemoryChunk} truncated={smartData.truncated} file={file} />
    );
  }
  return <RangeFilePane query={q} file={file} />;
}

// ───────────────────────────────────────────────────────────────────────
// Stack-mode body
// ───────────────────────────────────────────────────────────────────────

function StackBody({ rowId }: { rowId: string }) {
  const filesQuery = useCascadeStackDiffSmart(rowId);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Non-linear stack → render a dedicated notice instead of the tree.
  // 400 errors aren't recoverable so the smart hook surfaces them
  // directly; check the typed body the same way as before.
  const err = filesQuery.error as { body?: { error?: string; message?: string } } | null;
  if (err?.body?.error === 'non_linear_stack') {
    return <NonLinearNotice message={err.body.message ?? ''} />;
  }

  return (
    <TwoPane
      isLoading={filesQuery.isLoading}
      error={filesQuery.error}
      files={filesQuery.data?.files_touched ?? []}
      smartData={filesQuery.data}
      selectedFile={selectedFile}
      onSelectFile={setSelectedFile}
      sidebar={
        filesQuery.data?.stack ? (
          <StackChainPreview stack={filesQuery.data.stack} />
        ) : null
      }
      filePane={
        selectedFile ? (
          <StackFileDiff
            rowId={rowId}
            file={selectedFile}
            smartData={filesQuery.data}
          />
        ) : (
          <EmptyFilePane />
        )
      }
    />
  );
}

function StackFileDiff({
  rowId,
  file,
  smartData,
}: {
  rowId: string;
  file: string;
  smartData: (CascadeRangeSmartResult & { stack: CascadeLinearStack | null }) | null;
}) {
  const inMemoryChunk = useMemo(
    () =>
      smartData?.usedFallback && smartData.fullDiff
        ? extractFileFromUnifiedDiff(smartData.fullDiff, file)
        : null,
    [smartData?.usedFallback, smartData?.fullDiff, file],
  );
  const q = useCascadeStackDiff(rowId, {
    file,
    enabled: inMemoryChunk === null,
  });
  if (inMemoryChunk !== null && smartData) {
    return (
      <InlineFileDiff blob={inMemoryChunk} truncated={smartData.truncated} file={file} />
    );
  }
  return <RangeFilePane query={q} file={file} />;
}

// ───────────────────────────────────────────────────────────────────────
// Shared layout
// ───────────────────────────────────────────────────────────────────────

interface TwoPaneProps {
  isLoading: boolean;
  error: unknown;
  files: string[];
  /** Smart hook result; when `usedFallback`, we render an "offline cache" hint. */
  smartData?: CascadeRangeSmartResult | null;
  selectedFile: string | null;
  onSelectFile: (f: string) => void;
  /** Optional pre-tree content (stack chain preview, etc). */
  sidebar?: ReactNode;
  filePane: ReactNode;
}

function TwoPane({
  isLoading,
  error,
  files,
  smartData,
  selectedFile,
  onSelectFile,
  sidebar,
  filePane,
}: TwoPaneProps) {
  const sorted = useMemo(() => [...files].sort(), [files]);
  return (
    <>
      <div className="w-72 min-w-[14rem] border-r border-zinc-800 overflow-auto text-xs">
        {sidebar}
        <div className="px-3 py-2 text-zinc-500 flex items-center gap-1.5 border-b border-zinc-900">
          <ListTree className="w-3 h-3" />
          <span>Files touched ({files.length})</span>
          {smartData?.usedFallback && (
            <span
              className="ml-auto px-1.5 py-0.5 rounded text-2xs bg-amber-500/10 text-amber-300 border border-amber-500/30"
              title="Sidecar offline — rendering from cached blob"
            >
              cached
            </span>
          )}
        </div>
        {isLoading && (
          <div className="flex items-center gap-2 p-3 text-zinc-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading file list…
          </div>
        )}
        {error && !isLoading && <ErrorBox error={error} />}
        {!isLoading && !error && sorted.length === 0 && (
          <div className="p-3 text-zinc-500">No files in range.</div>
        )}
        <ul className="py-1">
          {sorted.map((f) => (
            <li key={f}>
              <button
                type="button"
                className={`w-full text-left px-3 py-1 font-mono text-xs flex items-center gap-1.5
                  hover:bg-zinc-900 transition-colors
                  ${selectedFile === f ? 'bg-honey-500/10 text-honey-300' : 'text-zinc-300'}`}
                onClick={() => onSelectFile(f)}
                title={f}
              >
                <FileText className="w-3 h-3 shrink-0 text-zinc-500" />
                <span className="truncate">{f}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">{filePane}</div>
    </>
  );
}

interface RangeFilePaneProps {
  query: ReturnType<typeof useCascadeStreamDiff>;
  file: string;
}

function RangeFilePane({ query, file }: RangeFilePaneProps) {
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 p-4 text-zinc-500 text-xs">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading diff for {file}…
      </div>
    );
  }
  if (query.error) {
    return <ErrorBox error={query.error} />;
  }
  const data = query.data?.data;
  if (!data) return <EmptyFilePane />;
  // Reuse the unified-diff renderer from DiffView by rendering a styled
  // panel directly. DiffView is keyed off (streamRowId, commitHash) so we
  // can't reuse it as-is here — render the lines inline.
  return <InlineFileDiff blob={data.diff} truncated={data.truncated} file={file} />;
}

function InlineFileDiff({
  blob,
  truncated,
  file,
}: {
  blob: string;
  truncated: boolean;
  file: string;
}) {
  return (
    <div className="text-xs font-mono">
      {truncated && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-200">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Output truncated.</span>
        </div>
      )}
      <pre className="px-3 py-2 leading-snug whitespace-pre">
        {blob.split('\n').map((line, idx) => (
          <div key={idx} className={`${classifyLine(line)} whitespace-pre`}>
            {line.length ? line : ' '}
          </div>
        ))}
      </pre>
      <div className="px-3 py-1 border-t border-zinc-900 text-zinc-500 text-2xs">
        {file}
      </div>
    </div>
  );
}

function classifyLine(line: string): string {
  if (line.startsWith('@@')) return 'text-blue-400 bg-blue-500/5';
  if (line.startsWith('+') && !line.startsWith('+++'))
    return 'text-emerald-300 bg-emerald-500/10';
  if (line.startsWith('-') && !line.startsWith('---'))
    return 'text-rose-300 bg-rose-500/10';
  return 'text-zinc-400';
}

function EmptyFilePane() {
  return (
    <div className="p-6 text-zinc-500 text-xs flex items-center gap-2">
      <Folder className="w-3.5 h-3.5" />
      Select a file from the left to view its diff.
    </div>
  );
}

function StackChainPreview({ stack }: { stack: CascadeLinearStack }) {
  return (
    <div className="px-3 py-2 border-b border-zinc-900">
      <div className="text-2xs text-zinc-500 mb-1">
        Linear stack ({stack.entries.length} streams)
      </div>
      <div className="space-y-0.5">
        {stack.entries.map((e) => (
          <div key={e.stream_row_id} className="text-2xs flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-honey-500" />
            <span className="truncate text-zinc-300" title={e.cascade_stream_id}>
              {e.name || e.cascade_stream_id}
            </span>
          </div>
        ))}
      </div>
      <div className="text-2xs text-zinc-500 mt-1 font-mono">
        {stack.lowest_base.slice(0, 7)}..{stack.highest_head.slice(0, 7)}
      </div>
    </div>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <ListTree className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        <span className="font-mono truncate">{title}</span>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200 transition-colors px-2"
          aria-label="Close diff"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function NonLinearNotice({ message }: { message: string }) {
  return (
    <div className="flex-1 p-6">
      <div className="flex items-center gap-2 text-amber-300 mb-2">
        <AlertTriangle className="w-4 h-4" />
        <span className="text-sm font-medium">This stack has multiple active branches</span>
      </div>
      <div className="text-zinc-400 text-xs leading-relaxed">
        Stack diff requires a linear chain. {message ? <code className="text-zinc-300">{message}</code> : null}
      </div>
      <div className="text-zinc-500 text-2xs mt-3">
        Open the branching streams individually to view each one&apos;s diff.
      </div>
    </div>
  );
}

function ErrorBox({ error }: { error: unknown }) {
  const e = error as
    | { status?: number; body?: { error?: string; message?: string } }
    | undefined;
  const code = e?.body?.error;
  const message =
    e?.body?.message ??
    (error instanceof Error ? error.message : 'Failed to load diff');
  return (
    <div className="p-3 text-xs">
      <div className="flex items-center gap-2 text-rose-300 mb-1">
        <AlertTriangle className="w-3.5 h-3.5" />
        <span className="font-medium">{code ?? 'error'}</span>
      </div>
      <div className="text-zinc-400">{message}</div>
    </div>
  );
}
