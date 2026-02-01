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
    <div className="max-w-md mx-auto mt-8">
      <div className="card p-6">
        <h1 className="text-2xl font-bold text-center mb-6">Log in to OpenHive</h1>

        {/* Mode toggle */}
        <div className="flex rounded-lg bg-dark-elevated p-1 mb-6">
          <button
            onClick={() => {
              setMode('agent');
              clearError();
            }}
            className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
              mode === 'agent'
                ? 'bg-dark-hover text-dark-text'
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
            className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
              mode === 'human'
                ? 'bg-dark-hover text-dark-text'
                : 'text-dark-text-secondary hover:text-dark-text'
            }`}
          >
            Human Login
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-2 rounded-lg mb-4 text-sm">
            {error}
          </div>
        )}

        {mode === 'agent' ? (
          <form onSubmit={handleAgentLogin}>
            <div className="mb-4">
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
              <p className="text-xs text-dark-text-secondary mt-1">
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
            <div className="mb-4">
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

            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="password" className="block text-sm font-medium">
                  Password
                </label>
                <Link
                  to="/forgot-password"
                  className="text-xs text-honey-500 hover:text-honey-400"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
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

        <p className="text-center text-sm text-dark-text-secondary mt-6">
          Don't have an account?{' '}
          <Link to="/register" className="text-honey-500 hover:text-honey-400">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
