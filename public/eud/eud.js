// TAK EUD in the browser: map + situational picture from one or more TAK servers (CoT), own position,
// markers, chat. Our own server only relays (WebSocket /ws/tak); certificates stay on this device.
'use strict';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full / private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xmlEsc = esc;
const cotTime = d => d.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');
const launchHash = location.hash; // invitation (#host=…&username=…): also handed to the Android app ("open in the app")
const rnd = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');

const TEAMS = {
  White: '#FFFFFF', Yellow: '#FFFF00', Orange: '#FF7700', Magenta: '#FF00FF', Red: '#FF0000', Maroon: '#7F0000',
  Purple: '#7F007F', 'Dark Blue': '#00007F', Blue: '#0000FF', Cyan: '#00FFFF', Teal: '#007F7F', Green: '#00FF00',
  'Dark Green': '#007F00', Brown: '#A0714F',
};
const ROLES = ['Team Member', 'Team Lead', 'HQ', 'Sniper', 'Medic', 'Forward Observer', 'RTO', 'K9'];
const DEFAULT_PORT = { ssl: 8089, tcp: 8087, udp: 8087 };

// ======================================================================
// Profile and server list (only on this device)
// ======================================================================

const profile = Object.assign({
  callsign: '', team: 'Cyan', role: 'Team Member', uid: '', tiles: 'OSM', wake: false,
}, store.get('eud.profile', {}));
if (!profile.uid) profile.uid = 'EUD-' + rnd(6).toUpperCase();

let servers = store.get('eud.servers', null);
if (!servers) {
  // older version: one server in the profile
  servers = [];
  if (profile.host) {
    servers.push({
      id: rnd(4), name: profile.host, host: profile.host, port: profile.port, proto: profile.proto, enrollPort: profile.enrollPort,
      username: profile.username, certPem: profile.certPem, keyPem: profile.keyPem, caPems: profile.caPems || [],
      fingerprint: profile.fingerprint, certInfo: profile.certInfo, auto: !!profile.auto,
    });
  }
  for (const k of ['host', 'port', 'proto', 'enrollPort', 'username', 'certPem', 'keyPem', 'caPems', 'fingerprint', 'certInfo', 'auto']) delete profile[k];
}
const saveProfile = () => store.set('eud.profile', profile);
const saveServers = () => store.set('eud.servers', servers);
saveProfile();
saveServers();

function newServer(fields) {
  return Object.assign({
    id: rnd(4), name: '', host: '', port: 8089, proto: 'ssl', enrollPort: 8446, apiPort: 8443, username: '',
    certPem: '', keyPem: '', caPems: [], fingerprint: '', certInfo: null, auto: false,
  }, fields || {});
}

// ======================================================================
// Map
// ======================================================================

const view = store.get('eud.view', [51.1, 10.4, 6]);
// rotatable map (leaflet-rotate): the compass switches between north up and heading up
const map = L.map('map', {
  zoomControl: false, attributionControl: true, worldCopyJump: true,
  // rotate with two fingers (like ATAK), on a PC with Shift + mouse wheel
  rotate: true, bearing: 0, touchRotate: true, shiftKeyRotate: true, rotateControl: false, compassBearing: false,
}).setView([view[0], view[1]], view[2]);
map.attributionControl.setPosition('bottomleft');
// map sources: through our own server (same origin, cached there) or a custom URL
const SOURCES = {
  osm: { name: 'OpenStreetMap', maxZoom: 19, attribution: '© OpenStreetMap' },
  topo: { name: 'OpenTopoMap', maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' },
  sat: { name: 'Esri Satellite', maxZoom: 19, attribution: '© Esri' },
  esritopo: { name: 'Esri Topo', maxZoom: 19, attribution: '© Esri' },
};
// map sources from the TAK server's device profile (ATAK customMapSource): straight from their tile server
for (const m of store.get('eud.takMaps', [])) SOURCES[m.id] = { name: m.name + ' (TAK server)', maxZoom: m.maxZoom || 19, attribution: '', url: m.url };
const TILE_BASE = new URL('tiles/', location.href).pathname; // /eud/tiles/
// TAKweb loaded from a Meshtastic radio's flash (lib/meshsite.js): no TAKweb server – mesh only, map tiles straight from
// the internet if the phone has any (kept on the phone for later), below them the offline world map from the radio
const MESH_ONLY = !!window.TAKWEB_MESH;
const PUBLIC_TILES = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', topo: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
  sat: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  esritopo: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
};
if (MESH_ONLY) document.body.classList.add('mesh-only');
// on the radio: a link to the TAKweb server that tells it about this radio – TAKweb online then talks to the mesh
// through this radio over WLAN (Meshtastic → "Radio over WLAN"), login/QR/video come from the server
function radioLink(u) {
  const x = new URL(u, location.href);
  const h = new URLSearchParams(x.hash.slice(1));
  h.set('radio', location.origin);
  x.hash = h.toString();
  return x.href;
}
// on the radio: its small web server can drop a file now and then – then a part of TAKweb is missing: offer a reload
if (MESH_ONLY) {
  window.addEventListener('load', () => setTimeout(() => {
    const missing = [!window.meshProto && 'meshproto.js', !window.eudMeshReady && 'mesh.js', !window.L && 'leaflet.js'].filter(Boolean);
    if (missing.length && confirm(`Part of TAKweb did not load from the radio (${missing.join(', ')}). Load the page again?`)) location.reload();
  }, 1500));
}
if (!SOURCES[profile.tiles] && profile.tiles !== 'custom') profile.tiles = 'osm';

function sourceTemplate(id) {
  if (id === 'custom') return profile.customUrl || '';
  if (SOURCES[id] && SOURCES[id].url) return SOURCES[id].url;
  if (MESH_ONLY && PUBLIC_TILES[id]) return PUBLIC_TILES[id];
  return TILE_BASE + id + '/{z}/{x}/{y}.png';
}
function sourceMaxZoom(id) { return id === 'custom' ? 20 : SOURCES[id].maxZoom; }

// ---------------- Offline tiles without a service worker ----------------
// Browsers without service workers (Bluefy and other iPhone apps on WKWebView) keep saved areas in IndexedDB
// themselves; the map then takes a tile from there first. With a service worker it does all that (sw.js).
// On the radio (no service worker over its self-signed certificate) the page does it too.
const pageTiles = MESH_ONLY || !('serviceWorker' in navigator);
const tileDb = (() => {
  let db = null;
  const open = () => db || (db = new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('no IndexedDB'));
    const r = indexedDB.open('eud-tiles', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('t');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const run = (mode, fn) => open().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction('t', mode);
    const req = fn(tx.objectStore('t'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  }));
  return {
    get: url => run('readonly', st => st.get(url)).catch(() => null),
    has: url => run('readonly', st => st.count(url)).then(n => n > 0).catch(() => false),
    put: (url, rec) => run('readwrite', st => st.put(rec, url)), // { type, data: ArrayBuffer } – Blobs are unreliable in older iOS
    del: urls => run('readwrite', st => { for (const u of urls) st.delete(u); }).catch(() => {}),
  };
})();
const OfflineTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    if (!pageTiles) return L.TileLayer.prototype.createTile.call(this, coords, done);
    const tile = document.createElement('img');
    L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
    L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));
    tile.alt = '';
    tile.setAttribute('role', 'presentation');
    const url = this.getTileUrl(coords);
    const key = new URL(url, location.href).href;
    const show = rec => {
      const obj = URL.createObjectURL(new Blob([rec.data], { type: rec.type || 'image/png' }));
      tile.addEventListener('load', () => URL.revokeObjectURL(obj), { once: true });
      tile.src = obj;
    };
    tileDb.get(key).then(rec => {
      if (!rec && MESH_ONLY) {
        // on the radio: what the phone sees with internet stays on the phone – the same area works offline later
        fetch(key, { mode: 'cors' }).then(async res => {
          if (!res.ok) throw new Error(String(res.status));
          const r = { type: res.headers.get('content-type') || 'image/png', data: await res.arrayBuffer() };
          tileDb.put(key, r).catch(() => {});
          show(r);
        }).catch(() => tile.dispatchEvent(new Event('error'))); // no internet: empty tile, the world map below shows
        return;
      }
      if (!rec) { tile.src = url; return; }
      show(rec);
    });
    return tile;
  },
});
// save without a service worker: in the page (keeps running only while TAKweb is open)
let pageStop = false;
async function pagePrefetch(urls, report) {
  pageStop = false;
  let done = 0, failed = 0;
  const queue = urls.slice();
  const worker = async () => {
    while (queue.length && !pageStop) {
      const u = queue.shift();
      try {
        if (!(await tileDb.has(u))) {
          const res = await fetch(u, { mode: new URL(u).origin === location.origin ? 'same-origin' : 'cors' });
          if (!res.ok) throw new Error(String(res.status));
          await tileDb.put(u, { type: res.headers.get('content-type') || 'image/png', data: await res.arrayBuffer() });
        }
      } catch (e) { failed++; }
      done++;
      if (done % 20 === 0) report({ done, failed, total: urls.length });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  report({ done, failed, total: urls.length, finished: true, stopped: pageStop });
}

let baseLayer = null;
function setTiles(id) {
  if (id === 'custom' && !profile.customUrl) return;
  if (baseLayer) baseLayer.remove();
  baseLayer = new OfflineTileLayer(sourceTemplate(id), {
    maxZoom: sourceMaxZoom(id), maxNativeZoom: sourceMaxZoom(id),
    attribution: id === 'custom' ? '' : SOURCES[id].attribution, keepBuffer: 4,
  });
  // tile not loaded (e.g. briefly no network): reload once instead of a half-empty map
  baseLayer.on('tileerror', e => {
    const img = e.tile;
    if (MESH_ONLY || img.dataset.retry) return; // on the radio: usually no internet – no retries
    img.dataset.retry = '1';
    setTimeout(() => { img.src = img.src.replace(/([?&])r=\d+|$/, m => (m ? m[0] : (img.src.includes('?') ? '&' : '?')) + 'r=' + Date.now()); }, 1500);
  });
  baseLayer.addTo(map);
  profile.tiles = id;
  saveProfile();
  if (window.view3d) view3d.baseChanged();
}
setTiles(profile.tiles);
// offline world map from the radio's flash (worldmap.json: Natural Earth, public domain – countries, coasts, cities):
// the base map below the tiles – without internet it is what you see, details come from the tiles when there is internet
if (MESH_ONLY) {
  const World = L.GridLayer.extend({
    initialize(opts) {
      L.GridLayer.prototype.initialize.call(this, opts);
      this.data = null;
      fetch('worldmap.json').then(r => r.json()).then(d => {
        const S = d.scale || 10000;
        // features: [bbox, [parts: x0,y0, dx,dy …]] -> [bbox in degrees, [Float64Array lon/lat …]]
        const dec = list => list.map(([bb, parts]) => [bb.map(v => v / S), parts.map(p => {
          const a = new Float64Array(p.length);
          let x = 0, y = 0;
          for (let i = 0; i < p.length; i += 2) { x += p[i]; y += p[i + 1]; a[i] = x / S; a[i + 1] = y / S; }
          return a;
        })]);
        this.data = { land0: dec(d.land0), land1: dec(d.land1), cities: d.cities || [], labels: d.labels || [] };
        this.redraw();
      }).catch(() => {});
    },
    createTile(coords) {
      const t = document.createElement('canvas');
      const size = this.getTileSize();
      t.width = size.x; t.height = size.y;
      const ctx = t.getContext('2d');
      ctx.fillStyle = '#a9c7d6';
      ctx.fillRect(0, 0, size.x, size.y);
      if (!this.data) return t;
      const z = coords.z, n = 256 * Math.pow(2, z), ox = coords.x * size.x, oy = coords.y * size.y;
      const X = lon => (lon + 180) / 360 * n - ox;
      const Y = lat => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - oy; };
      const nw = map.unproject(coords.scaleBy(size), z), se = map.unproject(coords.scaleBy(size).add(size), z);
      const pad = (se.lng - nw.lng) * 0.05;
      const inView = bb => !(bb[2] < nw.lng - pad || bb[0] > se.lng + pad || bb[3] < se.lat - pad || bb[1] > nw.lat + pad);
      ctx.fillStyle = '#ece8df'; ctx.strokeStyle = '#8f8a80'; ctx.lineWidth = 0.8;
      for (const [bb, parts] of (z <= 3 || !this.data.land1.length ? this.data.land0 : this.data.land1)) {
        if (!inView(bb)) continue;
        ctx.beginPath();
        for (const a of parts) {
          ctx.moveTo(X(a[0]), Y(a[1]));
          for (let i = 2; i < a.length; i += 2) ctx.lineTo(X(a[i]), Y(a[i + 1]));
          ctx.closePath();
        }
        ctx.fill('evenodd'); ctx.stroke();
      }
      ctx.textAlign = 'center';
      if (z <= 6) {
        ctx.font = 'bold 11px sans-serif'; ctx.fillStyle = '#6d6455';
        for (const [name, lon, lat, minz] of this.data.labels) if (z >= minz - 0.5) ctx.fillText(name, X(lon), Y(lat));
      }
      ctx.font = '11px sans-serif';
      for (const [name, lon, lat, minz] of this.data.cities) {
        if (z < minz || lon < nw.lng - pad || lon > se.lng + pad || lat < se.lat - pad || lat > nw.lat + pad) continue;
        const x = X(lon), y = Y(lat);
        ctx.fillStyle = '#333'; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(name, x, y - 5);
        ctx.fillStyle = '#222'; ctx.fillText(name, x, y - 5);
      }
      return t;
    },
  });
  new World({ zIndex: 0, maxZoom: 22, maxNativeZoom: 12, attribution: 'Natural Earth' }).addTo(map);
}
// coordinate grid: on the radio – lines every 0.001° … 10° depending on the zoom, with labels
if (MESH_ONLY) {
  const Grid = L.GridLayer.extend({
    createTile(coords) {
      const t = document.createElement('canvas');
      const size = this.getTileSize();
      t.width = size.x; t.height = size.y;
      const ctx = t.getContext('2d');
      const nw = map.unproject(coords.scaleBy(size), coords.z), se = map.unproject(coords.scaleBy(size).add(size), coords.z);
      const span = (se.lng - nw.lng) * 2;
      const step = [10, 5, 1, 0.5, 0.1, 0.05, 0.01, 0.005, 0.001].find(s => s <= span) || 0.001;
      ctx.strokeStyle = 'rgba(120,200,255,0.35)'; ctx.fillStyle = 'rgba(160,220,255,0.8)'; ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
      const px = ll => map.project(ll, coords.z).subtract(coords.scaleBy(size));
      for (let lng = Math.ceil(nw.lng / step) * step; lng <= se.lng; lng += step) {
        const x = Math.round(px(L.latLng(nw.lat, lng)).x) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size.y); ctx.stroke(); ctx.fillText(lng.toFixed(3), x + 2, size.y - 3);
      }
      for (let lat = Math.ceil(se.lat / step) * step; lat <= nw.lat; lat += step) {
        const y = Math.round(px(L.latLng(lat, nw.lng)).y) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.x, y); ctx.stroke(); ctx.fillText(lat.toFixed(3), 2, y - 2);
      }
      return t;
    },
  });
  new Grid({ zIndex: 2, pane: 'overlayPane' }).addTo(map);
}
map.on('moveend', () => { const c = map.getCenter(); store.set('eud.view', [c.lat, c.lng, map.getZoom()]); });
const shapesLayer = L.layerGroup().addTo(map);
const pointsLayer = L.layerGroup().addTo(map);

// ======================================================================
// Helpers
// ======================================================================

let toastTimer;
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function setMsg(el, text, ok) {
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function distance(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
// point at distance m (metres) and bearing brg (degrees) from lat/lon
function destPoint(lat, lon, m, brg) {
  const r = Math.PI / 180, d = m / 6371000, b = brg * r, la = lat * r;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lon * r + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 / r, lon: ((lo2 / r + 540) % 360) - 180 };
}
const fmtDist = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return Math.max(s, 0) + ' s ago';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(ts).toLocaleString();
}
const hhmm = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// ARGB number from ATAK (-1 = white) -> CSS color
function argb(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v) >>> 0;
  const a = ((n >>> 24) & 255) / 255;
  return `rgba(${(n >>> 16) & 255},${(n >>> 8) & 255},${n & 255},${a.toFixed(2)})`;
}

// CoT type -> symbol code (MIL-STD-2525C) for milsymbol
function sidcFor(type) {
  const p = type.split('-');
  if (p[0] !== 'a' || p.length < 3) return null;
  const aff = ({ f: 'F', h: 'H', n: 'N', u: 'U', a: 'A', s: 'S', j: 'J', k: 'K', p: 'P' })[p[1]] || 'U';
  const dim = ({ P: 'P', A: 'A', G: 'G', S: 'S', U: 'U', F: 'F', X: 'X' })[p[2]] || 'G';
  const fn = p.slice(3).join('').slice(0, 6).padEnd(6, '-');
  return 'S' + aff + dim + 'P' + fn + '-----';
}
const AFF_NAMES = { f: 'Friendly', h: 'Hostile', n: 'Neutral', u: 'Unknown', a: 'Assumed friend', s: 'Suspect', p: 'Pending' };

const symCache = new Map();
function symbolSvg(sidc, size = 26) {
  const key = sidc + size;
  if (!symCache.has(key)) {
    let s = null;
    try { s = new ms.Symbol(sidc, { size }); if (!s.isValid()) s = null; } catch (e) { s = null; }
    if (!s) s = new ms.Symbol(sidc.slice(0, 4) + '-----------', { size });
    symCache.set(key, { svg: s.asSVG(), w: s.getSize().width, h: s.getSize().height, a: s.getAnchor() });
  }
  return symCache.get(key);
}

// ======================================================================
// Status bar: clock, battery, callsign
// ======================================================================

let battery = null;
// battery only for the own position (ATAK shows it on the contact)
if (navigator.getBattery) navigator.getBattery().then(b => {
  const upd = () => { battery = Math.round(b.level * 100); };
  upd();
  b.addEventListener('levelchange', upd);
}).catch(() => {});

function showMe() {
  document.title = profile.callsign ? `TAKweb – ${profile.callsign}` : 'TAKweb';
}

// ======================================================================
// Menu and windows
// ======================================================================

const TITLES = { server: 'Servers', edit: 'Server', me: 'Callsign', video: 'Video stream', contacts: 'Contacts & Markers', map: 'Map', data: 'TAK Data', clear: 'Clear Content', mesh: 'Meshtastic' };
let popupSec = null;
// like ATAK: only one sheet open at the bottom at a time
function closeSheets(except) {
  if (except !== 'sidebar') closeSidebar();
  if (except !== 'popup') closePopup();
  if (except !== 'chat' && typeof closeChat === 'function') closeChat();
  if (except !== 'markers' && profile.showTools && typeof showTools === 'function') showTools(false);
}

