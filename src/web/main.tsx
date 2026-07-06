import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles/globals.css';
// Global chat-bubble markdown styling (ships with swarmcraft's embed bundle).
// Must be imported at app root so it applies on every page that renders chat,
// not just surfaces that already bring it in via Dashboard.
import 'swarmcraft/ui/embed.css';
import { registerServiceWorker } from './utils/serviceWorker';
import { subscribeHub, getHubSnapshot } from './lib/hub';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1 minute
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// When the client is pointed at a different hub, the React Query cache still
// holds the previous hub's data — clear it on an origin change so nothing bleeds
// across a hub switch. Token-only changes (same hub, re-auth) keep the cache.
let lastHubOrigin = getHubSnapshot().origin;
subscribeHub(() => {
  const { origin } = getHubSnapshot();
  if (origin !== lastHubOrigin) {
    lastHubOrigin = origin;
    queryClient.clear();
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);

// Register service worker for offline support (production only)
if (import.meta.env.PROD) {
  registerServiceWorker();
}
