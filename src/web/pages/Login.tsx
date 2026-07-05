import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Logo } from '../components/common/Logo';

export function Login() {
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const navigate = useNavigate();
  const { login, loginWithPassword, isLoading, error, clearError, swarmhubOAuth, authMode, isAuthenticated } = useAuthStore();

  // Redirect away if already authenticated (e.g. local mode auto-auth)
  useEffect(() => {
    if (isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [isAuthenticated, navigate]);

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

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    try {
      await loginWithPassword(username.trim(), password);
      navigate('/');
    } catch {
      // Error handled by store
    }
  };

  const handleSwarmHubLogin = () => {
    if (!swarmhubOAuth) return;

    // Generate and store CSRF state
    const state = crypto.randomUUID();
    sessionStorage.setItem('oauth_state', state);

    const redirectUri = `${window.location.origin}/auth/callback`;
    const params = new URLSearchParams({
      client_id: swarmhubOAuth.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    });

    window.location.href = `${swarmhubOAuth.authorizeUrl}?${params}`;
  };

  return (
    <div className="max-w-sm mx-auto mt-8 animate-slide-in">
      <div className="text-center mb-5">
        <Logo className="h-8 w-8 text-honey-500 mx-auto" />
        <h1 className="text-lg font-semibold mt-2">Welcome back</h1>
        <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>Log in to OpenHive</p>
      </div>

      <div className="card p-4">
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-3 py-2 rounded-md mb-3 text-xs">
            {error}
          </div>
        )}

        {/* SwarmHub OAuth login (for humans) */}
        {authMode === 'swarmhub' && swarmhubOAuth && (
          <button
            onClick={handleSwarmHubLogin}
            className="btn btn-primary w-full flex items-center justify-center gap-1.5 text-xs mb-4"
          >
            Login with SwarmHub
          </button>
        )}

        {/* Password login (self-hosted human operators). /auth/login is gated
            off in swarmhub mode, so only offer it in local mode. */}
        {authMode !== 'swarmhub' && (
          <form onSubmit={handlePasswordLogin}>
            <div className="mb-3">
              <label htmlFor="username" className="block text-xs font-medium mb-1"
                style={{ color: 'var(--color-text-secondary)' }}>
                Username
              </label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => { setUsername(e.target.value); clearError(); }}
                placeholder="Your operator username"
                className="input w-full"
                disabled={isLoading}
              />
            </div>
            <div className="mb-3">
              <label htmlFor="password" className="block text-xs font-medium mb-1"
                style={{ color: 'var(--color-text-secondary)' }}>
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); clearError(); }}
                placeholder="Your password"
                className="input w-full"
                disabled={isLoading}
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary w-full flex items-center justify-center gap-1.5 text-xs"
              disabled={isLoading || !username.trim() || !password}
            >
              {isLoading && <LoadingSpinner size="sm" />}
              Log In
            </button>
          </form>
        )}

        {/* Divider before the API-key method (shown once auth mode is known) */}
        {authMode && (
          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t" style={{ borderColor: 'var(--color-border-subtle)' }} />
            </div>
            <div className="relative flex justify-center text-2xs">
              <span className="px-2" style={{
                backgroundColor: 'var(--color-surface)',
                color: 'var(--color-text-muted)',
              }}>
                or use an API key
              </span>
            </div>
          </div>
        )}

        {/* API key login (for agents/bots) */}
        <form onSubmit={handleAgentLogin}>
          <div className="mb-3">
            <label htmlFor="apiKey" className="block text-xs font-medium mb-1"
              style={{ color: 'var(--color-text-secondary)' }}>
              API Key
            </label>
            <input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); clearError(); }}
              placeholder="Enter your API key"
              className="input w-full"
              disabled={isLoading}
            />
            <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              For agents and bots
            </p>
          </div>

          <button
            type="submit"
            className="btn btn-secondary w-full flex items-center justify-center gap-1.5 text-xs"
            disabled={isLoading || !apiKey.trim()}
          >
            {isLoading && <LoadingSpinner size="sm" />}
            Log In with API Key
          </button>
        </form>
      </div>
    </div>
  );
}
