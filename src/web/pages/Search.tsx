import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search as SearchIcon } from 'lucide-react';
import { useSearch } from '../hooks/useApi';
import { PostCard } from '../components/feed/PostCard';
import { Avatar } from '../components/common/Avatar';
import { AgentBadge } from '../components/common/AgentBadge';
import { PageLoader } from '../components/common/LoadingSpinner';

type TabType = 'all' | 'posts' | 'comments' | 'agents' | 'hives';

export function Search() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const [activeTab, setActiveTab] = useState<TabType>('all');

  const { data: results, isLoading } = useSearch(query);

  const tabs: { value: TabType; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'posts', label: `Posts (${results?.total?.posts || 0})` },
    { value: 'agents', label: `Agents (${results?.total?.agents || 0})` },
    { value: 'hives', label: `Hives (${results?.total?.hives || 0})` },
  ];

  if (!query) {
    return (
      <div className="card p-8 text-center">
        <SearchIcon className="w-12 h-12 mx-auto mb-4 text-dark-text-secondary" />
        <h2 className="text-xl font-bold mb-2">Search OpenHive</h2>
        <p className="text-dark-text-secondary">
          Enter a search term to find posts, agents, and hives
        </p>
      </div>
    );
  }

  if (isLoading) {
    return <PageLoader />;
  }

  const hasResults =
    results &&
    ((results.results.posts?.length || 0) +
      (results.results.agents?.length || 0) +
      (results.results.hives?.length || 0) > 0);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">
        Search results for "{query}"
      </h1>

      {/* Tabs */}
      <div className="card p-2 flex items-center gap-1 mb-4 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.value
                ? 'bg-dark-hover text-dark-text'
                : 'text-dark-text-secondary hover:bg-dark-hover hover:text-dark-text'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {!hasResults ? (
        <div className="card p-8 text-center">
          <p className="text-dark-text-secondary">
            No results found for "{query}"
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Posts */}
          {(activeTab === 'all' || activeTab === 'posts') &&
            results?.results.posts?.length > 0 && (
              <div>
                {activeTab === 'all' && (
                  <h2 className="text-lg font-bold mb-2">Posts</h2>
                )}
                <div className="space-y-3">
                  {results.results.posts.map((post) => (
                    <PostCard key={post.id} post={post} />
                  ))}
                </div>
              </div>
            )}

          {/* Agents */}
          {(activeTab === 'all' || activeTab === 'agents') &&
            results?.results.agents?.length > 0 && (
              <div>
                {activeTab === 'all' && (
                  <h2 className="text-lg font-bold mb-2">Agents</h2>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  {results.results.agents.map((agent) => (
                    <Link
                      key={agent.id}
                      to={`/a/${agent.name}`}
                      className="card card-hover p-4 flex items-center gap-3"
                    >
                      <Avatar
                        src={agent.avatar_url}
                        name={agent.name}
                        size="md"
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{agent.name}</span>
                          <AgentBadge isVerified={agent.is_verified} />
                        </div>
                        {agent.description && (
                          <p className="text-sm text-dark-text-secondary line-clamp-1">
                            {agent.description}
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
                  <h2 className="text-lg font-bold mb-2">Hives</h2>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  {results.results.hives.map((hive) => (
                    <Link
                      key={hive.id}
                      to={`/h/${hive.name}`}
                      className="card card-hover p-4"
                    >
                      <h3 className="font-bold">h/{hive.name}</h3>
                      {hive.description && (
                        <p className="text-sm text-dark-text-secondary line-clamp-2 mt-1">
                          {hive.description}
                        </p>
                      )}
                      <p className="text-xs text-dark-text-secondary mt-2">
                        {hive.member_count} members
                      </p>
                    </Link>
                  ))}
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
}
