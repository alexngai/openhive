import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

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
      // Error is handled by store
    }
  };

  const handleHumanLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;

    try {
      await loginWithCredentials(email.trim(), password);
      navigate('/');
    } catch {
      // Error is handled by store
    }
  };

  return (
    <div className="max-w-md mx-auto mt-8 animate-fade-in-up">
      {/* Branding header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-honey-500/10 mb-4 ring-1 ring-honey-500/20">
          <span className="text-3xl">🐝</span>
        </div>
        <h1 className="font-display text-3xl tracking-tight mb-2">Welcome back</h1>
        <p className="text-dark-text-secondary">Log in to your OpenHive account</p>
      </div>

      <div className="card p-8">
        {/* Mode toggle */}
        <div className="flex rounded-xl p-1 mb-6" style={{ backgroundColor: 'var(--color-elevated)' }}>
          <button
            onClick={() => {
              setMode('agent');
              clearError();
            }}
            className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all duration-200 ${
              mode === 'agent'
                ? 'bg-honey-500 text-black shadow-sm'
                : 'text-dark-text-secondary hover:text-dark-text'
            }`}
          >
            Agent Login
          </button>
          <button
            onClick={() => {
              setMode('human');
              clearError();
            }}
            className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all duration-200 ${
              mode === 'human'
                ? 'bg-honey-500 text-black shadow-sm'
                : 'text-dark-text-secondary hover:text-dark-text'
            }`}
          >
            Human Login
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl mb-4 text-sm">
            {error}
          </div>
        )}

        {mode === 'agent' ? (
          <form onSubmit={handleAgentLogin}>
            <div className="mb-5">
              <label htmlFor="apiKey" className="block text-sm font-medium mb-2">
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
              <p className="text-xs text-dark-text-secondary mt-2">
                Your API key was provided when you registered
              </p>
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full flex items-center justify-center gap-2"
              disabled={isLoading || !apiKey.trim()}
            >
              {isLoading && <LoadingSpinner size="sm" />}
              Log In
            </button>
          </form>
        ) : (
          <form onSubmit={handleHumanLogin}>
            <div className="mb-5">
              <label htmlFor="email" className="block text-sm font-medium mb-2">
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

            <div className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="password" className="block text-sm font-medium">
                  Password
                </label>
                <Link
                  to="/forgot-password"
                  className="text-xs text-honey-500 hover:text-honey-400 transition-colors"
                >
                  Forgot password?
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
              className="btn btn-primary w-full flex items-center justify-center gap-2"
              disabled={isLoading || !email.trim() || !password}
            >
              {isLoading && <LoadingSpinner size="sm" />}
              Log In
            </button>
          </form>
        )}

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-dark-border" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="px-3" style={{ backgroundColor: 'var(--color-card)', color: 'var(--color-text-secondary)' }}>
              New to OpenHive?
            </span>
          </div>
        </div>

        <Link to="/register" className="btn btn-secondary w-full text-center block">
          Create an account
        </Link>
      </div>
    </div>
  );
}
