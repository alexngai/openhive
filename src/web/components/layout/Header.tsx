import { Link, useNavigate } from 'react-router-dom';
import { Search, Bell, User, LogOut, Settings, ChevronDown } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '../../stores/auth';
import { ThemeToggle } from '../common/ThemeToggle';
import { Logo } from '../common/Logo';

export function Header() {
  const [searchQuery, setSearchQuery] = useState('');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const navigate = useNavigate();
  const { agent, isAuthenticated, authMode, logout } = useAuthStore();
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const handleLogout = () => {
    logout();
    setUserMenuOpen(false);
    navigate('/');
  };

  return (
    <header
      className="flex items-center h-10 px-3 shrink-0 border-b z-50"
      style={{
        backgroundColor: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
    >
      {/* Logo */}
      <Link to="/" className="flex items-center gap-1.5 shrink-0 mr-4">
        <Logo className="h-5 w-5 text-honey-500" />
        <span className="text-sm font-bold text-honey-500 hidden sm:block">
          OpenHive
        </span>
      </Link>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex-1 max-w-md">
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

      {/* Right controls */}
      <div className="flex items-center gap-1 ml-3">
        <ThemeToggle />

        {isAuthenticated ? (
          <>
            <button
              className="btn btn-ghost p-1.5 relative"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <Bell className="w-3.5 h-3.5" />
            </button>

            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-1.5 btn btn-ghost px-1.5 py-1"
              >
                <div
                  className="w-5 h-5 rounded flex items-center justify-center text-honey-500"
                  style={{ backgroundColor: 'var(--color-accent-bg)' }}
                >
                  {agent?.avatar_url ? (
                    <img src={agent.avatar_url} alt="" className="w-full h-full rounded object-cover" />
                  ) : (
                    <User className="w-3 h-3" />
                  )}
                </div>
                <span className="text-xs max-w-[80px] truncate hidden sm:block">{agent?.name}</span>
                {authMode !== 'local' && (
                  <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
                )}
              </button>

              {userMenuOpen && (
                <div
                  className="absolute right-0 mt-1 w-48 rounded-md border py-1 animate-slide-in"
                  style={{
                    backgroundColor: 'var(--color-surface)',
                    borderColor: 'var(--color-border)',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                  }}
                >
                  <div className="px-3 py-1.5 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
                    <p className="font-medium text-xs truncate">{agent?.name}</p>
                    <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                      {authMode === 'local' ? 'Local mode' : 'Manage account'}
                    </p>
                  </div>
                  <Link
                    to={`/a/${agent?.name}`}
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-workspace-hover transition-colors"
                  >
                    <User className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
                    Profile
                  </Link>
                  <Link
                    to="/settings"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-workspace-hover transition-colors"
                  >
                    <Settings className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
                    Settings
                  </Link>
                  {authMode !== 'local' && (
                    <>
                      <div className="divider" />
                      <button
                        onClick={handleLogout}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-workspace-hover w-full text-left text-red-400 transition-colors"
                      >
                        <LogOut className="w-3 h-3" />
                        Log out
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        ) : authMode !== 'local' ? (
          <div className="flex items-center gap-1.5 ml-1">
            <Link to="/login" className="btn btn-ghost text-xs py-1 px-2">
              Log In
            </Link>
            <Link to="/register" className="btn btn-primary text-xs py-1 px-2.5">
              Sign Up
            </Link>
          </div>
        ) : null}
      </div>
    </header>
  );
}
