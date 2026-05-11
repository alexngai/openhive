/**
 * DiffView — renders a unified diff blob from the cascade-diff resolver.
 *
 * The hub returns pre-computed unified-diff text (`git show` / `git diff`
 * output), so this component is a styled renderer, not a diff *computer*.
 * Each file is collapsible (default open). Hunks are rendered with
 * line-level coloring matching common diff UIs:
 *
 *   diff --git ...   → header band
 *   @@ ... @@        → hunk header (muted)
 *   + line           → green
 *   - line           → red
 *   ' ' context      → neutral
 *
 * States covered: loading, error (with typed code surfaced), empty,
 * truncated, success.
 */

import { useMemo, useState, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { useCascadeDiff } from '../../hooks/useCascadeDiff';

interface DiffViewProps {
  streamRowId: string;
  commitHash: string;
  /** Restrict the diff to a single file path. */
  file?: string;
  /** Explicit base SHA for ranged diffs. */
  base?: string;
  /** Optional title for the panel; defaults to "Diff · {sha7}". */
  title?: string;
  /** Optional close handler — renders a dismiss control when set. */
  onClose?: () => void;
}

interface ParsedFile {
  /** Post-image path from `b/...`. */
  path: string;
  /** Raw header lines (everything between `diff --git` and the first `@@`). */
  header: string[];
  /** Raw body lines (`@@ ...` and the +/- /context lines that follow). */
  body: string[];
}

/**
 * Parse a unified diff blob into a per-file list. Cheap split-on-marker
 * approach — git's output uses `diff --git a/X b/Y` as the file boundary.
 */
function parseUnifiedDiff(blob: string): ParsedFile[] {
  if (!blob) return [];
  const lines = blob.split('\n');
  const files: ParsedFile[] = [];
  let current: ParsedFile | null = null;
  let inBody = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current);
      const m = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
      current = {
        path: m?.[2] ?? '(unknown)',
        header: [line],
        body: [],
      };
      inBody = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@ ')) {
      inBody = true;
      current.body.push(line);
      continue;
    }
    if (inBody) current.body.push(line);
    else current.header.push(line);
  }
  if (current) files.push(current);
  return files;
}

function classifyLine(line: string): string {
  if (line.startsWith('@@')) return 'text-blue-400 bg-blue-500/5';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-emerald-300 bg-emerald-500/10';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-rose-300 bg-rose-500/10';
  return 'text-zinc-400';
}

export function DiffView({
  streamRowId,
  commitHash,
  file,
  base,
  title,
  onClose,
}: DiffViewProps) {
  const { data, isLoading, error } = useCascadeDiff(streamRowId, commitHash, {
    file,
    base,
  });

  const blob = data?.data?.diff ?? '';
  const truncated = data?.data?.truncated ?? false;
  const filesTouched = data?.data?.files_touched ?? [];
  const parsed = useMemo(() => parseUnifiedDiff(blob), [blob]);

  const sha7 = commitHash.slice(0, 7);
  const headerTitle = title ?? `Diff · ${sha7}`;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-md overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          <span className="font-mono truncate" title={commitHash}>{headerTitle}</span>
          {file && (
            <span className="text-zinc-500 truncate" title={file}>· {file}</span>
          )}
          {base && (
            <span className="text-zinc-500 font-mono truncate" title={base}>
              ({base.slice(0, 7)}..{sha7})
            </span>
          )}
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

      {/* Body */}
      <div className="flex-1 overflow-auto text-xs font-mono">
        {isLoading && (
          <div className="flex items-center gap-2 p-4 text-zinc-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading diff…
          </div>
        )}

        {error && !isLoading && (
          <ErrorPanel error={error} />
        )}

        {!isLoading && !error && parsed.length === 0 && (
          <div className="p-4 text-zinc-500">No diff content.</div>
        )}

        {!isLoading && !error && truncated && (
          <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Output truncated — diff exceeded 50 MB sidecar cap.</span>
          </div>
        )}

        {!isLoading && !error && parsed.map((f, idx) => (
          <FileBlock key={`${f.path}-${idx}`} file={f} />
        ))}

        {/* Inline files-touched summary on empty body (shouldn't usually
            happen for a single commit, but defensive). */}
        {!isLoading && !error && parsed.length === 0 && filesTouched.length > 0 && (
          <div className="p-4">
            <div className="text-zinc-400 mb-1">Files touched:</div>
            <ul className="space-y-0.5">
              {filesTouched.map((path) => (
                <li key={path} className="text-zinc-300">{path}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

interface FileBlockProps {
  file: ParsedFile;
}

function FileBlock({ file }: FileBlockProps) {
  const [open, setOpen] = useState(true);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="border-b border-zinc-800">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-1 px-3 py-1.5 bg-zinc-900/60 hover:bg-zinc-900 text-left text-zinc-200 transition-colors"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
        )}
        <span className="truncate" title={file.path}>{file.path}</span>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <pre className="px-3 py-2 leading-snug whitespace-pre">
            {file.body.map((line, idx) => (
              <div
                key={idx}
                className={`${classifyLine(line)} whitespace-pre`}
              >
                {line.length ? line : ' '}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

interface ErrorPanelProps {
  error: unknown;
}

function ErrorPanel({ error }: ErrorPanelProps) {
  // ApiClient surfaces structured `{ error, message }` on 4xx/5xx.
  const e = error as { status?: number; body?: { error?: string; message?: string } };
  const code = e?.body?.error;
  const message = e?.body?.message ?? (error instanceof Error ? error.message : 'Failed to load diff');
  const friendly = friendlyMessage(code);

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 text-rose-300 mb-1">
        <AlertTriangle className="w-3.5 h-3.5" />
        <span className="font-medium">{friendly.title}</span>
      </div>
      <div className="text-zinc-400">{message}</div>
      {friendly.hint && (
        <div className="text-zinc-500 mt-2 text-2xs">{friendly.hint}</div>
      )}
    </div>
  );
}

function friendlyMessage(code: string | undefined): { title: string; hint?: string } {
  switch (code) {
    case 'swarm_offline':
      return {
        title: 'Sidecar offline',
        hint: 'Reconnect the agent that owns this stream to fetch the diff.',
      };
    case 'capability_missing':
      return {
        title: 'Diff serving not supported',
        hint: 'The connected sidecar does not declare cascade.canServeDiff.',
      };
    case 'timeout':
      return { title: 'Sidecar timed out', hint: 'Try again in a moment.' };
    case 'integrity_failed':
      return {
        title: 'Diff integrity check failed',
        hint: 'The sidecar response did not match its checksum.',
      };
    case 'not_found':
      return { title: 'Stream not found' };
    case 'bad_request':
      return { title: 'Bad request' };
    case 'internal':
    default:
      return { title: 'Failed to load diff' };
  }
}
