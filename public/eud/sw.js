// Service worker: app, libraries and map tiles stay on the device
// so the EUD starts and shows the map without internet.

const SHELL_CACHE = 'eud-shell-__TAKWEB_VERSION__'; // filled in by the server: every update renews the offline copy
const TILE_CACHE = 'eud-tiles';
const MAX_TILES = 40000; // saved areas + recently viewed tiles
const VERSION = '__TAKWEB_VERSION__';
// own files are loaded as file?v=<version> (index.html): page and files always belong to the same version
const OWN = ['eud.css', 'eud.js', 'view3d.js', 'video.js', 'data.js', 'meshproto.js', 'blenative.js', 'mesh.js', 'tools.js', 'voice.js'].map(f => `${f}?v=${VERSION}`);
const SHELL = [
  './', 'index.html', ...OWN, 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'tak-badge.png',
  'vendor/leaflet.js', 'vendor/leaflet-rotate.js', 'vendor/leaflet.css', 'vendor/milsymbol.js', 'vendor/jsQR.js', 'vendor/hls.min.js',
  'vendor/maplibre-gl.mjs', 'vendor/maplibre-gl-worker.mjs', 'vendor/maplibre-gl.css',
  'vendor/images/layers.png', 'vendor/images/layers-2x.png',
  'vendor/images/marker-icon.png', 'vendor/images/marker-icon-2x.png', 'vendor/images/marker-shadow.png',
];
// Tiles: own server (/eud/tiles/…) and custom sources (image requests with z/x/y in the path)
const isTile = (url, req) => url.pathname.includes('/eud/tiles/') && !url.pathname.endsWith('.json')
  || (url.origin !== location.origin && req.destination === 'image' && /\/\d{1,2}\/\d+\/\d+/.test(url.pathname + url.search));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

let tileWrites = 0;
async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      await cache.put(req, res.clone());
      if (++tileWrites % 200 === 0) trimTiles();
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504 });
  }
}

// Network first (for updates), from the cache after 4 s on failure
async function networkFirst(req, fallbackKey) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put(fallbackKey || req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(fallbackKey || req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (isTile(url, req)) return e.respondWith(tile(req));
  if (url.origin !== location.origin) return;
  const base = new URL('./', self.registration.scope).pathname; // e.g. /eud/
  if (req.mode === 'navigate' && url.pathname.startsWith(base)) return e.respondWith(networkFirst(req, new URL('index.html', self.registration.scope).href));
  if (url.pathname === '/api/eud/config') return e.respondWith(networkFirst(req));
  if (url.pathname.startsWith(base)) {
    // Libraries do not change: from the cache; own files: network first
    if (url.pathname.startsWith(base + 'vendor/')) {
      return e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
    }
    // a file of exactly this version does not change: from the cache (fast, offline, never mixed with an older version)
    if (url.searchParams.get('v') === VERSION) {
      return e.respondWith(caches.open(SHELL_CACHE).then(c => c.match(req)).then(hit => hit || networkFirst(req)));
    }
    return e.respondWith(networkFirst(req));
  }
});

// Preload the map: the page sends a list of tile addresses; STOP cancels, delete removes
let stopFlag = false;
self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'prefetch-stop') { stopFlag = true; return; }
  if (e.data.type === 'delete') {
    e.waitUntil(caches.open(TILE_CACHE).then(c => Promise.all((e.data.urls || []).map(u => c.delete(u)))));
    return;
  }
  if (e.data.type !== 'prefetch') return;
  stopFlag = false;
  const urls = e.data.urls || [];
  const port = e.ports[0];
  e.waitUntil((async () => {
    const cache = await caches.open(TILE_CACHE);
    let done = 0, failed = 0;
    const queue = urls.slice();
    const worker = async () => {
      while (queue.length && !stopFlag) {
        const u = queue.shift();
        try {
          if (!(await cache.match(u))) {
            const same = new URL(u).origin === location.origin;
            const res = await fetch(u, same ? {} : { mode: 'no-cors' });
            if (same && !res.ok) throw new Error(String(res.status));
            await cache.put(u, res);
          }
        } catch (err) { failed++; }
        done++;
        if (port && done % 20 === 0) port.postMessage({ done, failed, total: urls.length });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    await trimTiles();
    if (port) port.postMessage({ done, failed, total: urls.length, finished: true, stopped: stopFlag });
  })());
});