function openPopup(sec, title) {
  closeSheets('popup');
  popupSec = sec;
  for (const s of document.querySelectorAll('.mbody section')) s.classList.toggle('on', s.dataset.sec === sec);
  $('popupTitle').textContent = title || TITLES[sec] || '';
  $('popup').classList.remove('hidden');
  if (sec === 'server') renderServers();
  if (sec === 'contacts') renderList();
  if (sec === 'clear') renderClear();
  if (sec === 'me') fillMe();
  if (sec === 'map') fillMap();
  document.dispatchEvent(new CustomEvent('eud-popup', { detail: sec }));
}
function closePopup() {
  // server edit closed with ✕: apply like ATAK instead of discarding certificate/truststore
  if (popupSec === 'edit' && draft) {
    readEdit();
    if (draft.host && !LOCAL_HOST.test(draft.host)) saveDraft();
    draft = null;
  }
  $('popup').classList.add('hidden');
  popupSec = null;
}
for (const b of document.querySelectorAll('[data-pclose]')) b.addEventListener('click', closePopup);

function openSidebar() { closeSheets('sidebar'); $('sidebar').classList.remove('hidden'); }
function closeSidebar() { $('sidebar').classList.add('hidden'); }
for (const b of document.querySelectorAll('[data-sbclose]')) b.addEventListener('click', closeSidebar);
$('btnMenu').addEventListener('click', () => ($('sidebar').classList.contains('hidden') ? openSidebar() : closeSidebar()));
$('btnLayers').addEventListener('click', () => (popupSec === 'map' ? closePopup() : openPopup('map')));
for (const t of document.querySelectorAll('[data-open]')) {
  t.addEventListener('click', () => {
    const o = t.dataset.open;
    if (o === 'chat') return openChat();
    if (o === 'overlays' || o === 'sync' || o === 'data') {
      openPopup('data', { overlays: 'Overlay Manager', sync: 'Data Sync', data: 'Data Packages' }[o]);
      const tab = document.querySelector(`#dataTabs [data-tab="${o === 'data' ? 'packages' : o}"]`);
      if (tab) tab.click();
      return;
    }
    openPopup(o);
  });
}
$('connBtn').addEventListener('click', () => openPopup('server'));

// ======================================================================
// Situational picture: receive and draw CoT
// ======================================================================

const items = new Map(); // uid -> { uid, c, xml, layer, own, stale }
// chat messages are deleted automatically after 3 days (otherwise the window and the channel list grow without end)
const CHAT_KEEP_MS = 3 * 86400000;
const chatFresh = m => Date.now() - (m.time || 0) < CHAT_KEEP_MS;
let chat = store.get('eud.chat', []).filter(chatFresh);
store.set('eud.chat', chat);
let unread = 0;
let me = null; // own position

function parseCot(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const ev = doc.documentElement;
  if (!ev || ev.nodeName !== 'event' || doc.getElementsByTagName('parsererror').length) return null;
  const pt = ev.querySelector(':scope > point');
  const detail = ev.querySelector(':scope > detail');
  const q = sel => (detail ? detail.querySelector(sel) : null);
  const attr = (sel, a) => { const n = q(sel); return n ? n.getAttribute(a) : null; };
  const links = detail ? [...detail.querySelectorAll(':scope > link')] : [];
  return {
    uid: ev.getAttribute('uid') || '',
    type: ev.getAttribute('type') || '',
    time: Date.parse(ev.getAttribute('time')) || Date.now(),
    stale: Date.parse(ev.getAttribute('stale')) || Date.now() + 120000,
    lat: pt ? Number(pt.getAttribute('lat')) : NaN,
    lon: pt ? Number(pt.getAttribute('lon')) : NaN,
    hae: pt ? Number(pt.getAttribute('hae')) : NaN,
    callsign: attr('contact', 'callsign'),
    team: attr('__group', 'name'),
    role: attr('__group', 'role'),
    course: Number(attr('track', 'course')),
    speed: Number(attr('track', 'speed')),
    battery: attr('status', 'battery'),
    remarks: q('remarks') ? q('remarks').textContent : '',
    color: attr('color', 'argb') || attr('color', 'value'),
    stroke: attr('strokeColor', 'value'),
    fill: attr('fillColor', 'value'),
    weight: Number(attr('strokeWeight', 'value')) || 3,
    ellipse: q('shape > ellipse'),
    sensor: q(':scope > sensor'),
    rbRange: Number(attr('range', 'value')),
    rbBearing: Number(attr('bearing', 'value')),
    video: attr('__video', 'url'),
    videoEntry: q('__video ConnectionEntry'),
    linkPoints: links.map(l => l.getAttribute('point')).filter(Boolean).map(s => s.split(',').map(Number)).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])),
    links: links.map(l => ({ uid: l.getAttribute('uid'), relation: l.getAttribute('relation'), type: l.getAttribute('type') })),
    chat: q('__chat'),
    detail,
  };
}

function videoUrl(c) {
  if (c.videoEntry) {
    const e = c.videoEntry;
    const proto = e.getAttribute('protocol') || 'rtsp';
    const addr = e.getAttribute('address') || '';
    const port = e.getAttribute('port');
    const p = e.getAttribute('path') || '';
    if (/^https?:\/\//i.test(addr)) return addr;
    if (addr) return `${proto}://${addr}${port && port !== '-1' ? ':' + port : ''}${p.startsWith('/') || !p ? p : '/' + p}`;
  }
  return c.video || '';
}

// video link for the browser: open own streams (…/stream.ts) as a fullscreen page
function browserVideoUrl(u) {
  try {
    const url = new URL(u);
    if (url.origin === location.origin) url.pathname = url.pathname.replace(/\/(stream\.ts|index\.m3u8|snapshot\.jpg)$/, '');
    return url.href;
  } catch (e) { return u; }
}

function iconFor(c, stale) {
  const label = `<span class="lbl" style="top:{T}px">${esc(c.callsign || '')}</span>`;
  const cls = 'cot-icon' + (stale ? ' stale' : '');
  if (c.type.startsWith('a-') && c.team) {
    // ATAK user: circle in team color with short callsign, arrow for the direction
    const col = TEAMS[c.team] || '#00FFFF';
    const light = ['White', 'Yellow', 'Cyan', 'Green', 'Orange', 'Magenta'].includes(c.team);
    const short = esc((c.callsign || '?').slice(0, 4));
    const arrow = Number.isFinite(c.course) && c.speed > 0.5
      ? `<path d="M16 0 L21 7 L11 7 Z" fill="${col}" stroke="#000" stroke-width="1" transform="rotate(${c.course + northAngle()} 16 16)"/>` : '';
    const html = `<svg width="32" height="32" viewBox="0 0 32 32">${arrow}<circle cx="16" cy="16" r="11" fill="${col}" stroke="#333" stroke-width="1.5"/>`
      + `<text x="16" y="16" font-size="8" font-family="Courier New, monospace" font-weight="bold" fill="${light ? '#1a1a1a' : '#fff'}" text-anchor="middle" dominant-baseline="central">${short}</text></svg>${label.replace('{T}', 32)}`;
    return L.divIcon({ className: cls, html, iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -14] });
  }
  const sidc = sidcFor(c.type);
  if (sidc) {
    const s = symbolSvg(sidc);
    return L.divIcon({ className: cls, html: s.svg + label.replace('{T}', Math.round(s.h)), iconSize: [s.w, s.h], iconAnchor: [s.a.x, s.a.y], popupAnchor: [0, -s.a.y] });
  }
  const col = argb(c.color, c.type.startsWith('b-m-p-s-p-i') ? '#ff3030' : '#ffd400');
  const html = `<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="${col}" stroke="#000" stroke-width="2"/></svg>${label.replace('{T}', 20)}`;
  return L.divIcon({ className: cls, html, iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -8] });
}

function popupHtml(it) {
  const c = it.c;
  const rows = [];
  const kind = c.type.startsWith('a-')
    ? (AFF_NAMES[c.type.split('-')[1]] || 'Object') + (c.team ? ` · ${esc(c.team)} · ${esc(c.role || '')}` : '')
    : c.type.startsWith('b-m-p') ? 'Point' : c.type === 'u-rb-a' ? 'R&amp;B line' : c.type.startsWith('u-d') ? 'Drawing' : c.type.startsWith('b-m-r') ? 'Route' : esc(c.type);
  rows.push(`<div class="t">${esc(c.callsign || c.uid)}</div><div class="k">${kind}</div>`);
  if (isRb(c)) rows.push(`<div><b>${esc(rbText(c))}</b></div>`);
  const size = shapeSize(c);
  if (size) rows.push(`<div><b>${size}</b></div>`);
  if (Number.isFinite(c.lat)) rows.push(`<div>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}${Number.isFinite(c.hae) && c.hae < 9e6 ? ` · ${Math.round(c.hae)} m` : ''}</div>`);
  if (me && Number.isFinite(c.lat)) rows.push(`<div class="k">${fmtDist(distance(me, c))} · ${Math.round(bearing(me, c))}°</div>`);
  if (c.speed > 0.5) rows.push(`<div class="k">${(c.speed * 3.6).toFixed(0)} km/h</div>`);
  if (c.battery) rows.push(`<div class="k">Battery ${esc(c.battery)} %</div>`);
  rows.push(`<div class="k">${ago(c.time)}${it.offline ? ' · connection lost – last position' : Date.now() > c.stale ? ' · stale' : ''}</div>`);
  if (c.remarks) rows.push(`<div>${esc(c.remarks)}</div>`);
  const v = videoUrl(c);
  if (v) rows.push(`<button type="button" class="play" data-play="${esc(v)}" data-name="${esc(c.callsign || c.uid)}">▶ VIDEO</button>`);
  if (c.type.startsWith('a-') && c.team && it.uid !== profile.uid) rows.push(`<button type="button" class="play" data-msg="${esc(c.uid)}">✉ MESSAGE</button>`);
  if (Number.isFinite(c.lat) && it.uid !== profile.uid && !isRb(c)) rows.push(`<button type="button" class="play" data-hound="${esc(c.uid)}">BLOODHOUND</button>`);
  if (editable(it)) rows.push((isPoint(c) ? `<button type="button" class="play" data-move="${esc(c.uid)}">MOVE</button> ` : '')
    + `<button type="button" class="play" data-ren="${esc(c.uid)}">RENAME</button> <button type="button" data-del="${esc(c.uid)}">DELETE</button>`);
  return rows.join('');
}

// size of a drawing: radius of a circle, length of a line, perimeter of a closed shape
function shapeSize(c) {
  if (c.type === 'u-d-c-c' && c.ellipse) return 'Radius ' + fmtDist(Number(c.ellipse.getAttribute('major')) || 0);
  if (!c.type.startsWith('u-d') || c.linkPoints.length < 2) return '';
  let len = 0;
  for (let i = 1; i < c.linkPoints.length; i++) len += distance({ lat: c.linkPoints[i - 1][0], lon: c.linkPoints[i - 1][1] }, { lat: c.linkPoints[i][0], lon: c.linkPoints[i][1] });
  const p = c.linkPoints, closed = c.type === 'u-d-r' || (p.length > 2 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]);
  if (c.type === 'u-d-r') len += distance({ lat: p[p.length - 1][0], lon: p[p.length - 1][1] }, { lat: p[0][0], lon: p[0][1] });
  return (closed ? 'Perimeter ' : 'Length ') + fmtDist(len);
}

// like ATAK: every marker, point and drawing can be moved, renamed and deleted by anyone –
// only the live position of other devices (contacts with a team) not, the device sends it again anyway
function editable(it) { return !!it.own || !(it.c.type.startsWith('a-') && it.c.team); }

// moving like ATAK: only after MOVE in the marker's window (no accidental moving while zooming/panning) –
// then drag the marker or tap the new position
let movingUid = null;
const canDrag = it => editable(it) && movingUid === it.uid;
function startMove(uid) {
  const it = items.get(uid);
  if (!it || !editable(it)) return;
  endMove();
  movingUid = uid;
  if (it.layer && it.layer.dragging) it.layer.dragging.enable();
  $('moveName').textContent = it.c.callsign || toolName(it.c.type) || uid;
  $('moveHint').classList.remove('hidden');
  if (window.view3d) view3d.dirty();
}
function endMove() {
  const it = movingUid && items.get(movingUid);
  movingUid = null;
  if (it && it.layer && it.layer.dragging) it.layer.dragging.disable();
  $('moveHint').classList.add('hidden');
  if (window.view3d) view3d.dirty();
}
function moveTo(lat, lon) {
  const it = movingUid && items.get(movingUid);
  endMove();
  if (it) updateOwn(it, { lat, lon });
}

const isPoint = c => !(c.linkPoints.length >= 2 && (c.type.startsWith('u-d') || c.type.startsWith('b-m-r'))) && c.type !== 'u-d-c-c' && !isRb(c);
// R&B line (like ATAK, type u-rb-a): start point + range (m) + bearing (degrees)
const isRb = c => c.type === 'u-rb-a' && Number.isFinite(c.lat) && Number.isFinite(c.rbRange) && Number.isFinite(c.rbBearing);
const rbText = c => `${fmtDist(c.rbRange)} · ${String(Math.round(c.rbBearing) % 360).padStart(3, '0')}°`;

// change a marker (position and/or name) and send it to all servers – with the same UID, so it changes for everyone
function updateOwn(it, { lat, lon, name }) {
  const doc = new DOMParser().parseFromString(it.xml, 'application/xml');
  const ev = doc.documentElement;
  const now = new Date();
  ev.setAttribute('time', cotTime(now));
  ev.setAttribute('start', cotTime(now));
  if (Date.parse(ev.getAttribute('stale')) < +now + 86400000) ev.setAttribute('stale', cotTime(new Date(+now + 30 * 86400000)));
  ev.setAttribute('how', 'h-g-i-g-o');
  if (lat != null) {
    const pt = ev.querySelector(':scope > point');
    pt.setAttribute('lat', lat.toFixed(7));
    pt.setAttribute('lon', lon.toFixed(7));
  }
  if (name != null) {
    let detail = ev.querySelector(':scope > detail');
    if (!detail) { detail = doc.createElement('detail'); ev.append(detail); }
    let contact = detail.querySelector(':scope > contact');
    if (!contact) { contact = doc.createElement('contact'); detail.prepend(contact); }
    contact.setAttribute('callsign', name);
  }
  const xml = new XMLSerializer().serializeToString(ev);
  handleCot(xml, { own: !!it.own, local: true });
  persistSoon();
  const sent = sendCot(xml, true);
  toast((name != null ? 'Renamed' : 'Moved') + (sent ? ' – sent.' : ' – will be sent once connected.'));
}

// user lost the connection: grey at the last position (stale now), kept for 60 min like a contact without updates
function markOffline(it) {
  const now = Date.now() - 1; // stale from now on (drawItem greys what is past its stale time)
  if (it.c.stale <= now) return;
  it.c.stale = now;
  it.offline = true;
  it.xml = it.xml.replace(/(<event\b[^>]*\sstale=")[^"]*(")/, `$1${cotTime(new Date(now))}$2`);
  drawItem(it);
  persistSoon();
  if (popupSec === 'contacts') renderList();
}

function removeItem(uid) {
  const it = items.get(uid);
  if (!it) return;
  if (movingUid === uid) endMove();
  if (it.layer) it.layer.remove();
  if (it.fov) it.fov.remove();
  items.delete(uid);
  persistSoon();
  if (window.view3d) view3d.dirty();
}

// R&B lines are thin: drawn on a canvas that also counts a tap next to the line (easier with a finger)
const rbRenderer = L.canvas({ tolerance: 14 });

// field of view like ATAK (<sensor azimuth fov range …>): cameras, drones (UAS Tool, KLV), own stream
function sensorOf(c) {
  const s = c.sensor;
  if (!s || s.getAttribute('hideFov') === 'true') return null;
  const az = Number(s.getAttribute('azimuth')), fov = Number(s.getAttribute('fov'));
  if (!s.hasAttribute('azimuth') || !Number.isFinite(az) || !(fov > 0)) return null;
  const range = Number(s.getAttribute('range'));
  const rgb = ['fovRed', 'fovGreen', 'fovBlue'].map(a => Number(s.getAttribute(a)));
  const color = rgb.every(x => Number.isFinite(x) && s.hasAttribute('fovRed')) ? `rgb(${rgb.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255)).join(',')})`
    : TEAMS[c.team] || '#ffd400';
  return { az, fov: Math.min(fov, 359), range: range > 0 ? Math.min(range, 50000) : 100, color };
}
// the cone ("funnel") on the map: tip at the camera, opening in the view direction
const FOV_MIN_PX = 70; // a cone is at least this long on the screen – 100 m are only a few pixels when zoomed out
function fovLayer(lat, lon, s, faded) {
  const mpp = (40075016.686 * Math.cos(lat * Math.PI / 180)) / (256 * 2 ** map.getZoom()); // metres per pixel
  const range = Math.max(s.range, mpp * FOV_MIN_PX);
  const pts = [[lat, lon]];
  const n = Math.max(6, Math.ceil(s.fov / 5));
  for (let i = 0; i <= n; i++) {
    const p = destPoint(lat, lon, range, s.az - s.fov / 2 + (s.fov * i) / n);
    pts.push([p.lat, p.lon]);
  }
  // light overlay: clear edge, translucent fill – the map underneath stays readable
  const l = L.polygon(pts, { color: s.color, weight: 1.5, opacity: faded ? 0.35 : 0.85, fillColor: s.color, fillOpacity: faded ? 0.04 : 0.12, interactive: false });
  l._fov = { lat, lon, s, faded };
  return l;
}
// zooming changes the minimum length: draw the cones again
map.on('zoomend', () => {
  for (const it of items.values()) {
    if (!it.fov) continue;
    const { lat, lon, s, faded } = it.fov._fov;
    it.fov.remove();
    it.fov = fovLayer(lat, lon, s, faded).addTo(shapesLayer);
  }
  if (meFov) { const az = meFov._az; drawMeFov(); if (meFov) meFov._az = az; }
  if (window.view3d) view3d.dirty();
});

function drawItem(it) {
  const c = it.c;
  const stale = Date.now() > c.stale;
  if (it.layer) it.layer.remove();
  it.layer = null;
  if (it.fov) it.fov.remove();
  it.fov = null;
  const stroke = argb(c.stroke, '#ffd400');
  const fill = argb(c.fill, 'rgba(0,0,0,0)');
  const style = { color: stroke, weight: Math.min(c.weight, 8), fillColor: fill, fillOpacity: c.fill ? 1 : 0, opacity: stale ? 0.45 : 1 };
  if (isRb(c)) {
    const end = destPoint(c.lat, c.lon, c.rbRange, c.rbBearing);
    it.layer = L.polyline([[c.lat, c.lon], [end.lat, end.lon]], { ...style, color: argb(c.stroke, '#ffd700'), weight: Math.max(3, Math.min(c.weight, 8)), renderer: rbRenderer }).addTo(shapesLayer);
    it.layer.bindTooltip(`${esc(c.callsign || 'R&B')}: ${rbText(c)}`, { permanent: true, direction: 'center', className: 'measure-label' });
  } else if (c.type === 'u-d-c-c' && c.ellipse && Number.isFinite(c.lat)) {
    const r = Number(c.ellipse.getAttribute('major')) || Number(c.ellipse.getAttribute('minor')) || 0;
    it.layer = L.circle([c.lat, c.lon], { radius: r, ...style }).addTo(shapesLayer);
  } else if (c.linkPoints.length >= 2 && (c.type.startsWith('u-d') || c.type.startsWith('b-m-r'))) {
    const pts = c.linkPoints.map(p => [p[0], p[1]]);
    const closed = c.type === 'u-d-r' || c.type === 'u-d-f-c' || (c.detail && c.detail.querySelector('closed[value="true"]'))
      || (pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]);
    it.layer = (closed ? L.polygon(pts, style) : L.polyline(pts, { ...style, fill: false })).addTo(shapesLayer);
  } else if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && !(c.lat === 0 && c.lon === 0)) {
    // markers can be moved (drag & drop); the change goes out with the same UID like in ATAK
    it.layer = L.marker([c.lat, c.lon], { icon: iconFor(c, stale), zIndexOffset: c.team ? 500 : 0, draggable: canDrag(it), autoPan: true }).addTo(pointsLayer);
    if (editable(it)) it.layer.on('dragend', e => { const ll = e.target.getLatLng(); moveTo(ll.lat, ll.lng); });
    const s = sensorOf(c);
    if (s) it.fov = fovLayer(c.lat, c.lon, s, stale).addTo(shapesLayer);
  }
  if (it.layer) it.layer.bindPopup(() => popupHtml(it), { maxWidth: 260 });
  it.stale = stale;
  if (window.view3d) view3d.dirty();
}

