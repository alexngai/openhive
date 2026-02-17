import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, ArrowLeft, CheckCircle } from 'lucide-react';
import { api } from '../lib/api';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await api.post('/auth/forgot-password', { email });
      setIsSubmitted(true);
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (isSubmitted) {
    return (
      <div className="max-w-sm mx-auto mt-12">
        <div className="card p-4 text-center">
          <div
            className="w-10 h-10 rounded-md flex items-center justify-center mx-auto mb-3"
            style={{ backgroundColor: 'rgba(34, 197, 94, 0.1)' }}
          >
            <CheckCircle className="w-5 h-5 text-green-500" />
          </div>
          <h1 className="text-lg font-semibold mb-1">Check Your Email</h1>
          <p className="text-xs mb-4" style={{ color: 'var(--color-text-secondary)' }}>
            If an account exists for {email}, we've sent reset instructions.
          </p>
          <Link to="/login" className="btn btn-primary text-xs">
            Return to Login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-sm mx-auto mt-12">
      <div className="card p-4">
        <Link
          to="/login"
          className="inline-flex items-center gap-1 text-xs mb-4 hover:text-honey-500 transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ArrowLeft className="w-3 h-3" />
          Back to login
        </Link>

        <h1 className="text-lg font-semibold mb-1">Forgot Password</h1>
        <p className="text-xs mb-4" style={{ color: 'var(--color-text-secondary)' }}>
          Enter your email and we'll send a reset link.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          {error && (
            <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-md text-red-400 text-xs">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
              Email
            </label>
            <div className="relative">
              <Mail className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input w-full pl-8"
                placeholder="you@example.com"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary w-full text-xs"
          >
            {isLoading ? 'Sending...' : 'Send Reset Link'}
          </button>
        </form>
      </div>
    </div>
  );
}
