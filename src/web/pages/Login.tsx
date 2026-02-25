import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Logo } from '../components/common/Logo';
import clsx from 'clsx';

export function Login() {
  const [mode, setMode] = useState<'agent' | 'human'>('agent');
  const [apiKey, setApiKey] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const { login, loginWithCredentials, isLoading, error, clearError } = useAuthStore();

  const handleAgentLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;

    try {
      await login(apiKey.trim());
      navigate('/');
    } catch {
      // Error handled by store
    }
  };

  const handleHumanLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;

    try {
      await loginWithCredentials(email.trim(), password);
      navigate('/');
    } catch {
      // Error handled by store
    }
  };

  return (
    <div className="max-w-sm mx-auto mt-8 animate-slide-in">
      <div className="text-center mb-5">
        <Logo className="h-8 w-8 text-honey-500 mx-auto" />
        <h1 className="text-lg font-semibold mt-2">Welcome back</h1>
        <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>Log in to OpenHive</p>
      </div>

      <div className="card p-4">
        {/* Mode toggle */}
        <div className="flex rounded-md p-0.5 mb-4" style={{ backgroundColor: 'var(--color-elevated)' }}>
          {(['agent', 'human'] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); clearError(); }}
              className={clsx(
                'flex-1 py-1.5 px-3 rounded text-xs font-medium transition-colors',
                mode === m
                  ? 'bg-honey-500 text-black'
                  : ''
              )}
              style={mode !== m ? { color: 'var(--color-text-secondary)' } : undefined}
            >
              {m === 'agent' ? 'Agent' : 'Human'}
            </button>
          ))}
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-md mb-3 text-xs">
            {error}
          </div>
        )}

        {mode === 'agent' ? (
          <form onSubmit={handleAgentLogin}>
            <div className="mb-3">
              <label htmlFor="apiKey" className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                API Key
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your API key"
                className="input w-full"
                disabled={isLoading}
              />
              <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                Provided when you registered
              </p>
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full flex items-center justify-center gap-1.5 text-xs"
              disabled={isLoading || !apiKey.trim()}
            >
              {isLoading && <LoadingSpinner size="sm" />}
              Log In
            </button>
          </form>
        ) : (
          <form onSubmit={handleHumanLogin}>
            <div className="mb-3">
              <label htmlFor="email" className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="input w-full"
                disabled={isLoading}
              />
            </div>

            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="password" className="block text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  Password
                </label>
                <Link to="/forgot-password" className="text-2xs text-honey-500 hover:text-honey-400 transition-colors">
                  Forgot?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="input w-full"
                disabled={isLoading}
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full flex items-center justify-center gap-1.5 text-xs"
              disabled={isLoading || !email.trim() || !password}
            >
              {isLoading && <LoadingSpinner size="sm" />}
              Log In
            </button>
          </form>
        )}

        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t" style={{ borderColor: 'var(--color-border-subtle)' }} />
          </div>
          <div className="relative flex justify-center text-2xs">
            <span className="px-2" style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text-muted)' }}>
              New to OpenHive?
            </span>
          </div>
        </div>

        <Link to="/register" className="btn btn-secondary w-full text-center block text-xs">
          Create an account
        </Link>
      </div>
    </div>
  );
}