function handleCot(xml, { local = false, own = false, srv = null } = {}) {
  const c = parseCot(xml);
  if (!c || !c.uid) return;
  if (c.type.startsWith('t-x-c-t')) return; // Ping/Pong
  if (c.uid.startsWith('TAKWEB-')) return; // TAKweb's server connections announce themselves to the TAK server
  if (c.type === 't-x-d-d') {
    // the TAK server sends this too when a device loses its connection (OpenTAKServer: send_disconnect_cot).
    // Like ATAK, a user is then only greyed out at the last position – removed by the sweep after 60 min.
    // A deliberate deletion (<__forcedelete/>, markers) removes it right away.
    const force = !!(c.detail && c.detail.querySelector('__forcedelete'));
    for (const l of c.links) {
      const it = l.uid && items.get(l.uid);
      if (it && it.c.team && !force) markOffline(it); else if (l.uid) removeItem(l.uid);
    }
    return;
  }
  if (c.type === 'b-t-f') return receiveChat(c, local);
  // sent by the TAK server (taken over automatically like ATAK): file/package, mission invitation, mission change
  if (c.type === 'b-f-t-r') { if (!local) document.dispatchEvent(new CustomEvent('eud-file-push', { detail: { xml, srv } })); return; }
  if (c.type === 't-x-m-i') { if (!local) document.dispatchEvent(new CustomEvent('eud-mission-invite', { detail: { xml, srv } })); return; }
  if (c.type.startsWith('t-x-m-')) { document.dispatchEvent(new CustomEvent('eud-mission-change', { detail: { xml, srv } })); return; }
  if (c.uid === profile.uid) return; // own echo
  const prev = items.get(c.uid);
  if (prev && prev.c.time > c.time && !local) return; // older than known (e.g. via a second server)
  const mc = profile.mapCleared;
  if (!prev && mc && c.time <= mc.before && mc.cats.includes(categoryOf({ c }))) return; // cleared by the admin's request: does not come back
  const it = prev || { uid: c.uid };
  it.c = c;
  it.xml = xml;
  it.offline = false; // a new position: back online
  it.own = own || (prev && prev.own) || c.links.some(l => l.uid === profile.uid && l.relation === 'p-p');
  items.set(c.uid, it);
  drawItem(it);
  if (!local) persistSoon();
  if (popupSec === 'contacts') renderList();
}

// keep the situational picture on the device (for starting without network)
let persistTimer;
function persistSoon() {
  if (persistTimer) return; // at the latest after 1.5 s – constant updates (drone telemetry) must not postpone it forever
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const keep = [...items.values()].sort((a, b) => b.c.time - a.c.time).slice(0, 800)
      .map(it => ({ xml: it.xml, own: !!it.own }));
    store.set('eud.picture', keep);
  }, 1500);
}

function loadPicture() {
  for (const e of store.get('eud.picture', [])) handleCot(e.xml, { local: true, own: e.own });
}

// fade stale contacts, remove very old ones
setInterval(() => {
  const now = Date.now();
  for (const it of [...items.values()]) {
    const tooOld = it.c.team ? now - it.c.stale > 3600000 : now - it.c.stale > 24 * 3600000;
    if (tooOld) { removeItem(it.uid); continue; }
    if ((now > it.c.stale) !== it.stale) drawItem(it);
  }
}, 15000);

// ======================================================================
// Chat (GeoChat) with channels like ATAK/iTAK/WinTAK: "All Chat Rooms", own team,
// direct messages and groups. Direct and group messages carry <marti><dest …/></marti>,
// so the TAK server delivers them only to the recipients.
// ======================================================================

const ALL_ROOM = 'All Chat Rooms';
let chatConv = 'all';                // current channel (key)
const chatUnread = {};               // channel key -> unread messages

// channel of a message: all | team:<name> | dm:<uid of the other one> | grp:<id>
function chatChannel(c) {
  const ch = c.chat;
  const room = ch ? ch.getAttribute('chatroom') || '' : '';
  const id = ch ? ch.getAttribute('id') || room : '';
  const grp = ch && ch.querySelector('chatgrp');
  const uids = grp ? [...grp.attributes].filter(a => /^uid\d+$/.test(a.name)).sort((a, b) => a.name.slice(3) - b.name.slice(3)).map(a => a.value) : [];
  const fromMe = c.uid.startsWith('GeoChat.' + profile.uid + '.') || uids[0] === profile.uid;
  const senderUid = uids[0] || (c.links[0] && c.links[0].uid) || (/^GeoChat\.(.+?)\./.exec(c.uid) || [])[1] || '';
  if (!ch || room === ALL_ROOM || id === ALL_ROOM) return { key: 'all', name: 'All' };
  if (id === profile.uid || (room && room === profile.callsign && uids.length <= 2)) {
    return { key: 'dm:' + senderUid, name: (ch.getAttribute('senderCallsign') || senderUid), uid: senderUid };
  }
  if (fromMe && uids.length === 2 && id === uids[1]) return { key: 'dm:' + id, name: room || id, uid: id };
  if (TEAMS[room] && id === room) return { key: 'team:' + room, name: room };
  return { key: 'grp:' + id, name: room || id, id, members: uids.filter(u => u !== profile.uid && u !== id) };
}

function receiveChat(c, local) {
  const ch = c.chat;
  const sender = ch ? ch.getAttribute('senderCallsign') || '' : c.callsign || '';
  if (chat.some(m => m.id === c.uid)) return;
  if (!chatFresh(c)) return; // older than 3 days (e.g. sent again by a server): not shown any more
  const fromMe = c.uid.startsWith('GeoChat.' + profile.uid + '.');
  const conv = chatChannel(c);
  chat.push({ id: c.uid, from: sender, conv: conv.key, convName: conv.name, uid: conv.uid || '', members: conv.members || null, text: c.remarks, time: c.time, me: fromMe });
  chat = chat.slice(-500);
  store.set('eud.chat', chat);
  const visible = !$('chatWin').classList.contains('hidden') && chatConv === conv.key;
  if (!local && !fromMe && !visible) {
    unread++;
    chatUnread[conv.key] = (chatUnread[conv.key] || 0) + 1;
    updateBadge();
    toast(`${sender}${conv.key === 'all' ? '' : ' → ' + (conv.key.startsWith('dm:') ? 'you' : conv.name)}: ${c.remarks}`);
  }
  renderChat();
}

setInterval(() => {
  const keep = chat.filter(chatFresh);
  if (keep.length === chat.length) return;
  chat = keep;
  store.set('eud.chat', chat);
  renderChat();
}, 600000);

function updateBadge() {
  $('chatBadge').textContent = unread;
  $('chatBadge').classList.toggle('hidden', !unread);
}

// known channels: All, own team, all conversations so far, then contacts for a new direct message
function chatChannels() {
  const list = [{ key: 'all', name: 'All' }];
  if (profile.team) list.push({ key: 'team:' + profile.team, name: profile.team });
  const seen = new Set(list.map(x => x.key));
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    const key = m.conv || 'all';
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ key, name: m.convName || m.room || key, uid: m.uid, id: key.startsWith('grp:') ? key.slice(4) : '', members: m.members });
  }
  const contacts = [...items.values()].filter(it => it.c && it.c.type.startsWith('a-') && it.c.team && it.uid !== profile.uid && !seen.has('dm:' + it.uid))
    .map(it => ({ key: 'dm:' + it.uid, name: it.c.callsign || it.uid, uid: it.uid, fresh: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { list, contacts };
}
function channelInfo(key) {
  const { list, contacts } = chatChannels();
  return list.concat(contacts).find(x => x.key === key) || { key: 'all', name: 'All' };
}
const channelLabel = x => x.key === 'all' ? 'All Chat Rooms' : x.key.startsWith('team:') ? `Team ${x.name}` : x.key.startsWith('dm:') ? `✉ ${x.name}` : `Group ${x.name}`;

function renderChannels() {
  const sel = $('chatConv');
  const { list, contacts } = chatChannels();
  if (!list.concat(contacts).some(x => x.key === chatConv)) chatConv = 'all';
  sel.textContent = '';
  for (const x of list) {
    const o = document.createElement('option');
    o.value = x.key;
    o.textContent = channelLabel(x) + (chatUnread[x.key] ? ` (${chatUnread[x.key]})` : '');
    sel.append(o);
  }
  if (contacts.length) {
    const g = document.createElement('optgroup');
    g.label = 'New direct message';
    for (const x of contacts) {
      const o = document.createElement('option');
      o.value = x.key;
      o.textContent = '✉ ' + x.name;
      g.append(o);
    }
    sel.append(g);
  }
  sel.value = chatConv;
}

function renderChat() {
  renderChannels();
  const log = $('chatLog');
  log.textContent = '';
  const msgs = chat.filter(m => (m.conv || 'all') === chatConv);
  if (!msgs.length) {
    const e = document.createElement('div');
    e.className = 'chat-empty';
    e.textContent = 'No messages';
    log.append(e);
  }
  for (const m of msgs) {
    const d = document.createElement('div');
    d.className = 'cm ' + (m.me ? 'out' : 'in');
    const h = document.createElement('div');
    h.className = 'cm-h';
    const who = document.createElement('b');
    who.textContent = m.from;
    const time = document.createElement('span');
    time.textContent = hhmm(new Date(m.time));
    h.append(who, time);
    const txt = document.createElement('div');
    txt.className = 'cm-t';
    txt.textContent = m.text;
    d.append(h, txt);
    // voice message (voice.js): a player right in the chat
    const vm = /(https?:\/\/[^\s]+\/voicemsg\/[a-f0-9]{32}\.wav)/.exec(m.text || '');
    if (vm) {
      const a = document.createElement('audio');
      a.controls = true;
      a.preload = 'none';
      a.src = new URL(vm[1]).origin === location.origin ? vm[1] : new URL(new URL(vm[1]).pathname, location.href).href;
      a.className = 'cm-audio';
      txt.textContent = m.text.replace(vm[1], '').trim();
      d.append(a);
    } else if (window.eudVoicePlayer) {
      const pl = window.eudVoicePlayer(m.id); // voice message that came over the mesh (Codec 2, voice.js)
      if (pl) d.append(pl);
    }
    log.append(d);
  }
  log.scrollTop = log.scrollHeight;
}

function setChatConv(key) {
  chatConv = key;
  unread = Math.max(0, unread - (chatUnread[key] || 0));
  chatUnread[key] = 0;
  updateBadge();
  renderChat();
}

const callsignOf = uid => { const it = items.get(uid); return (it && it.c && it.c.callsign) || ''; };

// recipients of a channel (null = everyone)
function chatRecipients(x) {
  if (x.key === 'all') return null;
  if (x.key.startsWith('dm:')) return [x.uid || x.key.slice(3)];
  if (x.key.startsWith('team:')) {
    return [...items.values()].filter(it => it.c && it.c.type.startsWith('a-') && it.c.team === x.name && it.uid !== profile.uid).map(it => it.uid);
  }
  return (x.members || []).filter(u => u !== profile.uid);
}

function chatXml(text, x = { key: 'all', name: 'All' }) {
  const now = new Date();
  const msgId = rnd(8);
  const to = chatRecipients(x);
  const room = x.key === 'all' ? ALL_ROOM : x.key.startsWith('dm:') ? (callsignOf(x.uid) || x.name) : x.name;
  const roomId = x.key === 'all' ? ALL_ROOM : x.key.startsWith('dm:') ? x.uid : x.key.startsWith('team:') ? x.name : x.id;
  const uids = x.key === 'all' ? [profile.uid, ALL_ROOM] : [profile.uid, ...to];
  const call = xmlEsc(profile.callsign || profile.uid);
  const p = me || profile.lastPos || { lat: 0, lon: 0 };
  // TAK server: only to these devices (by callsign, otherwise by UID)
  const marti = to ? `<marti>${to.map(u => callsignOf(u) ? `<dest callsign="${xmlEsc(callsignOf(u))}"/>` : `<dest uid="${xmlEsc(u)}"/>`).join('')}</marti>` : '';
  return `<event version="2.0" uid="GeoChat.${xmlEsc(profile.uid)}.${xmlEsc(roomId)}.${msgId}" type="b-t-f" how="h-g-i-g-o" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 86400000))}">`
    + `<point lat="${p.lat}" lon="${p.lon}" hae="9999999" ce="9999999" le="9999999"/><detail>`
    + `<__chat parent="RootContactGroup" groupOwner="false" messageId="${msgId}" chatroom="${xmlEsc(room)}" id="${xmlEsc(roomId)}" senderCallsign="${call}">`
    + `<chatgrp ${uids.map((u, i) => `uid${i}="${xmlEsc(u)}"`).join(' ')} id="${xmlEsc(roomId)}"/></__chat>`
    + `<link uid="${xmlEsc(profile.uid)}" type="a-f-G-U-C" relation="p-p"/>`
    + `<remarks source="BAO.F.ATAK.${xmlEsc(profile.uid)}" to="${xmlEsc(roomId)}" time="${cotTime(now)}">${xmlEsc(text)}</remarks>`
    + marti
    + `<__serverdestination destinations="0.0.0.0:4242:tcp:${xmlEsc(profile.uid)}"/></detail></event>`;
}

function openChat(key) {
  closeSheets('chat');
  setChatConv(key || chatConv);
  $('chatWin').classList.remove('hidden', 'min');
  $('btnChat').classList.add('active');
  chatToEnd();
}
// newest message in view – only possible once the window is visible (hidden it has no height)
function chatToEnd() { const log = $('chatLog'); log.scrollTop = log.scrollHeight; }
function closeChat() {
  $('chatWin').classList.add('hidden');
  $('btnChat').classList.remove('active');
}
$('btnChat').addEventListener('click', () => ($('chatWin').classList.contains('hidden') ? openChat() : closeChat()));
$('chatClose').addEventListener('click', closeChat);
$('chatMin').addEventListener('click', e => { e.stopPropagation(); $('chatWin').classList.toggle('min'); chatToEnd(); });
document.querySelector('.chat-head').addEventListener('click', e => { if (e.target.closest('button')) return; $('chatWin').classList.remove('min'); });
// a chat message into the current channel (TAK server and Meshtastic) – { xml, uid, msgId, conv }, or null if nobody
// can get it. server: false = only here and over the mesh (e.g. a voice message without internet)
function sendChat(text, { mesh = true, server = true } = {}) {
  const x = channelInfo(chatConv);
  const to = chatRecipients(x);
  if (to && !to.length) { toast(`Nobody of team ${x.name} is online right now.`); return null; }
  const xml = chatXml(text, x);
  handleCot(xml, { local: true });
  if (server) sendCot(xml, true);
  if (mesh) document.dispatchEvent(new CustomEvent('eud-chat-out', { detail: { text, xml, conv: x } })); // Meshtastic (mesh.js)
  return { xml, uid: (/uid="([^"]+)"/.exec(xml) || [])[1], msgId: (/messageId="([^"]+)"/.exec(xml) || [])[1], conv: x };
}
$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatIn').value.trim();
  if (!text) return;
  if (sendChat(text)) $('chatIn').value = '';
});
$('chatConv').addEventListener('change', e => setChatConv(e.target.value));
$('chatConv').addEventListener('click', e => e.stopPropagation());

// ======================================================================
// Connections to the TAK servers (one WebSocket to the relay per server)
// ======================================================================

const conns = new Map(); // server.id -> { ws, retry, timer, state, message }
let outbox = store.get('eud.outbox2', {}); // server.id -> [xml]

function connOf(srv) {
  if (!conns.has(srv.id)) conns.set(srv.id, { ws: null, retry: 0, timer: null, state: 'idle', message: '' });
  return conns.get(srv.id);
}
const isOpen = c => c && c.ws && c.ws.readyState === 1;
// at least one TAK server connected right now (otherwise Meshtastic sends over LoRa)
const serverOnline = () => navigator.onLine && servers.some(s => s.auto && connOf(s).state === 'connected');

function updateStatus() {
  const active = servers.filter(s => s.auto);
  const ok = active.filter(s => connOf(s).state === 'connected').length;
  const anyErr = active.some(s => ['error', 'untrusted'].includes(connOf(s).state));
  // header: green = all connected, orange = only some, red = offline/disconnected/error
  let kind = '', text = 'OFFLINE';
  if (!servers.length) text = 'SETUP';
  else if (!active.length) text = 'DISCONNECTED';
  else if (!navigator.onLine) text = 'OFFLINE';
  else if (ok === active.length) { kind = 'ok'; text = active.length > 1 ? `ONLINE ${ok}/${active.length}` : 'ONLINE'; }
  else if (ok) { kind = 'warn'; text = `ONLINE ${ok}/${active.length}`; }
  else if (anyErr) text = 'ERROR';
  else text = 'CONNECTING';
  $('dot').className = 'dot ' + kind;
  $('connBtn').className = kind;
  $('statusText').textContent = text;
  $('connBtn').title = 'Servers: ' + text;
  if (popupSec === 'server') renderServers();
}

// drone/camera address: the login from TAKweb for a connected user (proved by the certificate) – kept like ATAK
const droneWait = new Map(); // server id -> resolve
function askDrone() {
  const list = servers.filter(s => s.auto && isOpen(connOf(s)) && connOf(s).state === 'connected');
  return Promise.all(list.map(srv => new Promise(resolve => {
    droneWait.set(srv.id, resolve);
    connOf(srv).ws.send(JSON.stringify({ type: 'drone' }));
    setTimeout(() => { if (droneWait.get(srv.id) === resolve) { droneWait.delete(srv.id); resolve({}); } }, 4000);
  }).then(r => {
    if (!r.username || !r.password) return false;
    srv.username = srv.username || r.username;
    if (srv.username !== r.username) return false; // another user on this server: keep the own one
    srv.password = r.password;
    return true;
  }))).then(ok => { if (ok.some(Boolean)) saveServers(); return ok.some(Boolean); });
}

