// TravelSync service worker — makes the home-screen app open fast.
// - Google Apps Script calls and every POST pass straight through: trip data is always live.
// - The page: network first; if the network has not answered in PAGE_TIMEOUT_MS (or is down), the copy
//   from the last visit is shown, so a new version reaches people on the next open with normal signal.
// - Files (app.js, CSS, fonts, icons, CDN libraries): the stored copy at once, refreshed in the background.
// Bump CACHE together with app.js?v= in index.html; activate deletes the older caches.
const CACHE = 'travelsync-v4';
const SHELL = ['./', './index.html', './app.js?v=4', './tailwind.css', './manifest.json'];
const ASSET_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'img.icons8.com'];
const PAGE_TIMEOUT_MS = 3000;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // one file failing (bad signal) must not stop the install; it is stored on first use instead
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === new URL(self.location.href).origin;
  if (req.mode === 'navigate' && sameOrigin) return e.respondWith(pageFirstFromNetwork(e));
  if (sameOrigin || ASSET_HOSTS.includes(url.hostname)) return e.respondWith(storedThenRefresh(e));
  // anything else (script.google.com …) is left to the browser
});

// Only good answers are stored; CDN files loaded by <link> come back "opaque" (status unreadable) — kept too.
function storable(res) {
  return res && (res.ok || res.type === 'opaque');
}

function store(req, res) {
  return caches.open(CACHE).then((c) => c.put(req, res));
}

function pageFirstFromNetwork(e) {
  const req = e.request;
  const fromNet = fetch(req).then((res) => {
    if (storable(res)) e.waitUntil(store(req, res.clone()));
    return res;
  });
  const fromCache = () => caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true })
    .then((hit) => hit || c.match('./index.html')));
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(resolve, PAGE_TIMEOUT_MS); })
    .then(fromCache)
    .then((hit) => hit || fromNet);                       // nothing stored yet: keep waiting for the network
  return Promise.race([fromNet, slow])
    .catch(() => fromCache().then((hit) => hit || fromNet))   // offline: stored copy at once
    .finally(() => clearTimeout(timer));
}

function storedThenRefresh(e) {
  const req = e.request;
  return caches.open(CACHE).then((c) => c.match(req).then((hit) => {
    const refresh = fetch(req).then((res) => {
      if (storable(res)) return c.put(req, res.clone()).then(() => res);
      return res;
    });
    if (hit) {
      e.waitUntil(refresh.catch(() => {}));
      return hit;
    }
    return refresh;
  }));
}
