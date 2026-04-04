import { useState } from 'react';
import { List, Network, GitBranch, Search, Wrench, Upload, Zap, Globe } from 'lucide-react';
import { useSkillRealtime } from '../../hooks/useRealtimeInvalidation';
import { SkillList } from './skills/SkillList';
import { SkillGraph } from './skills/SkillGraph';
import { SkillVersions } from './skills/SkillVersions';
import { SkillImport } from './skills/SkillImport';
import { LoadoutPanel } from './skills/LoadoutPanel';
import { SkillScraper } from './skills/SkillScraper';
import clsx from 'clsx';

type Tab = 'list' | 'graph' | 'versions' | 'import' | 'loadout' | 'scraper';

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'list', label: 'Skills', icon: List },
  { key: 'graph', label: 'Graph', icon: Network },
  { key: 'versions', label: 'Versions', icon: GitBranch },
  { key: 'import', label: 'Import', icon: Upload },
  { key: 'loadout', label: 'Loadout', icon: Zap },
  { key: 'scraper', label: 'Scraper', icon: Globe },
];

export function SkillBrowser({ resourceId }: { resourceId: string }) {
  useSkillRealtime(resourceId);
  const [activeTab, setActiveTab] = useState<Tab>('list');
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1">
          <Wrench className="w-4 h-4 mr-1" style={{ color: 'var(--color-text-muted)' }} />
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={clsx(
                  'flex items-center gap-1 px-2 py-1 rounded text-2xs transition-colors cursor-pointer',
                  activeTab === tab.key ? 'font-medium' : 'hover:bg-workspace-hover',
                )}
                style={activeTab === tab.key ? {
                  color: 'var(--color-honey-500)',
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

      {/* Search bar */}
      <div className="relative mb-3">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search skills..."
          className="input w-full pl-7 text-xs"
        />
      </div>

      {activeTab === 'list' && (
        <SkillList resourceId={resourceId} searchQuery={searchQuery} />
      )}
      {activeTab === 'graph' && (
        <SkillGraph resourceId={resourceId} />
      )}
      {activeTab === 'versions' && (
        <SkillVersions resourceId={resourceId} />
      )}
      {activeTab === 'import' && (
        <SkillImport resourceId={resourceId} />
      )}
      {activeTab === 'loadout' && (
        <LoadoutPanel resourceId={resourceId} />
      )}
      {activeTab === 'scraper' && (
        <SkillScraper resourceId={resourceId} />
      )}
    </div>
  );
}