// send to all connected servers; those not connected right now get it later (queue)
function sendCot(xml, queue) {
  let sent = false;
  for (const srv of servers.filter(s => s.auto)) {
    const c = connOf(srv);
    if (isOpen(c)) {
      c.ws.send(JSON.stringify({ type: 'cot', xml }));
      sent = true;
    } else if (queue) {
      outbox[srv.id] = (outbox[srv.id] || []).concat(xml).slice(-100);
    }
  }
  if (queue) store.set('eud.outbox2', outbox);
  // markers, changes and deletions also over Meshtastic (mesh.js) – chat goes its own way (eud-chat-out)
  if (queue && !/ type="b-t-f"/.test(xml)) {
    const ev = new CustomEvent('eud-cot-out', { detail: { xml, mesh: false } });
    document.dispatchEvent(ev);
    if (ev.detail.mesh) sent = true;
  }
  return sent;
}

function flushOutbox(srv) {
  const c = connOf(srv);
  const list = outbox[srv.id] || [];
  while (list.length && isOpen(c)) c.ws.send(JSON.stringify({ type: 'cot', xml: list.shift() }));
  outbox[srv.id] = list;
  store.set('eud.outbox2', outbox);
}

function openConn(srv) {
  const c = connOf(srv);
  clearTimeout(c.timer);
  if (!srv.auto || !srv.host) return updateStatus();
  if (c.ws && (c.ws.readyState === 0 || c.ws.readyState === 1)) return;
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/tak');
  c.ws = sock;
  c.state = 'connecting';
  c.message = '';
  updateStatus();
  sock.onopen = () => {
    c.retry = 0;
    c.wsOk = true;
    sock.send(JSON.stringify({
      type: 'connect', host: srv.host, port: srv.port, proto: srv.proto, uid: profile.uid, callsign: profile.callsign,
      certPem: srv.proto === 'ssl' ? srv.certPem : '', keyPem: srv.proto === 'ssl' ? srv.keyPem : '',
      caPems: srv.caPems, fingerprint: srv.fingerprint,
    }));
    flushOutbox(srv); // the relay buffers until the TAK server is connected
    sendSelfTo(srv);
  };
  sock.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'cot') { // mesh bridge (mesh.js): what the server sends right after connecting is its stored picture, not live
      document.dispatchEvent(new CustomEvent('eud-cot-in', { detail: { xml: msg.xml, replay: !c.connectedAt || Date.now() - c.connectedAt < 15000 } }));
      return handleCot(msg.xml, { srv });
    }
    if (msg.type === 'assign') return applyAssignment(msg);
    if (msg.type === 'mapclear') return askMapClear(msg.request);
    if (msg.type === 'drone') { const w = droneWait.get(srv.id); if (w) { droneWait.delete(srv.id); w(msg); } return; }
    if (msg.type !== 'status') return;
    const was = c.state;
    c.state = msg.state;
    c.message = msg.message || '';
    if (msg.state === 'connected' && was !== 'connected') {
      c.connectedAt = Date.now();
      toast('Connected: ' + (srv.name || srv.host));
      sendSelfTo(srv);
      document.dispatchEvent(new CustomEvent('eud-connected', { detail: { srv } })); // device profile (data.js)
    }
    if (msg.state === 'untrusted') {
      askTrust(`${srv.host}:${srv.port}`, msg.fingerprint, msg.subject).then(ok => {
        if (!ok) return disconnectServer(srv);
        srv.fingerprint = msg.fingerprint;
        saveServers();
        reconnect(srv);
      });
    }
    updateStatus();
  };
  sock.onclose = () => {
    if (c.ws !== sock) return;
    c.ws = null;
    if (c.state !== 'error' && c.state !== 'untrusted') {
      c.state = 'offline';
      // the page itself loads, only the WebSocket does not open: usually a reverse proxy (nginx) without WebSocket forwarding
      c.message = !c.wsOk && navigator.onLine
        ? 'TAKweb relay not reachable: the WebSocket /ws/tak does not open. If TAKweb runs behind nginx/Apache, the proxy must forward WebSockets (Upgrade/Connection headers).'
        : '';
    }
    updateStatus();
    if (srv.auto) c.timer = setTimeout(() => openConn(srv), Math.min(30000, 1000 * 2 ** c.retry++));
  };
  sock.onerror = () => {};
}

function closeSock(srv) {
  const c = connOf(srv);
  clearTimeout(c.timer);
  if (c.ws) {
    try { c.ws.send(JSON.stringify({ type: 'disconnect' })); } catch (e) { /* ignore */ }
    const s = c.ws;
    c.ws = null;
    s.onclose = null;
    s.close();
  }
  c.state = 'idle';
  c.message = '';
}

function reconnect(srv) {
  closeSock(srv);
  connOf(srv).retry = 0;
  openConn(srv);
}

function connectServer(srv) {
  srv.auto = true;
  saveServers();
  reconnect(srv);
}

function disconnectServer(srv) {
  srv.auto = false;
  saveServers();
  closeSock(srv);
  updateStatus();
}

function removeServer(srv) {
  closeSock(srv);
  conns.delete(srv.id);
  delete outbox[srv.id];
  store.set('eud.outbox2', outbox);
  servers = servers.filter(s => s !== srv);
  saveServers();
  updateStatus();
}

function reconnectAll() {
  for (const srv of servers) { connOf(srv).retry = 0; openConn(srv); }
}
window.addEventListener('online', reconnectAll);
window.addEventListener('offline', updateStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { reconnectAll(); sendSelf(); if (profile.wake) wakeLock(); }
});

// ======================================================================
// Own position (SA)
// ======================================================================

let meMarker = null, meCircle = null, meFov = null, follow = true, lastSent = 0, sentAt = null, sentAz = null;

// own camera while streaming: field of view for ATAK/TAKweb (<sensor>). Phone camera: direction of the
// back of the phone (compass); helmet camera: GPS course while moving, standing still the phone's compass
// (the phone is not on the helmet – it fits when it is carried facing forward, e.g. on the chest).
const CAM_FOV = { phone: { fov: 60, vfov: 45, model: 'Phone camera' }, ble: { fov: 66, vfov: 50, model: 'Helmet camera' } };
const CAM_RANGE = 100;
function camSensor() {
  const kind = window.eudVideoUrl && CAM_FOV[window.eudVideoSource];
  if (!kind || !me) return null;
  const moving = Number.isFinite(me.course) && me.speed > 0.5;
  const az = window.eudVideoSource === 'phone' ? (camHeading != null ? camHeading : moving ? me.course : null)
    : moving ? me.course : heading;
  return az == null ? null : { az: Math.round(az) % 360, fov: kind.fov, vfov: kind.vfov, model: kind.model, range: CAM_RANGE, color: TEAMS[profile.team] || '#00FFFF' };
}

function selfXml() {
  const now = new Date();
  // without GPS (PC, location refused) still report: otherwise the TAK server does not know this device
  // and cannot deliver direct messages – last known position, otherwise 0,0 without accuracy
  const p = me || { ...(profile.lastPos || { lat: 0, lon: 0 }), acc: 9999999 };
  const course = Number.isFinite(p.course) ? p.course : 0;
  const speed = Number.isFinite(p.speed) ? p.speed : 0;
  const video = window.eudVideoUrl ? `<__video url="${xmlEsc(window.eudVideoUrl)}"/>` : '';
  const cam = camSensor();
  const sensor = cam ? `<sensor azimuth="${cam.az}" fov="${cam.fov}" vfov="${cam.vfov}" range="${cam.range}" elevation="0" roll="0" north="0" type="r-e" model="${cam.model}" version="0.6"/>` : '';
  return `<event version="2.0" uid="${xmlEsc(profile.uid)}" type="a-f-G-U-C" how="m-g" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 120000))}">`
    + `<point lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}" hae="${Number.isFinite(p.alt) ? p.alt.toFixed(1) : '9999999'}" ce="${Math.round(p.acc || 9999999)}" le="9999999"/>`
    + `<detail><takv os="${xmlEsc(navigator.platform || 'Web')}" version="1.0" device="Browser" platform="TAKweb"/>`
    + `<contact endpoint="*:-1:stcp" callsign="${xmlEsc(profile.callsign || profile.uid)}"/>`
    + `<uid Droid="${xmlEsc(profile.callsign || profile.uid)}"/>`
    + `<precisionlocation altsrc="GPS" geopointsrc="GPS"/>`
    + `<__group role="${xmlEsc(profile.role)}" name="${xmlEsc(profile.team)}"/>`
    + (battery != null ? `<status battery="${battery}"/>` : '')
    + video + sensor
    + `<track course="${course.toFixed(1)}" speed="${speed.toFixed(1)}"/></detail></event>`;
}

function sendSelf() {
  const cam = camSensor();
  if (sendCot(selfXml(), false)) {
    sentAz = cam ? cam.az : null;
    lastSent = Date.now();
    if (me) {
      sentAt = { lat: me.lat, lon: me.lon };
      profile.lastPos = { lat: +me.lat.toFixed(6), lon: +me.lon.toFixed(6) };
      saveProfile();
    }
  }
}
function sendSelfTo(srv) {
  const c = connOf(srv);
  if (isOpen(c)) c.ws.send(JSON.stringify({ type: 'cot', xml: selfXml() }));
}
window.eudSendSelf = sendSelf;

// direction of the own arrow (like ATAK): GPS course while moving, otherwise the phone's compass –
// independent of the compass button, which only turns the map (north up / heading up)
let lastDir = 0;
function myDir() {
  if (me && Number.isFinite(me.course) && me.speed > 1) lastDir = me.course;
  else if (heading != null) lastDir = heading;
  return lastDir; // no compass, standing: keep the last direction instead of jumping to north
}
function meIcon() {
  const col = TEAMS[profile.team] || '#00FFFF';
  const rot = myDir() + northAngle();
  const html = `<svg width="32" height="32" viewBox="0 0 32 32"><g transform="rotate(${Math.round(rot)} 16 16)">`
    + `<path d="M16 2 L28 29 L16 22 L4 29 Z" fill="#007bff" stroke="${col}" stroke-width="2" stroke-linejoin="round"/></g></svg>`;
  return L.divIcon({ className: 'cot-icon', html, iconSize: [32, 32], iconAnchor: [16, 16] });
}
// the compass turned the phone: only the arrow (no full redraw), at most ~6×/s and from 3°
let arrowAt = 0, arrowDir = null;
function turnArrow() {
  if (!me || !meMarker) return;
  const d = myDir(), now = Date.now();
  if (now - arrowAt < 150 || (arrowDir != null && Math.abs(((d - arrowDir + 540) % 360) - 180) < 3)) return;
  arrowAt = now;
  arrowDir = d;
  meMarker.setIcon(meIcon());
  if (window.view3d && view3d.active) view3d.dirty();
}
function drawMe() {
  updateSelfInfo();
  const ll = [me.lat, me.lon];
  const icon = meIcon();
  arrowDir = lastDir;
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: me.acc || 0, color: '#007bff', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon, zIndexOffset: 1000 }).addTo(map).bindPopup(() =>
      `<div class="t">${esc(profile.callsign || 'Me')}</div><div>${me.lat.toFixed(5)}, ${me.lon.toFixed(5)}</div><div class="k">± ${Math.round(me.acc)} m</div>`);
    map.setView(ll, Math.max(map.getZoom(), 15));
  } else {
    meMarker.setLatLng(ll).setIcon(icon);
    meCircle.setLatLng(ll).setRadius(me.acc || 0);
    if (follow) map.panTo(ll, { animate: true });
  }
  drawMeFov();
  if (window.view3d) view3d.dirty();
}
function drawMeFov() {
  if (meFov) meFov.remove();
  const cam = camSensor();
  meFov = cam ? fovLayer(me.lat, me.lon, cam).addTo(shapesLayer) : null;
}
// streaming: compass on (also in north-up mode); the view turns -> the cone follows, others see it within seconds
let camWatch = false;
setInterval(() => {
  const want = !!window.eudVideoUrl && !!CAM_FOV[window.eudVideoSource];
  if (want && !camWatch) { camWatch = true; startHeading(true); } // asked already with the tap on the stream button
  if (!want && camWatch) { camWatch = false; camHeading = null; }
  if (!me) return;
  const cam = camSensor();
  if ((cam ? cam.az : null) !== (meFov ? meFov._az : null)) { drawMeFov(); if (meFov) meFov._az = cam.az; if (window.view3d) view3d.dirty(); }
  const turned = cam && (sentAz == null || Math.abs(((cam.az - sentAz + 540) % 360) - 180) > 15);
  if ((turned || (!cam && sentAz != null)) && Date.now() - lastSent > 3000) sendSelf();
}, 1000);

// position: started right away; refused (or the browser wants a tap) -> the permission bar asks again with one tap
let geoWatch = null, geoDenied = false;
// Android app (mobile/, Capacitor): the native plugins are in the page – the position keeps coming with the screen
// locked (a notification shows it), in the browser only while TAKweb is in front
const appPlugins = (window.Capacitor && window.Capacitor.Plugins) || {};
const nativeApp = !!appPlugins.TakWeb;
const bgGeo = appPlugins.BackgroundGeolocation;
function onPosition(c, t) {
  if (geoDenied) { geoDenied = false; updatePermBar(); }
  me = { lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: c.accuracy, speed: c.speed, course: c.heading, t };
  drawMe();
  const moved = sentAt ? distance(sentAt, me) : Infinity;
  if (Date.now() - lastSent > 30000 || (moved > 10 && Date.now() - lastSent > 3000)) sendSelf();
}
function startGeo() {
  if (bgGeo) {
    if (geoWatch != null) return;
    geoWatch = 'bg';
    bgGeo.addWatcher({ backgroundTitle: 'TAKweb', backgroundMessage: 'Your position is sent to your team.', requestPermissions: true, stale: false, distanceFilter: 0 }, (loc, err) => {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED') { geoDenied = true; geoWatch = null; updatePermBar(); }
        return;
      }
      onPosition({ latitude: loc.latitude, longitude: loc.longitude, altitude: loc.altitude, accuracy: loc.accuracy, speed: loc.speed, heading: loc.bearing }, loc.time);
    });
    return;
  }
  if (!('geolocation' in navigator)) return;
  if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch);
  geoWatch = navigator.geolocation.watchPosition(pos => onPosition(pos.coords, pos.timestamp), err => {
    if (err.code === 1) { geoDenied = true; updatePermBar(); }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
startGeo();
setInterval(() => { if (Date.now() - lastSent > 30000) sendSelf(); }, 10000);

map.on('dragstart', () => { follow = false; $('btnLocate').classList.remove('active'); });
$('btnLocate').addEventListener('click', () => {
  follow = true;
  $('btnLocate').classList.add('active');
  if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 16));
  else toast('No position yet.');
});
$('btnLocate').classList.add('active');

// ======================================================================
// Placing markers: choose a symbol -> crosshair -> PLACE POINT
// ======================================================================

// markers like ATAK: affiliation + dimension + MIL-STD-2525 function (CoT type a-<aff>-<dim>-<function>)
const AFF_LABEL = { u: 'Unknown', n: 'Neutral', h: 'Hostile', f: 'Friendly' };
const DIM_LABEL = { G: 'Ground', A: 'Air', S: 'Sea', U: 'Subsurface', P: 'Space' };
const FUNCTIONS = {
  G: [['U-C-I', 'Infantry'], ['U-C-I-Z', 'Mech. Infantry'], ['U-C-A', 'Armor'], ['U-C-R', 'Recon'], ['U-C-F', 'Artillery'], ['U-C-F-M', 'Mortar'],
    ['U-C-D', 'Air Defense'], ['U-C-E', 'Engineer'], ['U-C-V', 'Aviation'], ['U-U-S', 'Signal'], ['U-S-M', 'Medical'], ['U-S-S', 'Supply'],
    ['U-U-M', 'Intelligence'], ['E-V-A-T', 'Tank'], ['E-V', 'Vehicle'], ['I', 'Installation']],
  A: [['M-F', 'Fixed Wing'], ['M-F-F', 'Fighter'], ['M-F-B', 'Bomber'], ['M-F-A', 'Attack'], ['M-F-C', 'Cargo'], ['M-F-R', 'Recon'],
    ['M-H', 'Helicopter'], ['M-H-A', 'Attack Heli'], ['M-H-U', 'Utility Heli'], ['M-F-Q', 'UAV / Drone'], ['W-M', 'Missile'], ['C-F', 'Civil Aircraft'], ['C-H', 'Civil Heli']],
  S: [['C', 'Combatant'], ['C-L', 'Line Ship'], ['C-A', 'Amphibious'], ['C-M', 'Mine Warfare'], ['C-P', 'Patrol'], ['N', 'Non-Combatant'],
    ['X', 'Civilian'], ['X-F', 'Fishing'], ['X-M', 'Merchant'], ['X-R', 'Leisure']],
  U: [['S', 'Submarine'], ['S-N', 'Nuclear Sub'], ['S-C', 'Conventional Sub'], ['W-T', 'Torpedo'], ['W-M', 'Sea Mine'], ['X', 'Civilian']],
  P: [['S', 'Satellite'], ['V', 'Crewed Vehicle'], ['T', 'Station']],
};
const fnLabel = {};
for (const [dim, list] of Object.entries(FUNCTIONS)) for (const [fn, label] of list) fnLabel[`${dim}-${fn}`] = label;
// only offer functions that milsymbol knows as a valid 2525 symbol
const validType = type => { try { return new ms.Symbol(sidcFor(type), { size: 20 }).isValid(); } catch (e) { return false; } };
for (const dim of Object.keys(FUNCTIONS)) FUNCTIONS[dim] = FUNCTIONS[dim].filter(([fn]) => validType(`a-f-${dim}-${fn}`));

function toolName(type) {
  if (type.startsWith('b-m-p')) return 'Point';
  const [, aff, dim, ...rest] = type.split('-');
  const fn = rest.join('-');
  const what = fn ? fnLabel[`${dim}-${fn}`] || fn : (dim !== 'G' ? DIM_LABEL[dim] : '');
  return `${AFF_LABEL[aff] || 'Unknown'}${what ? ' ' + what : ''}`;
}

let tool = null;
let mkAff = profile.mkAff || 'h';
let mkDim = profile.mkDim || 'G';

function toolButton(type, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tool';
  b.dataset.tool = type;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = symbolSvg(sidcFor(type), 28).svg + (label && type.split('-').length > 3 ? `<span>${esc(label)}</span>` : '');
  b.addEventListener('click', () => {
    const aff = type.split('-')[1];
    if (aff !== mkAff) { mkAff = aff; renderMarkerSheet(); }
    setTool(tool === type ? null : type);
  });
  return b;
}

function renderMarkerSheet() {
  profile.mkAff = mkAff;
  profile.mkDim = mkDim;
  saveProfile();
  $('mkAff').replaceChildren(...['u', 'n', 'h', 'f'].map(a => toolButton(`a-${a}-${mkDim}`, AFF_LABEL[a])));
  for (const b of document.querySelectorAll('#mkDims button')) b.classList.toggle('on', b.dataset.dim === mkDim);
  $('mkFns').replaceChildren(...FUNCTIONS[mkDim].map(([fn, label]) => toolButton(`a-${mkAff}-${mkDim}-${fn}`, label)));
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
}
for (const b of document.querySelectorAll('#mkDims button')) {
  b.addEventListener('click', () => { mkDim = b.dataset.dim; setTool(null); renderMarkerSheet(); });
}
renderMarkerSheet();

