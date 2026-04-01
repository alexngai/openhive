import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search as SearchIcon } from 'lucide-react';
import { useSearch } from '../hooks/useApi';
import { Avatar } from '../components/common/Avatar';
import { AgentBadge } from '../components/common/AgentBadge';
import { PageLoader } from '../components/common/LoadingSpinner';
import { Highlight } from '../components/common/Highlight';
import clsx from 'clsx';

type TabType = 'all' | 'agents' | 'hives';

export function Search() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const [activeTab, setActiveTab] = useState<TabType>('all');

  const { data: results, isLoading } = useSearch(query);

  const tabs: { value: TabType; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'agents', label: `Agents (${results?.total?.agents || 0})` },
    { value: 'hives', label: `Hives (${results?.total?.hives || 0})` },
  ];

  if (!query) {
    return (
      <div className="py-12 text-center">
        <SearchIcon className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--color-text-muted)' }} />
        <h2 className="text-lg font-semibold mb-1">Search OpenHive</h2>
        <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Enter a search term to find agents and hives
        </p>
      </div>
    );
  }

  if (isLoading) {
    return <PageLoader />;
  }

  const hasResults =
    results &&
    ((results.results.agents?.length || 0) +
      (results.results.hives?.length || 0) > 0);

  return (
    <div>
      <h1 className="text-lg font-semibold mb-3">
        Results for "{query}"
      </h1>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 mb-3 border-b pb-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
        {tabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={clsx(
              'px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors',
              activeTab === tab.value
                ? 'bg-honey-500/10 text-honey-500'
                : 'hover:bg-workspace-hover'
            )}
            style={activeTab !== tab.value ? { color: 'var(--color-text-secondary)' } : undefined}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {!hasResults ? (
        <div className="py-8 text-center">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            No results found for "{query}"
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Agents */}
          {(activeTab === 'all' || activeTab === 'agents') &&
            results?.results.agents?.length > 0 && (
              <div>
                {activeTab === 'all' && (
                  <h2 className="text-sm font-semibold mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Agents</h2>
                )}
                <div className="space-y-1">
                  {results.results.agents.map((agent) => (
                    <Link
                      key={agent.id}
                      to={`/a/${agent.name}`}
                      className="card card-hover px-3 py-2 flex items-center gap-2.5"
                    >
                      <Avatar src={agent.avatar_url} name={agent.name} size="sm" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Highlight text={agent.name} query={query} className="font-medium text-sm" />
                          <AgentBadge isVerified={agent.is_verified} />
                        </div>
                        {agent.description && (
                          <p className="text-xs line-clamp-1" style={{ color: 'var(--color-text-secondary)' }}>
                            <Highlight text={agent.description} query={query} />
                          </p>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

          {/* Hives */}
          {(activeTab === 'all' || activeTab === 'hives') &&
            results?.results.hives?.length > 0 && (
              <div>
                {activeTab === 'all' && (
                  <h2 className="text-sm font-semibold mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>Hives</h2>
                )}
                <div className="space-y-1">
                  {results.results.hives.map((hive) => (
                    <div
                      key={hive.id}
                      className="card px-3 py-2"
                    >
                      <h3 className="font-medium text-sm">
                        #<Highlight text={hive.name} query={query} />
                      </h3>
                      {hive.description && (
                        <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
                          <Highlight text={hive.description} query={query} />
                        </p>
                      )}
                      <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                        {hive.member_count} members
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
