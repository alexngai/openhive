// Service Worker Registration
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] Service workers are not supported');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    });

    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (newWorker) {
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New service worker installed, show update notification
            console.log('[SW] New version available');
            dispatchUpdateEvent();
          }
        });
      }
    });

    console.log('[SW] Service worker registered');
    return registration;
  } catch (error) {
    console.error('[SW] Service worker registration failed:', error);
    return null;
  }
}

export function unregisterServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) {
    return Promise.resolve(false);
  }

  return navigator.serviceWorker.ready.then((registration) => {
    return registration.unregister();
  });
}

// Tell the waiting service worker to take over
export function skipWaiting(): void {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' });
  }
}

// Clear all caches
export function clearCache(): void {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
  }
}

// Dispatch custom event when update is available
function dispatchUpdateEvent(): void {
  window.dispatchEvent(new CustomEvent('sw-update-available'));
}

// Check if the app is running as a PWA
export function isPWA(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

// Check if the user is online
export function isOnline(): boolean {
  return navigator.onLine;
}

// Listen for online/offline events
export function onOnlineStatusChange(callback: (online: boolean) => void): () => void {
  const handleOnline = () => callback(true);
  const handleOffline = () => callback(false);

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