function setTool(t) {
  tool = t;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
  $('placeHint').classList.toggle('hidden', !t);
  map.getContainer().classList.toggle('drawing', !!t || measuring || drawing || !!(window.eudTools && eudTools.capturing())); // a tap hits the map
  if (t) { follow = false; $('btnLocate').classList.remove('active'); setPitch(0); }
}

function placeMarker(latlng) {
  const now = new Date();
  const type = tool;
  const uid = profile.uid + '-' + rnd(4);
  // name like ATAK: prefix + running number (without prefix: type + time)
  const prefix = ($('mkPrefix').value || '').trim();
  let name = `${toolName(type)} ${hhmm(now)}`;
  if (prefix) {
    const idx = Math.max(1, Number($('mkIndex').value) || 1);
    name = `${prefix} ${idx}`;
    $('mkIndex').value = idx + 1;
  }
  profile.markerPrefix = prefix;
  profile.markerIndex = Number($('mkIndex').value) || 1;
  saveProfile();
  const xml = `<event version="2.0" uid="${uid}" type="${type}" how="h-g-i-g-o" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 30 * 86400000))}">`
    + `<point lat="${latlng.lat.toFixed(7)}" lon="${latlng.lng.toFixed(7)}" hae="9999999" ce="9999999" le="9999999"/>`
    + `<detail><contact callsign="${xmlEsc(name)}"/>`
    + `<link uid="${xmlEsc(profile.uid)}" production_time="${cotTime(now)}" type="a-f-G-U-C" parent_callsign="${xmlEsc(profile.callsign || profile.uid)}" relation="p-p"/>`
    + `<archive/>${type.startsWith('b-m-p') ? '<color argb="-65536"/>' : ''}<remarks/></detail></event>`;
  handleCot(xml, { own: true });
  const sent = sendCot(xml, true);
  setTool(null);
  toast(sent ? `${name} sent.` : `${name} saved – will be sent once connected.`);
}


// buttons in the marker popup (video, rename, delete) – for the 2D and the 3D map
function wirePopup(root, close) {
  const play = root.querySelector('[data-play]');
  if (play) play.addEventListener('click', () => { close(); window.eudPlay(play.dataset.name, play.dataset.play); });
  const msg = root.querySelector('[data-msg]');
  if (msg) msg.addEventListener('click', () => { close(); openChat('dm:' + msg.getAttribute('data-msg')); });
  const hound = root.querySelector('[data-hound]');
  if (hound) hound.addEventListener('click', () => { close(); document.dispatchEvent(new CustomEvent('eud-hound', { detail: { uid: hound.getAttribute('data-hound') } })); });
  const mv = root.querySelector('[data-move]');
  if (mv) mv.addEventListener('click', () => { close(); startMove(mv.getAttribute('data-move')); });
  const ren = root.querySelector('[data-ren]');
  if (ren) ren.addEventListener('click', () => {
    const it = items.get(ren.getAttribute('data-ren'));
    if (!it) return;
    const name = prompt('New name:', it.c.callsign || '');
    if (name == null || !name.trim()) return;
    close();
    updateOwn(it, { name: name.trim().slice(0, 40) });
  });
  const btn = root.querySelector('[data-del]');
  if (btn) btn.addEventListener('click', () => {
    const uid = btn.getAttribute('data-del');
    const it = items.get(uid);
    if (it && !it.own && !confirm(`Delete "${it.c.callsign || toolName(it.c.type) || uid}" for everyone?`)) return;
    removeItem(uid);
    sendCot(deleteXml(uid), true);
    close();
  });
}
map.on('popupopen', e => wirePopup(e.popup.getElement(), () => map.closePopup()));

// ======================================================================
// Contacts
// ======================================================================

// content split by type, like the ATAK overlay manager: contacts (users), markers by affiliation,
// other points and drawings. Every group can be cleared on its own.
const CATS = [
  { id: 'contacts', label: 'Contacts', color: '#2fd8ff' },
  { id: 'f', label: 'Friendly', color: '#80e0ff' },
  { id: 'h', label: 'Hostile', color: '#ff8080' },
  { id: 'n', label: 'Neutral', color: '#aaffaa' },
  { id: 'u', label: 'Unknown', color: '#ffff80' },
  { id: 'points', label: 'Other points', color: '#d0d0d0' },
  { id: 'shapes', label: 'Drawings & routes', color: '#ffd400' },
];
// 2525 affiliation (3rd character of the CoT type) -> one of the four ATAK groups
const AFF_GROUP = { f: 'f', a: 'f', d: 'f', m: 'f', h: 'h', s: 'h', j: 'h', k: 'h', n: 'n', u: 'u', p: 'u', o: 'u', x: 'u', g: 'u' };
function categoryOf(it) {
  const c = it.c;
  if (!isPoint(c)) return 'shapes';
  if (c.type.startsWith('a-')) return c.team ? 'contacts' : (AFF_GROUP[c.type[2]] || 'u');
  return 'points';
}
function itemsByCat() {
  const out = Object.fromEntries(CATS.map(c => [c.id, []]));
  for (const it of items.values()) out[categoryOf(it)].push(it);
  return out;
}
function posOf(c) {
  if (Number.isFinite(c.lat) && !(c.lat === 0 && c.lon === 0)) return { lat: c.lat, lon: c.lon };
  return c.linkPoints.length ? { lat: c.linkPoints[0][0], lon: c.linkPoints[0][1] } : null;
}
function deleteXml(uid) {
  const now = new Date();
  return `<event version="2.0" uid="${xmlEsc(rnd(8))}" type="t-x-d-d" how="h-g-i-g-o" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 20000))}">`
    + `<point lat="0" lon="0" hae="9999999" ce="9999999" le="9999999"/><detail><link uid="${xmlEsc(uid)}" relation="none" type="none"/><__forcedelete/></detail></event>`;
}
// remove groups from the device. Optionally delete own markers on the TAK server too (like "Delete" in ATAK).
function clearCats(ids, { serverToo = false, before = Infinity } = {}) {
  const groups = itemsByCat();
  let n = 0;
  for (const id of ids) {
    for (const it of groups[id] || []) {
      if (it.c.time > before) continue; // newer than the admin's request: stays
      if (serverToo && it.own) sendCot(deleteXml(it.uid), true);
      removeItem(it.uid);
      n++;
    }
  }
  if (popupSec === 'contacts') renderList();
  if (popupSec === 'clear') renderClear();
  return n;
}

function listRow(it) {
  const row = document.createElement('div');
  row.className = 'contact' + (Date.now() > it.c.stale ? ' stale' : '');
  const icon = document.createElement('span');
  icon.className = 'sym';
  const cat = categoryOf(it);
  if (cat === 'contacts') {
    icon.innerHTML = `<span class="sw" style="background:${TEAMS[it.c.team] || '#0ff'}"></span>`;
  } else if (cat === 'shapes') {
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#ffd400" stroke-width="2"><path d="M3 18 9 6l6 9 6-7"/></svg>';
  } else {
    try { icon.innerHTML = symbolSvg(sidcFor(it.c.type), 18).svg; } catch (e) { icon.innerHTML = '<span class="sw"></span>'; }
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = it.c.callsign || toolName(it.c.type) || it.uid;
  const pos = posOf(it.c);
  const dist = document.createElement('span');
  dist.className = 'dist';
  dist.textContent = me && pos ? fmtDist(distance(me, pos)) : ago(it.c.time);
  row.append(icon, name, dist);
  if (it.own) row.title = 'My marker';
  row.addEventListener('click', () => {
    if (!pos) return;
    closePopup();
    follow = false;
    $('btnLocate').classList.remove('active');
    if (window.view3d && view3d.active) return view3d.focus(it, pos);
    map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 15));
    if (it.layer) it.layer.openPopup();
  });
  return row;
}

const listOpen = store.get('eud.listOpen', { contacts: true, f: true, h: true, n: true, u: true, points: false, shapes: false });
function renderList() {
  const box = $('listBody');
  box.textContent = '';
  const groups = itemsByCat();
  let any = false;
  for (const cat of CATS) {
    const list = groups[cat.id];
    if (!list.length) continue;
    any = true;
    list.sort((a, b) => String(a.c.callsign || a.uid).localeCompare(String(b.c.callsign || b.uid)));
    const head = document.createElement('div');
    head.className = 'grp' + (listOpen[cat.id] ? ' open' : '');
    head.innerHTML = `<span class="arr">▸</span><span class="sw" style="background:${cat.color}"></span><b>${esc(cat.label)}</b><span class="cnt">${list.length}</span>`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.title = `Clear ${cat.label}`;
    del.setAttribute('aria-label', del.title);
    del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(`Remove all ${list.length} "${cat.label}" from this device?` + (cat.id === 'contacts' ? '\n\nContacts come back with their next position update.' : ''))) return;
      clearCats([cat.id]);
      toast(`${cat.label} cleared`);
    });
    head.append(del);
    head.addEventListener('click', () => { listOpen[cat.id] = !listOpen[cat.id]; store.set('eud.listOpen', listOpen); renderList(); });
    box.append(head);
    if (listOpen[cat.id]) for (const it of list) box.append(listRow(it));
  }
  if (!any) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Nothing on the map yet.';
    box.append(e);
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mbtn red';
  btn.textContent = 'CLEAR CONTENT …';
  btn.addEventListener('click', () => openPopup('clear'));
  box.append(btn);
}

// Clear Content: clear several groups at once (also overlays and chat)
function renderClear() {
  const box = $('clearBody');
  box.textContent = '';
  const groups = itemsByCat();
  const ov = window.eud.overlayApi ? window.eud.overlayApi.list() : [];
  const rows = [...CATS.map(c => ({ id: c.id, label: c.id === 'contacts' ? 'Contacts (users)' : (c.id.length === 1 ? 'Markers – ' + c.label : c.label), color: c.color, n: groups[c.id].length })),
    { id: 'overlays', label: 'Overlays (KML/KMZ)', color: '#b388ff', n: ov.length },
    { id: 'chat', label: 'Chat messages', color: '#888', n: chat.length }];
  for (const r of rows) {
    const l = document.createElement('label');
    l.className = 'clr' + (r.n ? '' : ' none');
    l.innerHTML = `<input type="checkbox" value="${r.id}"${r.n && r.id !== 'contacts' && r.id !== 'chat' ? ' checked' : ''}${r.n ? '' : ' disabled'}>`
      + `<span class="sw" style="background:${r.color}"></span><span class="name">${esc(r.label)}</span><span class="cnt">${r.n}</span>`;
    box.append(l);
  }
}

$('clearAll').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('#clearBody input:not(:disabled)')];
  const on = boxes.some(b => !b.checked);
  for (const b of boxes) b.checked = on;
});
$('clearGo').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('#clearBody input:checked')].map(b => b.value);
  if (!ids.length) return toast('Nothing selected.');
  const serverToo = $('clearServer').checked;
  if (!confirm('Remove the selected content from this device?' + (serverToo ? '\n\nYour own markers are also deleted on the TAK server (for everyone).' : ''))) return;
  let n = clearCats(ids.filter(id => CATS.some(c => c.id === id)), { serverToo });
  if (ids.includes('overlays') && window.eud.overlayApi) n += await window.eud.overlayApi.clear();
  if (ids.includes('chat')) n += clearChat();
  renderClear();
  toast(`${n} item(s) removed`);
});

function clearChat(before = Infinity) {
  const keep = chat.filter(m => (m.time || 0) > before);
  const n = chat.length - keep.length;
  chat = keep;
  store.set('eud.chat', chat);
  for (const k of Object.keys(chatUnread)) delete chatUnread[k];
  unread = 0;
  updateBadge();
  renderChat();
  return n;
}

// Clear map asked by the admin (TAKweb admin → Clear map): on every (re)connection until the user
// cleared it – then never again for this request. Only what is older than the request is removed.
const MC_LABEL = { contacts: 'Contacts (users)', f: 'Markers – Friendly', h: 'Markers – Hostile', n: 'Markers – Neutral', u: 'Markers – Unknown',
  points: 'Other points', shapes: 'Drawings & routes', overlays: 'Overlays (KML/KMZ)', chat: 'Chat messages' };
let mcRequest = null;
function askMapClear(r) {
  if (!r) { mcRequest = null; $('mapClear').classList.add('hidden'); return; } // withdrawn by the admin
  if (profile.mapClearDone === r.id || (mcRequest && mcRequest.id === r.id && !$('mapClear').classList.contains('hidden'))) return;
  mcRequest = r;
  const before = Date.parse(r.time) || Date.now();
  const groups = itemsByCat();
  const ov = window.eud.overlayApi ? window.eud.overlayApi.list().length : 0;
  const count = id => (groups[id] ? groups[id].filter(it => it.c.time <= before).length : id === 'overlays' ? ov : id === 'chat' ? chat.filter(m => (m.time || 0) <= before).length : 0);
  $('mcText').textContent = `The administrator asks to clear the map (${new Date(before).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}):`;
  $('mcNote').textContent = r.note || '';
  $('mcList').replaceChildren(...r.cats.map(id => {
    const row = document.createElement('div');
    row.className = 'clr';
    row.innerHTML = `<span class="name">${esc(MC_LABEL[id] || id)}</span><span class="cnt">${count(id)}</span>`;
    return row;
  }));
  $('mapClear').classList.remove('hidden');
}
$('mcLater').addEventListener('click', () => { $('mapClear').classList.add('hidden'); toast('You will be asked again at the next connection.'); });
$('mcGo').addEventListener('click', async () => {
  const r = mcRequest;
  $('mapClear').classList.add('hidden');
  if (!r) return;
  const before = Date.parse(r.time) || Date.now();
  let n = clearCats(r.cats.filter(id => CATS.some(c => c.id === id)), { before });
  if (r.cats.includes('overlays') && window.eud.overlayApi) n += await window.eud.overlayApi.clear();
  if (r.cats.includes('chat')) n += clearChat(before);
  profile.mapClearDone = r.id;
  profile.mapCleared = { before, cats: r.cats };
  saveProfile();
  toast(`Map cleared: ${n} item(s) removed.`);
});

// ======================================================================
// Callsign
// ======================================================================

for (const t of Object.keys(TEAMS)) $('fTeam').append(new Option(t, t));
for (const r of ROLES) $('fRole').append(new Option(r, r));
// set by the admin (managed TAK access): team and role are locked in the menu. The callsign is only a
// suggestion – the user can change it (several players may share one login for a quick game); a new
// callsign from the admin is only taken over if the user did not change the last one.
const takeCallsign = (next, prev) => !!next && (!profile.callsign || (profile.callsign === prev && next !== prev));
function applyAssignment(a) {
  const before = { callsign: profile.callsign, team: profile.team, role: profile.role };
  const prev = profile.assigned ? profile.assigned.callsign : undefined;
  profile.assigned = { callsign: String(a.callsign || ''), team: TEAMS[a.team] ? a.team : profile.team, role: ROLES.includes(a.role) ? a.role : profile.role };
  if (takeCallsign(profile.assigned.callsign, prev)) profile.callsign = profile.assigned.callsign;
  profile.team = profile.assigned.team;
  profile.role = profile.assigned.role;
  const changed = before.callsign !== profile.callsign || before.team !== profile.team || before.role !== profile.role;
  saveProfile();
  showMe();
  if (typeof updateSelfInfo === 'function') updateSelfInfo();
  if (me) drawMe();
  if (popupSec === 'me') fillMe();
  if (changed) { toast(`Assigned by administrator: ${profile.callsign} (${profile.team})`, 5000); sendSelf(); }
}

// settings from the TAK server's device profile (like ATAK): callsign, team, role – an administrator's
// assignment (TAKweb) has priority
function applyProfilePrefs(p) {
  if (!p || profile.assigned) return;
  // callsign: like an admin's assignment only when the user did not change the server's last one
  const prev = profile.serverCallsign;
  if (p.callsign) profile.serverCallsign = p.callsign;
  const next = { callsign: takeCallsign(p.callsign, prev) ? p.callsign : profile.callsign, team: TEAMS[p.team] ? p.team : profile.team, role: ROLES.includes(p.role) ? p.role : profile.role };
  if (next.callsign === profile.callsign && next.team === profile.team && next.role === profile.role) return;
  Object.assign(profile, next);
  saveProfile();
  showMe();
  if (typeof updateSelfInfo === 'function') updateSelfInfo();
  if (me) drawMe();
  toast(`Set by the TAK server: ${profile.callsign} (${profile.team}, ${profile.role})`, 5000);
  sendSelf();
}
// map sources from a device profile: into the map menu (kept on the device)
function addTakMaps(list) {
  const known = store.get('eud.takMaps', []);
  let added = 0;
  for (const m of list || []) {
    const id = 'tak-' + (m.name || m.url).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const rec = { id, name: m.name, url: m.url, maxZoom: m.maxZoom };
    const i = known.findIndex(k => k.id === id);
    if (i >= 0) known[i] = rec; else { known.push(rec); added++; }
    const isNew = !SOURCES[id];
    SOURCES[id] = { name: m.name + ' (TAK server)', maxZoom: m.maxZoom || 19, attribution: '', url: m.url };
    if (isNew) $('fTiles').insertBefore(new Option(SOURCES[id].name, id), $('fTiles').querySelector('option[value="custom"]'));
  }
  store.set('eud.takMaps', known);
  return added;
}

function fillMe() {
  $('fCallsign').value = profile.callsign;
  $('fTeam').value = profile.team;
  $('fRole').value = profile.role;
  const locked = !!profile.assigned;
  for (const id of ['fTeam', 'fRole']) $(id).disabled = locked;
  $('meLocked').classList.toggle('hidden', !locked);
  $('uidText').textContent = profile.uid;
}
// Android: the app (background location) – in the browser download / open in the app, in the app change the server
(() => {
  const android = /Android/i.test(navigator.userAgent);
  if (!android && !nativeApp) return;
  $('appBox').classList.remove('hidden');
  if (nativeApp) {
    $('appBtns').classList.add('hidden');
    $('appServer').classList.remove('hidden');
    $('appText').textContent = `TAKweb app · server ${location.host}. Your position is also sent with the screen locked (notification "TAKweb").`;
    $('appServer').addEventListener('click', () => {
      if (confirm('Choose another TAKweb server? The app starts again.')) appPlugins.TakWeb.setServer({ url: '' });
    });
    return;
  }
  $('appText').textContent = 'The TAKweb app for Android keeps sending your position with the screen locked. Install it, then tap "Open in the app" – server and login are taken over.';
  // the invitation this page was opened with (login included), otherwise just this server
  $('appOpen').href = 'takweb://open?u=' + encodeURIComponent(location.origin + location.pathname + (/host=/.test(launchHash) ? launchHash : ''));
})();

$('meSave').addEventListener('click', () => {
  const call = $('fCallsign').value.trim();
  if (!call) { $('fCallsign').focus(); return; }
  profile.callsign = call;
  if (!profile.assigned) {
    profile.team = $('fTeam').value;
    profile.role = $('fRole').value;
  }
  saveProfile();
  if (typeof updateSelfInfo === 'function') updateSelfInfo();
  if (me) drawMe();
  showMe();
  sendSelf();
  closePopup();
  if (!servers.length) openEdit(null);
});

