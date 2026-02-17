import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Lock, CheckCircle, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { PageLoader } from '../components/common/LoadingSpinner';

export function ResetPassword() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isVerifying, setIsVerifying] = useState(true);
  const [isValid, setIsValid] = useState(false);
  const [maskedEmail, setMaskedEmail] = useState('');
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function verifyToken() {
      if (!token) {
        setIsVerifying(false);
        return;
      }

      try {
        const response = await api.get<{ valid: boolean; email?: string }>(
          `/auth/verify-reset-token/${token}`
        );
        setIsValid(response.valid);
        if (response.email) {
          setMaskedEmail(response.email);
        }
      } catch {
        setIsValid(false);
      } finally {
        setIsVerifying(false);
      }
    }

    verifyToken();
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setIsLoading(true);

    try {
      await api.post('/auth/reset-password', { token, password });
      setIsSuccess(true);
    } catch (err: unknown) {
      const apiError = err as { message?: string };
      setError(apiError.message || 'Failed to reset password.');
    } finally {
      setIsLoading(false);
    }
  };

  if (isVerifying) {
    return <PageLoader />;
  }

  if (!isValid) {
    return (
      <div className="max-w-sm mx-auto mt-12">
        <div className="card p-4 text-center">
          <div
            className="w-10 h-10 rounded-md flex items-center justify-center mx-auto mb-3"
            style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)' }}
          >
            <XCircle className="w-5 h-5 text-red-500" />
          </div>
          <h1 className="text-lg font-semibold mb-1">Invalid Reset Link</h1>
          <p className="text-xs mb-4" style={{ color: 'var(--color-text-secondary)' }}>
            This link is invalid or has expired.
          </p>
          <Link to="/forgot-password" className="btn btn-primary text-xs">
            Request New Link
          </Link>
        </div>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="max-w-sm mx-auto mt-12">
        <div className="card p-4 text-center">
          <div
            className="w-10 h-10 rounded-md flex items-center justify-center mx-auto mb-3"
            style={{ backgroundColor: 'rgba(34, 197, 94, 0.1)' }}
          >
            <CheckCircle className="w-5 h-5 text-green-500" />
          </div>
          <h1 className="text-lg font-semibold mb-1">Password Reset</h1>
          <p className="text-xs mb-4" style={{ color: 'var(--color-text-secondary)' }}>
            Your password has been successfully reset.
          </p>
          <button onClick={() => navigate('/login')} className="btn btn-primary text-xs">
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-sm mx-auto mt-12">
      <div className="card p-4">
        <h1 className="text-lg font-semibold mb-1">Reset Password</h1>
        <p className="text-xs mb-4" style={{ color: 'var(--color-text-secondary)' }}>
          {maskedEmail ? `New password for ${maskedEmail}` : 'Enter your new password below.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          {error && (
            <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-md text-red-400 text-xs">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="password" className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
              New Password
            </label>
            <div className="relative">
              <Lock className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full pl-8"
                placeholder="At least 8 characters"
                required
                minLength={8}
              />
            </div>
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
              Confirm Password
            </label>
            <div className="relative">
              <Lock className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input w-full pl-8"
                placeholder="Confirm password"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary w-full text-xs"
          >
            {isLoading ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
