import { useMemo, useState } from 'react';
import { Lightbulb, Bug, Zap, FileText, MessageSquare, Tag, ChevronDown, ChevronRight, User } from 'lucide-react';
import { useMemoryEntries, useMemorySearch } from '../../../hooks/useApi';
import { Markdown } from '../../common/Markdown';
import type { MemoryEntry } from '../../../lib/api';

const TYPE_CONFIG: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  decision: { icon: Lightbulb, color: '#7c3aed', label: 'decision' },
  bugfix: { icon: Bug, color: '#ef4444', label: 'bugfix' },
  discovery: { icon: Zap, color: '#14b8a6', label: 'discovery' },
  feature: { icon: Zap, color: '#3b82f6', label: 'feature' },
  context: { icon: MessageSquare, color: '#6b7280', label: 'context' },
  note: { icon: FileText, color: '#6b7280', label: 'note' },
};

function TypeBadge({ type }: { type: string | null }) {
  const config = TYPE_CONFIG[type || ''] || TYPE_CONFIG.note;
  const Icon = config.icon;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs"
      style={{ backgroundColor: config.color + '18', color: config.color }}
    >
      <Icon className="w-2.5 h-2.5" />
      {config.label}
    </span>
  );
}

function DomainTag({ domain }: { domain: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-2xs" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
      <Tag className="w-2 h-2" />
      {domain}
    </span>
  );
}

function EntryCard({ entry }: { entry: MemoryEntry }) {
  const [expanded, setExpanded] = useState(false);
  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const preview = entry.body.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('<!--')).slice(0, 2).join(' ');
  const hasMore = entry.body.split('\n').filter(l => l.trim()).length > 3;

  return (
    <button
      onClick={() => setExpanded(!expanded)}
      className="w-full text-left rounded-md p-2.5 transition-colors hover:bg-workspace-hover cursor-pointer"
      style={{ backgroundColor: expanded ? 'var(--color-elevated)' : 'transparent' }}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 mb-1">
        {time && <span className="text-2xs font-mono shrink-0" style={{ color: 'var(--color-text-muted)' }}>{time}</span>}
        <TypeBadge type={entry.type} />
        {entry.agentId && (
          <span className="flex items-center gap-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <User className="w-2.5 h-2.5" />
            {entry.agentId}
          </span>
        )}
        {hasMore && (
          expanded
            ? <ChevronDown className="w-3 h-3 ml-auto shrink-0" style={{ color: 'var(--color-text-muted)' }} />
            : <ChevronRight className="w-3 h-3 ml-auto shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        )}
      </div>

      {/* Content */}
      {expanded ? (
        <div className="prose-sm mt-1.5" onClick={(e) => e.stopPropagation()}>
          <Markdown content={entry.body} />
        </div>
      ) : (
        <p className="text-xs leading-relaxed line-clamp-2" style={{ color: 'var(--color-text-secondary)' }}>{preview}</p>
      )}

      {/* Tags */}
      {(entry.domains.length > 0 || entry.entities.length > 0) && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {entry.domains.map(d => <DomainTag key={d} domain={d} />)}
          {entry.entities.map(e => (
            <span key={e} className="text-2xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>{e}</span>
          ))}
        </div>
      )}
    </button>
  );
}

function SearchResults({ resourceId, query }: { resourceId: string; query: string }) {
  const { data, isLoading } = useMemorySearch(resourceId, query);

  if (isLoading) return <div className="py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Searching...</div>;
  if (!data || data.results.length === 0) {
    return <div className="py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>No results for "{query}"</div>;
  }

  return (
    <div className="space-y-1">
      <div className="text-2xs mb-2 flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
        <span>{data.total} result{data.total !== 1 ? 's' : ''}</span>
        {data.engine === 'minimem' && (
          <span className="px-1.5 py-0.5 rounded text-2xs" style={{ backgroundColor: 'var(--color-elevated)' }}>semantic</span>
        )}
      </div>
      {data.results.map((result: { path: string; line: number; snippet: string; score: number; heading?: string }, i: number) => (
        <div key={`${result.path}:${result.line}:${i}`} className="rounded-md p-2.5" style={{ backgroundColor: 'var(--color-elevated)' }}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono font-medium">{result.path}</span>
            {result.heading && <span className="text-2xs" style={{ color: 'var(--color-accent)' }}>{result.heading}</span>}
            {result.score > 0 && result.score <= 1 && (
              <span className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>{(result.score * 100).toFixed(0)}%</span>
            )}
          </div>
          <pre className="text-xs whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>{result.snippet}</pre>
        </div>
      ))}
    </div>
  );
}

export function MemoryTimeline({ resourceId, searchQuery }: { resourceId: string; searchQuery: string }) {
  const { data: entries, isLoading } = useMemoryEntries(resourceId);

  // Group entries by date
  const grouped = useMemo(() => {
    if (!entries?.length) return [];
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const date = entry.timestamp ? new Date(entry.timestamp).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown Date';
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date)!.push(entry);
    }
    return [...groups.entries()].map(([date, items]) => ({ date, entries: items }));
  }, [entries]);

  if (searchQuery.length >= 2) {
    return <SearchResults resourceId={resourceId} query={searchQuery} />;
  }

  if (isLoading) {
    return <div className="py-8 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading timeline...</div>;
  }

  if (grouped.length === 0) {
    return (
      <div className="py-8 text-center">
        <FileText className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No memory entries yet</p>
        <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
          Entries appear when agents write to memory files
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        {entries?.length || 0} entries
      </div>
      {grouped.map(({ date, entries: dayEntries }) => (
        <div key={date}>
          <div className="text-2xs font-medium mb-2 pb-1 border-b" style={{ color: 'var(--color-text-muted)', borderColor: 'var(--color-border-subtle)' }}>
            {date}
          </div>
          <div className="space-y-0.5">
            {dayEntries.map((entry, i) => (
              <EntryCard key={`${entry.path}:${entry.timestamp}:${i}`} entry={entry} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
