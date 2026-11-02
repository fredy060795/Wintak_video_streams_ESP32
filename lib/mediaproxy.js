// Pass video feeds (HLS from MediaMTX/OpenTAKServer etc.) through to TAKweb in the browser:
// same origin as the app – no "mixed content" (https page, http video) and no CORS problems.
// Video files only (playlists, segments); the target is checked like the TAK relay.

const http = require('http');
const https = require('https');

const MEDIA = /\.(m3u8|ts|m4s|mp4|m4a|m4v|aac|vtt|cmfv|cmfa)$/i;
const PLAYLIST_MAX = 2 * 1024 * 1024;

const proxied = abs => '/api/eud/media?u=' + encodeURIComponent(abs);

// Rewrite all addresses in a playlist (lines without # and URI="…") to the proxy.
// Pass the playlist's access parameters (e.g. ?jwt=… from OpenTAKServer) on to sub-playlists and segments
// of the same server – otherwise the video server rejects them
function rewritePlaylist(text, base) {
  const b = new URL(base);
  const abs = ref => {
    try {
      const u = new URL(ref, b);
      if (u.origin === b.origin) for (const [k, v] of b.searchParams) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      return u.href;
    } catch (e) { return ref; }
  };
  return text.split(/\r?\n/).map(line => {
    const l = line.trim();
    if (!l) return line;
    if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, ref) => `URI="${proxied(abs(ref))}"`);
    return proxied(abs(l));
  }).join('\n');
}

function fetchUpstream(url, redirects = 2) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    // Video servers often have self-signed certificates (like the TAK server); this is only image data
    const req = lib.get(url, { rejectUnauthorized: false, timeout: 15000, headers: { 'User-Agent': 'TAKweb/1.0', Accept: '*/*' } }, up => {
      if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && redirects > 0) {
        up.resume();
        let next;
        try { next = new URL(up.headers.location, url); } catch (e) { return reject(new Error('Bad redirect')); }
        if (next.origin !== url.origin) return reject(new Error('Redirect to another server')); // do not follow redirects to other servers
        return resolve(fetchUpstream(next, redirects - 1));
      }
      resolve({ up, url });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

// allowed(host) -> Promise<boolean>
// mapUpstream(url, { fresh }) -> Promise<{ fetch: URL, base: URL } | null>: own video server with a login the
// browser must not see (OTS ?jwt=): "fetch" carries it, "base" (for the playlist addresses) does not.
// fresh = the login was rejected, get a new one.
async function proxyMedia(req, res, { allowed, log, mapUpstream }) {
  const fail = (status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };
  let url;
  try { url = new URL(new URL(req.url, 'http://x').searchParams.get('u') || ''); } catch (e) { return fail(400, 'Bad address'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return fail(400, 'Only http(s) video addresses');
  if (!MEDIA.test(url.pathname)) return fail(400, 'Only video files (HLS playlist/segments, MP4)');
  let mapped = null;
  try { mapped = mapUpstream ? await mapUpstream(url, {}) : null; } catch (e) { return fail(502, 'Video server login failed: ' + e.message); }
  if (!mapped && !(await allowed(url.hostname))) return fail(403, `Video server ${url.hostname} is not allowed on this server.`);
  let r;
  try {
    r = await fetchUpstream(mapped ? mapped.fetch : url);
    if (mapped && (r.up.statusCode === 401 || r.up.statusCode === 403)) {
      r.up.resume();
      mapped = await mapUpstream(url, { fresh: true });
      r = await fetchUpstream(mapped.fetch);
    }
  } catch (e) { return fail(502, 'Video server not reachable: ' + e.message); }
  const { up } = r;
  if (mapped) r.url = mapped.base; // playlist addresses without the login
  if (up.statusCode !== 200) { up.resume(); return fail(up.statusCode === 404 ? 404 : 502, `Video server answered ${up.statusCode}`); }
  if (/\.m3u8$/i.test(r.url.pathname) || /mpegurl/i.test(up.headers['content-type'] || '')) {
    const chunks = [];
    let size = 0;
    up.on('data', c => { size += c.length; if (size > PLAYLIST_MAX) up.destroy(); else chunks.push(c); });
    up.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
      res.end(rewritePlaylist(Buffer.concat(chunks).toString('utf8'), r.url.href));
    });
    up.on('error', e => { if (log) log('Video-Proxy:', e.message); fail(502, 'Video server error'); });
    return;
  }
  res.writeHead(200, {
    'Content-Type': up.headers['content-type'] || 'application/octet-stream',
    ...(up.headers['content-length'] ? { 'Content-Length': up.headers['content-length'] } : {}),
    'Cache-Control': 'no-store',
  });
  up.pipe(res);
  req.on('close', () => up.destroy());
}

module.exports = { proxyMedia, rewritePlaylist, MEDIA };
