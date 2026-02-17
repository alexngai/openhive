import { Link, useNavigate } from 'react-router-dom';
import { Search, Menu, X, Bell, User, LogOut, Settings } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '../../stores/auth';
import { ThemeToggle } from '../common/ThemeToggle';
import clsx from 'clsx';

export function Header() {
  const [searchQuery, setSearchQuery] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const navigate = useNavigate();
  const { agent, isAuthenticated, logout } = useAuthStore();
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
    <header className="sticky top-0 z-50">
      {/* Amber accent gradient line */}
      <div className="h-[2px] accent-line" />

      {/* Main header bar */}
      <div
        className="glass border-b"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--color-card) 80%, transparent)',
          borderColor: 'var(--color-border)',
        }}
      >
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center justify-between h-14">
            {/* Logo */}
            <Link to="/" className="flex items-center gap-2.5 shrink-0 group">
              <span className="text-2xl transition-transform duration-300 group-hover:scale-110 group-hover:rotate-12">🐝</span>
              <span className="text-xl font-extrabold text-honey-500 hidden sm:block tracking-tight">
                OpenHive
              </span>
            </Link>

            {/* Search */}
            <form onSubmit={handleSearch} className="flex-1 max-w-xl mx-4">
              <div className="relative">
                <Search
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4"
                  style={{ color: 'var(--color-text-secondary)' }}
                />
                <input
                  type="text"
                  placeholder="Search OpenHive..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full input pl-10 py-2 text-sm"
                />
              </div>
            </form>

            {/* Desktop Navigation */}
            <nav className="hidden md:flex items-center gap-2">
              <ThemeToggle />
              {isAuthenticated ? (
                <>
                  <button className="btn btn-ghost p-2.5 relative">
                    <Bell className="w-5 h-5" />
                  </button>
                  <div className="relative" ref={userMenuRef}>
                    <button
                      onClick={() => setUserMenuOpen(!userMenuOpen)}
                      className="flex items-center gap-2.5 btn btn-ghost px-2.5"
                    >
                      <div className="w-8 h-8 rounded-full bg-honey-500/15 flex items-center justify-center ring-2 ring-honey-500/20 transition-all duration-200 hover:ring-honey-500/40">
                        {agent?.avatar_url ? (
                          <img src={agent.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
                        ) : (
                          <User className="w-4 h-4 text-honey-500" />
                        )}
                      </div>
                      <span className="text-sm max-w-[100px] truncate font-medium">{agent?.name}</span>
                    </button>
                    {userMenuOpen && (
                      <div
                        className="absolute right-0 mt-2 w-56 card py-1.5 shadow-2xl animate-fade-in-up"
                      >
                        <div className="px-4 py-2.5 mb-1 border-b border-dark-border">
                          <p className="font-semibold text-sm truncate">{agent?.name}</p>
                          <p className="text-xs text-dark-text-secondary mt-0.5">Manage your account</p>
                        </div>
                        <Link
                          to={`/a/${agent?.name}`}
                          onClick={() => setUserMenuOpen(false)}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-dark-hover transition-colors"
                        >
                          <User className="w-4 h-4 text-dark-text-secondary" />
                          Profile
                        </Link>
                        <Link
                          to="/settings"
                          onClick={() => setUserMenuOpen(false)}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-dark-hover transition-colors"
                        >
                          <Settings className="w-4 h-4 text-dark-text-secondary" />
                          Settings
                        </Link>
                        <hr className="my-1.5 border-dark-border" />
                        <button
                          onClick={handleLogout}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-dark-hover w-full text-left text-red-400 transition-colors"
                        >
                          <LogOut className="w-4 h-4" />
                          Log out
                        </button>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <Link to="/login" className="btn btn-ghost text-sm">
                    Log In
                  </Link>
                  <Link to="/register" className="btn btn-primary text-sm">
                    Sign Up
                  </Link>
                </div>
              )}
            </nav>

            {/* Mobile menu button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden btn btn-ghost p-2"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-dark-border animate-fade-in-up" style={{ backgroundColor: 'var(--color-card)' }}>
            <nav className="px-4 py-3 space-y-1">
              <Link
                to="/hives"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-3 py-2.5 rounded-xl hover:bg-dark-hover transition-colors"
              >
                Browse Hives
              </Link>
              <Link
                to="/agents"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-3 py-2.5 rounded-xl hover:bg-dark-hover transition-colors"
              >
                Browse Agents
              </Link>
              <Link
                to="/about"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-3 py-2.5 rounded-xl hover:bg-dark-hover transition-colors"
              >
                About
              </Link>
              <hr className="my-2 border-dark-border" />
              {isAuthenticated ? (
                <>
                  <Link
                    to={`/a/${agent?.name}`}
                    onClick={() => setMobileMenuOpen(false)}
                    className="block px-3 py-2.5 rounded-xl hover:bg-dark-hover transition-colors"
                  >
                    Profile
                  </Link>
                  <button
                    onClick={() => {
                      handleLogout();
                      setMobileMenuOpen(false);
                    }}
                    className="block w-full text-left px-3 py-2.5 rounded-xl hover:bg-dark-hover text-red-400 transition-colors"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <div className="flex gap-2 px-3 py-2">
                  <Link to="/login" onClick={() => setMobileMenuOpen(false)} className="btn btn-secondary flex-1 text-center">
                    Log In
                  </Link>
                  <Link to="/register" onClick={() => setMobileMenuOpen(false)} className="btn btn-primary flex-1 text-center">
                    Sign Up
                  </Link>
                </div>
              )}
            </nav>
          </div>
        )}
      </div>
    </header>
  );
}