// ======================================================================
// Servers: list, edit, certificate, files, QR
// ======================================================================

const STATE_TEXT = { connected: 'connected', connecting: 'connecting …', offline: 'relay not reachable', idle: 'disconnected' };

function renderServers() {
  const box = $('srvList');
  box.textContent = '';
  if (!servers.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No server set up yet.';
    box.append(e);
  }
  for (const srv of servers) {
    const c = connOf(srv);
    const el = document.createElement('div');
    el.className = 'srv';
    const dotKind = !srv.auto ? '' : c.state === 'connected' ? 'ok' : ['error', 'untrusted'].includes(c.state) ? 'err' : 'warn';
    el.innerHTML = `<div class="srv-h"><span class="dot ${dotKind}"></span><span class="srv-name"></span><span class="srv-proto"></span><button type="button" class="srv-del" aria-label="Remove">×</button></div>`
      + `<div class="srv-url"></div><div class="srv-info"></div><div class="srv-acts"><button type="button" class="act"></button><button type="button" class="edit">EDIT</button></div>`;
    el.querySelector('.srv-name').textContent = srv.name || srv.host;
    el.querySelector('.srv-proto').textContent = srv.proto.toUpperCase();
    el.querySelector('.srv-url').textContent = `${srv.host}:${srv.port}` + (srv.proto === 'ssl' ? (srv.certPem ? ' · certificate ✓' : ' · no certificate') : '');
    const info = el.querySelector('.srv-info');
    info.textContent = !srv.auto ? 'disconnected' : (c.state === 'error' || c.state === 'untrusted' || (c.state === 'offline' && c.message) ? c.message : STATE_TEXT[c.state] || c.state);
    info.classList.toggle('err', srv.auto && ['error', 'untrusted'].includes(c.state));
    const act = el.querySelector('.act');
    act.textContent = srv.auto ? 'DISCONNECT' : 'CONNECT';
    act.className = srv.auto ? 'dis' : 'con';
    act.onclick = () => (srv.auto ? disconnectServer(srv) : (profile.callsign ? connectServer(srv) : askCallsign()));
    el.querySelector('.edit').onclick = () => openEdit(srv);
    el.querySelector('.srv-del').onclick = () => { if (confirm(`Remove server "${srv.name || srv.host}"?`)) removeServer(srv); };
    box.append(el);
  }
}

function askCallsign(msg) {
  openPopup('me');
  toast(msg || 'Please enter a callsign first.', msg ? 6000 : undefined);
  $('fCallsign').focus();
}

// editing works on a copy; "Save & connect" applies it
let draft = null;
let draftOrig = null;

function openEdit(srv) {
  // on the radio (mesh only) there is no TAKweb server behind the page: servers are reached through the TAKweb server
  if (MESH_ONLY) return openPopup('server');
  draftOrig = srv;
  draft = srv ? JSON.parse(JSON.stringify(srv)) : newServer();
  openPopup('edit', srv ? 'Edit server' : 'Add server');
  fillEdit();
  setMsg($('setupMsg'), '');
  $('fPass').value = '';
  $('p12Box').classList.add('hidden');
  pendingP12 = null;
}
$('addSrvBtn').addEventListener('click', () => openEdit(null));
$('editCancel').addEventListener('click', () => { draft = null; openPopup('server'); }); // BACK = discard

function fillEdit() {
  $('fName').value = draft.name || '';
  $('fHost').value = draft.host;
  $('fPort').value = draft.port || '';
  $('fProto').value = draft.proto;
  $('fEnroll').value = draft.enrollPort || '';
  $('fApi').value = draft.apiPort || '';
  $('fUser').value = draft.username || '';
  updateCertState();
}

function readEdit() {
  const host = $('fHost').value.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '');
  const prevHost = draft.host;
  if (host !== draft.host) draft.fingerprint = '';
  draft.host = host;
  draft.name = $('fName').value.trim();
  draft.port = Number($('fPort').value) || DEFAULT_PORT[$('fProto').value];
  draft.proto = $('fProto').value;
  draft.enrollPort = Number($('fEnroll').value) || 8446;
  draft.apiPort = Number($('fApi').value) || 8443;
  const user = $('fUser').value.trim();
  if (host !== prevHost || user !== draft.username) draft.password = ''; // the remembered login no longer fits
  draft.username = user;
}

function updateCertState() {
  $('sslBox').classList.toggle('hidden', $('fProto').value !== 'ssl');
  const st = $('certState');
  const i = draft.certInfo;
  if (draft.certPem) {
    st.textContent = '✓ ' + (i ? `${i.subject}${i.validTo ? ' · until ' + new Date(i.validTo).toLocaleDateString('en-GB') : ''}` : 'Certificate present')
      + (draft.caPems.length ? ` · ${draft.caPems.length} CA` : '');
    st.className = 'state ok';
  } else {
    st.textContent = draft.caPems.length ? `Truststore loaded (${draft.caPems.length} CA) – no client certificate yet` : 'No certificate – request one or import .p12 / data package';
    st.className = 'state';
  }
}
$('fProto').addEventListener('change', () => {
  if (!$('fPort').value || Object.values(DEFAULT_PORT).includes(Number($('fPort').value))) $('fPort').value = DEFAULT_PORT[$('fProto').value];
  updateCertState();
});

// 127.0.0.1 / localhost = this phone (e.g. TAK server in the Meshtastic app). A web app cannot
// open TCP/TLS connections, and the relay cannot reach the phone.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/i;
const LOCAL_MSG = 'This address is the phone itself (e.g. Meshtastic app): a web app cannot reach it – this needs the EUD as an installed app.';

$('editSave').addEventListener('click', () => {
  readEdit();
  const msg = $('setupMsg');
  if (!draft.host) return setMsg(msg, 'Please enter an address.');
  if (LOCAL_HOST.test(draft.host)) return setMsg(msg, LOCAL_MSG);
  saveDraft();
  draft = null;
  if (!profile.callsign) return askCallsign();
  openPopup('server');
});

function saveDraft() {
  if (!draft.name) draft.name = draft.host;
  if (draftOrig) {
    const keepAuto = draftOrig.auto;
    Object.assign(draftOrig, draft, { auto: keepAuto });
    draft = draftOrig;
  } else {
    servers.push(draft);
    draftOrig = draft;
  }
  saveServers();
  if (profile.callsign) connectServer(draftOrig);
  else updateStatus();
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('Server not reachable – this needs a connection.');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) { const err = new Error(data.error || 'Error ' + res.status); Object.assign(err, data, { status: res.status }); throw err; }
  return data;
}

function addCas(srv, pems) {
  for (const p of pems || []) if (!srv.caPems.includes(p)) srv.caPems.push(p);
}

async function requestCert(password) {
  readEdit();
  const msg = $('setupMsg');
  if (!draft.host) return setMsg(msg, 'Please enter an address.');
  if (!draft.username || !password) return setMsg(msg, 'Please enter user and password.');
  setMsg(msg, 'Requesting certificate …', true);
  $('enrollBtn').disabled = true;
  try {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await postJson('/api/eud/enroll', {
          host: draft.host, port: draft.enrollPort, username: draft.username, password,
          uid: profile.uid, caPems: draft.caPems, fingerprint: draft.fingerprint,
        });
        draft.certPem = r.certPem;
        draft.keyPem = r.keyPem;
        draft.certInfo = r.info;
        draft.enrollProfile = true; // fetch the enrollment profile (maps, data packages) on the next connection, like ATAK
        draft.password = password; // confirmed by the TAK server: the drone/camera address (RTMP/SRT) needs it, like ATAK keeps it
        addCas(draft, r.caPems);
        $('fPass').value = '';
        setMsg(msg, 'Certificate received.', true);
        updateCertState();
        return true;
      } catch (e) {
        if (e.code !== 'UNTRUSTED' || i) throw e;
        const ok = await askTrust(`${draft.host}:${draft.enrollPort}`, e.fingerprint, e.subject);
        if (!ok) { setMsg(msg, 'Cancelled.'); return false; }
        draft.fingerprint = e.fingerprint;
      }
    }
  } catch (e) {
    setMsg(msg, e.message);
  } finally {
    $('enrollBtn').disabled = false;
  }
  return false;
}
$('enrollBtn').addEventListener('click', () => requestCert($('fPass').value));

// trust question for an unknown server certificate
function askTrust(host, fingerprint, subject) {
  return new Promise(resolve => {
    $('trustHost').textContent = host;
    $('trustSubject').textContent = subject || '';
    $('trustFp').textContent = fingerprint;
    $('trust').classList.remove('hidden');
    const done = ok => {
      $('trust').classList.add('hidden');
      $('trustYes').onclick = $('trustNo').onclick = null;
      resolve(ok);
    };
    $('trustYes').onclick = () => done(true);
    $('trustNo').onclick = () => done(false);
  });
}

// ---------------- Files: data package, .p12, truststore ----------------

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Cannot read file.'));
    r.readAsDataURL(file);
  });
}

async function loadFile(file) {
  const msg = $('setupMsg');
  readEdit();
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.zip')) {
      const r = await postJson('/api/eud/package', { data: await fileBase64(file) });
      if (r.server) {
        if (r.server.host !== draft.host) draft.fingerprint = '';
        Object.assign(draft, { host: r.server.host, port: r.server.port, proto: r.server.proto });
        if (!draft.name && r.server.description) draft.name = r.server.description;
      }
      if (r.certPem) Object.assign(draft, { certPem: r.certPem, keyPem: r.keyPem, certInfo: r.info });
      addCas(draft, r.caPems);
      fillEdit();
      if (LOCAL_HOST.test(draft.host)) return setMsg(msg, LOCAL_MSG);
      setMsg(msg, 'Data package loaded' + (r.server ? ': ' + r.server.host : '') + (r.enroll && !r.certPem ? ' – enter user/password and request a certificate.' : '.'), true);
    } else if (/\.(p12|pfx)$/.test(name)) {
      // first with the ATAK default password, otherwise a password field in the form (prompt() is partly missing in iPhone web apps)
      const data = await fileBase64(file);
      try {
        applyP12(await postJson('/api/eud/p12', { data, password: 'atakatak' }));
      } catch (e) {
        if (e.status !== 400) throw e;
        pendingP12 = { data, name: file.name };
        $('p12Name').textContent = file.name;
        $('p12Pass').value = '';
        $('p12Box').classList.remove('hidden');
        $('p12Pass').focus();
        setMsg(msg, 'Enter the password of the file and tap OPEN.');
      }
    } else {
      const r = await postJson('/api/eud/pem', { data: await file.text() });
      addCas(draft, r.caPems);
      updateCertState();
      setMsg(msg, `Truststore loaded (${r.caPems.length} CA).`, true);
    }
  } catch (e) {
    setMsg(msg, e.message);
  }
}
let pendingP12 = null;
function applyP12(r) {
  if (r.kind === 'client') Object.assign(draft, { certPem: r.certPem, keyPem: r.keyPem, certInfo: r.info });
  addCas(draft, r.caPems);
  updateCertState();
  $('p12Box').classList.add('hidden');
  pendingP12 = null;
  setMsg($('setupMsg'), r.kind === 'client' ? 'Certificate loaded.' : `Truststore loaded (${r.caPems.length} CA).`, true);
}
async function openP12() {
  if (!pendingP12) return;
  $('p12Ok').disabled = true;
  try {
    applyP12(await postJson('/api/eud/p12', { data: pendingP12.data, password: $('p12Pass').value }));
  } catch (e) {
    setMsg($('setupMsg'), e.message);
  } finally {
    $('p12Ok').disabled = false;
  }
}
$('p12Ok').addEventListener('click', openP12);
$('p12Pass').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); openP12(); } });

$('fileIn').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); });

// ---------------- QR-Codes ----------------

// Supported: ATAK enrollment (tak://com.atakmap.app/enroll?...), iTAK (name,host,port,proto),
// own link (…/eud/#host=…), JSON {host,port,proto,username,password} and "host:port:ssl"
function parseQr(text) {
  text = String(text || '').trim();
  const out = {};
  const fromParams = sp => {
    for (const [k, v] of sp) {
      const key = k.toLowerCase();
      if (key === 'host' || key === 'server') out.host = v;
      else if (key === 'port') out.port = Number(v);
      else if (key === 'proto' || key === 'protocol') out.proto = v.toLowerCase();
      else if (key === 'enroll' || key === 'enrollport') out.enrollPort = Number(v);
      else if (key === 'username' || key === 'user') out.username = v;
      else if (key === 'token' || key === 'password') out.password = v;
      else if (key === 'callsign') out.callsign = v;
      else if (key === 'name') out.name = v;
    }
  };
  if (/^tak:\/\//i.test(text)) {
    const u = new URL(text.replace(/^tak:/i, 'https:'));
    if (!/enroll/i.test(u.pathname)) throw new Error('This TAK code is not supported (enrollment only).');
    fromParams(u.searchParams);
    if (out.host && out.host.includes(':')) { const [h, p] = out.host.split(':'); out.host = h; out.enrollPort = Number(p) || out.enrollPort; }
    out.proto = 'ssl';
  } else if (/^https?:\/\//i.test(text)) {
    const u = new URL(text);
    fromParams(new URLSearchParams(u.hash.slice(1)));
    if (!out.host) fromParams(u.searchParams);
    if (!out.host) out.host = u.hostname;
  } else if (text.startsWith('{')) {
    fromParams(Object.entries(JSON.parse(text)).map(([k, v]) => [k, String(v)]));
  } else if (text.split(',').length === 4) {
    const [name, host, port, proto] = text.split(',').map(s => s.trim());
    Object.assign(out, { name, host, port: Number(port), proto: proto.toLowerCase() === 'quic' ? 'ssl' : proto.toLowerCase() });
  } else if (/^[\w.-]+:\d+(:\w+)?$/.test(text)) {
    const [host, port, proto] = text.split(':');
    Object.assign(out, { host, port: Number(port), proto: (proto || 'ssl').toLowerCase() });
  } else {
    throw new Error('Unknown QR code.');
  }
  if (out.proto && !['ssl', 'tcp', 'udp'].includes(out.proto)) out.proto = 'ssl';
  if (!out.host) throw new Error('The QR code contains no server.');
  return out;
}

// apply server data: into the open draft, otherwise into the matching or a new server
async function applyConfig(cfg, auto) {
  if (MESH_ONLY) { openPopup('server'); return; } // see openEdit
  if (!draft || popupSec !== 'edit') {
    const existing = servers.find(s => s.host === cfg.host && (!cfg.port || s.port === cfg.port));
    openEdit(existing || null);
  }
  if (cfg.host !== draft.host) {
    draft.fingerprint = '';
    if (draft.host) Object.assign(draft, { certPem: '', keyPem: '', certInfo: null, caPems: [] }); // another server: the old certificate does not fit
  }
  draft.host = cfg.host;
  if (cfg.name && !draft.name) draft.name = cfg.name;
  if (cfg.port) draft.port = cfg.port;
  if (cfg.proto) draft.proto = cfg.proto;
  if (cfg.enrollPort) draft.enrollPort = cfg.enrollPort;
  if (cfg.username) draft.username = cfg.username;
  const fresh = !profile.callsign;
  if (cfg.callsign && !profile.callsign) { profile.callsign = cfg.callsign; saveProfile(); showMe(); }
  fillEdit();
  if (cfg.password) $('fPass').value = cfg.password;
  if (LOCAL_HOST.test(cfg.host)) return setMsg($('setupMsg'), LOCAL_MSG);
  setMsg($('setupMsg'), 'Server settings applied.', true);
  if (auto && cfg.username && cfg.password && draft.proto === 'ssl') {
    const ok = await requestCert(cfg.password);
    if (ok) {
      saveDraft();
      if (fresh) askCallsign('Check your callsign – several players can share one login, each with an own callsign.');
      else openPopup('server');
    }
  }
}

let scanStream = null, scanRaf = 0;
function decodeImage(source, w, h) {
  const cv = document.createElement('canvas');
  const scale = Math.min(1, 1000 / Math.max(w, h));
  cv.width = Math.round(w * scale);
  cv.height = Math.round(h * scale);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, cv.width, cv.height);
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}
function onQr(text) {
  stopScan();
  // on the radio: an invitation link of a TAKweb server opens that server (its certificate request needs it)
  if (MESH_ONLY && /^https?:\/\//i.test(text)) {
    try { store.set('eud.webUrl', new URL(text).origin + '/eud/'); } catch (e) { /* keep */ }
    location.href = radioLink(text);
    return;
  }
  try {
    applyConfig(parseQr(text), true);
  } catch (e) {
    setMsg($('setupMsg'), e.message);
  }
}
async function startScan() {
  $('scanner').classList.remove('hidden');
  $('scanMsg').textContent = 'Hold the QR code inside the frame';
  const video = $('scanVideo');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = scanStream;
    await video.play();
    const step = () => {
      if (!scanStream) return;
      if (video.readyState >= 2) {
        const text = decodeImage(video, video.videoWidth, video.videoHeight);
        if (text) return onQr(text);
      }
      scanRaf = requestAnimationFrame(step);
    };
    step();
  } catch (e) {
    $('scanMsg').textContent = 'Camera not available – use "Pick photo".';
  }
}
function stopScan() {
  cancelAnimationFrame(scanRaf);
  if (scanStream) for (const t of scanStream.getTracks()) t.stop();
  scanStream = null;
  $('scanVideo').srcObject = null;
  $('scanner').classList.add('hidden');
}
$('scanBtn').addEventListener('click', startScan);
$('scanClose').addEventListener('click', stopScan);
$('scanFile').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const img = new Image();
  img.onload = () => {
    const text = decodeImage(img, img.naturalWidth, img.naturalHeight);
    URL.revokeObjectURL(img.src);
    if (text) onQr(text);
    else $('scanMsg').textContent = 'No QR code found in the photo.';
  };
  img.src = URL.createObjectURL(f);
});

// ======================================================================
// Map: map type, save offline, screen, delete
// ======================================================================

$('fTiles').addEventListener('change', () => setTiles($('fTiles').value));

let wakeSentinel = null;
async function wakeLock() {
  try { if ('wakeLock' in navigator && !wakeSentinel) { wakeSentinel = await navigator.wakeLock.request('screen'); wakeSentinel.onrelease = () => { wakeSentinel = null; }; } } catch (e) { /* not allowed */ }
}
$('f3d').addEventListener('change', () => {
  setPitch(0);
  profile.map3d = $('f3d').checked;
  saveProfile();
  pitchUi(0);
});
$('fStart3d').addEventListener('change', () => { profile.start3d = $('fStart3d').checked; saveProfile(); });
$('fExag').addEventListener('change', () => { profile.exag = Number($('fExag').value) || 1; saveProfile(); if (window.view3d) view3d.baseChanged(); });
$('fWake').addEventListener('change', () => {
  profile.wake = $('fWake').checked;
  saveProfile();
  if (profile.wake) wakeLock();
  else if (wakeSentinel) wakeSentinel.release();
});

