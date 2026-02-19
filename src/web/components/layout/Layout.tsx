import { Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ToastContainer } from '../common/Toast';

// Routes that need full-width layout (no max-width constraint)
const FULL_WIDTH_ROUTES = ['/swarmcraft'];

export function Layout() {
  const location = useLocation();
  const isFullWidth = FULL_WIDTH_ROUTES.some(r => location.pathname.startsWith(r));

  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto" style={{ backgroundColor: 'var(--color-bg)' }}>
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
      </div>
      <ToastContainer />
    </div>
  );
}
