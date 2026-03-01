import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { PageLoader } from './LoadingSpinner';

export function ProtectedRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isReady = useAuthStore((s) => s.isReady);

  if (!isReady) {
    return <PageLoader />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
