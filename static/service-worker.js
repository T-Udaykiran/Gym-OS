const CACHE_NAME = 'gymos-cache-v24';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/shared/styles.css',
  '/shared/member-avatar.js',
  '/member/index.html',
  '/member/style.css',
  '/member/app.js',
  '/admin/index.html',
  '/admin/style.css',
  '/admin/app.js',
  '/vendor/jsQR.js',
  '/vendor/qrcode.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install Service Worker and cache resources
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] Caching app shell assets');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate Service Worker and clear old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event listener
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Avoid caching backend API calls or SSE streams
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(err => {
        console.warn('[Service Worker] API Fetch failed (offline):', err);
        
        // Return custom offline JSON response if it's an API post/get
        if (event.request.headers.get('accept')?.includes('application/json') || 
            event.request.method === 'POST') {
          return new Response(
            JSON.stringify({ 
              success: false, 
              error: 'Offline: Internet connection is currently unavailable. Please reconnect and try again.' 
            }), 
            { 
              status: 503, 
              headers: { 'Content-Type': 'application/json' } 
            }
          );
        }
        throw err;
      })
    );
    return;
  }

  // Cache-first, fallback-to-network strategy for static assets
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          // Serve from cache and update in background if online
          if (navigator.onLine) {
            fetch(event.request).then(networkResponse => {
              if (networkResponse && networkResponse.status === 200) {
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, networkResponse));
              }
            }).catch(() => {});
          }
          return cachedResponse;
        }

        return fetch(event.request).then(response => {
          // Cache new static resources dynamically
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });

          return response;
        });
      }).catch(() => {
        // Fallback for HTML pages if offline and not cached
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('/index.html');
        }
      })
  );
});
