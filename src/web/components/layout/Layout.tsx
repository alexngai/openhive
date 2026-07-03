import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { ToastContainer } from '../common/Toast';
import { UpdateBanner } from '../common/UpdateBanner';
import { ChatFab, ChatSidebar } from '../chat-fab/ChatFab';
import { useGlobalAttention } from '../../hooks/useGlobalAttention';

// Routes that need full-width layout (no max-width constraint)
const FULL_WIDTH_ROUTES = ['/terminal', '/tasks', '/threads', '/changes'];
const FULL_WIDTH_EXACT = ['/'];
// Spec detail (`/specs/:resourceId/:specId`) needs full width for the
// TOC + content + dispatch sidebar layout; spec list and spec create do not.
const FULL_WIDTH_PATTERNS = [/^\/specs\/[^/]+\/[^/]+/];

// Visual editors (team/loadout/etc.) want the full main-area viewport —
// they manage their own height/width internally and break when wrapped
// in the standard `max-w-4xl mx-auto px-4 py-4` reading column.
function isEditorRoute(pathname: string): boolean {
  return /\/editor\/?$/.test(pathname);
}

export function Layout() {
  const location = useLocation();
  // App-wide attention tracking (idle + permission events → attention store).
  useGlobalAttention();
  const isFullWidth = FULL_WIDTH_ROUTES.some(r => location.pathname.startsWith(r))
    || FULL_WIDTH_EXACT.includes(location.pathname)
    || isEditorRoute(location.pathname)
    || FULL_WIDTH_PATTERNS.some(p => p.test(location.pathname));

  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ backgroundColor: 'var(--color-bg)' }}>
        <UpdateBanner />
        <div className="flex-1 overflow-y-auto min-w-0">
          {isFullWidth ? (
            <div className="h-full">
              <Outlet />
            </div>
          ) : (
            <div className="max-w-4xl mx-auto px-4 py-4">
              <Outlet />
            </div>
          )}
        </div>
      </main>
      <ChatSidebar />
      <ToastContainer />
      <ChatFab />
    </div>
  );
}
