import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { ToastContainer } from '../common/Toast';

// Routes that need full-width layout (no max-width constraint)
const FULL_WIDTH_ROUTES = ['/swarmcraft', '/terminal'];

export function Layout() {
  const location = useLocation();
  const isFullWidth = FULL_WIDTH_ROUTES.some(r => location.pathname.startsWith(r));

  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto min-w-0" style={{ backgroundColor: 'var(--color-bg)' }}>
        {isFullWidth ? (
          <div className="h-full">
            <Outlet />
          </div>
        ) : (
          <div className="max-w-4xl mx-auto px-4 py-4">
            <Outlet />
          </div>
        )}
      </main>
      <ToastContainer />
    </div>
  );
}
