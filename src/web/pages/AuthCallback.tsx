import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { Logo } from '../components/common/Logo';

export function AuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const exchangeOAuthCode = useAuthStore((s) => s.exchangeOAuthCode);
  const error = useAuthStore((s) => s.error);
  const [exchanging, setExchanging] = useState(true);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const errorParam = searchParams.get('error');

    if (errorParam) {
      setExchanging(false);
      return;
    }

    if (!code) {
      setExchanging(false);
      return;
    }

    // Validate CSRF state
    const savedState = sessionStorage.getItem('oauth_state');
    if (savedState && state !== savedState) {
      setExchanging(false);
      return;
    }
    sessionStorage.removeItem('oauth_state');

    exchangeOAuthCode(code)
      .then(() => {
        navigate('/', { replace: true });
      })
      .catch(() => {
        setExchanging(false);
      });
  }, [searchParams, exchangeOAuthCode, navigate]);

  if (exchanging && !error) {
    return (
      <div className="max-w-sm mx-auto mt-12 text-center">
        <Logo className="h-8 w-8 text-honey-500 mx-auto" />
        <div className="mt-4">
          <LoadingSpinner size="lg" />
        </div>
        <p className="text-xs mt-3" style={{ color: 'var(--color-text-secondary)' }}>
          Completing authentication...
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-sm mx-auto mt-12 text-center">
      <Logo className="h-8 w-8 text-honey-500 mx-auto" />
      <h1 className="text-lg font-semibold mt-4">Authentication Failed</h1>
      <p className="text-xs mt-2" style={{ color: 'var(--color-text-secondary)' }}>
        {error || searchParams.get('error_description') || 'Unable to complete authentication.'}
      </p>
      <button
        onClick={() => navigate('/login', { replace: true })}
        className="btn btn-primary mt-4 text-xs"
      >
        Return to Login
      </button>
    </div>
  );
}
