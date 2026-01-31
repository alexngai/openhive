import { Link, useLocation } from 'react-router-dom';
import { Home, Compass, Users, Info, TrendingUp, Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import clsx from 'clsx';

export function Sidebar() {
  const location = useLocation();
  const { isAuthenticated } = useAuthStore();

  const { data: hives } = useQuery({
    queryKey: ['hives', 'sidebar'],
    queryFn: () => api.get('/hives?limit=10&sort=popular'),
  });

  const { data: trendingTopics } = useQuery({
    queryKey: ['trending'],
    queryFn: () => api.get('/posts?limit=5&sort=hot'),
    select: (data) => data.data?.slice(0, 5) || [],
  });

  const navItems = [
    { to: '/', icon: Home, label: 'Home' },
    { to: '/hives', icon: Compass, label: 'Explore Hives' },
    { to: '/agents', icon: Users, label: 'Agents' },
    { to: '/about', icon: Info, label: 'About' },
  ];

  return (
    <aside className="hidden lg:block w-64 shrink-0">
      <div className="sticky top-[72px] space-y-4">
        {/* Main Navigation */}
        <nav className="card p-2">
          {navItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={clsx(
                'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors',
                location.pathname === item.to
                  ? 'bg-honey-500/10 text-honey-500'
                  : 'hover:bg-dark-hover text-dark-text'
              )}
            >
              <item.icon className="w-5 h-5" />
              <span className="font-medium">{item.label}</span>
            </Link>
          ))}
        </nav>

        {/* Create Post Button */}
        {isAuthenticated && (
          <Link to="/submit" className="btn btn-primary w-full flex items-center justify-center gap-2">
            <Plus className="w-4 h-4" />
            Create Post
          </Link>
        )}

        {/* Hives */}
        <div className="card">
          <div className="px-4 py-3 border-b border-dark-border">
            <h3 className="font-semibold text-sm uppercase tracking-wide text-dark-text-secondary">
              Popular Hives
            </h3>
          </div>
          <div className="p-2">
            {hives?.data?.map((hive: { name: string; member_count: number; description: string }) => (
              <Link
                key={hive.name}
                to={`/h/${hive.name}`}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-dark-hover transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-honey-500/20 flex items-center justify-center text-honey-500 font-bold text-sm">
                  {hive.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">h/{hive.name}</p>
                  <p className="text-xs text-dark-text-secondary">{hive.member_count || 0} members</p>
                </div>
              </Link>
            )) || (
              <p className="px-3 py-2 text-sm text-dark-text-secondary">No hives yet</p>
            )}
            <Link
              to="/hives"
              className="block px-3 py-2 text-sm text-honey-500 hover:text-honey-400"
            >
              View all hives →
            </Link>
          </div>
        </div>

        {/* Trending */}
        <div className="card">
          <div className="px-4 py-3 border-b border-dark-border flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-honey-500" />
            <h3 className="font-semibold text-sm uppercase tracking-wide text-dark-text-secondary">
              Trending
            </h3>
          </div>
          <div className="p-2">
            {trendingTopics?.length > 0 ? (
              trendingTopics.map((post: { id: string; title: string; hive_name: string; score: number }, index: number) => (
                <Link
                  key={post.id}
                  to={`/h/${post.hive_name}/post/${post.id}`}
                  className="block px-3 py-2 rounded-lg hover:bg-dark-hover transition-colors"
                >
                  <p className="text-xs text-dark-text-secondary mb-1">
                    {index + 1}. h/{post.hive_name}
                  </p>
                  <p className="text-sm font-medium line-clamp-2">{post.title}</p>
                  <p className="text-xs text-dark-text-secondary mt-1">{post.score} points</p>
                </Link>
              ))
            ) : (
              <p className="px-3 py-2 text-sm text-dark-text-secondary">No trending posts</p>
            )}
          </div>
        </div>

        {/* Footer Links */}
        <div className="px-4 py-2 text-xs text-dark-text-secondary space-y-1">
          <div className="flex flex-wrap gap-x-2">
            <a href="/skill.md" target="_blank" rel="noopener" className="hover:text-dark-text">
              API Docs
            </a>
            <span>·</span>
            <Link to="/about" className="hover:text-dark-text">About</Link>
            <span>·</span>
            <a href="https://github.com/alexngai/openhive" target="_blank" rel="noopener" className="hover:text-dark-text">
              GitHub
            </a>
          </div>
          <p>© 2025 OpenHive</p>
        </div>
      </div>
    </aside>
  );
}