$('clearPicBtn').addEventListener('click', () => {
  for (const uid of [...items.keys()]) removeItem(uid);
  chat = [];
  store.set('eud.chat', chat);
  renderChat();
  toast('Map data cleared.');
});
$('resetBtn').addEventListener('click', () => {
  if (!confirm('Delete all data on this device (servers, certificates, map data)?')) return;
  for (const srv of servers) closeSock(srv);
  for (const k of ['eud.profile', 'eud.servers', 'eud.picture', 'eud.chat', 'eud.outbox', 'eud.outbox2', 'eud.view', 'eud.video', 'eud.areas']) store.del(k);
  location.reload();
});

// ---------------- Kartenquelle ----------------

for (const [id, src] of Object.entries(SOURCES)) $('fTiles').append(new Option(src.name, id));
$('fTiles').append(new Option('Custom source (URL) …', 'custom'));
function fillMap() {
  $('fTiles').value = profile.tiles;
  $('fCustom').value = profile.customUrl || '';
  $('customBox').classList.toggle('hidden', profile.tiles !== 'custom');
  $('fWake').checked = !!profile.wake;
  $('f3d').checked = profile.map3d !== false;
  $('f3d').disabled = !(window.view3d && view3d.supported);
  $('fStart3d').checked = profile.start3d !== false;
  $('fExag').value = String(profile.exag || 1);
  $('no3d').classList.toggle('hidden', !!(window.view3d && view3d.supported));
  fillZoom();
  renderAreas();
  updateEstimate();
}
$('fTiles').addEventListener('change', () => {
  const id = $('fTiles').value;
  $('customBox').classList.toggle('hidden', id !== 'custom');
  if (id !== 'custom') setTiles(id);
  else if (profile.customUrl) setTiles('custom');
  fillZoom();
  updateEstimate();
});
$('customSave').addEventListener('click', () => {
  const u = $('fCustom').value.trim();
  if (!/^https?:\/\/.+\{z\}.+\{x\}.+\{y\}|^https?:\/\/.+\{z\}.+\{y\}.+\{x\}/i.test(u)) return toast('The URL needs {z}, {x} and {y}.');
  profile.customUrl = u;
  saveProfile();
  setTiles('custom');
  toast('Map source applied.');
});

// ---------------- Save offline: area or corridor ----------------

let areaMode = 'view';
let corridor = []; // [[lat, lon], …]
let corridorLine = null;
let drawing = false;
let areas = store.get('eud.areas', []);

function fillZoom() {
  const max = sourceMaxZoom(profile.tiles);
  const z = map.getZoom();
  for (const [id, def] of [['fZmin', Math.max(1, z - 2)], ['fZmax', Math.min(max, z + 3)]]) {
    const sel = $(id);
    const keep = sel.value;
    sel.replaceChildren(...Array.from({ length: max }, (_, i) => new Option(String(i + 1), String(i + 1))));
    sel.value = keep && Number(keep) <= max ? keep : String(def);
  }
}

for (const b of document.querySelectorAll('#areaMode button')) {
  b.addEventListener('click', () => {
    areaMode = b.dataset.mode;
    for (const x of document.querySelectorAll('#areaMode button')) x.classList.toggle('on', x === b);
    $('corridorBox').classList.toggle('hidden', areaMode !== 'corridor');
    updateEstimate();
  });
}
for (const id of ['fZmin', 'fZmax', 'fWidth']) $(id).addEventListener('change', updateEstimate);
$('fWidth').addEventListener('input', updateEstimate);

const tileX = (lon, n) => Math.floor((lon + 180) / 360 * n);
const tileY = (lat, n) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };

