import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Menu, X, CirclePile,
  User, Activity, MessageSquare, ChevronLeft, ChevronDown,
  ChevronRight, ListTodo, Brain, Wrench, GraduationCap, Settings, FileText, Send,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { MailConversation } from '../../lib/api';
import { useMapSwarms } from '../../hooks/useApi';
import { useInstanceFeatures } from '../../hooks/useInstanceFeatures';
import { useAuthStore } from '../../stores/auth';
import { useState, useCallback } from 'react';
import clsx from 'clsx';
import { Logo } from '../common/Logo';

interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
  badge?: number;
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

const STORAGE_KEY = 'sidebar-sections';

function loadSectionState(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveSectionState(state: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { agent, isAuthenticated, authMode } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebar-collapsed') === 'true'; } catch { return false; }
  });
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(loadSectionState);

  const toggleSection = useCallback((id: string) => {
    setExpandedSections((prev) => {
      const next = { ...prev, [id]: prev[id] === false };
      saveSectionState(next);
      return next;
    });
  }, []);

  const { data: activeThreads } = useQuery<{ conversations: MailConversation[] }>({
    queryKey: ['mail-conversations-sidebar'],
    queryFn: () => api.get('/mail/conversations?status=active'),
    select: (data) => ({ conversations: (data.conversations ?? []).slice(0, 5) }),
    staleTime: 15_000,
  });

  const { features } = useInstanceFeatures();
  const { data: mapSwarms } = useMapSwarms();
  const onlineSwarmCount = mapSwarms?.filter((s) => s.status === 'online').length ?? 0;

  const navGroups: NavGroup[] = [
    {
      id: 'command-center',
      label: 'Control Plane',
      items: [
        { to: '/', icon: LayoutDashboard, label: 'Overview' },
        { to: '/specs', icon: FileText, label: 'Specs' },
        { to: '/dispatches', icon: Send, label: 'Dispatches' },
        { to: '/tasks', icon: ListTodo, label: 'Tasks' },
        { to: '/swarms', icon: CirclePile, label: 'Swarms', badge: onlineSwarmCount || undefined },
        { to: '/sessions', icon: Activity, label: 'Sessions' },
        { to: '/messages', icon: MessageSquare, label: 'Messages' },
      ],
    },
    {
      id: 'knowledge',
      label: 'Resources',
      items: [
        { to: '/memory', icon: Brain, label: 'Memory' },
        { to: '/skills', icon: Wrench, label: 'Skills' },
        { to: '/learning', icon: GraduationCap, label: 'Learning' },
      ],
    },
  ];

  const sidebarContent = (
    <>
      {/* Logo + Brand (toggles sidebar) */}
      <button
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          try { localStorage.setItem('sidebar-collapsed', String(next)); } catch { /* ignore */ }
        }}
        className={clsx(
          'hidden lg:flex items-center border-b shrink-0 cursor-pointer transition-colors duration-80 w-full',
          collapsed ? 'justify-center gap-1.5 px-2 py-4' : 'gap-2.5 px-4 py-4'
        )}
        style={{ borderColor: 'var(--color-border-subtle)' }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        <Logo className="h-6 w-6 text-honey-500 shrink-0" />
        {!collapsed && (
          <>
            <span className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>openhive</span>
            <ChevronLeft className="w-4 h-4 ml-auto shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          </>
        )}
      </button>
      {/* Mobile: logo links home */}
      <div
        className={clsx(
          'flex lg:hidden items-center border-b shrink-0 px-4 py-4'
        )}
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <Link to="/" className="flex items-center gap-2.5 min-w-0" onClick={() => setMobileOpen(false)}>
          <Logo className="h-6 w-6 text-honey-500 shrink-0" />
          <span className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>openhive</span>
        </Link>
      </div>



      {/* Navigation */}
      <nav className={clsx('flex-1 overflow-y-auto py-2', collapsed ? 'px-1 space-y-0.5' : 'px-0')}>
        {collapsed ? (
          /* Collapsed: icon list grouped by thin dividers */
          <div className="space-y-1">
            {navGroups.map((group, gi) => (
              <div key={group.id}>
                {gi > 0 && <div className="divider mx-2 !my-1" />}
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setMobileOpen(false)}
                      className={clsx(
                        'flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 mx-0.5 text-center cursor-pointer transition-colors duration-80',
                        (location.pathname === item.to || location.pathname.startsWith(item.to + '/')) ? 'bg-honey-500/10 text-honey-500' : ''
                      )}
                      style={!(location.pathname === item.to || location.pathname.startsWith(item.to + '/')) ? { color: 'var(--color-text-secondary)' } : undefined}
                      onMouseEnter={(e) => { if (!(location.pathname === item.to || location.pathname.startsWith(item.to + '/'))) { e.currentTarget.style.backgroundColor = 'var(--color-hover)'; e.currentTarget.style.color = 'var(--color-text)'; } }}
                      onMouseLeave={(e) => { if (!(location.pathname === item.to || location.pathname.startsWith(item.to + '/'))) { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--color-text-secondary)'; } }}
                    >
                      <div className="relative">
                        <item.icon className="w-5 h-5 shrink-0" />
                        {item.badge != null && (
                          <span className="absolute -top-1.5 -right-2.5 text-[9px] font-medium px-1 py-px rounded-full bg-honey-500/15 text-honey-500 leading-none min-w-[14px] text-center">
                            {item.badge}
                          </span>
                        )}
                      </div>
                      <span className="text-2xs leading-tight truncate w-full">{item.label}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Expanded: grouped sections */
          <div className="space-y-1">
            {navGroups.map((group) => {
              const isExpanded = expandedSections[group.id] !== false;
              return (
                <div key={group.id}>
                  <button
                    onClick={() => toggleSection(group.id)}
                    className="sidebar-section-toggle"
                  >
                    <span>{group.label}</span>
                    {isExpanded
                      ? <ChevronDown className="w-3 h-3 shrink-0" />
                      : <ChevronRight className="w-3 h-3 shrink-0" />
                    }
                  </button>
                  {isExpanded && (
                    <div className="space-y-0.5">
                      {group.items.map((item) => (
                        <Link
                          key={item.to}
                          to={item.to}
                          onClick={() => setMobileOpen(false)}
                          className={clsx(
                            'sidebar-item',
                            (location.pathname === item.to || location.pathname.startsWith(item.to + '/')) && 'active'
                          )}
                        >
                          <item.icon className="w-4 h-4 shrink-0" />
                          <span className="truncate">{item.label}</span>
                          {item.badge != null && (
                            <span className="ml-auto text-2xs font-medium px-1.5 py-0.5 rounded-full bg-honey-500/15 text-honey-500 leading-none">
                              {item.badge}
                            </span>
                          )}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Threads (active mail conversations) */}
            {activeThreads?.conversations && activeThreads.conversations.length > 0 && (
              <>
                <div className="py-1">
                  <div className="sidebar-section flex items-center gap-1.5">
                    <MessageSquare className="w-3 h-3" />
                    <span>Threads</span>
                  </div>
                  {activeThreads.conversations.map((conv) => (
                    <Link
                      key={conv.id}
                      to={`/messages/${conv.id}`}
                      onClick={() => setMobileOpen(false)}
                      className={clsx(
                        'sidebar-item flex-col items-start gap-0 py-1.5',
                        location.pathname === `/messages/${conv.id}` && 'active'
                      )}
                    >
                      <span className="text-xs line-clamp-1 w-full">
                        {conv.subject || conv.participants.map((p) => p.agent_id).join(', ') || 'Untitled'}
                      </span>
                      <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                        {conv.participants.length} participant{conv.participants.length !== 1 ? 's' : ''}
                      </span>
                    </Link>
                  ))}
                  <Link
                    to="/messages"
                    onClick={() => setMobileOpen(false)}
                    className="sidebar-item text-xs"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    View all
                  </Link>
                </div>

                <div className="divider mx-1" />
              </>
            )}

          </div>
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
