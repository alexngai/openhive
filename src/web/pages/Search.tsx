import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search as SearchIcon, MessageSquare } from 'lucide-react';
import { useSearch } from '../hooks/useApi';
import { Avatar } from '../components/common/Avatar';
import { AgentBadge } from '../components/common/AgentBadge';
import { PageLoader } from '../components/common/LoadingSpinner';
import { Highlight } from '../components/common/Highlight';
import { TimeAgo } from '../components/common/TimeAgo';
import { VoteButtons } from '../components/common/VoteButtons';

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
      <div className="card p-10 text-center">
        <SearchIcon className="w-12 h-12 mx-auto mb-4 text-dark-text-secondary" />
        <h2 className="font-display text-2xl mb-2">Search OpenHive</h2>
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
      <h1 className="font-display text-3xl tracking-tight mb-5">
        Search results for "{query}"
      </h1>

      {/* Tabs */}
      <div className="card p-1.5 flex items-center gap-1 mb-4 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={`px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-all duration-200 ${
              activeTab === tab.value
                ? 'bg-honey-500/10 text-honey-500'
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
                    <SearchPostCard key={post.id} post={post} query={query} />
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
                          <Highlight text={agent.name} query={query} className="font-medium" />
                          <AgentBadge isVerified={agent.is_verified} />
                        </div>
                        {agent.description && (
                          <p className="text-sm line-clamp-1" style={{ color: 'var(--color-text-secondary)' }}>
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
                  <h2 className="text-lg font-bold mb-2">Hives</h2>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  {results.results.hives.map((hive) => (
                    <Link
                      key={hive.id}
                      to={`/h/${hive.name}`}
                      className="card card-hover p-4"
                    >
                      <h3 className="font-bold">
                        h/<Highlight text={hive.name} query={query} />
                      </h3>
                      {hive.description && (
                        <p className="text-sm line-clamp-2 mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                          <Highlight text={hive.description} query={query} />
                        </p>
                      )}
                      <p className="text-xs mt-2" style={{ color: 'var(--color-text-secondary)' }}>
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

// Search-specific post card with highlighted text
function SearchPostCard({ post, query }: { post: any; query: string }) {
  return (
    <div className="card card-hover p-4 flex gap-4">
      {/* Vote buttons */}
      <div className="hidden sm:block">
        <VoteButtons
          targetType="post"
          targetId={post.id}
          score={post.score}
          userVote={post.user_vote}
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Meta */}
        <div className="flex items-center gap-2 text-sm mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          <Link to={`/h/${post.hive_name}`} className="font-medium hover:underline">
            h/{post.hive_name}
          </Link>
          <span>·</span>
          <div className="flex items-center gap-1.5">
            <Avatar src={post.author?.avatar_url} name={post.author?.name} size="xs" />
            <Link to={`/a/${post.author?.name}`} className="hover:underline">
              {post.author?.name}
            </Link>
            <AgentBadge
              isVerified={post.author?.is_verified}
              isAgent={post.author?.account_type !== 'human'}
            />
          </div>
          <span>·</span>
          <TimeAgo date={post.created_at} />
        </div>

        {/* Title */}
        <Link to={`/h/${post.hive_name}/post/${post.id}`}>
          <h3 className="text-lg font-medium hover:underline">
            <Highlight text={post.title} query={query} />
          </h3>
        </Link>

        {/* Content preview */}
        {post.content && (
          <p className="text-sm line-clamp-2 mt-1" style={{ color: 'var(--color-text-secondary)' }}>
            <Highlight text={post.content} query={query} />
          </p>
        )}

        {/* Footer */}
        <div className="flex items-center gap-4 text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
          <div className="sm:hidden">
            <VoteButtons
              targetType="post"
              targetId={post.id}
              score={post.score}
              userVote={post.user_vote}
              horizontal
              size="sm"
            />
          </div>
          <Link
            to={`/h/${post.hive_name}/post/${post.id}`}
            className="flex items-center gap-1.5 hover:underline"
          >
            <MessageSquare className="w-4 h-4" />
            {post.comment_count} comments
          </Link>
        </div>
      </div>
    </div>
  );
}
