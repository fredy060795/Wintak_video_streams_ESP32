// TAKweb / Helm Camera Streams – server
//
//   Phone app:   https://<domain>/app/#u=<user>&s=<streamId>&k=<key>             (via QR code)
//   Stream:      https://<domain>/<user>/<streamId>                             (MJPEG, link for ATAK/WinTAK)
//                https://<domain>/<user>/<streamId>/index.m3u8                  (HLS, needs ffmpeg)
//                https://<domain>/<user>/<streamId>/stream.ts                   (MPEG-TS, needs ffmpeg)
//                https://<domain>/<user>/<streamId>/snapshot.jpg                (last image)
//   Admin:       https://<admin-domain>/admin/
//
// Settings via environment variables, see README.md.

require('./lib/preflight').check(); // Node.js version and installed packages – before anything else is loaded

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const { Store } = require('./lib/store');
const { Auth } = require('./lib/auth');
const { StreamHub, normRotate, normFit, normFramesize } = require('./lib/streams');
const { sendMail, configured: smtpConfigured } = require('./lib/mailer');
const tak = require('./lib/tak');
const { TileCache } = require('./lib/tiles');
const { TakUsers, TEAM_COLORS, ROLES, maskEmail, makePassword, ANON } = require('./lib/takusers');
const { TakVideo } = require('./lib/takvideo');
const { atakPackage, zip } = require('./lib/datapackage');
const { proxyMedia } = require('./lib/mediaproxy');
const { KlvFeeds } = require('./lib/klvfeed');
const { Federation } = require('./lib/federation');
const { Tracks, stateOf } = require('./lib/tracks');
const { Hq } = require('./lib/hq');
const { Voice } = require('./lib/voice');
const raster = require('./lib/raster');
const meshsite = require('./lib/meshsite');
const { FirmwareLibrary } = require('./lib/firmware');

const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 5036,
  bind: process.env.BIND || '0.0.0.0',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  adminHost: (process.env.ADMIN_HOST || '').toLowerCase(),
  adminUrl: (process.env.ADMIN_URL || '').replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  // Only for testing on a PC (start.bat): own CA that phones can download at /ca.crt
  testCa: process.env.TEST_CA_FILE || '',
  // Evaluate X-Forwarded-* only when a reverse proxy sits in front. With its own
  // certificate (TLS_CERT) the server runs directly on the network, then it is off by default.
  trustProxy: process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY !== '0' : !process.env.TLS_CERT,
  // Android app: built by GitHub Actions (mobile/, .github/workflows/android.yml) – or an own build / fork
  apkUrl: process.env.TAKWEB_APK_URL || 'https://github.com/fredy060795/5036-TAKweb/releases/download/android/TAKweb.apk',
};

const log = (...args) => console.log(new Date().toISOString(), ...args);

const store = new Store(config.dataDir);
const auth = new Auth(store);
const ffmpegOk = spawnSync(config.ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
const hub = new StreamHub({
  store,
  ffmpeg: ffmpegOk ? config.ffmpeg : null,
  workDir: path.join(config.dataDir, 'hls'),
  log,
});

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.json': 'application/json', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// Version shown in the headers: package version + short code of the program files,
// changes by itself with every update (shows whether the browser loaded the current page)
const VERSION = (() => {
  const hash = crypto.createHash('sha1');
  const walk = f => {
    const st = fs.statSync(f);
    if (st.isDirectory()) { for (const n of fs.readdirSync(f).sort()) walk(path.join(f, n)); return; }
    hash.update(path.relative(__dirname, f)).update(fs.readFileSync(f));
  };
  for (const f of ['server.js', 'package.json', 'lib', 'public']) { try { walk(path.join(__dirname, f)); } catch (e) { /* missing */ } }
  return `${require('./package.json').version}-${hash.digest('hex').slice(0, 6)}`;
})();
const VERSION_TAG = '__TAKWEB_VERSION__';

// ======================================================================
// Helpers
// ======================================================================

function hostOf(req) {
  const h = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '';
  return h.split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();
}

function protoOf(req) {
  if (config.trustProxy && req.headers['x-forwarded-proto']) return req.headers['x-forwarded-proto'].split(',')[0].trim();
  return req.socket.encrypted ? 'https' : 'http';
}

function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// Public address: set in the admin > PUBLIC_URL > from the request
function configuredBase() {
  return ((store.data.settings || {}).publicUrl) || config.publicUrl;
}

function publicBase(req) {
  const host = ((config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
  return configuredBase() || `${protoOf(req)}://${host}`;
}

// "https://domain:5036/anything" -> "https://domain:5036"; empty = automatic
function normalizeBase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); } catch (e) { u = null; }
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) throw new Error('Please enter a valid address, e.g. https://example.com:5036');
  return u.origin;
}

// Address for links in reset mails: only from the configuration, never from the request
// (otherwise someone could redirect the link with a forged Host header).
function resetBase() {
  if (config.adminUrl) return config.adminUrl;
  const pub = configuredBase();
  if (!pub) return null;
  if (!config.adminHost) return pub;
  const u = new URL(pub);
  u.hostname = config.adminHost;
  return u.origin;
}

// Admin only on the admin domain, if one is set
function isAdminHost(req) {
  return !config.adminHost || hostOf(req) === config.adminHost;
}

function links(req, entry) {
  const base = publicBase(req) + '/' + entry.user + '/' + entry.streamId;
  return {
    stream: base,
    hls: base + '/index.m3u8',
    ts: base + '/stream.ts',
    snapshot: base + '/snapshot.jpg',
    app: `${publicBase(req)}/app/#u=${encodeURIComponent(entry.user)}&s=${encodeURIComponent(entry.streamId)}&k=${encodeURIComponent(entry.key)}`,
  };
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function json(res, status, obj, extra) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
}

// raw request body (Buffer) up to limit
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, dir, rel) {
  const root = path.join(PUBLIC_DIR, dir);
  let file = path.normalize(path.join(root, rel || 'index.html'));
  if (!file.startsWith(root)) return send(res, 404, 'Not found');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return send(res, 404, 'Not found');
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  // pages and the service worker carry the version (new version -> the phone renews its offline copy)
  if (/\.html$/.test(file) || path.basename(file) === 'sw.js') return res.end(fs.readFileSync(file, 'utf8').split(VERSION_TAG).join(VERSION));
  fs.createReadStream(file).pipe(res);
}

// ======================================================================
// Self-registration (general QR code -> /app/ -> name + unit)
// ======================================================================

const registrations = new Map(); // ip -> [timestamps]
const MAX_REG_PER_HOUR = 20;

function registrationEnabled() {
  return (store.data.registration || {}).enabled !== false; // default: on
}

async function handleRegister(req, res) {
  const body = await readJson(req);
  if (!registrationEnabled()) {
    return json(res, 403, { error: 'Streaming sign-up is currently disabled. Please contact the admin.' });
  }
  const ip = clientIp(req);
  const now = Date.now();
  const list = (registrations.get(ip) || []).filter(t => now - t < 3600 * 1000);
  if (list.length >= MAX_REG_PER_HOUR) return json(res, 429, { error: 'Too many sign-ups. Please try again later.' });
  const entry = hub.register(body.name, body.unit, body.source === 'eud');
  list.push(now);
  registrations.set(ip, list);
  log('Self-registration', entry.user + '/' + entry.streamId, JSON.stringify(entry.label), ip);
  hub.event(StreamHub.id(entry.user, entry.streamId), 'register', `${entry.label} signed up`);
  takVideo.touch(StreamHub.id(entry.user, entry.streamId));
  return json(res, 200, { u: entry.user, s: entry.streamId, k: entry.key, label: entry.label });
}

// ======================================================================
// EUD (TAK client in the browser): request a certificate, read .p12
// ======================================================================

const VENDOR = {
  'leaflet.js': 'leaflet/dist/leaflet.js',
  'leaflet.css': 'leaflet/dist/leaflet.css',
  'images/marker-icon.png': 'leaflet/dist/images/marker-icon.png',
  'images/marker-shadow.png': 'leaflet/dist/images/marker-shadow.png',
  'images/layers.png': 'leaflet/dist/images/layers.png',
  'images/layers-2x.png': 'leaflet/dist/images/layers-2x.png',
  'images/marker-icon-2x.png': 'leaflet/dist/images/marker-icon-2x.png',
  'leaflet-rotate.js': 'leaflet-rotate/dist/leaflet-rotate.js',
  'milsymbol.js': 'milsymbol/dist/milsymbol.js',
  'jsQR.js': 'jsqr/dist/jsQR.js',
  'hls.min.js': 'hls.js/dist/hls.min.js', // HLS feeds in Chrome/Edge (Safari can do it itself)
  // 3D map (ES modules; the worker is loaded relative to the module)
  'maplibre-gl.mjs': 'maplibre-gl/dist/maplibre-gl.mjs',
  'maplibre-gl-worker.mjs': 'maplibre-gl/dist/maplibre-gl-worker.mjs',
  'maplibre-gl.css': 'maplibre-gl/dist/maplibre-gl.css',
  'esptool.js': 'esptool-js/bundle.js', // admin: flash Meshtastic firmware over USB (ES module)
};

function serveVendor(res, name) {
  const rel = VENDOR[name];
  if (!rel) return send(res, 404, 'Not found');
  const file = require.resolve(rel.split('/')[0] + '/package.json').replace(/package\.json$/, '') + rel.split('/').slice(1).join('/');
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
}

const tiles = new TileCache(path.join(config.dataDir, 'tiles'), 'TAKweb/1.0 (TAK-Client; Kachel-Zwischenspeicher)', process.env.TILE_URL_OVERRIDE);

async function serveTile(res, rel) {
  const t = TileCache.parse(rel);
  if (!t) return send(res, 404, 'Not found');
  try {
    const { data, type } = await tiles.get(t);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', 'Content-Length': data.length });
    res.end(data);
  } catch (e) {
    send(res, 502, 'Tile not available');
  }
}

// ======================================================================
// TAK access (OpenTAKServer): registration, access page, management
// ======================================================================

const takUsers = new TakUsers(store, { log });
// regularly set callsign/team/role for new devices as an OTS profile
// bring groups to the wanted state once at startup (e.g. remove old TEAM_ groups when nothing is blocked)
setTimeout(() => takUsers.syncAllGroups().then(errs => { for (const e of errs) log('OTS groups:', e); })
  .catch(e => log('OTS groups:', e.message)), 10000).unref();
setInterval(() => takUsers.syncProfiles().then(r => { if (r.updated) log('OTS profiles updated:', r.updated); })
  .catch(e => log('OTS profiles:', e.message)), 2 * 60 * 1000).unref();

// Register camera streams as video feeds in the TAK server automatically.
// Address for the HLS link: the configured public address, otherwise the one last used in the admin.
const takVideo = new TakVideo({
  store, hub, takUsers, log,
  base: () => configuredBase() || ((store.data.takVideo || {}).lastBase) || '',
});
setTimeout(() => takVideo.syncAll().catch(e => log('TAK video:', e.message)), 5000).unref();
let takVideoTick = 0;
setInterval(() => {
  // mode "live only": check every 30 s, otherwise sync everything every 10 min to be safe
  if (takVideo.s.when === 'live' || ++takVideoTick % 20 === 0) takVideo.syncAll().catch(e => log('TAK video:', e.message));
}, 30 * 1000).unref();

const accessLimits = new Map(); // ip -> [timestamps] for registrations
function mailReady() { return smtpConfigured(store.data.smtp); }
// Mail to a user. Safety net: links to the admin area are never sent to users.
function mailUser(to, subject, text) {
  if (!mailReady() || !to) return Promise.resolve(false);
  if (/\/admin\b/i.test(text)) {
    log('E-mail to', to, 'NOT sent: contains a link to the admin area');
    return Promise.resolve(false);
  }
  return sendMail(store.data.smtp, { to, subject, text }).then(() => true).catch(e => { log('E-mail failed:', e.message); return false; });
}
// Mail only to the admin address (Settings → System), never to the requesting person
function mailAdmin(subject, text, notTo) {
  const to = String(auth.admin.email || '').trim();
  if (!mailReady() || !to) return Promise.resolve(false);
  if (notTo && to.toLowerCase() === String(notTo).trim().toLowerCase()) {
    log('Admin notification not sent: admin e-mail equals the e-mail of the request');
    return Promise.resolve(false);
  }
  return sendMail(store.data.smtp, { to, subject, text }).then(() => true).catch(e => { log('E-mail failed:', e.message); return false; });
}
const accessLink = (req, u) => `${publicBase(req)}/access/#t=${u.token}`;

function requestMail(u, link) {
  return `Hello ${u.name},\n\nthank you – your registration request for TAKweb has been received.\n\n`
    + `Name: ${u.name}\n${u.unit ? `Unit: ${u.unit}\n` : ''}${u.requestedCallsign ? `Requested callsign: ${u.requestedCallsign}\n` : ''}\n`
    + 'What happens next:\n1. An administrator reviews your request.\n2. As soon as it is approved you get another e-mail.\n'
    + '3. Your login details, QR codes and a step-by-step guide are then shown on your personal status page:\n\n'
    + `${link}\n\nKeep this link private – it is your personal access.\n`;
}

