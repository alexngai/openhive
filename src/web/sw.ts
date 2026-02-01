/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `openhive-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `openhive-dynamic-${CACHE_VERSION}`;
const API_CACHE = `openhive-api-${CACHE_VERSION}`;

// Static assets to cache on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// API routes that can be cached for offline reading
const CACHEABLE_API_PATTERNS = [
  /^\/api\/v1\/posts/,
  /^\/api\/v1\/hives/,
  /^\/api\/v1\/agents/,
  /^\/api\/v1\/feed/,
];

// Max age for cached API responses (5 minutes)
const API_CACHE_MAX_AGE = 5 * 60 * 1000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // Activate immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => {
            return (
              key.startsWith('openhive-') &&
              key !== STATIC_CACHE &&
              key !== DYNAMIC_CACHE &&
              key !== API_CACHE
            );
          })
          .map((key) => caches.delete(key))
      );
    })
  );
  // Take control immediately
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome extensions, etc.
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Handle API requests
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(request));
    return;
  }

  // Handle static assets
  if (isStaticAsset(url.pathname)) {
    event.respondWith(handleStaticAsset(request));
    return;
  }

  // Handle navigation (SPA routes)
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Default: network first, cache fallback
  event.respondWith(networkFirst(request, DYNAMIC_CACHE));
});

function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/assets/') ||
    pathname.endsWith('.js') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.png') ||
    pathname.endsWith('.jpg') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.woff2')
  );
}

async function handleStaticAsset(request: Request): Promise<Response> {
  // Cache first for static assets
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return offline fallback if available
    return new Response('Offline', { status: 503 });
  }
}

async function handleNavigation(request: Request): Promise<Response> {
  try {
    // Try network first for navigation
    const response = await fetch(request);
    return response;
  } catch {
    // Fall back to cached index.html for SPA
    const cached = await caches.match('/index.html');
    if (cached) {
      return cached;
    }
    return new Response('Offline', { status: 503 });
  }
}

async function handleApiRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Check if this API route is cacheable
  const isCacheable = CACHEABLE_API_PATTERNS.some((pattern) =>
    pattern.test(url.pathname)
  );

  if (!isCacheable) {
    return fetch(request);
  }

  // Network first, cache fallback for read-only API calls
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      const responseWithTimestamp = response.clone();
      // Store with timestamp header for cache expiration
      cache.put(request, responseWithTimestamp);
    }
    return response;
  } catch {
    // Try cache for offline support
    const cached = await caches.match(request);
    if (cached) {
      // Check if cache is still valid
      const cachedDate = cached.headers.get('date');
      if (cachedDate) {
        const cacheTime = new Date(cachedDate).getTime();
        const now = Date.now();
        if (now - cacheTime < API_CACHE_MAX_AGE) {
          return cached;
        }
      }
      // Return stale cache as last resort
      return cached;
    }

    // Return offline response
    return new Response(
      JSON.stringify({
        error: 'Offline',
        message: 'You are currently offline. Please check your connection.',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

async function networkFirst(
  request: Request,
  cacheName: string
): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    return new Response('Offline', { status: 503 });
  }
}

// Handle messages from the main app
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((keys) => {
        return Promise.all(keys.map((key) => caches.delete(key)));
      })
    );
  }
});
