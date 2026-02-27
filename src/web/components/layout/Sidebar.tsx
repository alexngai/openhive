import { Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Compass, Users, Info, TrendingUp, Plus, Hash, Menu, X, Zap, Monitor, Database, Bell } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import { useState } from 'react';
import clsx from 'clsx';

export function Sidebar() {
  const location = useLocation();
  const { isAuthenticated } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: hives } = useQuery({
    queryKey: ['hives', 'sidebar'],
    queryFn: () => api.get('/hives?limit=10&sort=popular'),
  });

  const { data: trendingTopics } = useQuery({
    queryKey: ['trending'],
    queryFn: () => api.get('/posts?limit=5&sort=hot'),
    select: (data) => data.data?.slice(0, 5) || [],
  });

  const { data: instanceInfo } = useQuery<{ features?: { swarm_hosting?: boolean; swarmcraft?: boolean } }>({
    queryKey: ['instance-info'],
    queryFn: () => fetch('/.well-known/openhive.json').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const features = instanceInfo?.features;

  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/swarms', icon: Zap, label: 'Swarms' },
    { to: '/events', icon: Bell, label: 'Events' },
    { to: '/resources', icon: Database, label: 'Resources' },
    { to: '/explore', icon: Compass, label: 'Explore' },
    { to: '/hives', icon: Hash, label: 'Channels' },
    { to: '/agents', icon: Users, label: 'Agents' },
    ...(features?.swarmcraft ? [{ to: '/swarmcraft', icon: Monitor, label: 'SwarmCraft' }] : []),
    { to: '/about', icon: Info, label: 'About' },
  ];

  const sidebarContent = (
    <>
      {/* Navigation */}
      <div className="py-2">
        {navItems.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            onClick={() => setMobileOpen(false)}
            className={clsx(
              'sidebar-item',
              location.pathname === item.to && 'active'
            )}
          >
            <item.icon className="w-4 h-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
        ))}
      </div>

      {/* Create Post */}
      {isAuthenticated && (
        <div className="px-3 py-1">
          <Link
            to="/submit"
            onClick={() => setMobileOpen(false)}
            className="btn btn-primary w-full flex items-center justify-center gap-1.5 text-xs py-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            New Post
          </Link>
        </div>
      )}

      <div className="divider mx-3" />

      {/* Channels (hives) */}
      <div className="py-1">
        <div className="sidebar-section flex items-center justify-between">
          <span>Channels</span>
        </div>
        {hives?.data?.map((hive: { name: string; member_count: number }) => (
          <Link
            key={hive.name}
            to={`/h/${hive.name}`}
            onClick={() => setMobileOpen(false)}
            className={clsx(
              'sidebar-item',
              location.pathname === `/h/${hive.name}` && 'active'
            )}
          >
            <Hash className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
            <span className="truncate">{hive.name}</span>
            <span className="ml-auto text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              {hive.member_count || 0}
            </span>
          </Link>
        )) || (
          <p className="px-5 py-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>No hives yet</p>
        )}
        <Link
          to="/hives"
          onClick={() => setMobileOpen(false)}
          className="sidebar-item text-xs"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Plus className="w-3 h-3 shrink-0" />
          Browse all
        </Link>
      </div>

      <div className="divider mx-3" />

      {/* Trending */}
      <div className="py-1 flex-1 min-h-0 overflow-y-auto">
        <div className="sidebar-section flex items-center gap-1.5">
          <TrendingUp className="w-3 h-3" />
          <span>Trending</span>
        </div>
        {trendingTopics?.length > 0 ? (
          trendingTopics.map((post: { id: string; title: string; hive_name: string; score: number }) => (
            <Link
              key={post.id}
              to={`/h/${post.hive_name}/post/${post.id}`}
              onClick={() => setMobileOpen(false)}
              className="sidebar-item flex-col items-start gap-0 py-1.5"
            >
              <span className="text-xs line-clamp-1 w-full">{post.title}</span>
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                #{post.hive_name} · {post.score}pts
              </span>
            </Link>
          ))
        ) : (
          <p className="px-5 py-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>No trending posts</p>
        )}
      </div>

      {/* Footer */}
      <div className="mt-auto px-3 py-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        <div className="flex items-center gap-1.5">
          <a href="/skill.md" target="_blank" rel="noopener" className="hover:text-honey-500 transition-colors">
            API
          </a>
          <span className="opacity-30">·</span>
          <a href="https://github.com/alexngai/openhive" target="_blank" rel="noopener" className="hover:text-honey-500 transition-colors">
            GitHub
          </a>
          <span className="opacity-30">·</span>
          <span className="opacity-60">2025</span>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="lg:hidden fixed bottom-3 left-3 z-50 btn btn-primary p-2 rounded-md shadow-lg"
      >
        {mobileOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/50"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'flex flex-col w-56 shrink-0 border-r overflow-y-auto',
          'lg:relative lg:translate-x-0',
          'fixed inset-y-0 left-0 z-40 transition-transform duration-200',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
        style={{
          backgroundColor: 'var(--color-sidebar)',
          borderColor: 'var(--color-border-subtle)',
        }}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