// New request: notification in the admin window and mail to the admin address
function newRequest(u, suffix) {
  const text = `TAKweb access requested: ${u.name}${u.unit ? ' – ' + u.unit : ''}${suffix}`;
  hub.event('tak', 'takreg', text);
  // Link to the admin area only in this mail to the admin address – and only from a trusted source:
  // the configured address (ADMIN_URL/public address) or the one the admin was logged in under.
  // Never from the Host header of the request (that is controlled by whoever registers).
  const base = resetBase() || ((store.data.takVideo || {}).lastBase) || '';
  mailAdmin('TAKweb – new registration request',
    `${text}\nE-mail: ${u.email}\n${u.requestedCallsign ? `Requested callsign: ${u.requestedCallsign}\n` : ''}\n`
    + 'Please review it in the TAKweb admin under "Users & requests" and approve or decline it'
    + (base ? `:\n${base}/admin/#users\n` : '.\n'), u.email);
}

async function handleAccessApi(req, res, route) {
  const url = new URL(req.url, 'http://x');
  const token = req.headers['x-access-token'] || url.searchParams.get('t') || '';
  if (route === 'config' && req.method === 'GET') {
    const r = takUsers.t.registration;
    return json(res, 200, { open: r.open, codeword: !!r.codeword, emailConfirm: r.emailConfirm && mailReady() });
  }
  if (route === 'register' && req.method === 'POST') {
    const ip = clientIp(req);
    const now = Date.now();
    const list = (accessLimits.get(ip) || []).filter(t => now - t < 3600 * 1000);
    if (list.length >= 5) return json(res, 429, { error: 'Too many registrations. Please try again later.' });
    list.push(now);
    accessLimits.set(ip, list);
    const body = await readJson(req);
    let u;
    try { u = takUsers.register(body, { smtpReady: mailReady() }); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    const link = accessLink(req, u);
    let mailed;
    if (u.status === 'unconfirmed') {
      mailed = await mailUser(u.email, 'TAKweb – please confirm your registration request',
        `Hello ${u.name},\n\nwe received your registration request for TAKweb.\nPlease confirm your e-mail address with this link:\n\n${link}&c=${u.emailToken}\n\n`
        + `After that an administrator will review your request. You will get another e-mail as soon as your access is approved.\n\n`
        + `If you did not request access, simply ignore this e-mail.\n`);
    } else {
      newRequest(u, '');
      mailed = await mailUser(u.email, 'TAKweb – registration request received', requestMail(u, link));
    }
    return json(res, 200, { status: u.status, token: u.token, mailed, email: maskEmail(u.email) });
  }
  if (route === 'confirm' && req.method === 'POST') {
    const body = await readJson(req);
    const u = takUsers.confirmEmail(String(body.code || ''));
    if (!u) return json(res, 400, { error: 'This confirmation link is invalid or was already used.' });
    newRequest(u, ' (e-mail confirmed)');
    return json(res, 200, { status: u.status });
  }
  const u = takUsers.byToken(String(token));
  if (!u) return json(res, 404, { error: 'Unknown access link.' });
  if (route === 'me' && req.method === 'GET') return json(res, 200, { ...takUsers.publicView(u), mail: mailReady() });
  if (u.status !== 'active') return json(res, 403, { error: 'Your access is not approved yet.' });
  const o = takUsers.t.ots;
  const host = takUsers.takHost();
  const qr = text => QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  // ATAK QR: plain https link (the phone camera opens it in the browser) to the page with the setup package
  if (route === 'qr/atak.svg') return send(res, 200, await qr(`${publicBase(req)}/access/atak.html#t=${encodeURIComponent(String(token))}`), 'image/svg+xml');
  // tak:// link from OTS (only with a trusted server certificate, e.g. Let's Encrypt)
  if (route === 'qr/atak-direct.svg') {
    if (!u.atakQr) return send(res, 404, 'No QR code');
    return send(res, 200, await qr(takUsers.fixQr(u.atakQr)), 'image/svg+xml');
  }
  if (route === 'atak-link') return json(res, 200, { link: takUsers.fixQr(u.atakQr || '') });
  // Setup package: truststore + server + user + password + callsign/team – ATAK sets up everything
  if (route === 'atak-package.zip') {
    let truststore;
    try { truststore = await takUsers.ots().truststore(); } catch (e) { return json(res, 502, { error: 'Truststore not available: ' + e.message }); }
    const team = takUsers.team(u.team);
    const pkg = atakPackage({
      host, port: o.streamPort, description: 'TAKweb ' + host, username: u.username, password: u.password,
      caPassword: o.truststorePassword || 'atakatak', callsign: u.callsign, team: team.color, role: u.role, truststore,
    });
    return send(res, 200, pkg.data, 'application/zip', { 'Content-Disposition': `attachment; filename="${pkg.filename}"`, 'Cache-Control': 'no-store' });
  }
  if (route === 'qr/itak.svg') return send(res, 200, await qr(`${host},${host},${o.streamPort},ssl`), 'image/svg+xml');
  if (route === 'qr/eud.svg') {
    const p = new URLSearchParams({ host, port: o.streamPort, proto: 'ssl', enroll: o.enrollPort, username: u.username, password: u.password, callsign: u.callsign });
    return send(res, 200, await qr(`${publicBase(req)}/eud/#${p}`), 'image/svg+xml');
  }
  if (route === 'truststore.p12') {
    try {
      const data = await takUsers.ots().truststore();
      return send(res, 200, data, 'application/x-pkcs12', { 'Content-Disposition': `attachment; filename="truststore-${host || 'tak'}.p12"` });
    } catch (e) { return json(res, 502, { error: 'Truststore not available: ' + e.message }); }
  }
  return json(res, 404, { error: 'Unknown request.' });
}

// ======================================================================
// Manage the TAK server (like the OTS UI): users, roles, groups, missions, feeds, Meshtastic
// ======================================================================

async function handleOtsAdmin(req, res, route) {
  if (!takUsers.otsConfigured()) return json(res, 400, { error: 'OpenTAKServer is not connected (Settings → OpenTAKServer & registration).' });
  const ots = takUsers.ots();
  const method = req.method;
  const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
  const seg = route.split('/').map(decodeURIComponent);

  if (route === 'users' && method === 'GET') {
    const [users, groups] = await Promise.all([ots.allUsers(), ots.allGroups().catch(() => [])]);
    return json(res, 200, {
      groups: groups.map(g => ({ id: g.id, name: g.name, description: g.description || '' })),
      users: users.map(u => {
        const m = takUsers.byUsername(u.username);
        return {
          username: u.username, active: u.active !== false, lastLogin: u.current_login_at || u.last_login_at || null,
          roles: (u.roles || []).map(r => r.name || r).filter(Boolean),
          memberships: (u.group_memberships || []).map(g => ({ group: g.group_name || (g.group && g.group.name) || g.name, direction: g.direction, enabled: g.enabled !== false })),
          euds: (u.euds || []).map(e => ({ uid: e.uid, callsign: e.callsign, device: e.device || e.platform || '', lastStatus: e.last_status || '' })),
          managed: m ? { id: m.id, callsign: m.callsign, status: m.status } : null,
        };
      }).sort((a, b) => a.username.localeCompare(b.username)),
    });
  }
  if (route === 'users' && method === 'POST') {
    if (req.takwebHelper) body.admin = false; // helpers only create normal users
    const u = await takUsers.createDirect(body);
    log('Admin: TAK user created', u.username);
    return json(res, 200, { ok: true, user: takUsers.adminView(u), password: u.password, link: accessLink(req, u) });
  }
  if (seg[0] === 'users' && seg[1]) {
    const name = seg[1];
    const action = seg[2] || '';
    if (action === 'import' && method === 'POST') {
      const u = await takUsers.importOts(name, body);
      return json(res, 200, { ok: true, user: takUsers.adminView(u), link: accessLink(req, u) });
    }
    if (action === 'active' && method === 'POST') {
      if (body.on) await ots.activateUser(name).catch(e => { if (!/already/i.test(e.message)) throw e; });
      else await ots.deactivateUser(name).catch(e => { if (!/already/i.test(e.message)) throw e; });
      const m = takUsers.byUsername(name);
      if (m && m.status !== 'rejected') { m.status = body.on ? 'active' : 'blocked'; takUsers.save(); }
      return json(res, 200, { ok: true });
    }
    if (action === 'password' && method === 'POST') {
      const pw = String(body.password || '').trim() || takUsers.newUserPassword();
      takUsers.checkPassword(pw);
      await ots.resetPassword(name, pw);
      await takUsers.checkLogin(name, pw);
      const m = takUsers.byUsername(name);
      if (m) { m.password = pw; takUsers.save(); }
      return json(res, 200, { ok: true, password: pw });
    }
    if (action === 'role' && method === 'POST') {
      await ots.setRoles(name, body.admin ? ['administrator'] : ['user']);
      return json(res, 200, { ok: true });
    }
    if (action === 'groups' && method === 'POST') {
      const group = String(body.group || '').trim();
      const direction = body.direction === 'OUT' ? 'OUT' : 'IN';
      if (!group) return json(res, 400, { error: 'Group missing.' });
      if (body.remove) await ots.removeFromGroup(name, group, direction);
      else { await ots.ensureGroup(group); await ots.addToGroup(name, group, direction); }
      return json(res, 200, { ok: true });
    }
    if (!action && method === 'DELETE') {
      const m = takUsers.byUsername(name);
      if (m) await takUsers.remove(m.id); else await ots.deleteUser(name);
      log('Admin: TAK user deleted', name);
      return json(res, 200, { ok: true });
    }
  }

  if (route === 'groups' && method === 'GET') return json(res, 200, { groups: await ots.allGroups() });
  if (route === 'groups' && method === 'POST') {
    const name = String(body.name || '').trim();
    if (!/^[\w.-]{1,60}$/.test(name)) return json(res, 400, { error: 'Group name: 1–60 characters, letters, digits, _ . -' });
    await ots.createGroup(name, String(body.description || '').slice(0, 200));
    return json(res, 200, { ok: true });
  }
  if (seg[0] === 'groups' && seg[1] && method === 'DELETE') {
    if (seg[1] === '__ANON__') return json(res, 400, { error: '__ANON__ is the OTS default group and stays.' });
    await ots.deleteGroup(seg[1]);
    return json(res, 200, { ok: true });
  }

  if (route === 'euds' && method === 'GET') {
    const euds = await ots.allEuds();
    return json(res, 200, { euds: euds.map(e => ({ uid: e.uid, callsign: e.callsign, username: e.username || '', lastStatus: e.last_status || '' })) });
  }

  // OTS shows users with groups only missions of their IN groups; nobody then sees a mission without a group.
  // So no selection means: all groups (like "visible to everyone")
  const missionGroupIds = async names => {
    const all = await ots.allGroups();
    const pick = Array.isArray(names) && names.length ? all.filter(g => names.includes(g.name)) : all;
    return pick.map(g => g.id).filter(x => x != null);
  };
  if (route === 'missions' && method === 'GET') {
    const list = await ots.missions();
    return json(res, 200, { missions: list.map(m => ({ name: m.name, description: m.description || '', creator: m.creator_uid || m.creatorUid || '',
      created: m.create_time || m.createTime || '', password: !!(m.password_protected || m.passwordProtected),
      groups: (m.groups || []).map(g => (typeof g === 'string' ? g : g && g.name)).filter(Boolean),
      items: (m.uids || []).length, files: (m.contents || []).length })) });
  }
  if (route === 'missions' && method === 'POST') {
    const name = String(body.name || '').trim();
    if (!name || name.length > 100) return json(res, 400, { error: 'Please enter a mission name.' });
    let creatorUid = String(body.creatorUid || '').trim();
    if (!creatorUid) {
      const euds = await ots.allEuds();
      if (!euds.length) return json(res, 400, { error: 'OTS needs a known device as creator – none has connected yet.' });
      creatorUid = euds[0].uid;
    }
    const groupIds = await missionGroupIds(body.groups);
    await ots.createMission({ name, description: String(body.description || '').slice(0, 500), password: String(body.password || ''), creatorUid, groups: groupIds });
    log('Admin: mission created', name);
    return json(res, 200, { ok: true });
  }
  if (seg[0] === 'missions' && seg[1] && seg[2] === 'groups' && method === 'PUT') {
    const m = (await ots.missions()).find(x => x.name === seg[1]);
    if (!m) return json(res, 404, { error: 'Mission not found.' });
    await ots.setMissionGroups(m.name, m.creator_uid || m.creatorUid, await missionGroupIds(body.groups));
    log('Admin: mission groups set', m.name);
    return json(res, 200, { ok: true });
  }
  if (seg[0] === 'missions' && seg[1] && method === 'DELETE') {
    await ots.deleteMission(seg[1]);
    return json(res, 200, { ok: true });
  }

  // Video feeds in the TAK server (MediaMTX): all paths, create a feed (source pulled on demand), delete
  if (route === 'feeds' && method === 'GET') return json(res, 200, { feeds: await ots.videoStreams(), rtspHost: takUsers.takHost() });
  if (route === 'feeds' && method === 'POST') {
    const p = String(body.path || '').trim().replace(/^\/+|\/+$/g, '');
    const source = String(body.source || '').trim();
    if (!TakVideo.validPath(p)) return json(res, 400, { error: 'Path: only letters, digits, - _ . and /' });
    if (source && !/^(rtsp|rtsps|rtmp|rtmps|http|https|srt|udp):\/\//i.test(source)) return json(res, 400, { error: 'Source: rtsp://, rtmp://, http(s):// (HLS), srt:// or udp://' });
    await ots.addStream(p, source);
    return json(res, 200, { ok: true });
  }
  if (seg[0] === 'feeds' && seg[1] && method === 'DELETE') {
    await ots.deleteStream(seg.slice(1).join('/'));
    return json(res, 200, { ok: true });
  }

  // Meshtastic channels
  if (route === 'mesh' && method === 'GET') return json(res, 200, { channels: await ots.meshChannels() });
  if (route === 'mesh/psk' && method === 'GET') return json(res, 200, { psk: await ots.meshPsk() });
  if (route === 'mesh' && method === 'POST') {
    const b = {};
    if (body.url) b.url = String(body.url).trim();
    else {
      const name = String(body.name || '').trim();
      if (!name || name.length > 11) return json(res, 400, { error: 'Channel name: 1–11 characters (Meshtastic limit).' });
      Object.assign(b, {
        name, psk: String(body.psk || ''), modem_preset: String(body.modemPreset || 'LONG_FAST'), lora_region: String(body.region || 'EU_868'),
        uplink_enabled: body.uplink !== false, downlink_enabled: body.downlink !== false, lora_tx_enabled: true, lora_hop_limit: 3,
        position_precision: Number(body.positionPrecision) || 32,
      });
    }
    await ots.createMeshChannel(b);
    return json(res, 200, { ok: true });
  }
  if (route === 'mesh' && method === 'DELETE') {
    const u = new URL(req.url, 'http://x').searchParams.get('url');
    if (!u) return json(res, 400, { error: 'Channel missing.' });
    await ots.deleteMeshChannel(u);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Unknown request.' });
}

async function handleTakAdmin(req, res, route) {
  const method = req.method;
  if (route === 'state' && method === 'GET') {
    const { password, ...ots } = req.takwebHelper ? { password: '' } : takUsers.t.ots;
    return json(res, 200, {
      ots: { ...ots, hasPassword: !!password, effectiveHost: takUsers.takHost() }, otsReady: takUsers.otsConfigured(), registration: takUsers.t.registration,
      teams: takUsers.t.teams, blocks: takUsers.t.blocks, users: takUsers.list().map(u => takUsers.adminView(u)),
      colors: TEAM_COLORS, roles: ROLES, joinUrl: publicBase(req) + '/join/', mail: mailReady(),
    });
  }
  if (route === 'join-qr.svg' && method === 'GET') {
    return send(res, 200, await QRCode.toString(publicBase(req) + '/join/', { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }), 'image/svg+xml');
  }
  if (method === 'GET') {
    const m = /^user\/([a-f0-9]+)\/link$/.exec(route);
    if (m) return json(res, 200, { link: accessLink(req, takUsers.get(m[1])) });
    // ATAK enrollment QR of a user (popup in the admin: scan, save, print)
    const q = /^user\/([a-f0-9]+)\/atak-qr\.svg$/.exec(route);
    if (q) {
      const link = takUsers.fixQr(takUsers.get(q[1]).atakQr || '');
      if (!link) return send(res, 404, 'No QR code');
      return send(res, 200, await QRCode.toString(link, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }), 'image/svg+xml');
    }
    return json(res, 404, { error: 'Unknown request.' });
  }
  const body = method === 'DELETE' ? {} : await readJson(req);
  if (route === 'ots') { takUsers.setOts(body); return json(res, 200, { ok: true }); }
  if (route === 'ots/test') {
    const r = await takUsers.ots().test();
    let groups = [];
    try { groups = await takUsers.ots().groups(); } catch (e) { /* groups possibly via LDAP */ }
    return json(res, 200, { ok: r.ok, groups });
  }
  if (route === 'registration') { takUsers.setRegistration(body); return json(res, 200, { ok: true }); }
  if (route === 'teams') {
    const errors = await takUsers.setTeams(body.teams, body.blocks);
    return json(res, 200, { ok: true, errors });
  }
  if (route === 'sync') {
    const groupErrors = await takUsers.syncAllGroups();
    const r = await takUsers.syncProfiles();
    return json(res, 200, { ok: true, updated: r.updated, errors: [...groupErrors, ...r.errors] });
  }
  const m = /^user\/([a-f0-9]+)(?:\/([a-z]*))?$/.exec(route);
  if (!m) return json(res, 404, { error: 'Unknown request.' });
  const [, id, action] = m;
  if (method === 'DELETE' && !action) { await takUsers.remove(id); return json(res, 200, { ok: true }); }
  let u;
  if (action === 'approve') {
    u = await takUsers.approve(id, body);
    const sent = await mailUser(u.email, 'TAKweb – your access is ready',
      `Hello ${u.name},\n\nyour TAKweb access has been approved.\n\nCallsign: ${u.callsign}\n\nOpen this page for your login details, QR codes and the step-by-step guide.\nRecommended: start TAKweb right from that page – it runs in the browser on any phone, nothing to install:\n\n${accessLink(req, u)}\n\nKeep this link private.\n`);
    return json(res, 200, { ok: true, user: takUsers.adminView(u), mailed: sent, link: accessLink(req, u) });
  }
  if (action === 'update') u = await takUsers.update(id, body);
  else if (action === 'reject') {
    u = await takUsers.reject(id);
    mailUser(u.email, 'TAKweb – registration request declined',
      `Hello ${u.name},\n\nyour registration request for TAKweb was declined by an administrator.\nIf you think this is a mistake, please contact your administrator.\n`);
  }
  else if (action === 'block') u = await takUsers.block(id);
  else if (action === 'unblock') u = await takUsers.unblock(id);
  else if (action === 'password') u = await takUsers.newPassword(id);
  else if (action === 'qr') u = await takUsers.newQr(id);
  else return json(res, 404, { error: 'Unknown request.' });
  return json(res, 200, { ok: true, user: takUsers.adminView(u) });
}

function takSettings() {
  const s = store.data.settings || {};
  return { allowedHosts: s.takHosts || '', preset: s.eudPreset || null };
}

// The TAK server connected in the admin (OTS): allowed on its TAK ports even if it runs on this machine
// (localhost / 127.0.1.1 in /etc/hosts), and reached over the OTS address set in the admin (often internal)
// when its public domain does not answer from here (router without NAT loopback, Docker).
function ownTak(host) {
  const o = takUsers.t.ots || {};
  let internal = '';
  try { internal = new URL(o.url).hostname.replace(/^\[|\]$/g, ''); } catch (e) { /* no OTS address */ }
  const names = [o.host, internal, (takSettings().preset || {}).host].filter(Boolean).map(x => x.toLowerCase());
  if (!host || !names.includes(host.toLowerCase())) return null;
  return { altHost: internal && internal.toLowerCase() !== host.toLowerCase() ? internal : '' };
}

function takPorts() {
  const o = takUsers.t.ots || {};
  const p = takSettings().preset || {};
  return [o.streamPort, o.enrollPort, o.apiPort, p.port, p.enrollPort, 8089, tak.ENROLL_PORT, tak.API_PORT].filter(Boolean).map(Number);
}

// '' = allowed, otherwise the reason
// Videos of the own TAK server (OTS): like the OTS web UI over its /hls/ with the login (jwt) of the OTS
// admin set in TAKweb – MediaMTX itself (port 8888) usually is not reachable/redirects. Only for devices that are
// connected to a TAK server through TAKweb right now; the browser never sees the login.
function otsMedia(req) {
  if (!takUsers.otsConfigured()) return null;
  const ip = clientIp(req);
  const hqUser = !!auth.check(cookies(req).sid); // HQ pages (logged in to the admin)
  if (!hqUser && ![...takLinks.values()].some(l => l.ip === ip && l.state === 'connected')) return null;
  let base;
  try { base = new URL(takUsers.t.ots.url); } catch (e) { return null; }
  return async (url, { fresh }) => {
    let path;
    if (url.origin === base.origin && url.pathname.startsWith('/hls/')) path = url.pathname;
    else if (ownTak(url.hostname) && url.port === '8888') path = '/hls' + url.pathname;
    else return null;
    const ots = takUsers.ots();
    if (fresh || !ots.token) await ots.login();
    const b = new URL(path, base);
    const f = new URL(b);
    f.searchParams.set('jwt', ots.token);
    return { fetch: f, base: b };
  };
}

// drone telemetry (KLV) of a feed: where to read it. The TAK server's MediaMTX via RTSP with the OTS login
// (RTSP keeps the KLV track, OTS's HLS usually does not), then the feed address itself if it is allowed.
const klvFeeds = new KlvFeeds({ ffmpeg: ffmpegOk ? config.ffmpeg : null, log });
async function klvCandidates(req, raw) {
  let url;
  try { url = new URL(raw); } catch (e) { return []; }
  if (!/^(rtsps?|srt|https?):$/.test(url.protocol)) return [];
  const out = [];
  const own = ownTak(url.hostname);
  const o = takUsers.t.ots || {};
  const linked = [...takLinks.values()].some(l => l.ip === clientIp(req) && l.state === 'connected');
  if (own && takUsers.otsConfigured() && linked && o.username && o.password) {
    // path of the feed: rtsp://host:8554/<path>, http://host:8888/<path>/index.m3u8, https://ots/hls/<path>/…
    let path = url.pathname.replace(/\/(index|stream)\.m3u8$/i, '').replace(/\/[^/]*\.m3u8$/i, '');
    if (/^https?:$/.test(url.protocol) && path.startsWith('/hls/')) path = path.slice(4);
    if (/^rtsps?:$/.test(url.protocol) || url.port === '8888' || url.pathname.startsWith('/hls/')) {
      const host = own.altHost || url.hostname;
      out.push({ url: `rtsp://${encodeURIComponent(o.username)}:${encodeURIComponent(o.password)}@${host.includes(':') ? `[${host}]` : host}:8554${path}`, label: `rtsp://${host}:8554${path}` });
    }
  }
  if (!url.username && !url.password && (own || await tak.targetAllowed(takSettings().allowedHosts, url.hostname))) {
    out.push({ url: url.href, label: url.origin + url.pathname });
  }
  return out;
}

// ---------------- Federation: TAK servers exchange data through TAKweb ----------------
// store.data.federation = { id, enabled, intervalMin, local: { enabled, cot, packages, cert… }, peers: [{ id, name, host, ports, cert…, cot, packages, enabled }] }
function fedConfig() {
  const f = store.data.federation || (store.data.federation = {});
  if (!f.id) f.id = crypto.randomBytes(4).toString('hex');
  f.intervalMin = Number(f.intervalMin) || 5;
  f.local = Object.assign({ enabled: true, cot: true, packages: true }, f.local || {});
  f.peers = f.peers || [];
  return f;
}
const certOf = x => ({ certPem: x.certPem || '', keyPem: x.keyPem || '', caPems: x.caPems || [], fingerprint: x.fingerprint || '' });
function fedLocal() {
  const o = takUsers.t.ots || {};
  let internal = '';
  try { internal = new URL(o.url).hostname; } catch (e) { /* no OTS */ }
  const host = o.host || internal;
  return { id: 'local', name: 'This TAK server', host, altHost: internal && internal !== host ? internal : '', port: o.streamPort || 8089, apiPort: o.apiPort || 8443, enrollPort: o.enrollPort || tak.ENROLL_PORT };
}
function fedMembers() {
  const f = fedConfig();
  if (!f.enabled) return [];
  const out = [];
  if (f.local.enabled && takUsers.otsConfigured()) out.push({ ...fedLocal(), ...certOf(f.local), cot: f.local.cot, packages: f.local.packages });
  for (const p of f.peers) if (p.enabled !== false) out.push({ ...p, ...certOf(p), altHost: '' });
  return out;
}
const federation = new Federation({ tak, log, id: fedConfig().id, members: fedMembers, intervalMin: () => fedConfig().intervalMin });
// client certificate for a member: with user + password (the password is not kept) or from a .p12
async function fedCert(target, { host, enrollPort, username, password, p12, p12Password, fingerprint }) {
  if (p12) {
    const r = tak.readP12(String(p12), String(p12Password || ''));
    if (!r.certPem || !r.keyPem) throw new Error('The .p12 holds no client certificate.');
    Object.assign(target, { certPem: r.certPem, keyPem: r.keyPem, caPems: r.caPems || [], fingerprint: fingerprint || target.fingerprint || '' });
    return;
  }
  const r = await tak.enroll({ host, port: Number(enrollPort) || tak.ENROLL_PORT, username, password, uid: 'TAKWEB-FED-' + fedConfig().id, caPems: target.caPems || [], fingerprint: fingerprint || target.fingerprint || '' });
  Object.assign(target, { certPem: r.certPem, keyPem: r.keyPem, caPems: r.caPems, fingerprint: fingerprint || target.fingerprint || '', username });
}
// own TAK server: certificate with the OTS login from the settings (the own server is trusted) -> '' or a problem
async function fedLocalCert() {
  const f = fedConfig();
  if (!f.enabled || !f.local.enabled || !takUsers.otsConfigured() || f.local.certPem) return '';
  const o = takUsers.t.ots, l = fedLocal();
  const req = { host: l.altHost || l.host, enrollPort: l.enrollPort, username: o.username, password: o.password };
  try {
    try { await fedCert(f.local, req); } catch (e) { if (e.code !== 'UNTRUSTED') throw e; await fedCert(f.local, { ...req, fingerprint: e.fingerprint }); }
    f.local.error = '';
    return '';
  } catch (e) {
    f.local.error = 'certificate request failed – ' + e.message + ' (switch "takes part" off and on to try again)';
    return 'This TAK server: ' + f.local.error;
  }
}

// ---------------- Mission tracks: record positions and map objects, replay afterwards ----------------
// store.data.tracks = { user: { username, password } (OTS user of the recorder, receives every group),
//   certPem, keyPem, caPems, fingerprint (its client certificate), missions: [...] }
const tracksData = () => store.data.tracks || (store.data.tracks = {});
// who is recorded: OTS devices (uid -> username, callsign) and the groups of each user, refreshed while recording
const who = { euds: new Map(), groups: new Map(), at: 0, busy: null };
async function whoRefresh(force = false) {
  if (who.busy) return who.busy;
  if (!force && Date.now() - who.at < 30000) return null;
  who.busy = (async () => {
    try {
      const ots = takUsers.ots();
      const euds = await ots.allEuds();
      who.euds = new Map(euds.filter(e => e.uid).map(e => [e.uid, { username: e.username || '', callsign: e.callsign || '' }]));
      const m = tracks.active();
      if (m && m.who.mode === 'groups') {
        const names = [...new Set([...who.euds.values()].map(e => e.username).filter(Boolean))];
        for (const n of names) who.groups.set(n, (await ots.userGroups(n)).map(g => g.group));
      }
      who.at = Date.now();
    } catch (e) { log('Mission tracks: devices from OTS – ' + e.message); who.at = Date.now(); } finally { who.busy = null; }
  })();
  return who.busy;
}
function trackAccept(m, uid, callsign) {
  const w = m.who || { mode: 'all' };
  if (w.mode === 'all') return true;
  const e = who.euds.get(uid);
  if (!e) whoRefresh(); // a device OTS did not know yet: asked again (the next position counts)
  if (w.mode === 'users') {
    const ids = [uid, e && e.username, e && e.callsign, callsign].filter(Boolean).map(s => s.toLowerCase());
    return w.users.some(u => ids.includes(String(u).toLowerCase()));
  }
  const groups = (e && who.groups.get(e.username)) || [];
  return groups.some(g => w.groups.includes(g));
}
// HQ pages: live picture, geofences, warnings, situation log (lib/hq.js)
const hq = new Hq({ data: () => store.data.hq || (store.data.hq = {}), save: () => store.save(), log });
setInterval(() => hq.sweep(), 60000).unref();
const tracks = new Tracks({
  dir: path.join(config.dataDir, 'tracks'), data: tracksData, save: () => store.save(), log, accept: trackAccept,
  onChange: () => recApply().catch(e => log('Mission tracks: ' + e.message)),
});
let recLink = null;
const recState = { state: 'off', message: '' };
const recUid = () => 'TAKWEB-REC-' + fedConfig().id;
// OTS delivers to a client only what its user's groups may read: the recorder has its own OTS user that reads every group
async function recUser() {
  const d = tracksData(), ots = takUsers.ots();
  if (!d.user) { d.user = { username: 'takweb_recorder', password: makePassword() }; store.save(); }
  if (!(await ots.userExists(d.user.username))) {
    await ots.addUser(d.user.username, d.user.password, ['user']);
    d.certPem = ''; // a new user needs a new certificate
  }
  const groups = new Set((await ots.allGroups()).map(g => g.name).filter(Boolean));
  groups.add(ANON);
  await ots.syncGroups(d.user.username, [...groups].map(group => ({ group, direction: 'OUT' })), '', []);
  return d.user;
}
// for the HQ pages and while a mission is recorded: connected to the own TAK server, receives every position and object
async function recApply() {
  const want = (!!tracks.active() || hq.enabled()) && takUsers.otsConfigured();
  if (!want) {
    if (recLink) { recLink.stop(); recLink = null; }
    Object.assign(recState, { state: 'off', message: tracks.active() ? 'OpenTAKServer is not set up – nothing is recorded.' : '' });
    return recState.message;
  }
  if (recLink) return '';
  const d = tracksData(), l = fedLocal();
  try {
    const u = await recUser();
    if (!d.certPem) {
      const req = { host: l.altHost || l.host, port: l.enrollPort, username: u.username, password: u.password, uid: recUid(), caPems: d.caPems || [] };
      let r;
      try { r = await tak.enroll(req); } catch (e) {
        if (e.code === 'UNTRUSTED') { d.fingerprint = e.fingerprint; r = await tak.enroll({ ...req, fingerprint: e.fingerprint }); } else if (/401|403|password|credentials/i.test(e.message)) {
          await takUsers.ots().resetPassword(u.username, u.password); // the OTS user exists, but with another password
          r = await tak.enroll(req);
        } else throw e;
      }
      Object.assign(d, { certPem: r.certPem, keyPem: r.keyPem, caPems: r.caPems || [] });
      store.save();
    }
  } catch (e) {
    Object.assign(recState, { state: 'error', message: 'Recorder at the TAK server not ready – ' + e.message });
    return recState.message;
  }
  if (recLink || !(tracks.active() || hq.enabled())) return '';
  whoRefresh(true);
  recLink = new tak.TakLink({
    host: l.host, altHost: l.altHost, port: l.port, proto: 'ssl', certPem: d.certPem, keyPem: d.keyPem, caPems: d.caPems, fingerprint: d.fingerprint || '',
    uid: recUid(), hello: 'TAKweb HQ',
    onStatus: (state, message) => {
      if (recState.state !== state) log(`TAK server (HQ/tracks): ${message || state}`);
      if (state === 'connected') hq.connected();
      Object.assign(recState, { state, message: message || '' });
      if (/rejected the client certificate/.test(message || '')) { d.certPem = ''; store.save(); } // e.g. revoked: a new one next time
    },
    onCot: xml => { tracks.cot(xml); hq.cot(xml); },
  });
  recLink.start();
  return '';
}
setInterval(() => { const m = tracks.active(); if (m && m.who.mode !== 'all') whoRefresh(true); }, 120000).unref();

const missionSummary = m => ({
  id: m.id, name: m.name, otsMission: m.otsMission || '', state: stateOf(m), from: m.from || null, to: m.to || null, start: m.start || null, end: m.end || null,
  who: m.who || { mode: 'all', groups: [], users: [] }, objects: m.objects !== false, missed: !!m.missed,
  points: m.points || 0, objectCount: m.objectCount || 0, users: Object.keys(m.users || {}).length,
});
function tracksView() {
  return { available: takUsers.otsConfigured(), source: { ...recState }, missions: tracks.missions().map(missionSummary) };
}
async function handleTracks(req, res, route, method) {
  if (route === '' && method === 'GET') return json(res, 200, tracksView());
  // choices for a new mission: OTS missions (Data Sync), groups and devices
  if (route === 'options' && method === 'GET') {
    if (!takUsers.otsConfigured()) return json(res, 200, { missions: [], groups: [], euds: [] });
    const ots = takUsers.ots();
    const safe = p => p.catch(() => []);
    const [missions, groups, euds] = await Promise.all([safe(ots.missions()), safe(ots.allGroups()), safe(ots.allEuds())]);
    return json(res, 200, {
      missions: missions.map(x => x.name).filter(Boolean).sort(),
      groups: groups.map(g => g.name).filter(n => n && n !== ANON).sort(),
      euds: euds.filter(e => e.uid && !/^TAKWEB-/.test(e.uid)).map(e => ({ uid: e.uid, callsign: e.callsign || '', username: e.username || '', lastSeen: e.last_event_time || null }))
        .sort((a, b) => a.callsign.localeCompare(b.callsign)),
    });
  }
  if (route === '' && method === 'POST') {
    if (!takUsers.otsConfigured()) return json(res, 400, { error: 'Set up OpenTAKServer first (OpenTAKServer & registration) – the positions come from there.' });
    const body = await readJson(req);
    try { tracks.create(body); } catch (e) { return json(res, 409, { error: e.message }); }
    const warning = await recApply();
    return json(res, 200, { ...tracksView(), warning });
  }
  const m = /^([a-f0-9]{12})(?:\/(stop|start|points|objects|export\.gpx|export\.kml))?$/.exec(route);
  const mission = m && tracks.get(m[1]);
  if (!mission) return json(res, 404, { error: 'Mission not found.' });
  if (!m[2] && method === 'GET') return json(res, 200, { mission: missionSummary(mission) });
  if (!m[2] && method === 'POST') {
    try { tracks.edit(mission.id, await readJson(req)); } catch (e) { return json(res, 400, { error: e.message }); }
    return json(res, 200, tracksView());
  }
  if (!m[2] && method === 'DELETE') { tracks.remove(mission.id); await recApply(); log('Mission deleted:', mission.name); return json(res, 200, tracksView()); }
  if (m[2] === 'stop' && method === 'POST') { if (stateOf(mission) === 'recording') tracks.stop(); return json(res, 200, tracksView()); }
  if (m[2] === 'start' && method === 'POST') {
    try { tracks.startNow(mission.id); } catch (e) { return json(res, 409, { error: e.message }); }
    const warning = await recApply();
    return json(res, 200, { ...tracksView(), warning });
  }
  if (m[2] === 'points' && method === 'GET') {
    const users = {};
    for (const [uid, u] of Object.entries(mission.users)) users[uid] = { callsign: u.callsign, team: u.team, role: u.role, first: u.first, last: u.last, points: u.points, meters: u.meters };
    return json(res, 200, { mission: missionSummary(mission), users, points: tracks.points(mission.id) });
  }
  if (m[2] === 'objects' && method === 'GET') return json(res, 200, { objects: tracks.objects(mission.id) });
  if (m[2] && m[2].startsWith('export') && method === 'GET') {
    const kml = m[2].endsWith('kml');
    const name = (mission.name.replace(/[^\w.-]+/g, '_') || 'mission') + (kml ? '.kml' : '.gpx');
    res.writeHead(200, { 'Content-Type': kml ? 'application/vnd.google-earth.kml+xml' : 'application/gpx+xml', 'Content-Disposition': `attachment; filename="${name}"` });
    return res.end(kml ? tracks.kml(mission.id) : tracks.gpx(mission.id));
  }
  return json(res, 404, { error: 'Not found' });
}

// ---------------- HQ pages ----------------
// video sources for the video wall: feeds of the TAK server (MediaMTX), TAKweb camera streams, videos in CoT (drones …)
async function hqFeeds(req) {
  const out = [];
  if (takUsers.otsConfigured()) {
    try {
      const base = new URL(takUsers.t.ots.url);
      for (const f of await takUsers.ots().videoStreams()) out.push({ name: f.path, kind: 'TAK server', url: new URL('/hls/' + f.path + '/index.m3u8', base).href });
    } catch (e) { /* OTS not reachable */ }
  }
  for (const e of Object.values(store.data.streams || {})) {
    if (!hub.live(StreamHub.id(e.user, e.streamId))) continue;
    out.push({ name: e.label || `${e.user}/${e.streamId}`, kind: 'Camera', url: links(req, e).stream, mjpeg: true });
  }
  const seen = new Set(out.map(x => x.url));
  const st = hq.state(Infinity);
  for (const x of [...st.devices, ...st.objects]) if (x.video && !seen.has(x.video)) { seen.add(x.video); out.push({ name: x.callsign || x.uid, kind: /UAS|drone/i.test(x.uid + x.callsign) || /^a-.-A/.test(x.type) ? 'Drone' : 'Video', url: x.video }); }
  return out;
}
async function handleHq(req, res, route, method) {
  if (route === 'state' && method === 'GET') {
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
    return json(res, 200, { ...hq.state(since), source: { ...recState, available: takUsers.otsConfigured() }, recording: (() => { const m = tracks.active(); return m ? { id: m.id, name: m.name, start: m.start } : null; })() });
  }
  if (route === 'feeds' && method === 'GET') return json(res, 200, { feeds: await hqFeeds(req) });
  if (route === 'log.csv' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="situation-log.csv"' });
    return res.end('\ufeff' + hq.csv());
  }
  const body = method === 'POST' ? await readJson(req) : {};
  try {
    if (route === 'log' && method === 'POST') { hq.addLog(body); store.save(); return json(res, 200, { ok: true }); }
    const lm = /^log\/([a-f0-9]{10})$/.exec(route);
    if (lm && method === 'DELETE') { hq.removeLog(lm[1]); return json(res, 200, { ok: true }); }
    if (route === 'units' && method === 'POST') { const units = hq.setUnits(body.units); store.save(); return json(res, 200, { units }); }
    const um = /^units\/([a-f0-9]{10})\/status$/.exec(route);
    if (um && method === 'POST') { hq.setUnitStatus(um[1], String(body.status || '')); store.save(); return json(res, 200, { ok: true }); }
    if (route === 'clear' && method === 'POST') { hq.clear(Array.isArray(body.what) ? body.what : []); store.save(); return json(res, 200, { ok: true }); }
    if (route === 'fences' && method === 'POST') { const fences = hq.setFences(body.fences); store.save(); return json(res, 200, { fences }); }
    if (route === 'settings' && method === 'POST') {
      hq.d().enabled = body.enabled !== false;
      store.save();
      const warning = await recApply();
      return json(res, 200, { ok: true, warning });
    }
  } catch (e) { return json(res, 400, { error: e.message }); }
  return json(res, 404, { error: 'Not found' });
}

function fedView() {
  const f = fedConfig();
  const st = federation.state();
  const live = id => st.members.find(m => m.id === id) || null;
  const info = x => (x.certPem ? tak.certInfo(x.certPem) : null);
  return {
    enabled: !!f.enabled, intervalMin: f.intervalMin, lastSync: st.lastSync,
    local: { available: takUsers.otsConfigured(), host: fedLocal().host, enabled: f.local.enabled, cot: f.local.cot, packages: f.local.packages, cert: info(f.local), live: live('local'), error: f.local.certPem ? '' : f.local.error || '' },
    peers: f.peers.map(p => ({ id: p.id, name: p.name, host: p.host, port: p.port, apiPort: p.apiPort, enrollPort: p.enrollPort, username: p.username || '',
      cot: p.cot !== false, packages: p.packages !== false, enabled: p.enabled !== false, cert: info(p), live: live(p.id) })),
  };
}
async function handleFederation(req, res, route, method) {
  const f = fedConfig();
  const untrusted = e => (e.code === 'UNTRUSTED' ? json(res, 409, { error: e.message, code: e.code, fingerprint: e.fingerprint, subject: e.subject }) : null);
  if (route === '' && method === 'GET') return json(res, 200, fedView());
  if (route === '' && method === 'POST') {
    const body = await readJson(req);
    f.enabled = !!body.enabled;
    if (body.intervalMin) f.intervalMin = Math.min(1440, Math.max(1, Number(body.intervalMin) || 5));
    const warning = await fedLocalCert();
    store.save();
    federation.apply();
    log('Federation', f.enabled ? 'on' : 'off');
    return json(res, 200, { ...fedView(), warning });
  }
  if (route === 'local' && method === 'POST') {
    const body = await readJson(req);
    Object.assign(f.local, { enabled: !!body.enabled, cot: !!body.cot, packages: !!body.packages });
    const warning = await fedLocalCert();
    store.save();
    federation.apply();
    return json(res, 200, { ...fedView(), warning });
  }
  if (route === 'peers' && method === 'POST') {
    const body = await readJson(req, 512 * 1024);
    const host = String(body.host || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '');
    if (!host || !/^[a-z0-9.:_-]+$/i.test(host)) throw new Error('Enter the address of the TAK server.');
    let p = f.peers.find(x => x.id === body.id);
    const fresh = !p;
    if (!p) p = { id: crypto.randomBytes(4).toString('hex') };
    const before = { host: p.host, enrollPort: p.enrollPort };
    Object.assign(p, {
      name: String(body.name || host).trim().slice(0, 60), host, port: Number(body.port) || 8089, apiPort: Number(body.apiPort) || 8443,
      enrollPort: Number(body.enrollPort) || tak.ENROLL_PORT, cot: body.cot !== false, packages: body.packages !== false, enabled: body.enabled !== false,
    });
    if (before.host && before.host !== host) Object.assign(p, { certPem: '', keyPem: '', caPems: [], fingerprint: '' }); // another server
    if (body.password || body.p12) {
      try {
        await fedCert(p, { host, enrollPort: p.enrollPort, username: String(body.username || '').trim(), password: String(body.password || ''), p12: body.p12, p12Password: body.p12Password, fingerprint: body.fingerprint });
      } catch (e) { return untrusted(e) || json(res, 400, { error: e.message }); }
    }
    if (!p.certPem) return json(res, 400, { error: 'Enter user and password (or a .p12) – TAKweb requests its own certificate there.' });
    if (fresh) f.peers.push(p);
    store.save();
    federation.apply();
    log('Federation server', fresh ? 'added' : 'changed', p.name);
    return json(res, 200, fedView());
  }
  const pm = route.match(/^peers\/([a-f0-9]+)$/);
  if (pm && method === 'DELETE') {
    f.peers = f.peers.filter(x => x.id !== pm[1]);
    store.save();
    federation.apply();
    return json(res, 200, fedView());
  }
  if (route === 'sync' && method === 'POST') {
    await federation.syncPackages();
    return json(res, 200, fedView());
  }
  return json(res, 404, { error: 'Unknown request.' });
}

async function takProblem(host, port) {
  const ports = takPorts();
  if (ownTak(host) && ports.includes(Number(port))) return '';
  return tak.targetProblem(takSettings().allowedHosts, host, { port, localPorts: ports });
}

const eudLimits = new Map(); // ip -> [timestamps] for certificate requests
const martiLimits = new Map(); // ip -> [timestamps] for TAK server API requests

async function handleEudApi(req, res, route) {
  if (route === 'config' && req.method === 'GET') {
    const t = takSettings();
    return json(res, 200, { preset: t.preset, restricted: !!t.allowedHosts.trim() });
  }
  // drone telemetry of a feed as server-sent events (CoT for the drone, image area, image centre)
  if (route === 'klv' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const raw = String(q.get('u') || '').slice(0, 2000);
    const name = String(q.get('n') || '').slice(0, 80);
    const candidates = await klvCandidates(req, raw);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!candidates.length) { send('status', { state: 'no-klv', message: 'No telemetry source for this stream.' }); return res.end(); }
    let path = '';
    try { path = new URL(raw).pathname; } catch (e) { /* checked above */ }
    const slug = (path.replace(/\/(index|stream)\.m3u8$/i, '').replace(/^\/(hls\/)?/, '') || name || 'uas').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    const close = klvFeeds.watch(candidates[0].url, { candidates, uid: 'UAS-' + slug, name, video: raw }, send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); close(); });
    return;
  }
  // voice message for the chat (voice.js): WAV 8 kHz, stored 3 days like the chat; the link goes into the GeoChat
  if (route === 'voicemsg' && req.method === 'POST') {
    if (!voiceWho(req)) return json(res, 403, { error: 'Voice messages need the connection to a TAK server through TAKweb.' });
    let data;
    try { data = await readRaw(req, VOICEMSG_MAX); } catch (e) { return json(res, 413, { error: 'Voice message too long.' }); }
    if (data.length < 44 || data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WAVE') return json(res, 400, { error: 'Not a WAV recording.' });
    const id = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(VOICEMSG_DIR, { recursive: true });
    fs.writeFileSync(path.join(VOICEMSG_DIR, id + '.wav'), data);
    return json(res, 200, { id, url: publicBase(req) + '/voicemsg/' + id + '.wav' });
  }
  // TAKweb for the flash of a Meshtastic radio (lib/meshsite.js, public/eud/meshinstall.js): list and files (gzipped)
  if (route === 'meshsite' && req.method === 'GET') {
    const b = meshsite.build(VERSION, publicBase(req) + '/eud/', new URL(req.url, 'http://x').searchParams.get('map'));
    return json(res, 200, { version: b.version, total: b.total, files: b.files.map(f => ({ name: f.name, size: f.size, gz: f.gz.length })) });
  }
  // the same as one ZIP (<name>.gz files) – for the Meshtastic desktop flasher, offline
  if (route === 'meshsite.zip' && req.method === 'GET') {
    const b = meshsite.build(VERSION, publicBase(req) + '/eud/', new URL(req.url, 'http://x').searchParams.get('map'));
    const entries = Object.fromEntries(b.files.map(f => [f.name + '.gz', f.gz]));
    entries['takweb-mesh.json'] = JSON.stringify({ version: b.version, files: b.files.map(f => f.name) });
    const z = zip(entries);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="takweb-mesh-${b.version}.zip"`, 'Content-Length': z.length });
    return res.end(z);
  }
  const msf = /^meshsite\/([\w.-]+)$/.exec(route);
  if (msf && req.method === 'GET') {
    const f = meshsite.build(VERSION, publicBase(req) + '/eud/', new URL(req.url, 'http://x').searchParams.get('map')).files.find(x => x.name === msf[1]);
    if (!f) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.gz.length, 'Cache-Control': 'no-cache' });
    return res.end(f.gz);
  }
  // video feeds (HLS) through our own server so the browser may play them
  if (route === 'media' && req.method === 'GET') {
    return proxyMedia(req, res, { allowed: host => tak.targetAllowed(takSettings().allowedHosts, host), log, mapUpstream: otsMedia(req) });
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'Unknown request.' });
  if (route === 'p12') {
    const body = await readJson(req, 512 * 1024);
    const r = tak.readP12(String(body.data || ''), String(body.password || ''));
    return json(res, 200, { ...r, info: r.certPem ? tak.certInfo(r.certPem) : null, caInfo: r.caPems.map(tak.certInfo) });
  }
  if (route === 'package') {
    const body = await readJson(req, 6 * 1024 * 1024);
    const r = tak.readDataPackage(String(body.data || ''));
    return json(res, 200, { ...r, info: r.certPem ? tak.certInfo(r.certPem) : null });
  }
  if (route === 'pem') {
    // truststore as a PEM file (one or more CAs)
    const body = await readJson(req, 512 * 1024);
    const pems = String(body.data || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    if (!pems.length) throw new Error('No certificates found in file.');
    return json(res, 200, { kind: 'truststore', caPems: pems.map(p => p + '\n'), caInfo: pems.map(p => tak.certInfo(p)) });
  }
  if (route === 'extract') {
    // load an own file (KML/KMZ/data package) as an overlay
    const body = await readJson(req, 120 * 1024 * 1024);
    return json(res, 200, await raster.prepare(tak.extractContent(String(body.name || ''), Buffer.from(String(body.data || ''), 'base64')), { ffmpeg: config.ffmpeg, log }));
  }
  if (route === 'marti') {
    const ip = clientIp(req);
    const now = Date.now();
    const list = (martiLimits.get(ip) || []).filter(t => now - t < 3600 * 1000);
    if (list.length >= 600) return json(res, 429, { error: 'Too many requests. Please try again later.' });
    list.push(now);
    martiLimits.set(ip, list);
    const body = await readJson(req, 512 * 1024);
    const conn = body.server || {};
    const host = String(conn.host || '').trim();
    const why = await takProblem(host, Number(conn.apiPort) || tak.API_PORT);
    if (why) return json(res, 403, { error: why });
    try {
      const r = await tak.marti({ ...conn, host, altHost: (ownTak(host) || {}).altHost || '' }, String(body.action || ''), body.args || {});
      return json(res, 200, await raster.prepare(r, { ffmpeg: config.ffmpeg, log })); // large map images in packages
    } catch (e) {
      log('EUD TAK-API', host, String(body.action || ''), 'error:', e.message);
      if (e.code === 'UNTRUSTED') return json(res, 409, { error: e.message, code: e.code, fingerprint: e.fingerprint, subject: e.subject });
      throw e;
    }
  }
  if (route === 'enroll' || route === 'check-login') {
    const ip = clientIp(req);
    const now = Date.now();
    const list = (eudLimits.get(ip) || []).filter(t => now - t < 3600 * 1000);
    if (list.length >= 30) return json(res, 429, { error: 'Too many requests. Please try again later.' });
    list.push(now);
    eudLimits.set(ip, list);
    const body = await readJson(req, 512 * 1024);
    const host = String(body.host || '').trim();
    const port = Number(body.port) || tak.ENROLL_PORT;
    const why = await takProblem(host, port);
    if (why) { log('EUD enrollment refused:', why); return json(res, 403, { error: why }); }
    try {
      // only check the password (drone/camera address): no new certificate
      if (route === 'check-login') {
        return json(res, 200, await tak.checkLogin({ host, altHost: (ownTak(host) || {}).altHost || '', port, username: body.username, password: body.password,
          caPems: Array.isArray(body.caPems) ? body.caPems : [], fingerprint: String(body.fingerprint || '') }));
      }
      const r = await tak.enroll({
        host, altHost: (ownTak(host) || {}).altHost || '', port, username: body.username, password: body.password,
        uid: String(body.uid || 'EUD').slice(0, 64), caPems: Array.isArray(body.caPems) ? body.caPems : [],
        fingerprint: String(body.fingerprint || ''),
      });
      log('EUD: certificate requested', host, r.info.subject);
      return json(res, 200, r);
    } catch (e) {
      if (e.code === 'UNTRUSTED') return json(res, 409, { error: e.message, code: e.code, fingerprint: e.fingerprint, subject: e.subject });
      throw e;
    }
  }
  return json(res, 404, { error: 'Unknown request.' });
}

// ======================================================================
// Admin API
// ======================================================================

// what helpers may do in the admin (method, route without query)
const HELPER_ROUTES = [
  ['GET', /^streams$/], ['POST', /^events\/delete$/], ['GET', /^registration$/], ['GET', /^tak$/], ['GET', /^(app|eud)-qr\.svg$/],
  ['GET', /^takusers\/state$/], ['GET', /^takusers\/join-qr\.svg$/], ['GET', /^takusers\/user\/[^/]+\/(link|atak-qr\.svg)$/],
  ['POST', /^takusers\/user\/[^/]+\/(approve|reject|update|block|unblock|password|qr)$/],
  ['GET', /^ots\/users$/], ['POST', /^ots\/users$/],
];

async function handleAdminApi(req, res, route) {
  const method = req.method;
  const sid = cookies(req).sid;
  const secure = protoOf(req) === 'https';
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

  // protection against foreign pages (CSRF): writing requests need this header
  if (method !== 'GET' && req.headers['x-requested-with'] !== 'helm') {
    return json(res, 403, { error: 'Invalid request.' });
  }

  // --- without login ---
  if (route === 'login' && method === 'POST') {
    const body = await readJson(req);
    const newSid = auth.login(clientIp(req), body.username, body.password);
    const ses = auth.check(newSid);
    log(ses.role === 'helper' ? 'Helper logged in' : 'Admin logged in', String(body.username || '').slice(0, 64), 'from', clientIp(req));
    return json(res, 200, { ok: true, role: ses.role, mustChange: ses.role === 'admin' && !!auth.admin.mustChange }, { 'Set-Cookie': `sid=${newSid}; ${cookieAttrs}; Max-Age=43200` });
  }
  if (route === 'forgot' && method === 'POST') {
    const body = await readJson(req);
    const who = String(body.username || '').trim().toLowerCase();
    const admin = auth.admin;
    if (who && admin.email && (who === admin.username.toLowerCase() || who === admin.email.toLowerCase())) {
      if (!resetBase()) {
        log('Password reset requested, but PUBLIC_URL/ADMIN_URL is not set – no mail sent.');
      } else if (smtpConfigured(store.data.smtp)) {
        const token = auth.createResetToken();
        const link = `${resetBase()}/admin/#reset=${token}`;
        sendMail(store.data.smtp, {
          to: admin.email,
          subject: 'TAKweb – reset password',
          text: `Hello,\n\nyou can set a new admin password with this link (valid for 1 hour):\n\n${link}\n\nIf you did not request this, ignore this e-mail.\n`,
        }).then(() => log('Reset mail sent')).catch(e => log('Reset mail failed:', e.message));
      } else {
        log('Password reset requested, but SMTP is not set up.');
      }
    }
    // always the same answer so nobody can probe usernames
    return json(res, 200, { ok: true });
  }
  if (route === 'reset' && method === 'POST') {
    const body = await readJson(req);
    auth.resetPassword(String(body.token || ''), body.password ? String(body.password) : '');
    log('Admin password reset via link');
    return json(res, 200, { ok: true });
  }

  // --- logged in from here on ---
  const session = auth.check(sid);
  if (!session) return json(res, 401, { error: 'Please log in.' });
  const helper = session.role === 'helper';
  const me = helper ? auth.helpers[session.helperId] : auth.admin;

  if (route === 'logout' && method === 'POST') {
    auth.logout(sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `sid=; ${cookieAttrs}; Max-Age=0` });
  }
  if (route === 'me' && method === 'GET') {
    return json(res, 200, {
      username: me.username,
      email: me.email || '',
      role: session.role,
      mustChange: !helper && !!auth.admin.mustChange,
      ffmpeg: ffmpegOk,
      publicBase: publicBase(req),
      testCa: !!config.testCa,
    });
  }
  if (route === 'credentials' && method === 'POST') {
    const body = await readJson(req);
    auth.changeCredentials(sid, {
      current: body.current,
      username: body.username,
      password: body.password,
      email: body.email,
    });
    log('Admin login details changed');
    return json(res, 200, { ok: true });
  }
  if (route === 'own-password' && method === 'POST') {
    const body = await readJson(req);
    auth.changeHelperPassword(sid, body.current, body.password);
    log('Helper changed their password:', me.username);
    return json(res, 200, { ok: true });
  }

  // remember the address the admin reaches us under, as a fallback for the HLS link in the TAK server
  if (!configuredBase() && !helper) {
    const b = publicBase(req);
    if (b && !/\/\/(localhost|127\.|\[::1\])/.test(b) && (store.data.takVideo || {}).lastBase !== b) {
      takVideo.s.lastBase = b;
      store.save();
    }
  }

  // the rest is only allowed after the first password change
  if (!helper && auth.admin.mustChange) return json(res, 403, { error: 'Please change the password first.', mustChange: true });

  // helpers: only approve/edit requests and create users – no settings, no deletions
  if (helper) {
    const allowed = HELPER_ROUTES.some(([m, re]) => m === method && re.test(route.split('?')[0]));
    if (!allowed) return json(res, 403, { error: 'Not allowed as a helper – please ask the admin.' });
    req.takwebHelper = true;
    if (route.startsWith('streams') && method === 'GET') {
      // no stream keys/links, only the notifications (new requests etc.)
      const q = new URL(req.url, 'http://x').searchParams;
      const since = Number(q.get('since'));
      const events = (Number.isFinite(since) && since >= 0 ? hub.eventsSince(since) : []).filter(e => e.kind === 'takreg');
      const history = q.get('history') ? hub.events.filter(e => e.kind === 'takreg').slice(-40) : undefined;
      return json(res, 200, { streams: [], ffmpeg: ffmpegOk, events, history, eventSeq: hub.eventSeq });
    }
  }

  // manage helpers (main admin only)
  if (route === 'helpers' && method === 'GET') return json(res, 200, { helpers: auth.listHelpers() });
  if (route === 'helpers' && method === 'POST') {
    const body = await readJson(req);
    const h = auth.addHelper(body);
    log('Helper created', h.username);
    return json(res, 200, { ok: true, helper: h });
  }
  const hm = route.match(/^helpers\/([A-Za-z0-9_-]+)(?:\/(password))?$/);
  if (hm && method === 'DELETE' && !hm[2]) { auth.removeHelper(hm[1]); log('Helper deleted', hm[1]); return json(res, 200, { ok: true }); }
  if (hm && method === 'POST' && hm[2]) { const body = await readJson(req); auth.setHelperPassword(hm[1], String(body.password || '')); return json(res, 200, { ok: true }); }

  if (route === 'registration' && method === 'GET') {
    const host = ((config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
    return json(res, 200, {
      enabled: registrationEnabled(),
      liveMode: hub.liveMode(),
      userCanStart: hub.userCanStart(),
      appUrl: publicBase(req) + '/app/',
      publicUrl: (store.data.settings || {}).publicUrl || '',           // set in the admin
      autoUrl: config.publicUrl || `${protoOf(req)}://${host}`,          // without a setting
    });
  }
  if (route.startsWith('takusers/')) return await handleTakAdmin(req, res, route.slice(9));
  if (route.startsWith('ots/')) return await handleOtsAdmin(req, res, route.slice(4));
  if (route === 'federation' || route.startsWith('federation/')) return await handleFederation(req, res, route.slice(11), method);
  if (route === 'tracks' || route.startsWith('tracks/')) return await handleTracks(req, res, route.slice(7), method);
  if (route === 'hq' || route.startsWith('hq/')) return await handleHq(req, res, route.slice(3).replace(/^\//, ''), method);
  if (route === 'takvideo' && method === 'GET') return json(res, 200, takVideo.state());
  if (route === 'takvideo/settings' && method === 'POST') { takVideo.setSettings(await readJson(req)); return json(res, 200, takVideo.state()); }
  if (route === 'takvideo/sync' && method === 'POST') { const r = await takVideo.syncAll(); return json(res, 200, { ...r, ...takVideo.state() }); }
  if (route === 'tak' && method === 'GET') {
    return json(res, 200, { allowedHosts: takSettings().allowedHosts, preset: takSettings().preset, eudUrl: publicBase(req) + '/eud/' });
  }
  if (route === 'tak' && method === 'POST') {
    const body = await readJson(req);
    const preset = body.preset && body.preset.host ? {
      host: String(body.preset.host).trim().slice(0, 200),
      port: Number(body.preset.port) || 8089,
      proto: ['ssl', 'tcp', 'udp'].includes(body.preset.proto) ? body.preset.proto : 'ssl',
      enrollPort: Number(body.preset.enrollPort) || tak.ENROLL_PORT,
    } : null;
    store.data.settings = { ...(store.data.settings || {}), takHosts: String(body.allowedHosts || '').slice(0, 2000), eudPreset: preset };
    store.save();
    return json(res, 200, { ok: true });
  }
  if (route === 'eud-qr.svg' && method === 'GET') {
    const p = takSettings().preset;
    let url = publicBase(req) + '/eud/';
    if (p) url += '#' + new URLSearchParams({ host: p.host, port: p.port, proto: p.proto, enroll: p.enrollPort }).toString();
    return send(res, 200, await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }), 'image/svg+xml');
  }
  // Meshtastic firmware library (lib/firmware.js): the admin flashes radios over USB from it, files to download
  if (route === 'firmware' && method === 'GET') return json(res, 200, { versions: firmwareLib.list() });
  if (route === 'firmware' && method === 'POST') {
    let buf;
    try { buf = await readRaw(req, FIRMWARE_MAX); } catch (e) { return json(res, 413, { error: 'Package too large.' }); }
    try { return json(res, 200, { imported: [firmwareLib.importZip(buf)], versions: firmwareLib.list() }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (route === 'firmware/releases' && method === 'GET') {
    try { return json(res, 200, { releases: await firmwareLib.releases() }); } catch (e) { return json(res, 502, { error: 'GitHub not reachable: ' + e.message }); }
  }
  if (route === 'firmware/fetch' && method === 'POST') {
    const body = await readJson(req);
    try {
      const imported = await firmwareLib.fetchRelease(String(body.tag || ''), Array.isArray(body.chips) ? body.chips.map(String) : []);
      return json(res, 200, { imported, versions: firmwareLib.list() });
    } catch (e) { return json(res, 502, { error: e.message }); }
  }
  const fwf = /^firmware\/file\/([\w.-]+)\/([\w.-]+)$/.exec(route);
  if (fwf && method === 'GET') {
    const file = firmwareLib.file(fwf[1], fwf[2]);
    if (!file) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Content-Disposition': `attachment; filename="${fwf[2]}"`, 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  const fwd = /^firmware\/([\w.-]+)$/.exec(route);
  if (fwd && method === 'DELETE') return json(res, 200, { removed: firmwareLib.remove(fwd[1]), versions: firmwareLib.list() });
  // clear the map on all TAKweb devices (after a mission): every device asks its user on the next connection
  if (route === 'mapclear' && method === 'GET') return json(res, 200, { request: store.data.mapClear || null, devices: takLinks.size });
  if (route === 'mapclear' && method === 'POST') {
    const body = await readJson(req);
    const cats = (Array.isArray(body.cats) ? body.cats : []).filter(c => MAP_CLEAR_CATS.includes(c));
    if (!cats.length) return json(res, 400, { error: 'Choose what to clear.' });
    store.data.mapClear = { id: crypto.randomBytes(6).toString('hex'), time: new Date().toISOString(), cats, note: String(body.note || '').slice(0, 200) };
    store.save();
    broadcastMapClear();
    log('Map clear requested:', cats.join(', '));
    return json(res, 200, { request: store.data.mapClear, devices: takLinks.size });
  }
  if (route === 'mapclear' && method === 'DELETE') {
    store.data.mapClear = null;
    store.save();
    broadcastMapClear();
    return json(res, 200, { request: null, devices: takLinks.size });
  }
  if (route === 'eud-links' && method === 'GET') {
    return json(res, 200, { links: [...takLinks.values()].map(l => l.info()) });
  }

  if (route === 'public-url' && method === 'POST') {
    const body = await readJson(req);
    const url = normalizeBase(body.url);
    store.data.settings = { ...(store.data.settings || {}), publicUrl: url };
    store.save();
    log('Public address', url || '(automatic)');
    return json(res, 200, { ok: true, publicUrl: url });
  }
  if (route === 'registration' && method === 'POST') {
    const body = await readJson(req);
    store.data.registration = { enabled: !!body.enabled };
    store.save();
    log('Self-registration', body.enabled ? 'allowed' : 'blocked');
    return json(res, 200, { ok: true });
  }
  if (route === 'app-qr.svg' && method === 'GET') {
    const svg = await QRCode.toString(publicBase(req) + '/app/', { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    return send(res, 200, svg, 'image/svg+xml');
  }

  if (route === 'ca-qr.svg' && method === 'GET' && config.testCa) {
    const svg = await QRCode.toString(publicBase(req) + '/ca.crt', { type: 'svg', margin: 2 });
    return send(res, 200, svg, 'image/svg+xml');
  }

  if (route === 'smtp' && method === 'GET') {
    const s = store.data.smtp;
    return json(res, 200, { host: s.host || '', port: s.port || 587, secure: !!s.secure, user: s.user || '', from: s.from || '', hasPass: !!s.pass });
  }
  if (route === 'smtp' && method === 'POST') {
    const body = await readJson(req);
    const s = store.data.smtp;
    s.host = String(body.host || '').trim();
    s.port = Number(body.port) || 587;
    s.secure = !!body.secure;
    s.user = String(body.user || '').trim();
    s.from = String(body.from || '').trim();
    if (body.pass) s.pass = String(body.pass);
    if (body.clearPass) s.pass = '';
    store.save();
    return json(res, 200, { ok: true });
  }
  if (route === 'smtp/test' && method === 'POST') {
    if (!auth.admin.email) throw new Error('Please enter an admin e-mail address first.');
    await sendMail(store.data.smtp, {
      to: auth.admin.email,
      subject: 'TAKweb – Test',
      text: 'SMTP works. Password reset mails and notifications are sent to this address.\n',
    });
    return json(res, 200, { ok: true });
  }

  if (route === 'defaults' && method === 'GET') {
    const d = store.data.defaults || {};
    return json(res, 200, { rotate: normRotate(d.rotate), mirror: !!d.mirror, fit: normFit(d.fit), framesize: normFramesize(d.framesize) });
  }
  if (route === 'defaults' && method === 'POST') {
    const body = await readJson(req);
    store.data.defaults = {
      rotate: normRotate(body.rotate), mirror: !!body.mirror, fit: normFit(body.fit), framesize: normFramesize(body.framesize),
    };
    if (body.applyAll) {
      for (const id of Object.keys(store.data.streams)) hub.setOptions(id, store.data.defaults);
    }
    store.save();
    return json(res, 200, { ok: true });
  }

  if (route === 'events/delete' && method === 'POST') {
    const body = await readJson(req);
    let seqs = body.all ? null : (Array.isArray(body.seqs) ? body.seqs.map(Number) : []);
    // helpers only see (and delete) the access requests
    if (req.takwebHelper) seqs = hub.events.filter(e => e.kind === 'takreg' && (!seqs || seqs.includes(e.seq))).map(e => e.seq);
    hub.deleteEvents(seqs);
    return json(res, 200, { ok: true });
  }
  if (route === 'streams' && method === 'GET') {
    const list = hub.list().map(s => {
      const id = StreamHub.id(s.user, s.streamId);
      return { ...s, links: links(req, store.data.streams[id]), tak: takVideo.view(id) };
    });
    // notifications since the last request; without "since" only the current number (do not show old ones again)
    const q = new URL(req.url, 'http://x').searchParams;
    const since = Number(q.get('since'));
    const events = Number.isFinite(since) && since >= 0 ? hub.eventsSince(since) : [];
    // on the first request the latest notifications for the notification list (without popup)
    const history = q.get('history') ? hub.events.slice(-40) : undefined;
    return json(res, 200, { streams: list, ffmpeg: ffmpegOk, events, history, eventSeq: hub.eventSeq, takVideo: { ready: takVideo.ready(), auto: takVideo.s.auto, when: takVideo.s.when, prefix: takVideo.s.prefix } });
  }
  if (route === 'streams' && method === 'POST') {
    const body = await readJson(req);
    const entry = hub.create(body.user, body.label);
    log('Stream created', entry.user + '/' + entry.streamId);
    takVideo.touch(StreamHub.id(entry.user, entry.streamId));
    return json(res, 200, { ok: true, stream: { ...hub.status(StreamHub.id(entry.user, entry.streamId)), links: links(req, entry) } });
  }
  if (route === 'live-mode' && method === 'POST') {
    const body = await readJson(req);
    store.data.settings = { ...(store.data.settings || {}) };
    if (body.mode !== undefined) store.data.settings.liveMode = body.mode === 'user' ? 'user' : 'admin';
    if (body.userCanStart !== undefined) store.data.settings.userCanStart = !!body.userCanStart;
    store.save();
    hub.broadcastLive();
    log('Live mode', hub.liveMode() === 'admin' ? 'admin puts live' : 'user starts by themselves');
    return json(res, 200, { ok: true, mode: hub.liveMode(), userCanStart: hub.userCanStart() });
  }
  if (route === 'streams/live-off-all' && method === 'POST') {
    for (const id of Object.keys(store.data.streams)) hub.setOnAir(id, false);
    log('All streams set to ready');
    return json(res, 200, { ok: true });
  }

  if (route === 'streams/stop-all' && method === 'POST') {
    hub.stopAll();
    log('All streams stopped');
    return json(res, 200, { ok: true });
  }

  const m = route.match(/^streams\/([^/]+)\/([^/]+)(?:\/([a-z.-]+))?$/);
  if (m) {
    const id = StreamHub.id(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    const entry = store.data.streams[id];
    if (!entry) return json(res, 404, { error: 'Stream not found.' });
    const action = m[3] || '';
    if (action === 'qr.svg' && method === 'GET') {
      const svg = await QRCode.toString(links(req, entry).app, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      return send(res, 200, svg, 'image/svg+xml');
    }
    if (method === 'POST' && action === 'options') {
      const body = await readJson(req);
      hub.setOptions(id, { rotate: body.rotate, mirror: body.mirror, fit: body.fit, framesize: body.framesize, label: body.label });
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'live') {
      const body = await readJson(req);
      hub.setOnAir(id, !!body.on);
      takVideo.touch(id);
      log(body.on ? 'Put live' : 'Live ended', id);
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'stop') { hub.setEnabled(id, false); takVideo.touch(id); log('Stream stopped', id); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'start') { hub.setEnabled(id, true); takVideo.touch(id); log('Stream enabled', id); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'revoke') { hub.revoke(id); log('Access revoked', id); return json(res, 200, { ok: true, links: links(req, entry) }); }
    if (method === 'DELETE' && action === '') { hub.remove(id); takVideo.removed(id); log('Stream deleted', id); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'tak') {
      const body = await readJson(req);
      return json(res, 200, { ok: true, video: await takVideo.set(id, { path: body.path, enabled: body.enabled }) });
    }
  }
  return json(res, 404, { error: 'Unknown request.' });
}

// ======================================================================
// Stream output
// ======================================================================

const escapeHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// fullscreen view for the stream link in the browser (tap: whole image / fill, double tap: fullscreen)
function viewerPage(entry) {
  const title = escapeHtml(entry.label || entry.user);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}
img{display:block;width:100vw;height:100vh;object-fit:contain}body.fill img{object-fit:cover}
#hint{position:fixed;left:10px;bottom:8px;color:#ccc;font:13px system-ui,sans-serif;text-shadow:0 1px 2px #000}</style>
</head><body><img src="?raw=1" alt="${title}">
<div id="hint">${title} · Tap: fill / whole image · Double tap: fullscreen</div>
<script>
document.body.onclick=function(){document.body.classList.toggle('fill')};
document.body.ondblclick=function(){var d=document.documentElement;if(document.fullscreenElement)document.exitFullscreen();else if(d.requestFullscreen)d.requestFullscreen()};
setTimeout(function(){var h=document.getElementById('hint');if(h)h.remove()},5000);
</script></body></html>`;
}

async function handleStream(req, res, user, streamId, rest) {
  const entry = hub.get(user, streamId);
  if (!entry) return send(res, 404, 'Stream not found');
  const id = StreamHub.id(user, streamId);
  const live = hub.live(id);

  if (rest === '' || rest === '/') {
    if (req.method === 'HEAD') return send(res, 200, '', 'multipart/x-mixed-replace');
    // browsers get a fullscreen page, players (ATAK, VLC …) the MJPEG stream
    const wantsHtml = /text\/html/.test(req.headers.accept || '') && !/[?&]raw\b/.test(req.url);
    if (wantsHtml) return send(res, 200, viewerPage(entry), 'text/html; charset=utf-8');
    return hub.addMjpegViewer(id, res);
  }
  if (rest === '/snapshot.jpg') {
    if (!live.frame) return send(res, 404, 'No image yet');
    return send(res, 200, live.frame, 'image/jpeg', { 'Access-Control-Allow-Origin': '*' });
  }

  if (rest === '/index.m3u8' || rest === '/stream.ts' || /^\/seg\d+\.ts$/.test(rest)) {
    const tc = hub.transcoder(id);
    if (!tc) return send(res, 503, 'HLS/MPEG-TS not available: ffmpeg is not installed on the server.');
    if (rest === '/stream.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      return tc.addTsClient(res);
    }
    tc.touch();
    if (rest === '/index.m3u8') {
      const file = await tc.waitForPlaylist();
      if (!file) return send(res, 503, 'Stream is still starting, please try again');
      return send(res, 200, fs.readFileSync(file), 'application/vnd.apple.mpegurl', { 'Access-Control-Allow-Origin': '*' });
    }
    const seg = path.join(tc.dir, path.basename(rest));
    if (!fs.existsSync(seg)) return send(res, 404, 'Segment not found');
    return send(res, 200, fs.readFileSync(seg), 'video/mp2t', { 'Access-Control-Allow-Origin': '*' });
  }
  return send(res, 404, 'Not found');
}

// ======================================================================
// HTTP
// ======================================================================

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const admin = isAdminHost(req);

  try {
    if (p === '/health') return send(res, 200, 'ok');
    if (p === '/version') return json(res, 200, { version: VERSION });
    // the Android app checks this before it uses a server (only a TAKweb server, never just any page)
    if (p === '/api/eud/app') return json(res, 200, { takweb: true, version: VERSION, name: 'TAKweb' });
    if (p === '/ca.crt' && config.testCa) {
      return send(res, 200, fs.readFileSync(config.testCa), 'application/x-x509-ca-cert',
        { 'Content-Disposition': 'attachment; filename="helm-camera-test-ca.crt"' });
    }
    // Android app: an APK in the data folder (e.g. without internet in the field), otherwise the GitHub release
    if (p === '/download/takweb.apk') {
      const local = path.join(config.dataDir, 'takweb.apk');
      if (fs.existsSync(local)) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="TAKweb.apk"', 'Content-Length': fs.statSync(local).size });
        return fs.createReadStream(local).pipe(res);
      }
      return send(res, 302, '', 'text/plain', { Location: config.apkUrl });
    }
    if (p === '/') {
      if (admin) return send(res, 302, '', 'text/plain', { Location: '/admin/' });
      return send(res, 200, 'TAKweb');
    }
    if (p === '/admin') return send(res, 302, '', 'text/plain', { Location: '/admin/' });
    if (p.startsWith('/admin/')) {
      if (!admin) return send(res, 404, 'Not found');
      return serveStatic(res, 'admin', decodeURIComponent(p.slice(7)));
    }
    const vm = /^\/voicemsg\/([a-f0-9]{32})\.wav$/.exec(p);
    if (vm && req.method === 'GET') {
      const f = path.join(VOICEMSG_DIR, vm[1] + '.wav');
      if (!fs.existsSync(f)) return send(res, 404, 'Voice message not found (kept 3 days).');
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': fs.statSync(f).size, 'Cache-Control': 'private, max-age=86400' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/hq') return send(res, 302, '', 'text/plain', { Location: '/hq/' });
    if (p.startsWith('/hq/')) {
      if (!admin) return send(res, 404, 'Not found');
      return serveStatic(res, 'hq', decodeURIComponent(p.slice(4)));
    }
    if (p.startsWith('/api/admin/')) {
      if (!admin) return json(res, 404, { error: 'Not found' });
      return await handleAdminApi(req, res, p.slice(11));
    }
    if (p === '/api/app/register' && req.method === 'POST') return await handleRegister(req, res);
    if (p.startsWith('/api/eud/')) return await handleEudApi(req, res, p.slice(9));
    if (p.startsWith('/api/access/')) return await handleAccessApi(req, res, p.slice(12));
    if (p === '/join' || p === '/access') return send(res, 302, '', 'text/plain', { Location: p + '/' });
    if (p.startsWith('/join/')) return serveStatic(res, 'join', decodeURIComponent(p.slice(6)));
    if (p.startsWith('/access/')) return serveStatic(res, 'access', decodeURIComponent(p.slice(8)));
    if (p === '/eud') return send(res, 302, '', 'text/plain', { Location: '/eud/' });
    if (p.startsWith('/eud/vendor/')) return serveVendor(res, p.slice(12));
    if (p === '/eud/tiles/sources.json') return json(res, 200, { sources: TileCache.list() });
    if (p.startsWith('/eud/tiles/')) return await serveTile(res, p.slice(11));
    if (p.startsWith('/eud/')) return serveStatic(res, 'eud', decodeURIComponent(p.slice(5)));
    if (p === '/api/app/info' && req.method === 'GET') return json(res, 200, { registration: registrationEnabled() });
    if (p === '/app') return send(res, 302, '', 'text/plain', { Location: '/app/' });
    if (p.startsWith('/app/')) return serveStatic(res, 'app', decodeURIComponent(p.slice(5)));
    if (p.startsWith('/assets/')) return serveStatic(res, 'assets', decodeURIComponent(p.slice(8)));
    if (p === '/favicon.ico') return serveStatic(res, 'assets', 'brand/favicon.ico');

    const m = p.match(/^\/([a-z0-9][a-z0-9_-]{0,31})\/([a-z0-9]{4,32})(\/.*)?$/);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) return await handleStream(req, res, m[1], m[2], m[3] || '');
    return send(res, 404, 'Not found');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
    else res.end();
  }
}

// ======================================================================
// WebSocket: phone sends images
// ======================================================================

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const takWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
// push-to-talk voice: TAKweb devices connected to a TAK server right now (same address) and the admin/HQ
const voiceWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const voice = new Voice({ log });
// voice messages of the chat: kept 3 days like the chat itself
const VOICEMSG_DIR = path.join(config.dataDir, 'voicemsg');
const FIRMWARE_MAX = 120 * 1024 * 1024; // one chip package of the desktop flasher is ~15–60 MB
const firmwareLib = new FirmwareLibrary(path.join(config.dataDir, 'firmware'), { log });
const VOICEMSG_MAX = 1024 * 1024; // ~60 s at 8 kHz 16 bit
setInterval(() => {
  try { for (const f of fs.readdirSync(VOICEMSG_DIR)) { const fp = path.join(VOICEMSG_DIR, f); if (Date.now() - fs.statSync(fp).mtimeMs > 3 * 86400000) fs.rmSync(fp, { force: true }); } } catch (e) { /* no folder yet */ }
}, 3600000).unref();
function voiceWho(req) {
  const ses = auth.check(cookies(req).sid);
  if (ses) return { hq: true, callsign: '' };
  const ip = clientIp(req);
  const link = [...takLinks.values()].find(l => l.ip === ip && l.state === 'connected');
  return link ? { hq: false, callsign: link.callsign || '' } : null;
}
const takLinks = new Map(); // ws -> connection info (for the admin overview)
const MAP_CLEAR_CATS = ['contacts', 'f', 'h', 'n', 'u', 'points', 'shapes', 'overlays', 'chat'];
const mapClearMsg = () => JSON.stringify({ type: 'mapclear', request: store.data.mapClear || null });
function broadcastMapClear() {
  for (const ws of takLinks.keys()) if (ws.readyState === 1) ws.send(mapClearMsg());
}
// several players often share one internet connection (field router, Starlink): one public IP
const MAX_TAK_PER_IP = Number(process.env.MAX_TAK_PER_IP) || 40;

// own position (SA) of a managed access: team and role as set by the admin
function enforceAssignment(xml, uid, a) {
  const m = /<event\b[^>]*\buid="([^"]*)"/.exec(xml);
  if (!m || m[1] !== uid || !/\btype="a-/.test(xml.slice(0, 400))) return xml;
  const attr = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // the callsign stays the user's (several players may share one login), team and role are the admin's
  return xml
    .replace(/(<__group\b[^>]*\bname=")[^"]*(")/, `$1${attr(a.team)}$2`)
    .replace(/(<__group\b[^>]*\brole=")[^"]*(")/, `$1${attr(a.role)}$2`);
}

// EUD <-> TAK server: the browser sends credentials and CoT, we only relay
function handleTakSocket(ws, req) {
  const ip = clientIp(req);
  const perIp = [...takLinks.values()].filter(l => l.ip === ip).length;
  if (perIp >= MAX_TAK_PER_IP) {
    ws.send(JSON.stringify({ type: 'status', state: 'error', message: 'Too many connections from this device.' }));
    return ws.close(4002, 'limit');
  }
  let link = null;
  let assigned = null; // callsign/team/role set by the admin (managed TAK access)
  let eudUid = '';
  let certUser = '';  // CN of the client certificate of this connection
  let linkSsl = false; // SSL to our own OTS: the TLS handshake proved the certificate (key on the device)
  const entry = { ip, since: Date.now(), host: '', callsign: '', state: 'idle', info() {
    return { ip: this.ip, host: this.host, callsign: this.callsign, state: this.state, since: new Date(this.since).toISOString() };
  } };
  takLinks.set(ws, entry);
  if (store.data.mapClear) ws.send(mapClearMsg()); // map clear asked by the admin: the device asks its user
  const say = (state, message, extra) => {
    entry.state = state;
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'status', state, message, ...(extra || {}) }));
  };
  const stop = () => { if (link) link.stop(); link = null; };

  ws.on('message', async data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (msg.type === 'connect') {
      stop();
      const host = String(msg.host || '').trim();
      if (!host) return say('error', 'No TAK server given.');
      const why = await takProblem(host, Number(msg.port) || 8089);
      if (why) { log('EUD connection refused:', why); return say('error', why); }
      if (ws.readyState !== 1) return;
      stop();
      entry.host = `${host}:${msg.port}`;
      entry.callsign = String(msg.callsign || '').slice(0, 40);
      eudUid = String(msg.uid || '');
      // managed access? The username is in the client certificate (CN)
      assigned = null;
      certUser = '';
      linkSsl = msg.proto === 'ssl' && !!ownTak(host);
      try {
        const cn = msg.certPem ? (/(?:^|, )CN=([^,]+)/.exec(tak.certInfo(msg.certPem).subject) || [])[1] : '';
        certUser = cn || '';
        assigned = takUsers.assignmentFor(cn);
      } catch (e) { /* no readable certificate */ }
      if (assigned) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'assign', ...assigned }));
      }
      link = new tak.TakLink({
        host, altHost: msg.proto === 'udp' ? '' : (ownTak(host) || {}).altHost || '', port: Number(msg.port) || 8089, proto: msg.proto, uid: String(msg.uid || 'EUD').slice(0, 64),
        certPem: msg.certPem, keyPem: msg.keyPem, caPems: Array.isArray(msg.caPems) ? msg.caPems : [], fingerprint: msg.fingerprint,
        onStatus: (state, message, extra) => say(state, message, extra),
        onCot: xml => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'cot', xml })); },
      });
      link.start();
      log('EUD connecting', entry.callsign, '->', entry.host, msg.proto);
    } else if (msg.type === 'cot' && link && typeof msg.xml === 'string' && msg.xml.length < 256 * 1024) {
      if (/^\s*<event[\s>]/.test(msg.xml)) link.send(assigned ? enforceAssignment(msg.xml, eudUid, assigned) : msg.xml);
    } else if (msg.type === 'drone') {
      // drone/camera address without typing the password: whoever is connected to our OTS with the certificate
      // of a user is that user (OTS checked the certificate in the TLS handshake) – we know the login of managed users
      const login = linkSsl && entry.state === 'connected' ? takUsers.loginFor(certUser) : null;
      if (ws.readyState === 1) ws.send(JSON.stringify(login ? { type: 'drone', host: takUsers.takHost() || entry.host.replace(/:\d+$/, ''), ...login } : { type: 'drone', error: 'unknown' }));
      if (login) log('EUD: drone address for', certUser);
    } else if (msg.type === 'disconnect') {
      stop();
      say('closed', 'Disconnected.');
    }
  });
  ws.on('close', () => { stop(); takLinks.delete(ws); });
  ws.on('error', () => {});
}

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws/tak') return takWss.handleUpgrade(req, socket, head, ws => handleTakSocket(ws, req));
  if (url.pathname === '/ws/voice') {
    const who = voiceWho(req);
    if (!who) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    return voiceWss.handleUpgrade(req, socket, head, ws => voice.attach(ws, who));
  }
  if (url.pathname !== '/ws/publish') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    const user = url.searchParams.get('u') || '';
    const streamId = url.searchParams.get('s') || '';
    const key = url.searchParams.get('k') || '';
    const result = hub.authorize(user, streamId, key);
    if (result.error) {
      ws.send(JSON.stringify({ type: result.error, message: result.message }));
      ws.close(4001, result.error);
      return;
    }
    const { id, entry } = result;
    hub.attachPublisher(id, ws);
    if (takVideo.s.when === 'live') takVideo.touch(id);
    const live = hub.live(id);
    log('Phone connected', id, clientIp(req));
    ws.send(JSON.stringify({
      type: 'welcome',
      user: entry.user,
      streamId: entry.streamId,
      label: entry.label,
      stream: links(req, entry).stream,
    }));
    ws.send(JSON.stringify(StreamHub.config(entry)));
    hub.sendLive(id);

    let alive = true;
    ws.on('pong', () => { alive = true; });
    const timer = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
      const st = hub.status(id);
      ws.send(JSON.stringify({ type: 'stats', viewers: st.viewers, fps: st.fps }));
    }, 5000);

    ws.on('message', (data, isBinary) => {
      if (live.publisher !== ws) return;
      if (isBinary) {
        hub.pushFrame(id, Buffer.isBuffer(data) ? data : Buffer.concat(data));
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello' || msg.type === 'info') {
          if (msg.camera !== undefined) live.camera = String(msg.camera).slice(0, 40);
          if (msg.phone !== undefined) live.phone = String(msg.phone).slice(0, 120);
          if (msg.resolution !== undefined) live.resolution = String(msg.resolution).slice(0, 20);
        } else if (msg.type === 'state') {
          const was = live.ready;
          live.ready = !!msg.ready; // camera connected on the phone
          if (!was && live.ready) hub.event(id, 'camera', `${hub.labelOf(id)} activated the camera`);
        } else if (msg.type === 'golive') {
          // user presses "start stream"/"stop stream"
          if (hub.liveMode() === 'admin') {
            if (hub.userCanStart() || entry.eud) {
              if (!!msg.on !== live.onAir) {
                hub.setOnAir(id, !!msg.on);
                hub.event(id, msg.on ? 'live' : 'stop', `${hub.labelOf(id)} ${msg.on ? 'started' : 'stopped'} the stream`);
                log(msg.on ? 'User starts' : 'User stops', id);
              }
            } else {
              hub.sendLive(id); // not allowed: the phone keeps its current state
            }
          } else {
            hub.event(id, msg.on ? 'live' : 'stop', `${hub.labelOf(id)} ${msg.on ? 'started' : 'stopped'} the stream`);
          }
        } else if (msg.type === 'options') {
          // user adjusts on the phone (rotation/mirroring); the admin sees it and can change it
          hub.setOptions(id, { rotate: msg.rotate, mirror: msg.mirror });
        }
      } catch (e) { /* ignore */ }
    });
    ws.on('close', () => {
      clearInterval(timer);
      hub.detachPublisher(id, ws);
      log('Phone disconnected', id);
    });
    ws.on('error', () => {});
  });
}

// ======================================================================

const server = config.tlsCert && config.tlsKey
  ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handle)
  : http.createServer(handle);
server.on('upgrade', handleUpgrade);

// pick up a renewed certificate (e.g. Let's Encrypt) without restart
if (config.tlsCert && config.tlsKey) {
  let stamp = fs.statSync(config.tlsCert).mtimeMs;
  setInterval(() => {
    try {
      const now = fs.statSync(config.tlsCert).mtimeMs;
      if (now === stamp) return;
      server.setSecureContext({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) });
      stamp = now;
      log('New TLS certificate loaded');
    } catch (e) {
      log('Certificate could not be reloaded:', e.message);
    }
  }, 60 * 60 * 1000).unref();
}
server.keepAliveTimeout = 65000;

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.port} is already in use – is the server already running in another window?`);
    console.error('Close the other window (or end "Node.js" in the Task Manager) and start again.\n');
  } else {
    console.error('Server error:', e.message);
  }
  process.exit(1);
});

server.listen(config.port, config.bind, () => {
  log(`TAKweb running on ${config.tlsCert ? 'https' : 'http'}://${config.bind}:${server.address().port}`);
  log(`Version ${VERSION}`);
  log(`Public address: ${config.publicUrl || '(from request)'}${config.adminHost ? ', admin domain: ' + config.adminHost : ''}`);
  log(ffmpegOk ? 'ffmpeg found: HLS and MPEG-TS available' : 'ffmpeg not found: MJPEG only');
  if (store.data.admin.mustChange) log('First start: admin login admin / admin123 – the password is changed at the first login.');
  federation.apply(); // TAK server federation (if switched on)
  recApply().catch(e => log('Mission tracks: ' + e.message)); // a recording that was running before the restart
});

function shutdown() {
  log('Server shutting down');
  hub.shutdown();
  federation.stop();
  voice.close();
  if (recLink) recLink.stop();
  if (tracks.active()) try { store.save(); } catch (e) { /* data folder gone */ } // summary of a running recording
  klvFeeds.close();
  for (const c of wss.clients) c.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server };
