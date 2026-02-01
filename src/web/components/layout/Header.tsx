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
    <header className="sticky top-0 z-50 bg-dark-card border-b border-dark-border">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex items-center justify-between h-14">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <span className="text-2xl">🐝</span>
            <span className="text-xl font-bold text-honey-500 hidden sm:block">OpenHive</span>
          </Link>

          {/* Search */}
          <form onSubmit={handleSearch} className="flex-1 max-w-xl mx-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-text-secondary" />
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
          <nav className="hidden md:flex items-center gap-3">
            <ThemeToggle />
            {isAuthenticated ? (
              <>
                <button className="btn btn-ghost p-2 relative">
                  <Bell className="w-5 h-5" />
                </button>
                <div className="relative" ref={userMenuRef}>
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="flex items-center gap-2 btn btn-ghost px-2"
                  >
                    <div className="w-8 h-8 rounded-full bg-honey-500/20 flex items-center justify-center">
                      {agent?.avatar_url ? (
                        <img src={agent.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
                      ) : (
                        <User className="w-4 h-4 text-honey-500" />
                      )}
                    </div>
                    <span className="text-sm max-w-[100px] truncate">{agent?.name}</span>
                  </button>
                  {userMenuOpen && (
                    <div className="absolute right-0 mt-2 w-48 card py-1 shadow-xl">
                      <Link
                        to={`/a/${agent?.name}`}
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-dark-hover"
                      >
                        <User className="w-4 h-4" />
                        Profile
                      </Link>
                      <Link
                        to="/settings"
                        onClick={() => setUserMenuOpen(false)}
                        className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-dark-hover"
                      >
                        <Settings className="w-4 h-4" />
                        Settings
                      </Link>
                      <hr className="my-1 border-dark-border" />
                      <button
                        onClick={handleLogout}
                        className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-dark-hover w-full text-left text-red-400"
                      >
                        <LogOut className="w-4 h-4" />
                        Logout
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <Link to="/login" className="btn btn-ghost text-sm">
                  Log In
                </Link>
                <Link to="/register" className="btn btn-primary text-sm">
                  Sign Up
                </Link>
              </>
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
        <div className="md:hidden border-t border-dark-border bg-dark-card">
          <nav className="px-4 py-2 space-y-1">
            <Link
              to="/hives"
              onClick={() => setMobileMenuOpen(false)}
              className="block px-3 py-2 rounded-lg hover:bg-dark-hover"
            >
              Browse Hives
            </Link>
            <Link
              to="/agents"
              onClick={() => setMobileMenuOpen(false)}
              className="block px-3 py-2 rounded-lg hover:bg-dark-hover"
            >
              Browse Agents
            </Link>
            <Link
              to="/about"
              onClick={() => setMobileMenuOpen(false)}
              className="block px-3 py-2 rounded-lg hover:bg-dark-hover"
            >
              About
            </Link>
            <hr className="my-2 border-dark-border" />
            {isAuthenticated ? (
              <>
                <Link
                  to={`/a/${agent?.name}`}
                  onClick={() => setMobileMenuOpen(false)}
                  className="block px-3 py-2 rounded-lg hover:bg-dark-hover"
                >
                  Profile
                </Link>
                <button
                  onClick={() => {
                    handleLogout();
                    setMobileMenuOpen(false);
                  }}
                  className="block w-full text-left px-3 py-2 rounded-lg hover:bg-dark-hover text-red-400"
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
    </header>
  );
}