// tiles of an area: { kind: 'rect', s, w, n, e } or { kind: 'corridor', points, width }
function areaTiles(area, zmin, zmax, limit = 50000) {
  const out = new Set();
  const addBox = (s, w, n, e, z) => {
    const N = 2 ** z;
    for (let x = Math.max(0, tileX(w, N)); x <= Math.min(N - 1, tileX(e, N)); x++) {
      for (let y = Math.max(0, tileY(n, N)); y <= Math.min(N - 1, tileY(s, N)); y++) {
        out.add(z + '/' + x + '/' + y);
        if (out.size > limit) return false;
      }
    }
    return true;
  };
  for (let z = zmin; z <= zmax; z++) {
    if (area.kind === 'rect') {
      if (!addBox(area.s, area.w, area.n, area.e, z)) return null;
    } else {
      const pts = area.points;
      const dLat = area.width / 111320;
      // step smaller than one tile of this zoom level
      const step = Math.min(area.width, 40075016 / 2 ** z / 2);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[i + 1] || pts[i];
        const len = distance({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
        const n = Math.max(1, Math.ceil(len / step));
        for (let k = 0; k <= n; k++) {
          const lat = a[0] + (b[0] - a[0]) * k / n, lon = a[1] + (b[1] - a[1]) * k / n;
          const dLon = area.width / (111320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
          if (!addBox(lat - dLat, lon - dLon, lat + dLat, lon + dLon, z)) return null;
        }
      }
    }
  }
  return [...out];
}

function currentArea() {
  if (areaMode === 'corridor') {
    if (corridor.length < 2) return null;
    return { kind: 'corridor', points: corridor.slice(), width: Math.max(50, Math.min(20000, Number($('fWidth').value) || 1000)) };
  }
  const b = map.getBounds();
  return { kind: 'rect', s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
}

function zoomRange() {
  let a = Number($('fZmin').value), b = Number($('fZmax').value);
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

function updateEstimate() {
  if (popupSec !== 'map') return;
  const area = currentArea();
  if (!area) { $('estimate').textContent = 'Draw a corridor, then choose zoom levels.'; return; }
  const [a, b] = zoomRange();
  const list = areaTiles(area, a, b, 20000);
  const dem = list && use3d() ? (areaTiles(area, a, Math.min(b, 15), 20000) || []).length : 0;
  $('estimate').textContent = list
    ? `≈ ${list.length} tiles${dem ? ` + ${dem} terrain tiles (3D)` : ''}, approx. ${Math.max(1, Math.round(list.length * 0.02 + dem * 0.04))} MB`
    : 'Too many tiles (over 20,000) – lower "zoom to" or use a smaller area.';
}
map.on('moveend', updateEstimate);

function tileUrl(src, key) {
  const [z, x, y] = key.split('/');
  return new URL(sourceTemplate(src).replace('{z}', z).replace('{x}', x).replace('{y}', y), location.href).href;
}

// drawing a corridor: tap points
function startDraw() {
  drawing = true;
  setPitch(0);
  if (measuring) toggleMeasure();
  map.getContainer().classList.add('drawing'); // a tap hits the map, not markers/overlays
  corridor = [];
  drawCorridor();
  closePopup();
  setTool(null);
  $('drawBar').classList.remove('hidden');
  $('drawHint').textContent = 'Tap the points of the route on the map';
}
function drawCorridor() {
  if (corridorLine) corridorLine.remove();
  corridorLine = null;
  if (!corridor.length) return;
  const width = Math.max(50, Number($('fWidth').value) || 1000);
  // roughly convert the width into pixels of the current zoom level (display only)
  const mpp = 40075016 * Math.cos(corridor[0][0] * Math.PI / 180) / (256 * 2 ** map.getZoom());
  corridorLine = L.layerGroup([
    L.polyline(corridor, { color: '#007bff', weight: Math.max(4, Math.min(200, 2 * width / mpp)), opacity: 0.2, interactive: false }),
    L.polyline(corridor, { color: '#007bff', weight: 3, dashArray: '6 6', interactive: false }),
    ...corridor.map(p => L.circleMarker(p, { radius: 5, color: '#fff', weight: 2, fillColor: '#007bff', fillOpacity: 1, interactive: false })),
  ]).addTo(map);
}
map.on('click', e => {
  if (movingUid) return moveTo(e.latlng.lat, e.latlng.lng); // MOVE: tap = new position
  if (window.eudMapTap && window.eudMapTap(e.latlng)) return; // drawing shapes, picking a Bloodhound target (tools.js)
  if (tool) return placeMarker(e.latlng); // symbol selected: a tap places the marker (like ATAK)
  if (measuring) return addMeasurePoint(e.latlng);
  if (!drawing) return;
  corridor.push([e.latlng.lat, e.latlng.lng]);
  drawCorridor();
  $('drawHint').textContent = `${corridor.length} point(s) – keep tapping or DONE`;
});
map.on('zoomend', () => { if (corridor.length) drawCorridor(); });
$('moveCancel').addEventListener('click', endMove);
$('drawUndo').addEventListener('click', () => { corridor.pop(); drawCorridor(); });
$('drawCancel').addEventListener('click', () => { drawing = false; map.getContainer().classList.remove('drawing'); corridor = []; drawCorridor(); $('drawBar').classList.add('hidden'); openPopup('map'); });
$('drawDone').addEventListener('click', () => {
  if (corridor.length < 2) return toast('Tap at least two points.');
  drawing = false;
  map.getContainer().classList.remove('drawing');
  $('drawBar').classList.add('hidden');
  let len = 0;
  for (let i = 1; i < corridor.length; i++) len += distance({ lat: corridor[i - 1][0], lon: corridor[i - 1][1] }, { lat: corridor[i][0], lon: corridor[i][1] });
  openPopup('map');
  $('corridorInfo').textContent = `Corridor: ${corridor.length} points, ${fmtDist(len)} long.`;
  updateEstimate();
});
$('drawBtn').addEventListener('click', startDraw);

// saving via the service worker (keeps running even when the window is closed)
let prefetchPort = null;
async function swReady() {
  if (pageTiles) return null;
  // "ready" never settles when the worker could not be installed: do not wait forever
  const reg = await Promise.race([navigator.serviceWorker.ready.catch(() => null), new Promise(r => setTimeout(() => r(null), 3000))]);
  return reg && reg.active ? reg.active : null;
}
$('prefetchBtn').addEventListener('click', async () => {
  const msg = $('prefetchMsg');
  const area = currentArea();
  if (!area) return setMsg(msg, 'Please draw a corridor first.');
  if (profile.tiles === 'custom' && !profile.customUrl) return setMsg(msg, 'Please enter a custom source first.');
  const [zmin, zmax] = zoomRange();
  const keys = areaTiles(area, zmin, zmax, 20000);
  if (!keys) return setMsg(msg, 'Too many tiles – lower "zoom to" or use a smaller area.');
  const sw = await swReady();
  if (!sw && !(pageTiles && window.indexedDB)) return setMsg(msg, 'Offline storage not available in this browser.');
  const rec = { id: rnd(4), kind: area.kind, src: profile.tiles, srcName: profile.tiles === 'custom' ? 'Custom source' : SOURCES[profile.tiles].name,
    zmin, zmax, count: keys.length, date: Date.now(), area, template: sourceTemplate(profile.tiles) };
  const ch = new MessageChannel();
  prefetchPort = ch.port1;
  $('prefetchBtn').disabled = true;
  $('prefetchStop').classList.remove('hidden');
  const onProgress = d => {
    if (!d.finished) return setMsg(msg, `Saving … ${d.done} / ${d.total}`, true);
    $('prefetchBtn').disabled = false;
    $('prefetchStop').classList.add('hidden');
    prefetchPort = null;
    setMsg(msg, `${d.stopped ? 'Stopped' : 'Done'}: ${d.done - d.failed} tiles saved${d.failed ? `, ${d.failed} failed` : ''}.`, !d.failed);
    if (d.done - d.failed > 0) {
      rec.count = d.done - d.failed;
      areas.unshift(rec);
      areas = areas.slice(0, 30);
      store.set('eud.areas', areas);
      renderAreas();
    }
  };
  ch.port1.onmessage = e => onProgress(e.data);
  // with the 3D map also save the elevation data (up to zoom 15) so the terrain is available offline
  const urls = keys.map(k => tileUrl(profile.tiles, k));
  if (use3d()) {
    const dem = areaTiles(area, zmin, Math.min(zmax, 15), 20000) || [];
    for (const k of dem) urls.push(tileUrl('dem', k));
  }
  rec.count = urls.length;
  setMsg(msg, `Saving … 0 / ${urls.length}`, true);
  if (sw) sw.postMessage({ type: 'prefetch', urls }, [ch.port2]);
  else {
    setMsg(msg, `Saving … 0 / ${urls.length} (keep TAKweb open until it is done)`, true);
    pagePrefetch(urls, onProgress);
  }
});
$('prefetchStop').addEventListener('click', async () => {
  pageStop = true;
  const sw = await swReady();
  if (sw) sw.postMessage({ type: 'prefetch-stop' });
});

function renderAreas() {
  const box = $('areaList');
  box.textContent = '';
  for (const a of areas) {
    const row = document.createElement('div');
    row.className = 'area';
    const t = document.createElement('span');
    t.textContent = `${a.kind === 'corridor' ? 'Corridor' : 'Area'} · ${a.srcName}`;
    const s = document.createElement('small');
    s.textContent = `Zoom ${a.zmin}–${a.zmax} · ${a.count} tiles · ${new Date(a.date).toLocaleDateString('en-GB')}`;
    t.append(s);
    t.style.cursor = 'pointer';
    t.onclick = () => {
      closePopup();
      const pts = a.kind === 'rect' ? [[a.area.s, a.area.w], [a.area.n, a.area.e]] : a.area.points;
      follow = false;
      $('btnLocate').classList.remove('active');
      map.fitBounds(pts);
    };
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete');
    del.onclick = async () => {
      if (!confirm('Delete saved area?')) return;
      const keys = areaTiles(a.area, a.zmin, a.zmax, 50000) || [];
      const tpl = a.template;
      const urls = keys.map(k => { const [z, x, y] = k.split('/'); return new URL(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), location.href).href; });
      const sw = await swReady();
      if (sw) sw.postMessage({ type: 'delete', urls });
      else tileDb.del(urls);
      areas = areas.filter(x => x !== a);
      store.set('eud.areas', areas);
      renderAreas();
    };
    row.append(t, del);
    box.append(row);
  }
}

// ======================================================================
// Compass, rotating and tilting the map, measuring distance, toolbar
// ======================================================================

// angle (degrees, clockwise) at which north currently lies on the screen (= map rotation)
function northAngle() {
  if (window.view3d && view3d.active) return view3d.northAngle(); // the 3D map rotates itself
  const b = map.getBearing ? map.getBearing() : 0;
  return ((b % 360) + 360) % 360;
}
// rotate the map so that direction "deg" is at the top
function headingUp(deg) { map.setBearing(-deg); }

let compassMode = 'north'; // 'north' = north up (ATAK default), 'heading' = heading up
let heading = null;        // device compass in degrees
let camHeading = null;     // where the back of the phone (rear camera) looks, degrees
let lastTurn = 0;

let needleAngle = 0; // continuous so the needle always turns the short way
function updateCompass() {
  const n = northAngle();
  needleAngle += ((n - needleAngle) % 360 + 540) % 360 - 180;
  $('needle').style.transform = `rotate(${Math.round(needleAngle * 10) / 10}deg)`;
  const shown = compassMode === 'heading' && heading != null ? heading : (360 - n) % 360;
  $('compassText').textContent = String(Math.round(shown) % 360).padStart(3, '0') + '°';
  $('compassMode').textContent = compassMode === 'heading' ? 'HDG' : 'N';
  $('compass').classList.toggle('heading', compassMode === 'heading');
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading; // iPhone
  else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;    // Android
  if (h == null) return;
  const sc = screen.orientation ? screen.orientation.angle || 0 : (window.orientation || 0);
  heading = (h + sc + 360) % 360;
  camHeading = backHeading(e, h);
  turnArrow();
  if (compassMode !== 'heading') return;
  const now = Date.now();
  if (now - lastTurn < 120) return; // rotate smoothly, save battery
  lastTurn = now;
  headingUp(heading);
  updateCompass();
}

// direction of the back of the device (rear camera) from alpha/beta/gamma (W3C device orientation, -z axis);
// iPhone: webkitCompassHeading already follows the camera when the phone is held up. Phone lying flat -> compass.
function backHeading(e, h) {
  if (typeof e.webkitCompassHeading === 'number' || typeof e.beta !== 'number' || typeof e.gamma !== 'number') return h;
  const r = Math.PI / 180, a = (360 - h) * r, b = e.beta * r, g = e.gamma * r;
  const vx = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
  const vy = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
  if (Math.hypot(vx, vy) < 0.35) return h; // flat: no meaningful camera direction
  return (Math.atan2(vx, vy) / r + 360) % 360;
}

// iPhone (and newer Chrome) allow the compass only after asking – and only during a tap. So it is asked
// with the tap that starts a camera stream (video.js) too, not only with the compass button.
let compassAllowed = !(window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function');
function askCompass() {
  if (compassAllowed) return Promise.resolve(true);
  return DeviceOrientationEvent.requestPermission().then(r => (compassAllowed = r === 'granted')).catch(() => false);
}
function startHeading(quiet) {
  window.addEventListener('deviceorientationabsolute', onOrientation);
  window.addEventListener('deviceorientation', onOrientation);
  askCompass().then(ok => { if (!ok && !quiet) toast('Compass not allowed – using GPS course while moving.'); });
}
// the compass always runs: the own arrow turns with the phone (the compass button only decides whether the map turns)
startHeading(true);
// After every start (iPhone asks again each time TAKweb was closed): a bar right away "allow location & compass" –
// one tap asks for both (the compass may only be asked within a tap). Shown only while something is missing.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let permAsked = false;
// on the radio's own WLAN the page may come over http (captive portal, http://takweb/): the browser then gives no
// position, compass or microphone – offer the same page over https (the radio's self-signed certificate, once)
const insecureRadio = () => MESH_ONLY && !window.isSecureContext && location.protocol === 'http:';
let radioOnline = false; // on the radio: the TAKweb server is reachable – "TAKweb online" is offered instead
function updatePermBar() {
  if (insecureRadio()) {
    // online the full TAKweb has position, camera and microphone – then only the "TAKweb online" bar shows
    $('permBar').classList.toggle('hidden', radioOnline);
    if (radioOnline) return;
    $('permGo').textContent = 'HTTPS';
    $('permText').textContent = 'Opened over http – here the browser gives no own position, compass or microphone (mesh, map and chat work). '
      + 'HTTPS opens the same page securely; accept the radio\'s certificate once (Advanced → continue).';
    return;
  }
  // Android app: Android keeps the app's permissions – no bar after the start, only when something was really refused
  const voice = window.eudVoice;
  const mic = !!voice && (nativeApp ? voice.micDenied() : voice.needMic());
  const need = (!compassAllowed && !nativeApp) || geoDenied || mic;
  $('permBar').classList.toggle('hidden', !need);
  if (!need) return;
  if (nativeApp) {
    $('permText').textContent = `${[geoDenied && 'Location', mic && 'Microphone (VoIP)'].filter(Boolean).join(' and ')} not allowed for the TAKweb app. ALLOW opens the app settings (Permissions${geoDenied ? ' → Location → "Allow all the time"' : ' → Microphone'}).`;
    return;
  }
  const parts = [geoDenied && 'location', !compassAllowed && 'compass', mic && 'microphone'].filter(Boolean);
  $('permText').textContent = `Allow ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')} – ` + [geoDenied && 'your position is sent', !compassAllowed && 'your direction is shown', mic && (MESH_ONLY ? 'voice messages work right away' : 'VoIP and voice messages work right away')].filter(Boolean).join(', ') + '.';
  if (permAsked && geoDenied) $('permText').textContent += isIOS ? ' Still refused: Settings → Privacy → Location Services → Safari Websites (or Bluefy) → "While Using".'
    : ' Still refused: tap the lock icon next to the address → Permissions → Location.';
}
$('permGo').addEventListener('click', () => {
  if (insecureRadio()) { location.href = 'https://' + location.hostname + location.pathname; return; }
  if (nativeApp) {
    if (bgGeo && bgGeo.openSettings) bgGeo.openSettings();
    // back from the settings: try again
    const back = () => { if (document.hidden) return; document.removeEventListener('visibilitychange', back); geoWatch = null; startGeo(); };
    document.addEventListener('visibilitychange', back);
    return;
  }
  permAsked = true;
  if (window.eudVoice) window.eudVoice.allow(); // microphone and sound, within the tap
  askCompass().then(updatePermBar); // must be called within the tap (iPhone)
  if (geoDenied) startGeo();
  setTimeout(updatePermBar, 1500);
});
$('permClose').addEventListener('click', () => $('permBar').classList.add('hidden'));

// on the radio: is the TAKweb server reachable (the phone's mobile data)? Then offer TAKweb online
if (MESH_ONLY) {
  let webUrl = '', invite = '', closed = false, onRadio = null;
  // set up in the admin: takweb-server.json on the radio holds the server and (optionally) this radio's TAK user.
  // That server comes first; an address the user typed only when the radio has none.
  const radioFile = () => onRadio || (onRadio = fetch('takweb-server.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : {})).catch(() => ({})));
  const serverUrl = async () => {
    if (webUrl) return webUrl;
    const j = await radioFile();
    invite = j.invite || '';
    return (webUrl = j.server || window.TAKWEB_SERVER || store.get('eud.webUrl', '') || '');
  };
  const goOnline = async () => { const u = await serverUrl(); if (u) location.href = radioLink(invite || u); };
  // server button: the known server with one tap, typing only when there is none (or for another server)
  async function showServer(manual) {
    const u = await serverUrl();
    let host = '';
    try { host = u ? new URL(u).host : ''; } catch (e) { /* invalid */ }
    $('srvKnown').classList.toggle('hidden', !host || manual);
    $('srvManual').classList.toggle('hidden', !!host && !manual);
    $('srvName').textContent = host;
    if (!$('srvWeb').value) $('srvWeb').value = u;
  }
  showServer(false);
  document.addEventListener('eud-popup', e => { if (e.detail === 'server') showServer(false); });
  $('srvKnownGo').addEventListener('click', goOnline);
  $('srvChange').addEventListener('click', () => showServer(true));
  $('srvWebGo').addEventListener('click', () => {
    let u = $('srvWeb').value.trim();
    if (!u) return $('srvWeb').focus();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    store.set('eud.webUrl', u);
    location.href = radioLink(u);
  });
  async function checkOnline() {
    const u = await serverUrl();
    if (!u || closed) return;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    let ok = false;
    try { await fetch(new URL('icon-192.png?ping=' + Date.now(), u), { mode: 'no-cors', cache: 'no-store', signal: ctl.signal }); ok = true; } catch (e) { /* offline */ }
    clearTimeout(t);
    $('onlineBar').classList.toggle('hidden', !ok || closed);
    radioOnline = ok && !closed;
    updatePermBar();
  }
  setTimeout(checkOnline, 2500);
  setInterval(checkOnline, 20000);
  // with the radio's TAK user: the invitation logs in by itself (certificate request on the server's page)
  $('onlineGo').addEventListener('click', goOnline);
  $('onlineClose').addEventListener('click', () => { closed = true; $('onlineBar').classList.add('hidden'); });
}
updatePermBar();
// app: should the WebView still want the compass allowed, quietly with the first tap (no bar)
if (nativeApp && !compassAllowed) document.addEventListener('pointerup', () => askCompass(), { once: true, capture: true });
// app: Android asks for the microphone once (Capacitor) – quietly with the first tap, the bar only if it was refused
if (nativeApp) document.addEventListener('pointerup', () => { if (window.eudVoice && window.eudVoice.needMic()) window.eudVoice.allow(); }, { once: true, capture: true });

// tapping the compass: a map rotated by hand goes back to north; if already north up, heading up (HDG)
$('compass').addEventListener('click', () => {
  const turned = Math.abs(((northAngle() + 180) % 360) - 180) > 0.5;
  if (compassMode === 'north' && turned) {
    resetNorth();
  } else if (compassMode === 'north') {
    compassMode = 'heading';
    startHeading();
    if (heading != null) headingUp(heading);
    else if (me && Number.isFinite(me.course) && me.speed > 0.5) headingUp(me.course);
    setTimeout(() => { if (compassMode === 'heading' && heading == null && !(me && me.speed > 0.5)) toast('No compass sensor – map turns with GPS course while moving.'); }, 2500);
  } else {
    compassMode = 'north';
    resetNorth();
  }
  updateCompass();
});
function resetNorth() {
  map.setBearing(0);
  if (window.view3d && view3d.active) view3d.map().easeTo({ bearing: 0, duration: 300 });
}
// rotated by hand (two fingers / Shift+mouse wheel): end heading-up mode, otherwise the compass turns it back
function manualRotate() {
  if (compassMode !== 'heading') return;
  compassMode = 'north';
  updateCompass();
}
// two fingers: only rotate after ~12° of deliberate rotation so the map does not wobble while zooming
(() => {
  const orig = map.setBearing.bind(map);
  let gesture = null;
  const box = map.getContainer();
  box.addEventListener('touchstart', e => { if (e.touches.length === 2) gesture = { start: map.getBearing(), latched: false }; }, { passive: true });
  box.addEventListener('touchend', e => { if (e.touches.length < 2) gesture = null; }, { passive: true });
  box.addEventListener('touchcancel', () => { gesture = null; }, { passive: true });
  map.setBearing = function (deg) {
    if (gesture && !gesture.latched) {
      const diff = Math.abs((((deg - gesture.start) % 360) + 540) % 360 - 180);
      if (diff < 12) return this;
      gesture.latched = true;
    }
    return orig(deg);
  };
})();
map.getContainer().addEventListener('touchmove', e => { if (e.touches.length === 2) manualRotate.pending = true; }, { passive: true });
map.getContainer().addEventListener('wheel', e => { if (e.shiftKey) manualRotate(); }, { passive: true });
map.on('rotate', () => { if (manualRotate.pending) { manualRotate.pending = false; manualRotate(); } });
// without a compass sensor: rotate by GPS course while walking/driving
setInterval(() => {
  if (compassMode === 'heading' && heading == null && me && Number.isFinite(me.course) && me.speed > 0.5) headingUp(me.course);
}, 2000);

// arrows of contacts and of the own symbol follow the map rotation
let rotateTimer = null;
map.on('rotate', () => {
  updateCompass();
  if (rotateTimer) return;
  rotateTimer = setTimeout(() => {
    rotateTimer = null;
    if (me) drawMe();
    for (const it of items.values()) if (it.c.team && it.c.speed > 0.5) drawItem(it);
  }, 300);
});
map.on('moveend zoomend', updateCompass);
updateCompass();

// ---------------- Tilt (0–60°) ----------------

let pitch = 0;
// with the 3D map (WebGL) like WinTAK almost up to the horizon, otherwise the flat map tilted (CSS)
const use3d = () => profile.map3d !== false && window.view3d && view3d.supported;
const pitchMax = () => (use3d() ? 88 : 60);
function pitchUi(p) {
  const max = pitchMax();
  const box = $('pitchBox').clientHeight || 96;
  $('pitchThumb').style.top = (4 + (1 - Math.min(p, max) / max) * (box - 14)) + 'px';
  $('pitchText').textContent = Math.round(p) + '°';
  $('pitchFill').style.opacity = String(0.3 + 0.7 * Math.min(p, max) / max);
  $('pitchBox').title = `Tilt map (0°–${max}°)` + (use3d() ? ' – 3D terrain' : '');
}
function setPitch(p, fromView) {
  p = Math.max(0, Math.min(pitchMax(), Math.round(p)));
  const was = pitch;
  pitch = p;
  const el = $('map');
  if (use3d()) {
    if (el.style.transform) { el.style.transform = ''; el.classList.remove('tilted'); map.invalidateSize({ pan: true, animate: false }); }
    if (!fromView) { if (p > 0) view3d.show(p); else view3d.hide(); }
  } else {
    if ((was > 0) !== (p > 0)) {
      el.classList.toggle('tilted', p > 0); // map larger so the far part is filled
      map.invalidateSize({ pan: true, animate: false });
    }
    el.style.transform = p ? `rotateX(${p}deg)` : '';
    el.style.setProperty('--tilt', p + 'deg'); // symbols stand upright instead (CSS)
  }
  if (p > 0) { profile.pitch = p; saveProfile(); }
  pitchUi(p);
}
(() => {
  const box = $('pitchBox');
  let dragging = false;
  const fromEvent = e => {
    const r = box.getBoundingClientRect();
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    setPitch((1 - y / r.height) * pitchMax());
  };
  box.addEventListener('pointerdown', e => { dragging = true; box.setPointerCapture(e.pointerId); fromEvent(e); });
  box.addEventListener('pointermove', e => { if (dragging) fromEvent(e); });
  box.addEventListener('pointerup', () => { dragging = false; });
  box.addEventListener('pointercancel', () => { dragging = false; });
  box.addEventListener('dblclick', () => setPitch(0));
})();
setPitch(0);

// Tilting with two fingers on the flat map too (like ATAK): pushing both fingers up together =
// tilt (switches to the 3D map, MapLibre takes over there), down = flatter. The finger distance stays
// the same – so it does not get mixed up with zooming (fingers apart/together).
(() => {
  let g = null;
  const box = map.getContainer();
  const mid = t => (t[0].clientY + t[1].clientY) / 2;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  box.addEventListener('touchstart', e => {
    g = e.touches.length === 2 ? { y: mid(e.touches), d: dist(e.touches), start: pitch, active: false } : null;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!g || e.touches.length !== 2) return;
    const dy = g.y - mid(e.touches);
    if (!g.active) {
      const sideBySide = Math.abs(e.touches[0].clientY - e.touches[1].clientY) < 90;
      if (Math.abs(dy) > 24 && Math.abs(dist(e.touches) - g.d) < 30 && sideBySide) g.active = true;
      else return;
    }
    setPitch(g.start + dy * 0.35);
  }, { passive: true });
  document.addEventListener('touchend', e => { if (e.touches.length < 2) g = null; }, { passive: true });
  document.addEventListener('touchcancel', () => { g = null; }, { passive: true });
})();

// 3D as default: start with the last used tilt
if (use3d() && profile.start3d !== false) setTimeout(() => setPitch(Math.max(45, profile.pitch || 60)), 300);

// ---------------- R&B line (range & bearing) ----------------
// Like ATAK: tap start and end point -> an R&B line that stays, is sent to the TAK server and
// can be tapped (rename, delete) like a marker. The tool stays on for more lines.

let measuring = false;
let measurePts = [];
const measureLayer = L.layerGroup().addTo(map);

function drawMeasure() {
  measureLayer.clearLayers();
  for (const p of measurePts) L.circleMarker(p, { radius: 5, color: '#000', weight: 1.5, fillColor: '#ffd700', fillOpacity: 1, interactive: false }).addTo(measureLayer);
}
function addMeasurePoint(ll) {
  measurePts.push(ll);
  if (measurePts.length < 2) return drawMeasure();
  const [a, b] = measurePts;
  measurePts = [];
  drawMeasure();
  placeRb({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });
}
function placeRb(a, b) {
  const now = new Date();
  const idx = Math.max(1, Number(profile.rbIndex) || 1);
  profile.rbIndex = idx + 1;
  saveProfile();
  const name = `R&B ${idx}`;
  const xml = `<event version="2.0" uid="${profile.uid}-rb-${rnd(6)}" type="u-rb-a" how="h-e" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 30 * 86400000))}">`
    + `<point lat="${a.lat.toFixed(7)}" lon="${a.lon.toFixed(7)}" hae="9999999" ce="9999999" le="9999999"/>`
    + `<detail><range value="${distance(a, b).toFixed(2)}"/><bearing value="${bearing(a, b).toFixed(2)}"/><inclination value="0.0"/>`
    + '<rangeUnits value="1"/><bearingUnits value="0"/><northRef value="0"/><strokeColor value="-10496"/><strokeWeight value="3.0"/>'
    + `<contact callsign="${xmlEsc(name)}"/><remarks/><archive/><labels_on value="true"/>`
    + `<link uid="${xmlEsc(profile.uid)}" production_time="${cotTime(now)}" type="a-f-G-U-C" parent_callsign="${xmlEsc(profile.callsign || profile.uid)}" relation="p-p"/></detail></event>`;
  handleCot(xml, { own: true });
  const sent = sendCot(xml, true);
  toast(sent ? `${name} sent.` : `${name} saved – will be sent once connected.`);
}
function toggleMeasure() {
  measuring = !measuring;
  closeSheets();
  $('btnMeasure').classList.toggle('active', measuring);
  $('measureHint').classList.toggle('hidden', !measuring);
  map.getContainer().classList.toggle('drawing', measuring);
  if (measuring) { setTool(null); setPitch(0); }
  measurePts = [];
  drawMeasure();
}
$('btnMeasure').addEventListener('click', toggleMeasure);

// ---------------- Toolbar on/off (pin) ----------------

$('toolsClose').addEventListener('click', () => showTools(false));
$('mkPrefix').value = profile.markerPrefix || '';
$('mkIndex').value = profile.markerIndex || 1;
function showTools(on) {
  if (on) closeSheets('markers');
  profile.showTools = !!on;
  saveProfile();
  $('toolbar').classList.toggle('hidden', !on);
  $('btnPin').classList.toggle('pinned', !!on);
  if (!on) { setTool(null); if (measuring) toggleMeasure(); }
}
$('btnPin').addEventListener('click', () => showTools(!profile.showTools));
showTools(profile.showTools);

// ======================================================================
// own position bottom right (like ATAK): callsign, MGRS, altitude, direction, speed, accuracy
// ======================================================================

// WGS84 -> MGRS (z. B. "33U VP 49594 44664")
function toMGRS(lat, lon) {
  if (!(lat > -80 && lat < 84)) return '';
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72) zone = lon < 9 ? 31 : lon < 21 ? 33 : lon < 33 ? 35 : lon < 42 ? 37 : zone;
  const r = Math.PI / 180;
  const phi = lat * r, lam = lon * r, lam0 = ((zone - 1) * 6 - 180 + 3) * r;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const E = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let Nn = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) Nn += 10000000;
  const band = 'CDEFGHJKLMNPQRSTUVWX'[Math.min(19, Math.floor((lat + 80) / 8))];
  const set = zone % 6 || 6;
  const col = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'][(set - 1) % 3][Math.floor(E / 100000) - 1];
  const row = 'ABCDEFGHJKLMNPQRSTUV'[(Math.floor(Nn / 100000) + (set % 2 === 0 ? 5 : 0)) % 20];
  const pad = v => String(Math.floor(v % 100000)).padStart(5, '0');
  return `${zone}${band} ${col}${row} ${pad(E)} ${pad(Nn)}`;
}
window.eudMGRS = toMGRS;

function updateSelfInfo() {
  $('siCall').textContent = profile.callsign || '---';
  if (!me) { $('siGrid').textContent = 'No GPS'; $('siAlt').textContent = $('siHdg').textContent = $('siSpd').textContent = $('siAcc').textContent = ''; return; }
  $('siGrid').textContent = toMGRS(me.lat, me.lon);
  $('siAlt').textContent = Number.isFinite(me.alt) && me.alt !== null ? `${Math.round(me.alt)} m MSL` : '--- m MSL';
  const dir = compassMode === 'heading' && heading != null ? heading : (heading != null ? heading : (Number.isFinite(me.course) ? me.course : null));
  $('siHdg').textContent = dir == null ? '---°' : `${String(Math.round(dir) % 360).padStart(3, '0')}°`;
  $('siSpd').textContent = `${Number.isFinite(me.speed) && me.speed !== null ? Math.round(me.speed * 3.6) : 0} km/h`;
  $('siAcc').textContent = `+/- ${Math.round(me.acc || 0)}m`;
}
setInterval(updateSelfInfo, 2000);
$('selfInfo').addEventListener('click', () => openPopup('me'));

L.control.scale({ metric: true, imperial: false, position: 'bottomleft', maxWidth: 110 }).addTo(map);

// ======================================================================
// Start
// ======================================================================

if ('serviceWorker' in navigator && !MESH_ONLY) { // the radio has no service worker (and a self-signed certificate)
  navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// all streams in the situational picture (contacts with a video link)
function videoItems() {
  return [...items.values()].map(it => ({ name: it.c.callsign || it.uid, url: videoUrl(it.c), stale: Date.now() > it.c.stale, time: it.c.time }))
    .filter(v => v.url && !v.stale).sort((a, b) => a.name.localeCompare(b.name));
}

window.eud = { sendChat, updatePermBar, videoItems, browserVideoUrl, $, store, profile, toast, setMsg, openPopup, closePopup, rnd, esc, map, handleCot, removeItem, askTrust, postJson, getServers: () => servers, saveServers, applyProfilePrefs, addTakMaps, forwardCot: xml => sendCot(xml, false), fmtDist, distance, bearing, askCompass, askDrone, destPoint, serverOnline,
  sendCot, cotTime, saveProfile, closeSheets, setTool, setPitch, items, stopMeasure: () => { if (measuring) toggleMeasure(); }, getMe: () => me, battery: () => battery };

loadPicture();
renderChat();
showMe();
updateStatus();

// presets from the admin's QR code (…/eud/#host=…) or from the server
(async () => {
  const hash = location.hash.slice(1);
  let handled = false;
  if (hash && new URLSearchParams(hash).has('host')) {
    history.replaceState(null, '', location.pathname);
    const t = new URLSearchParams(hash).get('t');
    if (t) try { localStorage.setItem('tak.access', t); } catch (e) { /* private mode */ }
    try {
      const cfg = parseQr(location.origin + location.pathname + '#' + hash);
      // also when the server is already saved but without a certificate or for another user
      // (e.g. an earlier failed attempt) – otherwise the new login from the link would be ignored
      const known = servers.find(s => s.host === cfg.host);
      if (!known || (cfg.username && cfg.password && (!known.certPem || known.username !== cfg.username))) { await applyConfig(cfg, true); handled = true; }
    } catch (e) { /* invalid */ }
  } else if (!servers.length && !MESH_ONLY) {
    try {
      const r = await fetch('/api/eud/config').then(x => x.json());
      if (r.preset && r.preset.host) {
        openEdit(null);
        await applyConfig({ host: r.preset.host, port: r.preset.port, proto: r.preset.proto, enrollPort: r.preset.enrollPort }, false);
        handled = true;
      }
    } catch (e) { /* offline */ }
  }
  if (!handled) {
    if (!profile.callsign) openPopup('me');
    else if (!servers.length && !MESH_ONLY) openEdit(null);
  }
  for (const srv of servers) if (srv.auto) openConn(srv);
  if (profile.wake) wakeLock();
})();
