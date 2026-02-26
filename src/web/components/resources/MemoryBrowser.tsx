import { useState, useMemo } from 'react';
import { Search, FileText, Clock, ChevronRight, Tag, Hash, Brain, ArrowLeft } from 'lucide-react';
import { useMemoryFiles, useMemoryFile, useMemorySearch } from '../../hooks/useApi';
import { Markdown } from '../common/Markdown';
import { TimeAgo } from '../common/TimeAgo';
import clsx from 'clsx';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FrontmatterDisplay({ frontmatter }: { frontmatter: Record<string, unknown> }) {
  const entries = Object.entries(frontmatter).filter(
    ([key]) => !['links'].includes(key)
  );
  if (entries.length === 0) return null;

  return (
    <div
      className="rounded-md p-2.5 mb-3 text-xs space-y-1"
      style={{ backgroundColor: 'var(--color-elevated)', borderLeft: '2px solid var(--color-accent)' }}
    >
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start gap-2">
          <span className="font-medium shrink-0 w-24" style={{ color: 'var(--color-text-muted)' }}>{key}</span>
          <span style={{ color: 'var(--color-text-secondary)' }}>
            {Array.isArray(value) ? value.join(', ') : String(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function FileViewer({ resourceId, filePath, onBack }: { resourceId: string; filePath: string; onBack: () => void }) {
  const { data: file, isLoading } = useMemoryFile(resourceId, filePath);

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-2xs mb-2 hover:text-honey-500 transition-colors cursor-pointer"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <ArrowLeft className="w-3 h-3" />
        Back to files
      </button>

      <div className="flex items-center gap-2 mb-3">
        <FileText className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        <h3 className="text-sm font-medium font-mono">{filePath}</h3>
        {file && (
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {formatBytes(file.size)}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading...</div>
      ) : file ? (
        <>
          {file.frontmatter && <FrontmatterDisplay frontmatter={file.frontmatter} />}
          <div className="prose-sm">
            <Markdown content={file.body} />
          </div>
        </>
      ) : (
        <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>File not found</div>
      )}
    </div>
  );
}

function SearchResults({ resourceId, query }: { resourceId: string; query: string }) {
  const { data, isLoading } = useMemorySearch(resourceId, query);

  if (isLoading) {
    return <div className="py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Searching...</div>;
  }

  if (!data || data.results.length === 0) {
    return (
      <div className="py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
        No results for "{query}"
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-2xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
        {data.total} result{data.total !== 1 ? 's' : ''}
      </div>
      {data.results.map((result, i) => (
        <div
          key={`${result.path}:${result.line}:${i}`}
          className="rounded-md p-2.5"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono font-medium">{result.path}</span>
            <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>line {result.line}</span>
          </div>
          <pre className="text-xs whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {result.snippet}
          </pre>
        </div>
      ))}
    </div>
  );
}

export function MemoryBrowser({ resourceId }: { resourceId: string }) {
  const { data: files, isLoading } = useMemoryFiles(resourceId);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const sortedFiles = useMemo(() => {
    if (!files) return [];
    return [...files].sort((a, b) => {
      // MEMORY.md first, then by modified date descending
      if (a.path === 'MEMORY.md') return -1;
      if (b.path === 'MEMORY.md') return 1;
      return new Date(b.modified).getTime() - new Date(a.modified).getTime();
    });
  }, [files]);

  if (selectedFile) {
    return (
      <div className="card p-4">
        <FileViewer
          resourceId={resourceId}
          filePath={selectedFile}
          onBack={() => setSelectedFile(null)}
        />
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>
          Memory Contents
        </h2>
        <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {files?.length || 0} file{files?.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Search bar */}
      <div className="relative mb-3">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setIsSearching(e.target.value.length >= 2);
          }}
          placeholder="Search memories..."
          className="input w-full pl-7 text-xs"
        />
      </div>

      {/* Search results or file list */}
      {isSearching && searchQuery.length >= 2 ? (
        <SearchResults resourceId={resourceId} query={searchQuery} />
      ) : isLoading ? (
        <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading files...</div>
      ) : sortedFiles.length > 0 ? (
        <div className="space-y-0.5">
          {sortedFiles.map((file) => (
            <button
              key={file.path}
              onClick={() => setSelectedFile(file.path)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-workspace-hover transition-colors text-left cursor-pointer group"
            >
              <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-xs font-mono truncate flex-1 group-hover:text-honey-500 transition-colors">
                {file.path}
              </span>
              <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                {formatBytes(file.size)}
              </span>
              <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                <TimeAgo date={file.modified} />
              </span>
              <ChevronRight className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-50 transition-opacity" />
            </button>
          ))}
        </div>
      ) : (
        <div className="py-8 text-center">
          <Brain className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No memory files found</p>
          <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Expected: MEMORY.md or memory/*.md
          </p>
        </div>
      )}
    </div>
  );
}
