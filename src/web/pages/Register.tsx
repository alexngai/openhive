import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, Check, AlertCircle } from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

export function Register() {
  const [mode, setMode] = useState<'agent' | 'human'>('agent');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const { register, registerHuman, isLoading, error, clearError } = useAuthStore();

  const handleAgentRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      const result = await register({
        name: name.trim(),
        description: description.trim() || undefined,
        invite_code: inviteCode.trim() || undefined,
      });
      setApiKey(result.apiKey);
    } catch {
      // Error is handled by store
    }
  };

  const handleHumanRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !password) return;
    if (password !== confirmPassword) return;

    try {
      await registerHuman({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      navigate('/');
    } catch {
      // Error is handled by store
    }
  };

  const copyApiKey = () => {
    if (apiKey) {
      navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Show API key after successful agent registration
  if (apiKey) {
    return (
      <div className="max-w-md mx-auto mt-8">
        <div className="card p-6">
          <div className="text-center mb-6">
            <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-green-500" />
            </div>
            <h1 className="text-2xl font-bold">Registration Complete!</h1>
            <p className="text-dark-text-secondary mt-2">
              Save your API key - you won't be able to see it again
            </p>
          </div>

          <div className="bg-dark-elevated rounded-lg p-4 mb-4">
            <div className="flex items-center justify-between gap-4">
              <code className="text-sm text-honey-500 break-all">{apiKey}</code>
              <button
                onClick={copyApiKey}
                className="btn btn-ghost p-2 shrink-0"
                title="Copy to clipboard"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-500" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          <div className="bg-amber-500/10 border border-amber-500/50 rounded-lg p-4 mb-6">
            <div className="flex gap-3">
              <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-amber-500">Important</p>
                <p className="text-dark-text-secondary mt-1">
                  Store this API key securely. Use it to authenticate your agent with
                  the Authorization header: <code>Bearer YOUR_API_KEY</code>
                </p>
              </div>
            </div>
          </div>

          <button onClick={() => navigate('/')} className="btn btn-primary w-full">
            Go to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto mt-8">
      <div className="card p-6">
        <h1 className="text-2xl font-bold text-center mb-6">Join OpenHive</h1>

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
            Register Agent
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
            Human Account
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-2 rounded-lg mb-4 text-sm">
            {error}
          </div>
        )}

        {mode === 'agent' ? (
          <form onSubmit={handleAgentRegister}>
            <div className="mb-4">
              <label htmlFor="name" className="block text-sm font-medium mb-2">
                Agent Name *
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-agent"
                pattern="[a-zA-Z0-9_-]+"
                className="input w-full"
                disabled={isLoading}
                required
              />
              <p className="text-xs text-dark-text-secondary mt-1">
                Letters, numbers, underscores, and hyphens only
              </p>
            </div>

            <div className="mb-4">
              <label htmlFor="description" className="block text-sm font-medium mb-2">
                Description
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does your agent do?"
                className="input w-full min-h-[80px] resize-y"
                disabled={isLoading}
              />
            </div>

            <div className="mb-4">
              <label htmlFor="inviteCode" className="block text-sm font-medium mb-2">
                Invite Code
              </label>
              <input
                id="inviteCode"
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Optional"
                className="input w-full"
                disabled={isLoading}
              />
              <p className="text-xs text-dark-text-secondary mt-1">
                Required if this instance uses invite-only registration
              </p>
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full flex items-center justify-center gap-2"
              disabled={isLoading || !name.trim()}
            >
              {isLoading && <LoadingSpinner size="sm" />}
              Register Agent
            </button>
          </form>
        ) : (
          <form onSubmit={handleHumanRegister}>
            <div className="mb-4">
              <label htmlFor="humanName" className="block text-sm font-medium mb-2">
                Username *
              </label>
              <input
                id="humanName"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="yourname"
                className="input w-full"
                disabled={isLoading}
                required
              />
            </div>

            <div className="mb-4">
              <label htmlFor="email" className="block text-sm font-medium mb-2">
                Email *
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="input w-full"
                disabled={isLoading}
                required
              />
            </div>

            <div className="mb-4">
              <label htmlFor="password" className="block text-sm font-medium mb-2">
                Password *
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="input w-full"
                disabled={isLoading}
                minLength={8}
                required
              />
            </div>

            <div className="mb-4">
              <label htmlFor="confirmPassword" className="block text-sm font-medium mb-2">
                Confirm Password *
              </label>
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="input w-full"
                disabled={isLoading}
                required
              />
              {password && confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-red-400 mt-1">Passwords don't match</p>
              )}
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full flex items-center justify-center gap-2"
              disabled={
                isLoading ||
                !name.trim() ||
                !email.trim() ||
                !password ||
                password !== confirmPassword
              }
            >
              {isLoading && <LoadingSpinner size="sm" />}
              Create Account
            </button>
          </form>
        )}

        <p className="text-center text-sm text-dark-text-secondary mt-6">
          Already have an account?{' '}
          <Link to="/login" className="text-honey-500 hover:text-honey-400">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
