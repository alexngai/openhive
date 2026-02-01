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
      setError(apiError.message || 'Failed to reset password. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (isVerifying) {
    return <PageLoader />;
  }

  if (!isValid) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="card p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-4">
            <XCircle className="w-8 h-8 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Invalid Reset Link</h1>
          <p style={{ color: 'var(--color-text-secondary)' }} className="mb-6">
            This password reset link is invalid or has expired.
          </p>
          <Link to="/forgot-password" className="btn btn-primary inline-block">
            Request New Reset Link
          </Link>
        </div>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="card p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-green-500" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Password Reset!</h1>
          <p style={{ color: 'var(--color-text-secondary)' }} className="mb-6">
            Your password has been successfully reset.
          </p>
          <button
            onClick={() => navigate('/login')}
            className="btn btn-primary"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="card p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold mb-2">Reset Password</h1>
        <p style={{ color: 'var(--color-text-secondary)' }} className="mb-6">
          {maskedEmail ? `Enter a new password for ${maskedEmail}` : 'Enter your new password below.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1">
              New Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5" style={{ color: 'var(--color-text-secondary)' }} />
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full pl-10"
                placeholder="At least 8 characters"
                required
                minLength={8}
              />
            </div>
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium mb-1">
              Confirm Password
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5" style={{ color: 'var(--color-text-secondary)' }} />
              <input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input w-full pl-10"
                placeholder="Confirm your password"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary w-full"
          >
            {isLoading ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
