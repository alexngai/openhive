import { useState } from 'react';
import { Clock, Network, FileText, Search, Brain } from 'lucide-react';
import { useMemoryRealtime } from '../../hooks/useRealtimeInvalidation';
import { MemoryTimeline } from './memory/MemoryTimeline';
import { MemoryFiles } from './memory/MemoryFiles';
import { KnowledgeGraph } from './memory/KnowledgeGraph';
import clsx from 'clsx';

type Tab = 'timeline' | 'graph' | 'files';

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'timeline', label: 'Timeline', icon: Clock },
  { key: 'graph', label: 'Graph', icon: Network },
  { key: 'files', label: 'Files', icon: FileText },
];

export function MemoryBrowser({ resourceId }: { resourceId: string }) {
  useMemoryRealtime(resourceId);
  const [activeTab, setActiveTab] = useState<Tab>('timeline');
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div className="card p-4">
      {/* Header with tabs */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1">
          <Brain className="w-4 h-4 mr-1" style={{ color: 'var(--color-text-muted)' }} />
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={clsx(
                  'flex items-center gap-1 px-2 py-1 rounded text-2xs transition-colors cursor-pointer',
                  activeTab === tab.key
                    ? 'font-medium'
                    : 'hover:bg-hover',
                )}
                style={activeTab === tab.key ? {
                  color: 'var(--color-accent)',
                  backgroundColor: 'var(--color-elevated)',
                } : {
                  color: 'var(--color-text-muted)',
                }}
              >
                <Icon className="w-3 h-3" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Search bar (shared across views) */}
      <div className="relative mb-3">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search memories..."
          className="input w-full pl-7 text-xs"
        />
      </div>

      {/* Tab content */}
      {activeTab === 'timeline' && (
        <MemoryTimeline resourceId={resourceId} searchQuery={searchQuery} />
      )}
      {activeTab === 'graph' && (
        <KnowledgeGraph resourceId={resourceId} />
      )}
      {activeTab === 'files' && (
        <MemoryFiles resourceId={resourceId} searchQuery={searchQuery} />
      )}
    </div>
  );
}
