import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Compass, Users, Info, TrendingUp, Plus, Hash, Menu, X, Zap, Monitor, Database, Bell, ChevronLeft, ChevronRight, User, Search, Activity } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuthStore } from '../../stores/auth';
import { useState } from 'react';
import clsx from 'clsx';
import { Logo } from '../common/Logo';

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { agent, isAuthenticated, authMode } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setMobileOpen(false);
    }
  };

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
    { to: '/', icon: LayoutDashboard, label: 'Home' },
    { to: '/swarms', icon: Zap, label: 'Swarms' },
    { to: '/sessions', icon: Activity, label: 'Sessions' },
    { to: '/events', icon: Bell, label: 'Events' },
    { to: '/resources', icon: Database, label: 'Assets' },
    { to: '/explore', icon: Compass, label: 'Explore' },
    { to: '/hives', icon: Hash, label: 'Channels' },
    { to: '/agents', icon: Users, label: 'Agents' },
    ...(features?.swarmcraft ? [{ to: '/swarmcraft', icon: Monitor, label: 'SwarmCraft' }] : []),
    { to: '/about', icon: Info, label: 'About' },
  ];

  const sidebarContent = (
    <>
      {/* Logo + Brand + Collapse Toggle */}
      <div
        className={clsx(
          'flex items-center border-b shrink-0',
          collapsed ? 'justify-center gap-1.5 px-2 py-4' : 'justify-between px-4 py-4'
        )}
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <Link to="/" className="flex items-center gap-2.5 min-w-0">
          <Logo className="h-6 w-6 text-honey-500 shrink-0" />
          {!collapsed && (
            <span className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>openhive</span>
          )}
        </Link>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden lg:block shrink-0 cursor-pointer hover:text-honey-500 transition-colors duration-80"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Search */}
      {collapsed ? (
        <div className="px-1 pt-3 pb-1">
          <Link
            to="/search"
            onClick={() => setMobileOpen(false)}
            className={clsx(
              'flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 mx-0.5 text-center cursor-pointer transition-colors duration-80',
              location.pathname === '/search' ? 'bg-honey-500/10 text-honey-500' : ''
            )}
            style={location.pathname !== '/search' ? { color: 'var(--color-text-secondary)' } : undefined}
            onMouseEnter={(e) => { if (location.pathname !== '/search') { e.currentTarget.style.backgroundColor = 'var(--color-hover)'; e.currentTarget.style.color = 'var(--color-text)'; } }}
            onMouseLeave={(e) => { if (location.pathname !== '/search') { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--color-text-secondary)'; } }}
          >
            <Search className="w-5 h-5 shrink-0" />
            <span className="text-2xs leading-tight">Search</span>
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSearch} className="px-3 pt-3 pb-1">
          <div className="relative">
            <Search
              className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5"
              style={{ color: 'var(--color-text-muted)' }}
            />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full input pl-7 py-1 text-sm h-7"
            />
          </div>
        </form>
      )}

      {/* Navigation */}
      <nav className={clsx('flex-1 overflow-y-auto py-2 space-y-0.5', collapsed ? 'px-1' : 'px-2')}>
        {navItems.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            onClick={() => setMobileOpen(false)}
            className={clsx(
              collapsed
                ? 'flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 mx-0.5 text-center cursor-pointer transition-colors duration-80'
                : 'sidebar-item',
              location.pathname === item.to && (collapsed ? 'bg-honey-500/10 text-honey-500' : 'active')
            )}
            style={collapsed && location.pathname !== item.to ? { color: 'var(--color-text-secondary)' } : undefined}
            onMouseEnter={(e) => { if (collapsed && location.pathname !== item.to) { e.currentTarget.style.backgroundColor = 'var(--color-hover)'; e.currentTarget.style.color = 'var(--color-text)'; } }}
            onMouseLeave={(e) => { if (collapsed && location.pathname !== item.to) { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--color-text-secondary)'; } }}
          >
            <item.icon className={clsx('shrink-0', collapsed ? 'w-5 h-5' : 'w-4 h-4')} />
            {collapsed
              ? <span className="text-2xs leading-tight truncate w-full">{item.label}</span>
              : <span className="truncate">{item.label}</span>
            }
          </Link>
        ))}

        {!collapsed && (
          <>
            {/* Create Post */}
            {isAuthenticated && (
              <div className="px-1 pt-2">
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

            <div className="divider mx-1" />

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

            <div className="divider mx-1" />

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

            {/* Footer links */}
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
        )}
      </nav>

      {/* User Profile / Login at bottom */}
      {isAuthenticated ? (
        <button
          onClick={() => navigate('/settings')}
          className={clsx(
            'flex border-t transition-colors duration-80 cursor-pointer shrink-0',
            collapsed
              ? 'flex-col items-center gap-1 px-1 py-3'
              : 'items-center gap-2 px-3 py-3'
          )}
          style={{
            borderColor: 'var(--color-border-subtle)',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-honey-500 shrink-0"
            style={{ backgroundColor: 'var(--color-accent-bg)' }}
          >
            {agent?.avatar_url ? (
              <img src={agent.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
            ) : (
              <User className="w-4 h-4" />
            )}
          </div>
          {collapsed ? (
            <span className="text-2xs truncate w-full text-center" style={{ color: 'var(--color-text-secondary)' }}>
              {agent?.name}
            </span>
          ) : (
            <div className="min-w-0 text-left">
              <p className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>
                {agent?.name}
              </p>
              <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                {authMode === 'local' ? 'Local mode' : 'Manage account'}
              </p>
            </div>
          )}
        </button>
      ) : authMode !== 'local' ? (
        <div
          className="border-t px-2 py-3 shrink-0"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          {!collapsed ? (
            <div className="flex items-center gap-1.5 px-1">
              <Link to="/login" className="btn btn-ghost text-xs py-1.5 flex-1 text-center">
                Log In
              </Link>
              <Link to="/register" className="btn btn-primary text-xs py-1.5 flex-1 text-center">
                Sign Up
              </Link>
            </div>
          ) : (
            <Link to="/login" className="flex flex-col items-center gap-1 py-1">
              <User className="w-5 h-5" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Log In</span>
            </Link>
          )}
        </div>
      ) : null}
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
          'flex flex-col shrink-0 border-r overflow-hidden transition-all duration-200',
          'lg:relative lg:translate-x-0',
          'fixed inset-y-0 left-0 z-40',
          mobileOpen ? 'translate-x-0 w-56' : '-translate-x-full lg:translate-x-0',
          collapsed ? 'lg:w-[72px]' : 'lg:w-56'
        )}
        style={{
          backgroundColor: 'var(--color-bg)',
          borderColor: 'var(--color-border-subtle)',
        }}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
