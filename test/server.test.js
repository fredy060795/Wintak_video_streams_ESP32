// End-to-end test: starts the server in its own data directory and plays through
// admin, phone (WebSocket) and viewers (MJPEG/HLS/TS).
//   npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const JPEG_A = fs.readFileSync(path.join(__dirname, 'fixtures', 'a.jpg'));
const JPEG_B = fs.readFileSync(path.join(__dirname, 'fixtures', 'b.jpg'));
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let proc, base, dataDir, cookie = '';
let tileSrv, tileHits = 0;

before(async () => {
  // mock tile server (instead of OpenStreetMap)
  tileSrv = http.createServer((req, res) => {
    tileHits++;
    if (req.url.startsWith('/fail')) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.alloc(100, 7));
  });
  await new Promise(r => tileSrv.listen(0, '127.0.0.1', r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmcam-test-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', BIND: '127.0.0.1', DATA_DIR: dataDir, PUBLIC_URL: '', ADMIN_URL: 'https://admin.test:5036', TILE_URL_OVERRIDE: `http://127.0.0.1:${tileSrv.address().port}/{z}/{x}/{y}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => {
      out += d;
      const m = out.match(/running on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve('http://127.0.0.1:' + m[1]);
    });
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('exit', code => reject(new Error('Server stopped: ' + code + '\n' + out)));
  });
});

after(() => {
  tileSrv.close();
  proc.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(p, { method = 'GET', body, csrf = true } = {}) {
  const res = await fetch(base + '/api/admin/' + p, {
    method,
    headers: {
      ...(csrf ? { 'X-Requested-With': 'helm' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

function publisher(stream, key) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/publish?u=${stream.user}&s=${stream.streamId}&k=${key}`);
  const messages = [];
  ws.on('message', (d, bin) => { if (!bin) messages.push(JSON.parse(d.toString())); });
  const closed = new Promise(r => ws.on('close', (code) => r(code)));
  const waitFor = async (type, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = messages.find(x => x.type === type);
      if (m) return m;
      await sleep(20);
    }
    throw new Error('Message missing: ' + type + ' (received: ' + JSON.stringify(messages) + ')');
  };
  return { ws, messages, waitFor, closed };
}

// reads the MJPEG stream until n images have arrived
function readMjpeg(url, n, ms = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      assert.match(res.headers['content-type'], /multipart\/x-mixed-replace/);
      let buf = Buffer.alloc(0);
      const frames = [];
      res.on('data', d => {
        buf = Buffer.concat([buf, d]);
        let m;
        while ((m = buf.toString('latin1').match(/Content-Length: (\d+)\r\n\r\n/))) {
          const start = m.index + m[0].length;
          const len = Number(m[1]);
          if (buf.length < start + len) break;
          frames.push(buf.subarray(start, start + len));
          buf = buf.subarray(start + len);
          if (frames.length >= n) { req.destroy(); resolve(frames); return; }
        }
      });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('MJPEG: too few images')); }, ms);
  });
}

let s1, s2;

test('first login with admin/admin123 forces a password change', async () => {
  assert.equal((await api('streams')).status, 401);
  assert.equal((await api('login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 400);
  const login = await api('login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChange, true);
  const blocked = await api('streams');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.mustChange, true);
  // the default password may not stay
  const same = await api('credentials', { method: 'POST', body: { current: 'admin123', username: 'admin', password: 'admin123' } });
  assert.equal(same.status, 400);
  const ok = await api('credentials', { method: 'POST', body: { current: 'admin123', username: 'chief', email: 'chief@example.com', password: 'secret-12345' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await api('streams')).status, 200);
  const me = await api('me');
  assert.equal(me.data.username, 'chief');
  assert.equal(me.data.mustChange, false);
  // the following tests send images directly: mode "user starts by themselves"
  assert.equal((await api('live-mode', { method: 'POST', body: { mode: 'user' } })).data.mode, 'user');
});

test('writing admin requests without CSRF header are rejected', async () => {
  const r = await api('streams', { method: 'POST', body: { user: 'x' }, csrf: false });
  assert.equal(r.status, 403);
});

test('creating streams: unique paths, invalid names rejected', async () => {
  assert.equal((await api('streams', { method: 'POST', body: { user: 'admin' } })).status, 400);
  assert.equal((await api('streams', { method: 'POST', body: { user: '../x' } })).status, 400);
  const a = await api('streams', { method: 'POST', body: { user: 'Mueller', label: 'Squad 1' } });
  const b = await api('streams', { method: 'POST', body: { user: 'mueller', label: 'Squad 2' } });
  assert.equal(a.status, 200);
  s1 = a.data.stream;
  s2 = b.data.stream;
  assert.equal(s1.user, 'mueller');
  assert.notEqual(s1.streamId, s2.streamId);
  assert.equal(s1.links.stream, `${base}/mueller/${s1.streamId}`);
  assert.match(s1.links.app, /\/app\/#u=mueller&s=\w+&k=[\w-]+$/);
  const qr = await fetch(base + `/api/admin/streams/mueller/${s1.streamId}/qr.svg`, { headers: { cookie } });
  assert.match(await qr.text(), /^<svg/);
});

const keyOf = s => new URLSearchParams(s.links.app.split('#')[1]).get('k');

test('phone sends images, viewers get MJPEG, streams are separate', async () => {
  const bad = publisher(s1, 'wrong-key');
  assert.equal((await bad.waitFor('invalid')).type, 'invalid');

  const p1 = publisher(s1, keyOf(s1));
  const p2 = publisher(s2, keyOf(s2));
  await p1.waitFor('welcome');
  await p2.waitFor('welcome');
  p1.ws.send(JSON.stringify({ type: 'hello', camera: 'Helm 1' }));
  p1.ws.send(Buffer.from('not a jpeg'));

  const viewer1 = readMjpeg(s1.links.stream, 2);
  const viewer2 = readMjpeg(s2.links.stream, 1);
  await sleep(200);
  p1.ws.send(JPEG_A);
  p2.ws.send(JPEG_B);
  await sleep(100);
  p1.ws.send(JPEG_B);
  const [f1, f2] = [await viewer1, await viewer2];
  assert.ok(f1[0].equals(JPEG_A));
  assert.ok(f1[1].equals(JPEG_B));
  assert.ok(f2[0].equals(JPEG_B), 'stream 2 only gets its own images');

  const snap = await fetch(s1.links.snapshot);
  assert.ok(Buffer.from(await snap.arrayBuffer()).equals(JPEG_B));

  const list = (await api('streams')).data.streams;
  const st = list.find(x => x.streamId === s1.streamId);
  assert.equal(st.phoneConnected, true);
  assert.equal(st.receiving, true);
  assert.equal(st.camera, 'Helm 1');
  p1.ws.close();
  p2.ws.close();
});

test('a second phone on the same stream replaces the first', async () => {
  const a = publisher(s2, keyOf(s2));
  await a.waitFor('welcome');
  const b = publisher(s2, keyOf(s2));
  await b.waitFor('welcome');
  await a.waitFor('replaced');
  b.ws.close();
});

test('HLS and MPEG-TS via ffmpeg', { skip: !HAS_FFMPEG && 'ffmpeg missing' }, async () => {
  const p = publisher(s1, keyOf(s1));
  await p.waitFor('welcome');
  const feeder = setInterval(() => p.ws.send(JPEG_A), 100);
  try {
    let playlist;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(s1.links.hls);
      if (r.status === 200) { playlist = await r.text(); if (/seg\d+\.ts/.test(playlist)) break; }
      await sleep(500);
    }
    assert.match(playlist, /#EXTM3U/);
    const seg = playlist.match(/(seg\d+\.ts)/)[1];
    const segRes = await fetch(`${s1.links.stream}/${seg}`);
    assert.equal(segRes.status, 200);
    const segData = Buffer.from(await segRes.arrayBuffer());
    assert.equal(segData[0], 0x47, 'MPEG-TS sync byte');

    const ts = await new Promise((resolve, reject) => {
      const req = http.get(s1.links.ts, res => {
        let n = Buffer.alloc(0);
        res.on('data', d => { n = Buffer.concat([n, d]); if (n.length > 4000) { req.destroy(); resolve(n); } });
      });
      req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
      setTimeout(() => reject(new Error('no TS')), 8000);
    });
    assert.equal(ts[0], 0x47);
  } finally {
    clearInterval(feeder);
    p.ws.close();
  }
});

test('stop, stop all, enable, kick, delete', async () => {
  const p = publisher(s1, keyOf(s1));
  await p.waitFor('welcome');
  assert.equal((await api(`streams/mueller/${s1.streamId}/stop`, { method: 'POST', body: {} })).status, 200);
  await p.waitFor('stopped');
  await p.closed;
  const again = publisher(s1, keyOf(s1));
  await again.waitFor('stopped');

  assert.equal((await api(`streams/mueller/${s1.streamId}/start`, { method: 'POST', body: {} })).status, 200);
  const p2 = publisher(s1, keyOf(s1));
  await p2.waitFor('welcome');
  const p3 = publisher(s2, keyOf(s2));
  await p3.waitFor('welcome');
  assert.equal((await api('streams/stop-all', { method: 'POST', body: {} })).status, 200);
  await p2.waitFor('stopped');
  await p3.waitFor('stopped');
  const list = (await api('streams')).data.streams;
  assert.ok(list.every(s => !s.enabled));

  await api(`streams/mueller/${s1.streamId}/start`, { method: 'POST', body: {} });
  const oldKey = keyOf(s1);
  const p4 = publisher(s1, oldKey);
  await p4.waitFor('welcome');
  const rev = await api(`streams/mueller/${s1.streamId}/revoke`, { method: 'POST', body: {} });
  assert.equal(rev.status, 200);
  await p4.waitFor('revoked');
  assert.notEqual(keyOf(rev.data), oldKey);
  await publisher(s1, oldKey).waitFor('invalid');
  const p5 = publisher(s1, keyOf(rev.data));
  await p5.waitFor('welcome');

  assert.equal((await api(`streams/mueller/${s1.streamId}`, { method: 'DELETE', body: {} })).status, 200);
  await p5.waitFor('removed');
  assert.equal((await fetch(s1.links.stream)).status, 404);
});

test('forgot password reveals nothing, reset link invalid without token', async () => {
  const r = await api('forgot', { method: 'POST', body: { username: 'unknown' } });
  assert.equal(r.status, 200);
  const reset = await api('reset', { method: 'POST', body: { token: 'x', password: 'new-password' } });
  assert.equal(reset.status, 400);
});

test('admin only on the admin domain when ADMIN_HOST is set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmcam-test2-'));
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', BIND: '127.0.0.1', DATA_DIR: dir, ADMIN_HOST: 'admin.example.com' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const url = await new Promise(resolve => {
      let out = '';
      p.stdout.on('data', d => { out += d; const m = out.match(/:(\d+)\n/); if (m) resolve('http://127.0.0.1:' + m[1]); });
    });
    const req = (host, p_) => new Promise(resolve => http.get(url + p_, { headers: { host } }, res => { res.resume(); resolve(res.statusCode); }));
    assert.equal(await req('cam.example.com', '/admin/'), 404);
    assert.equal(await req('cam.example.com', '/api/admin/me'), 404);
    assert.equal(await req('admin.example.com', '/admin/'), 200);
    assert.equal(await req('admin.example.com', '/api/admin/me'), 401);
    assert.equal(await req('cam.example.com', '/app/'), 200);
  } finally {
    p.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// minimal SMTP server that catches the mail
function smtpSink() {
  const net = require('net');
  const mails = [];
  const srv = net.createServer(sock => {
    let data = false, body = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', chunk => {
      for (const line of chunk.toString().split('\r\n')) {
        if (data) {
          if (line === '.') { data = false; mails.push(body); sock.write('250 OK\r\n'); } else body += line + '\n';
          continue;
        }
        if (!line) continue;
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
        else if (cmd === 'DATA') { data = true; body = ''; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, mails })));
}

test('forgot password via SMTP: mail with link, new password, login', async () => {
  const sink = await smtpSink();
  try {
    const save = await api('smtp', { method: 'POST', body: { host: '127.0.0.1', port: sink.port, secure: false, from: 'helm@example.com' } });
    assert.equal(save.status, 200);
    assert.equal((await api('smtp/test', { method: 'POST', body: {} })).status, 200);
    assert.match(sink.mails[0], /SMTP works/);

    await api('logout', { method: 'POST', body: {} });
    cookie = '';
    assert.equal((await api('forgot', { method: 'POST', body: { username: 'chief@example.com' } })).status, 200);
    for (let i = 0; i < 50 && sink.mails.length < 2; i++) await sleep(50);
    const mail = sink.mails[1].replace(/=\n/g, '').replace(/=3D/g, '=');
    assert.match(mail, /https:\/\/admin\.test:5036\/admin\/#reset=/, 'link from ADMIN_URL');

    // a forged Host header must not redirect the link in the mail
    await new Promise((resolve, reject) => {
      const u = new URL(base + '/api/admin/forgot');
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Requested-With': 'helm', 'Content-Type': 'application/json' } },
      res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify({ username: 'chief' }));
    });
    for (let i = 0; i < 50 && sink.mails.length < 3; i++) await sleep(50);
    assert.doesNotMatch(sink.mails[2], /evil\.example/);
    assert.match(sink.mails[2].replace(/=\n/g, ''), /admin\.test:5036/);
    const token = mail.match(/#reset=([\w-]+)/)[1];
    assert.equal((await api('reset', { method: 'POST', body: { token, password: 'short' } })).status, 400);
    assert.equal((await api('reset', { method: 'POST', body: { token, password: 'brand-new-password' } })).status, 200);
    assert.equal((await api('reset', { method: 'POST', body: { token, password: 'yet-another-password' } })).status, 400, 'link valid only once');
    assert.equal((await api('login', { method: 'POST', body: { username: 'chief', password: 'secret-12345' } })).status, 400);
    assert.equal((await api('login', { method: 'POST', body: { username: 'chief', password: 'brand-new-password' } })).status, 200);
  } finally {
    sink.srv.close();
  }
});

test('JPEG size is read from the header', () => {
  const { jpegSize } = require('../lib/streams');
  assert.equal(jpegSize(JPEG_A), '320x240');
  assert.equal(jpegSize(fs.readFileSync(path.join(__dirname, 'fixtures', 'portrait.jpg'))), '240x320');
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0x00])), null);
});

test('rotation: default for new streams, a change goes to the phone right away', async () => {
  assert.equal((await api('defaults', { method: 'POST', body: { rotate: 90, mirror: false } })).status, 200);
  const created = await api('streams', { method: 'POST', body: { user: 'helm', label: 'landscape' } });
  const s = created.data.stream;
  assert.equal(s.rotate, 90);

  const p = publisher(s, keyOf(s));
  await p.waitFor('welcome');
  const cfg = await p.waitFor('config');
  assert.equal(cfg.rotate, 90);

  p.messages.length = 0;
  assert.equal((await api(`streams/helm/${s.streamId}/options`, { method: 'POST', body: { rotate: 270, mirror: true } })).status, 200);
  const cfg2 = await p.waitFor('config');
  assert.equal(cfg2.rotate, 270);
  assert.equal(cfg2.mirror, true);
  // any angle, rounded to 0.5° and brought into 0–359.5
  const angle = async (rotate) => {
    await api(`streams/helm/${s.streamId}/options`, { method: 'POST', body: { rotate } });
    return (await api('streams')).data.streams.find(x => x.streamId === s.streamId).rotate;
  };
  assert.equal(await angle(45), 45);
  assert.equal(await angle(7.3), 7.5);
  assert.equal(await angle(-10), 350);
  assert.equal(await angle(400), 40);
  assert.equal(await angle(359.9), 0);
  assert.equal(await angle('abc'), 0);
  p.messages.length = 0;
  await api(`streams/helm/${s.streamId}/options`, { method: 'POST', body: { rotate: 12.5, fit: 'fit' } });
  const cfg3 = await p.waitFor('config');
  assert.equal(cfg3.rotate, 12.5);
  assert.equal(cfg3.fit, 'fit');
  await api(`streams/helm/${s.streamId}/options`, { method: 'POST', body: { fit: 'nonsense' } });
  let st = (await api('streams')).data.streams.find(x => x.streamId === s.streamId);
  assert.equal(st.fit, 'fill');

  // apply to all existing ones
  await api('defaults', { method: 'POST', body: { rotate: 180, mirror: false, applyAll: true } });
  const all = (await api('streams')).data.streams;
  assert.ok(all.every(x => x.rotate === 180));
  st = all.find(x => x.streamId === s.streamId);
  assert.equal(st.mirror, false);
  p.ws.close();
});

test('HLS keeps running when the image switches from landscape to portrait', { skip: !HAS_FFMPEG && 'ffmpeg missing' }, async () => {
  const PORTRAIT = fs.readFileSync(path.join(__dirname, 'fixtures', 'portrait.jpg'));
  const s = (await api('streams', { method: 'POST', body: { user: 'helm', label: 'switch' } })).data.stream;
  const p = publisher(s, keyOf(s));
  await p.waitFor('welcome');
  let current = JPEG_A;
  const feeder = setInterval(() => p.ws.send(current), 100);
  const waitSegments = async () => {
    for (let i = 0; i < 30; i++) {
      const r = await fetch(s.links.hls);
      if (r.status === 200) {
        const text = await r.text();
        const segs = text.match(/seg\d+\.ts/g);
        if (segs) return segs;
      }
      await sleep(400);
    }
    throw new Error('no HLS segments');
  };
  try {
    await waitSegments();
    current = PORTRAIT;
    await sleep(800);
    const segs = await waitSegments();
    const seg = await fetch(`${s.links.stream}/${segs[segs.length - 1]}`);
    assert.equal(seg.status, 200);
    // ffprobe checks that the new segment is portrait
    const file = path.join(os.tmpdir(), 'helmcam-seg.ts');
    fs.writeFileSync(file, Buffer.from(await seg.arrayBuffer()));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
    assert.equal(probe.stdout.toString().trim().split('\n')[0], '240,320', 'ffprobe: ' + probe.stderr);
    const st = (await api('streams')).data.streams.find(x => x.streamId === s.streamId);
    assert.equal(st.resolution, '240x320');
  } finally {
    clearInterval(feeder);
    p.ws.close();
  }
});

test('HTTPS directly with its own certificate (e.g. port 5036)', { skip: spawnSync('openssl', ['version']).status !== 0 && 'openssl missing' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmcam-tls-'));
  const cert = path.join(dir, 'cert.pem'), key = path.join(dir, 'key.pem');
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', BIND: '127.0.0.1', DATA_DIR: dir, TLS_CERT: cert, TLS_KEY: key, TRUST_PROXY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const port = await new Promise(resolve => {
      let out = '';
      p.stdout.on('data', d => { out += d; const m = out.match(/https:\/\/127\.0\.0\.1:(\d+)/); if (m) resolve(m[1]); });
    });
    const status = await new Promise((resolve, reject) => {
      require('https').get({ host: '127.0.0.1', port, path: '/health', rejectUnauthorized: false }, res => {
        res.resume(); resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 200);
  } finally {
    p.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-registration via the general QR code', async () => {
  const reg = async body => {
    const r = await fetch(base + '/api/app/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  assert.equal((await reg({ name: '', unit: 'x' })).status, 400);
  const a = await reg({ name: 'Jörg Müller', unit: 'Squad 2' });
  const b = await reg({ name: 'Jörg Müller', unit: 'Squad 3' });
  assert.equal(a.status, 200);
  assert.equal(a.data.u, 'joerg-mueller');
  assert.equal(a.data.label, 'Jörg Müller – Squad 2');
  assert.notEqual(a.data.s, b.data.s, 'same name, still separate streams');

  const st = (await api('streams')).data.streams.find(x => x.streamId === a.data.s);
  assert.equal(st.self, true);
  assert.equal(st.label, 'Jörg Müller – Squad 2');

  const p = publisher({ user: a.data.u, streamId: a.data.s }, a.data.k);
  await p.waitFor('welcome');
  p.ws.send(JPEG_A);
  await sleep(100);
  const snap = await fetch(`${base}/${a.data.u}/${a.data.s}/snapshot.jpg`);
  assert.equal(snap.status, 200);
  p.ws.close();

  // admin blocks registration
  assert.equal((await api('registration', { method: 'POST', body: { enabled: false } })).status, 200);
  assert.equal((await api('registration')).data.enabled, false);
  assert.equal((await reg({ name: 'New' })).status, 403);
  assert.equal((await (await fetch(base + '/api/app/info')).json()).registration, false);
  await api('registration', { method: 'POST', body: { enabled: true } });
  assert.equal((await reg({ name: 'New' })).status, 200);
  const qr = await fetch(base + '/api/admin/app-qr.svg', { headers: { cookie } });
  assert.match(await qr.text(), /^<svg/);
});

test('user aligns on the phone themselves (options via WebSocket)', async () => {
  const r = await fetch(base + '/api/app/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Aligner' }) });
  const reg = await r.json();
  const p = publisher({ user: reg.u, streamId: reg.s }, reg.k);
  await p.waitFor('welcome');
  p.messages.length = 0;
  p.ws.send(JSON.stringify({ type: 'options', rotate: 92.3, mirror: true }));
  const cfg = await p.waitFor('config');
  assert.equal(cfg.rotate, 92.5);
  assert.equal(cfg.mirror, true);
  const st = (await api('streams')).data.streams.find(x => x.streamId === reg.s);
  assert.equal(st.rotate, 92.5);
  assert.equal(st.mirror, true);
  p.ws.close();
});

test('setting the address in the admin: links and QR codes follow', async () => {
  const QRCode = require('qrcode');
  const qrOf = text => QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  const appQr = async () => (await fetch(base + '/api/admin/app-qr.svg', { headers: { cookie } })).text();

  assert.equal((await api('public-url', { method: 'POST', body: { url: 'no link !' } })).status, 400);
  const set = await api('public-url', { method: 'POST', body: { url: 'tak.example.com:5036/whatever' } });
  assert.equal(set.status, 200);
  assert.equal(set.data.publicUrl, 'https://tak.example.com:5036');

  const reg = (await api('registration')).data;
  assert.equal(reg.appUrl, 'https://tak.example.com:5036/app/');
  assert.equal(await appQr(), await qrOf('https://tak.example.com:5036/app/'), 'general QR code contains the new link');

  const s = (await api('streams')).data.streams[0];
  assert.ok(s.links.stream.startsWith('https://tak.example.com:5036/'));
  const streamQr = await (await fetch(`${base}/api/admin/streams/${s.user}/${s.streamId}/qr.svg`, { headers: { cookie } })).text();
  assert.equal(streamQr, await qrOf(s.links.app), 'stream QR code contains the new link');

  assert.equal((await api('public-url', { method: 'POST', body: { url: '' } })).data.publicUrl, '');
  assert.equal((await api('registration')).data.appUrl, base + '/app/');
  assert.equal(await appQr(), await qrOf(base + '/app/'));
});

test('the admin sets the image size (default 160x120)', async () => {
  const reg = async name => (await (await fetch(base + '/api/app/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json());
  // reset defaults from earlier tests
  await api('defaults', { method: 'POST', body: { rotate: 0 } });
  const a = await reg('Size');
  const find = async s => (await api('streams')).data.streams.find(x => x.streamId === s);
  assert.equal((await find(a.s)).framesize, 1);

  const p = publisher({ user: a.u, streamId: a.s }, a.k);
  assert.equal((await p.waitFor('config')).framesize, 1);
  p.messages.length = 0;
  await api(`streams/${a.u}/${a.s}/options`, { method: 'POST', body: { framesize: 8 } });
  assert.equal((await p.waitFor('config')).framesize, 8);
  assert.equal((await find(a.s)).framesize, 8);
  await api(`streams/${a.u}/${a.s}/options`, { method: 'POST', body: { framesize: 99 } });
  assert.equal((await find(a.s)).framesize, 1, 'invalid -> 160x120');
  p.ws.close();

  await api('defaults', { method: 'POST', body: { framesize: 5 } });
  assert.equal((await api('defaults')).data.framesize, 5);
  const b = await reg('Size2');
  assert.equal((await find(b.s)).framesize, 5);
  await api('defaults', { method: 'POST', body: { framesize: 1 } });
});

test('stream link: browsers get a fullscreen page, players the MJPEG stream', async () => {
  const r = await fetch(base + '/api/app/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '<b>Evil</b>' }) });
  const reg = await r.json();
  const url = `${base}/${reg.u}/${reg.s}`;
  const get = (u, accept) => new Promise((resolve, reject) => {
    const req = http.get(u, { headers: accept ? { Accept: accept } : {} }, res => {
      const type = res.headers['content-type'];
      if (/multipart/.test(type)) { req.destroy(); return resolve({ type, body: '' }); } // stream: only check the header
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ type, body }));
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
  });
  const html = await get(url, 'text/html,application/xhtml+xml,*/*;q=0.8');
  assert.match(html.type, /text\/html/);
  assert.match(html.body, /<img src="\?raw=1"/);
  assert.ok(!html.body.includes('<b>Evil</b>'), 'name is escaped');
  assert.match((await get(url, '*/*')).type, /multipart\/x-mixed-replace/);
  assert.match((await get(url)).type, /multipart\/x-mixed-replace/);
  assert.match((await get(url + '?raw=1', 'text/html')).type, /multipart\/x-mixed-replace/);
});

test('admin puts live: ready, live, live off', async () => {
  assert.equal((await api('live-mode', { method: 'POST', body: { mode: 'admin' } })).data.mode, 'admin');
  const reg = await (await fetch(base + '/api/app/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Standby' }) })).json();
  const find = async () => (await api('streams')).data.streams.find(x => x.streamId === reg.s);
  const snap = () => fetch(`${base}/${reg.u}/${reg.s}/snapshot.jpg`);

  const p = publisher({ user: reg.u, streamId: reg.s }, reg.k);
  const first = await p.waitFor('live');
  assert.equal(first.mode, 'admin');
  assert.equal(first.on, false);
  p.ws.send(JSON.stringify({ type: 'state', ready: true }));
  p.ws.send(JSON.stringify({ type: 'hello', camera: 'Helm 7' }));
  p.ws.send(JSON.stringify({ type: 'hello', camera: 'Helm 7' }));
  await sleep(100);
  let st = await find();
  assert.equal(st.ready, true);
  assert.equal(st.onAir, false);

  p.ws.send(JPEG_A); // not live: discarded
  await sleep(100);
  assert.equal((await snap()).status, 404);

  p.messages.length = 0;
  assert.equal((await api(`streams/${reg.u}/${reg.s}/live`, { method: 'POST', body: { on: true } })).status, 200);
  assert.equal((await p.waitFor('live')).on, true);
  p.ws.send(JPEG_B);
  await sleep(100);
  assert.equal((await snap()).status, 200);
  st = await find();
  assert.equal(st.onAir, true);
  assert.equal(st.receiving, true);

  p.messages.length = 0;
  await api('streams/live-off-all', { method: 'POST', body: {} });
  assert.equal((await p.waitFor('live')).on, false);
  assert.equal((await find()).onAir, false);

  // mode change is reported to the phones
  p.messages.length = 0;
  await api('live-mode', { method: 'POST', body: { mode: 'user' } });
  assert.equal((await p.waitFor('live')).mode, 'user');
  assert.equal((await api('registration')).data.liveMode, 'user');
  p.ws.close();
});

test('user starts by themselves (if allowed) and the admin gets notifications', async () => {
  const seq0 = (await api('streams')).data.eventSeq;
  await api('live-mode', { method: 'POST', body: { mode: 'admin', userCanStart: true } });
  const reg = await (await fetch(base + '/api/app/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Selfstarter', unit: 'Platoon 3' }) })).json();
  const id = reg.u + '/' + reg.s;
  const p = publisher({ user: reg.u, streamId: reg.s }, reg.k);
  const live0 = await p.waitFor('live');
  assert.equal(live0.userCanStart, true);
  p.ws.send(JSON.stringify({ type: 'state', ready: true }));
  await sleep(100);

  p.messages.length = 0;
  p.ws.send(JSON.stringify({ type: 'golive', on: true }));
  assert.equal((await p.waitFor('live')).on, true);
  const st = (await api('streams')).data.streams.find(x => x.streamId === reg.s);
  assert.equal(st.onAir, true);

  const ev = (await api('streams?since=' + seq0)).data.events.filter(e => e.id === id);
  assert.deepEqual(ev.map(e => e.kind), ['register', 'camera', 'live']);
  assert.match(ev[1].text, /Selfstarter – Platoon 3 activated the camera/);

  // permission revoked: a start from the phone is ignored
  await api(`streams/${reg.u}/${reg.s}/live`, { method: 'POST', body: { on: false } });
  await api('live-mode', { method: 'POST', body: { userCanStart: false } });
  p.messages.length = 0;
  p.ws.send(JSON.stringify({ type: 'golive', on: true }));
  const answer = await p.waitFor('live');
  assert.equal(answer.on, false);
  assert.equal(answer.userCanStart, false);
  assert.equal((await api('streams')).data.streams.find(x => x.streamId === reg.s).onAir, false);
  p.ws.close();
  await api('live-mode', { method: 'POST', body: { mode: 'user' } });
});

test('TAK EUD: app, offline files, preset, allowed servers and relay (TCP)', async () => {
  for (const p of ['/eud/', '/eud/sw.js', '/eud/eud.js', '/eud/manifest.webmanifest', '/eud/vendor/leaflet.js', '/eud/vendor/leaflet-rotate.js', '/eud/vendor/milsymbol.js', '/eud/vendor/jsQR.js', '/eud/vendor/images/layers.png']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    await r.arrayBuffer();
  }
  assert.equal((await fetch(base + '/eud/vendor/../../server.js')).status, 404);

  // mock TAK server (TCP)
  const net = require('net');
  const got = [];
  const tak = net.createServer(sock => {
    sock.on('data', d => got.push(d.toString()));
    sock.write('<event version="2.0" uid="X-1" type="a-f-G" time="t" start="t" stale="t"><point lat="1" lon="2"/><detail/></event>');
  });
  await new Promise(r => tak.listen(0, '127.0.0.1', r));

  // only allowed servers; the preset is in the QR code
  let r = await api('tak', { method: 'POST', body: { allowedHosts: 'tak.example.com', preset: { host: 'tak.example.com', port: 8089, proto: 'ssl' } } });
  assert.equal(r.status, 200);
  const cfg = await (await fetch(base + '/api/eud/config')).json();
  assert.equal(cfg.preset.host, 'tak.example.com');
  assert.equal(cfg.restricted, true);
  r = await fetch(base + '/api/eud/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'evil.example', username: 'a', password: 'b' }) });
  assert.equal(r.status, 403);

  const connectTak = () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws/tak');
    const msgs = [];
    ws.on('message', d => msgs.push(JSON.parse(d.toString())));
    return { ws, msgs, open: new Promise(res => ws.on('open', res)) };
  };
  const waitMsg = async (msgs, fn) => {
    for (let i = 0; i < 100; i++) { const m = msgs.find(fn); if (m) return m; await sleep(30); }
    throw new Error('missing: ' + JSON.stringify(msgs));
  };
  let c = connectTak();
  await c.open;
  c.ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: tak.address().port, proto: 'tcp' }));
  assert.match((await waitMsg(c.msgs, m => m.state === 'error')).message, /not allowed/);
  c.ws.close();

  await api('tak', { method: 'POST', body: { allowedHosts: '127.0.0.1', preset: null } });
  c = connectTak();
  await c.open;
  c.ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: tak.address().port, proto: 'tcp', callsign: 'BRAVO' }));
  await waitMsg(c.msgs, m => m.state === 'connected');
  const cot = await waitMsg(c.msgs, m => m.type === 'cot');
  assert.match(cot.xml, /uid="X-1"/);
  c.ws.send(JSON.stringify({ type: 'cot', xml: '<event uid="EUD-9" type="a-f-G-U-C"><detail/></event>' }));
  c.ws.send(JSON.stringify({ type: 'cot', xml: 'not CoT' }));
  for (let i = 0; i < 50 && !got.join('').includes('EUD-9'); i++) await sleep(30);
  assert.match(got.join(''), /uid="EUD-9"/);
  assert.doesNotMatch(got.join(''), /not CoT/);
  const links = await api('eud-links');
  assert.equal(links.data.links[0].callsign, 'BRAVO');
  c.ws.close();
  await api('tak', { method: 'POST', body: { allowedHosts: '', preset: null } });
  tak.close();
});

test('map tiles through our own server, with cache', async () => {
  const sources = await (await fetch(base + '/eud/tiles/sources.json')).json();
  assert.ok(sources.sources.some(s => s.id === 'osm'));
  const before = tileHits;
  let r = await fetch(base + '/eud/tiles/osm/5/10/12.png');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  r = await fetch(base + '/eud/tiles/osm/5/10/12.png');
  await r.arrayBuffer();
  assert.equal(tileHits - before, 1, 'second request comes from the cache');
  assert.ok(fs.existsSync(path.join(dataDir, 'tiles', 'osm', '5', '10', '12')));
  for (const bad of ['/eud/tiles/xyz/1/0/0.png', '/eud/tiles/osm/5/99/0.png', '/eud/tiles/osm/25/0/0.png', '/eud/tiles/osm/../../db.json']) {
    assert.equal((await fetch(base + bad)).status, 404, bad);
  }
});

test('mission tracks: admin API (without OpenTAKServer nothing is recorded)', async () => {
  let r = await api('tracks');
  assert.equal(r.status, 200);
  assert.equal(r.data.available, false);
  assert.deepEqual(r.data.missions, []);
  r = await api('tracks', { method: 'POST', body: { name: 'Exercise' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /OpenTAKServer/);
  assert.equal((await api('tracks/0123456789ab/points')).status, 404);
  assert.equal((await fetch(base + '/api/admin/tracks')).status, 401, 'admin only');
});

test('HQ: page and API only with the admin login; situation log, units, geofences', async () => {
  assert.equal((await fetch(base + '/hq/')).status, 200);
  assert.equal((await fetch(base + '/api/admin/hq/state')).status, 401);
  let r = await api('hq/log', { method: 'POST', body: { from: 'Alpha', to: 'HQ', kind: 'Request', text: 'Need water' } });
  assert.equal(r.status, 200);
  r = await api('hq/units', { method: 'POST', body: { units: [{ name: 'Alpha', kind: 'Squad', strength: 8, callsigns: ['ALPHA 1'] }] } });
  const id = r.data.units[0].id;
  assert.equal((await api(`hq/units/${id}/status`, { method: 'POST', body: { status: 'Moving' } })).status, 200);
  r = await api('hq/fences', { method: 'POST', body: { fences: [{ name: 'Base', kind: 'circle', lat: 47, lon: 11, radius: 250, base: true }] } });
  assert.equal(r.data.fences[0].radius, 250);
  r = await api('hq/state');
  assert.deepEqual(r.data.log.map(e => e.kind), ['Request', 'Troop report']);
  assert.equal(r.data.units[0].status, 'Moving');
  assert.equal(r.data.fences.length, 1);
  const csv = await fetch(base + '/api/admin/hq/log.csv', { headers: { cookie } });
  assert.match(await csv.text(), /Need water/);
});

test('helpers: may approve and create users, but not change settings', async () => {
  const { createMockOts } = require('./ots-mock');
  const mock = createMockOts();
  const otsUrl = await mock.listen();
  // own session for the helper (own cookie)
  let hcookie = '';
  const hapi = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + '/api/admin/' + p, { method, headers: { 'X-Requested-With': 'helm', ...(body ? { 'Content-Type': 'application/json' } : {}), cookie: hcookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) hcookie = set.split(';')[0];
    let data; const text = await res.text(); try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data };
  };
  try {
    await api('takusers/ots', { method: 'POST', body: { url: otsUrl, username: 'otsadmin', password: 'otspass', host: 'tak.example.com' } });
    await api('takusers/registration', { method: 'POST', body: { open: true, emailConfirm: false, codeword: '' } });
    assert.equal((await api('helpers', { method: 'POST', body: { username: 'helper1', password: 'short' } })).status, 400);
    const h = await api('helpers', { method: 'POST', body: { username: 'helper1', password: 'helper-pass-1', name: 'Hans' } });
    assert.equal(h.status, 200);
    assert.equal((await api('helpers', { method: 'POST', body: { username: 'HELPER1', password: 'helper-pass-1' } })).status, 400, 'duplicate');
    // login as helper
    let r = await hapi('login', { method: 'POST', body: { username: 'helper1', password: 'helper-pass-1' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.role, 'helper');
    r = await hapi('me');
    assert.equal(r.data.role, 'helper');
    assert.equal(r.data.username, 'helper1');
    // a request comes in -> helper approves
    const reg = await fetch(base + '/api/access/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Helper Test', email: 'ht@example.com', callsign: 'HT' }) }).then(x => x.json());
    r = await hapi('takusers/state');
    assert.equal(r.status, 200);
    assert.equal(r.data.ots.url, undefined, 'no OTS credentials for helpers');
    const id = r.data.users.find(u => u.email === 'ht@example.com').id;
    assert.ok(reg.token);
    r = await hapi(`takusers/user/${id}/approve`, { method: 'POST', body: { callsign: 'HT 1' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(mock.state.users.ht_1);
    // create users directly – never as OTS admin
    r = await hapi('ots/users', { method: 'POST', body: { callsign: 'Helper New', admin: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(mock.state.users.helper_new.roles, ['user']);
    assert.equal((await hapi('ots/users')).status, 200);
    // forbidden: settings, deleting, roles, helpers, admin login, stream details
    for (const [p, method, body] of [
      ['takusers/ots', 'POST', { url: 'http://evil' }], ['takusers/registration', 'POST', { open: false }], ['takusers/teams', 'POST', { teams: [] }],
      ['takusers/user/' + id, 'DELETE'], ['smtp', 'POST', {}], ['public-url', 'POST', { url: 'https://evil' }], ['tak', 'POST', {}],
      ['ots/users/ht_1/role', 'POST', { admin: true }], ['ots/users/ht_1', 'DELETE'], ['ots/groups', 'POST', { name: 'X' }], ['ots/missions', 'GET'],
      ['ots/feeds', 'POST', { path: 'x' }], ['ots/mesh', 'GET'], ['helpers', 'GET'], ['helpers', 'POST', { username: 'x2', password: 'abcdefgh1' }],
      ['credentials', 'POST', { current: 'helper-pass-1', username: 'boss', password: 'new-12345678' }], ['streams', 'POST', { user: 'x' }],
      ['defaults', 'POST', {}], ['live-mode', 'POST', { mode: 'user' }],
    ]) {
      const x = await hapi(p, { method, body });
      assert.ok(x.status === 403 || x.status === 400, `${method} ${p} -> ${x.status}`);
    }
    assert.equal(mock.state.users.ht_1.roles[0], 'user');
    r = await hapi('streams?since=0');
    assert.deepEqual(r.data.streams, [], 'no stream keys/links for helpers');
    // change own password
    assert.equal((await hapi('own-password', { method: 'POST', body: { current: 'wrong', password: 'new-pass-2' } })).status, 400);
    assert.equal((await hapi('own-password', { method: 'POST', body: { current: 'helper-pass-1', password: 'new-pass-2' } })).status, 200);
    // admin deletes the helper -> session invalid
    const list = await api('helpers');
    await api('helpers/' + list.data.helpers[0].id, { method: 'DELETE' });
    const after = await hapi('me');
    assert.equal(after.status, 401, JSON.stringify(after.data) + ' helpers=' + JSON.stringify(list.data));
    const st = await api('takusers/state');
    for (const u of st.data.users) await api('takusers/user/' + u.id, { method: 'DELETE' });
  } finally {
    mock.close();
  }
});

test('managing the TAK server: all OTS users, create, import, role, groups, missions, feeds, Meshtastic', async () => {
  const { createMockOts } = require('./ots-mock');
  const mock = createMockOts();
  const otsUrl = await mock.listen();
  try {
    assert.equal((await api('takusers/ots', { method: 'POST', body: { url: otsUrl, username: 'otsadmin', password: 'otspass', host: 'tak.example.com' } })).status, 200);
    // user created by hand in OTS with a device
    mock.state.users.user1 = { password: 'secret123', active: true, roles: ['user'] };
    mock.state.euds.push({ uid: 'ANDROID-1', callsign: 'Horst', username: 'user1' });
    let r = await api('ots/users');
    assert.equal(r.status, 200);
    const u1 = r.data.users.find(u => u.username === 'user1');
    assert.deepEqual(u1.roles, ['user']);
    assert.equal(u1.managed, null);
    assert.equal(u1.euds[0].callsign, 'Horst');
    // create directly (without registration)
    r = await api('ots/users', { method: 'POST', body: { callsign: 'Bravo 2', password: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.user.username, 'bravo_2');
    assert.match(r.data.password, /^[A-Za-z0-9]{14}$/, 'random password');
    assert.equal(mock.state.users.bravo_2.password, r.data.password);
    assert.match(r.data.link, /\/access\/#t=/);
    assert.equal((await api('ots/users', { method: 'POST', body: { callsign: 'X', username: 'user1' } })).status, 400, 'already exists in OTS');
    // import with a new password
    r = await api('ots/users/user1/import', { method: 'POST', body: { callsign: 'Horst', newPassword: true, password: 'newpass123' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(mock.state.users.user1.password, 'newpass123');
    r = await api('ots/users');
    assert.equal(r.data.users.find(u => u.username === 'user1').managed.callsign, 'Horst');
    // role, active, password, groups
    await api('ots/users/user1/role', { method: 'POST', body: { admin: true } });
    assert.deepEqual(mock.state.users.user1.roles, ['administrator']);
    await api('ots/users/user1/active', { method: 'POST', body: { on: false } });
    assert.equal(mock.state.users.user1.active, false);
    await api('ots/users/user1/active', { method: 'POST', body: { on: true } });
    r = await api('ots/users/user1/password', { method: 'POST', body: { password: '' } });
    assert.match(r.data.password, /^[A-Za-z0-9]{14}$/);
    assert.equal((await api('ots/users/user1/password', { method: 'POST', body: { password: 'short' } })).status, 400);
    await api('ots/users/user1/groups', { method: 'POST', body: { group: 'PLT_1', direction: 'IN' } });
    assert.deepEqual(mock.groupsOf('user1'), ['PLT_1.IN']);
    await api('ots/users/user1/groups', { method: 'POST', body: { group: 'PLT_1', direction: 'IN', remove: true } });
    assert.deepEqual(mock.groupsOf('user1'), []);
    // groups
    assert.equal((await api('ots/groups', { method: 'POST', body: { name: 'PLT_2' } })).status, 200);
    assert.ok((await api('ots/groups')).data.groups.some(g => g.name === 'PLT_2'));
    assert.equal((await api('ots/groups', { method: 'POST', body: { name: 'with space' } })).status, 400);
    assert.equal((await api('ots/groups/PLT_2', { method: 'DELETE' })).status, 200);
    // missions: creator = known device (automatically the first), groups by name
    await api('ots/groups', { method: 'POST', body: { name: 'PLT_3' } });
    r = await api('ots/missions', { method: 'POST', body: { name: 'Operation North', description: 'Test', password: 'pw', groups: ['PLT_3'] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(mock.state.missions['Operation North'].creator_uid, 'ANDROID-1');
    assert.equal(mock.state.missions['Operation North'].groups.length, 1);
    r = await api('ots/missions');
    assert.equal(r.data.missions[0].password, true);
    assert.deepEqual(r.data.missions[0].groups, ['PLT_3']);
    // without a group selection: all groups (otherwise a user with a team group does not see the mission in OTS)
    await api('ots/missions', { method: 'POST', body: { name: 'Everyone', description: '' } });
    assert.equal(mock.state.missions.Everyone.groups.length, mock.state.groups.size);
    // set an existing mission's groups afterwards
    mock.state.missions.Everyone.groups = [];
    assert.equal((await api('ots/missions/Everyone/groups', { method: 'PUT', body: { groups: [] } })).status, 200);
    assert.equal(mock.state.missions.Everyone.groups.length, mock.state.groups.size);
    assert.equal((await api('ots/missions/Everyone/groups', { method: 'PUT', body: { groups: ['PLT_3'] } })).status, 200);
    r = await api('ots/missions');
    assert.deepEqual(r.data.missions.find(m => m.name === 'Everyone').groups, ['PLT_3']);
    await api('ots/missions/Everyone', { method: 'DELETE' });
    await api('ots/missions/' + encodeURIComponent('Operation North'), { method: 'DELETE' });
    assert.equal(mock.state.missions['Operation North'], undefined);
    // video feeds
    assert.equal((await api('ots/feeds', { method: 'POST', body: { path: 'drone1', source: 'rtsp://10.0.0.5/live' } })).status, 200);
    assert.equal(mock.state.videos.drone1.source, 'rtsp://10.0.0.5/live');
    assert.equal((await api('ots/feeds', { method: 'POST', body: { path: '../x', source: '' } })).status, 400);
    assert.equal((await api('ots/feeds', { method: 'POST', body: { path: 'x', source: 'file:///etc' } })).status, 400);
    assert.equal((await api('ots/feeds')).data.feeds.length, 1);
    await api('ots/feeds/drone1', { method: 'DELETE' });
    assert.equal(mock.state.videos.drone1, undefined);
    // Meshtastic
    const psk = (await api('ots/mesh/psk')).data.psk;
    assert.ok(psk);
    assert.equal((await api('ots/mesh', { method: 'POST', body: { name: 'TAKweb', psk, modemPreset: 'LONG_FAST', region: 'EU_868' } })).status, 200);
    assert.equal(mock.state.mesh[0].lora_region, 'EU_868');
    assert.equal((await api('ots/mesh', { method: 'POST', body: { name: 'way too long!' } })).status, 400);
    const ch = (await api('ots/mesh')).data.channels[0];
    await api('ots/mesh?url=' + encodeURIComponent(ch.url), { method: 'DELETE' });
    assert.equal(mock.state.mesh.length, 0);
    // delete (also from the TAKweb management)
    await api('ots/users/bravo_2', { method: 'DELETE' });
    assert.equal(mock.state.users.bravo_2, undefined);
    assert.equal((await api('takusers/state')).data.users.some(u => u.username === 'bravo_2'), false);
    const st = await api('takusers/state');
    for (const u of st.data.users) await api('takusers/user/' + u.id, { method: 'DELETE' });
  } finally {
    mock.close();
  }
});

test('TAKweb video: HLS feeds through our own server (playlist rewritten, segments, video only, target checked)', async () => {
  const up = http.createServer((req, res) => {
    if (req.url === '/live/cam/index.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg1.ts\n#EXTINF:2,\nhttp://other.example/x.ts\n'); }
    if (req.url === '/live/cam/seg1.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(Buffer.from('TSDATA')); }
    if (req.url === '/live/redirect.m3u8') { res.writeHead(302, { Location: '/live/cam/index.m3u8' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${up.address().port}`;
  const media = u => fetch(base + '/api/eud/media?u=' + encodeURIComponent(u));
  try {
    // without allowing: own machine (127.0.0.1) blocked
    assert.equal((await media(origin + '/live/cam/index.m3u8')).status, 403);
    await api('tak', { method: 'POST', body: { allowedHosts: '127.0.0.1', preset: null } });
    let r = await media(origin + '/live/cam/index.m3u8');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /mpegurl/);
    const pl = await r.text();
    assert.match(pl, new RegExp('^/api/eud/media\\?u=' + encodeURIComponent(origin + '/live/cam/seg1.ts').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));
    assert.match(pl, /URI="\/api\/eud\/media\?u=[^"]+init\.mp4"/);
    assert.match(pl, /u=http%3A%2F%2Fother\.example%2Fx\.ts/);
    r = await media(origin + '/live/cam/seg1.ts');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'TSDATA');
    r = await media(origin + '/live/redirect.m3u8');
    assert.equal(r.status, 200, 'redirect on the same server is followed');
    assert.equal((await media(origin + '/admin/')).status, 400, 'video files only');
    assert.equal((await media('file:///etc/passwd.ts')).status, 400);
    assert.equal((await media('http://tak.example.com/x.m3u8')).status, 403, 'not in the list');
    assert.equal((await media(origin + '/live/cam/missing.ts')).status, 404);
  } finally {
    await api('tak', { method: 'POST', body: { allowedHosts: '', preset: null } });
    up.close();
  }
});

test('TAK access: mails – the user never gets an admin link, the admin notification only goes to the admin address', async () => {
  const sink = await smtpSink();
  try {
    await api('smtp', { method: 'POST', body: { host: '127.0.0.1', port: sink.port, secure: false, from: 'takweb@example.com' } });
    await api('takusers/registration', { method: 'POST', body: { open: true, emailConfirm: true, codeword: '' } });
    const pub = (p, body) => fetch(base + '/api/access/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
    const flat = m => m.replace(/=\n/g, '').replace(/=3D/g, '=');
    const waitMails = async n => { for (let i = 0; i < 100 && sink.mails.length < n; i++) await sleep(30); };
    await api('public-url', { method: 'POST', body: { url: 'https://takweb.example.com' } });
    let r = await fetch(base + '/api/access/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' },
      body: JSON.stringify({ name: 'Mail Test', email: 'mike@example.com', callsign: 'MIKE' }) }).then(async x => ({ status: x.status, data: await x.json() }));
    assert.equal(r.data.status, 'unconfirmed');
    await waitMails(1);
    const confirm = flat(sink.mails[0]);
    assert.match(confirm, /^To: mike@example\.com/m);
    const code = /&c=([a-f0-9]+)/.exec(confirm)[1];
    assert.equal((await pub('confirm', { code })).status, 200);
    await waitMails(2);
    await sleep(200);
    const toUser = sink.mails.map(flat).filter(m => /^To: mike@example\.com/m.test(m));
    const toAdmin = sink.mails.map(flat).filter(m => /^To: chief@example\.com/m.test(m));
    assert.equal(toAdmin.length, 1, 'admin gets exactly one notification');
    assert.match(toAdmin[0], /TAKweb access requested: Mail Test/);
    assert.match(toAdmin[0], /^https:\/\/admin\.test:5036\/admin\/#users$/m, 'admin notification with a link to the admin area (configured address, admin domain)');
    assert.doesNotMatch(toAdmin[0], /evil\.example/, 'never from the Host header of the request');
    for (const m of toUser) assert.doesNotMatch(m, /\/admin/i, 'no admin link to the user');
    assert.ok(sink.mails.map(flat).every(m => !/^To: mike@example\.com/m.test(m) || !/TAKweb access requested/.test(m)), 'admin notification never to the user');
    // admin address equals the request's address: no admin notification to that address
    await api('takusers/registration', { method: 'POST', body: { open: true, emailConfirm: false, codeword: '' } });
    const before = sink.mails.length;
    r = await pub('register', { name: 'Same Address', email: 'chief@example.com' });
    assert.equal(r.data.status, 'pending');
    await sleep(400);
    const newMails = sink.mails.slice(before).map(flat);
    assert.equal(newMails.filter(m => /TAKweb access requested/.test(m)).length, 0);
    assert.equal(newMails.filter(m => /your registration request for TAKweb has been received/.test(m)).length, 1);
    // clean up for the following tests
    await api('public-url', { method: 'POST', body: { url: '' } });
    const st = await api('takusers/state');
    for (const u of st.data.users) await api('takusers/user/' + u.id, { method: 'DELETE' });
  } finally {
    sink.srv.close();
  }
});

// web EUD connected over SSL to a TAK server at the OTS address with a client certificate (CN = user) -> asks for the drone login
async function droneLogin(otsUrl, cn, { connect = true } = {}) {
  const forge = require('node-forge');
  const tls = require('tls');
  const mk = (name, pub, signKey, issuer, ext) => {
    const c = forge.pki.createCertificate();
    c.publicKey = pub; c.serialNumber = String(Date.now() % 1e9); c.validity.notBefore = new Date(Date.now() - 864e5); c.validity.notAfter = new Date(Date.now() + 864e5);
    c.setSubject([{ shortName: 'CN', value: name }]); c.setIssuer(issuer || [{ shortName: 'CN', value: name }]); c.setExtensions(ext); c.sign(signKey, forge.md.sha256.create());
    return c;
  };
  const ck = forge.pki.rsa.generateKeyPair(1024), sk = forge.pki.rsa.generateKeyPair(1024), uk = forge.pki.rsa.generateKeyPair(1024);
  const ca = mk('CA', ck.publicKey, ck.privateKey, null, [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true }]);
  const srv = mk('tak', sk.publicKey, ck.privateKey, ca.subject.attributes, [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  const usr = mk(cn, uk.publicKey, ck.privateKey, ca.subject.attributes, [{ name: 'extKeyUsage', clientAuth: true }]);
  const pem = forge.pki.certificateToPem;
  const takSrv = tls.createServer({ key: forge.pki.privateKeyToPem(sk.privateKey), cert: pem(srv), ca: [pem(ca)], requestCert: true, rejectUnauthorized: true }, sock => sock.on('error', () => {}));
  await new Promise(r => takSrv.listen(0, '127.0.0.1', r));
  // a TAK port on this machine must be one set in the admin (preset)
  await api('tak', { method: 'POST', body: { allowedHosts: '', preset: { host: '127.0.0.1', port: takSrv.address().port, proto: 'ssl' } } });
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/tak');
  const msgs = [];
  ws.on('message', d => msgs.push(JSON.parse(d.toString())));
  await new Promise(r => ws.on('open', r));
  const wait = async fn => { for (let i = 0; i < 150; i++) { const m = msgs.find(fn); if (m) return m; await sleep(30); } throw new Error('missing: ' + JSON.stringify(msgs)); };
  try {
    if (connect) {
      ws.send(JSON.stringify({ type: 'connect', host: new URL(otsUrl).hostname, port: takSrv.address().port, proto: 'ssl', certPem: pem(usr), keyPem: forge.pki.privateKeyToPem(uk.privateKey), caPems: [pem(ca)] }));
      await wait(m => m.state === 'connected');
    }
    ws.send(JSON.stringify({ type: 'drone' }));
    return await wait(m => m.type === 'drone');
  } finally {
    ws.close();
    takSrv.close();
    await api('tak', { method: 'POST', body: { allowedHosts: '', preset: null } });
  }
}

test('TAK access: registration -> approval with callsign -> access page with QR and truststore -> block', async () => {
  const { createMockOts } = require('./ots-mock');
  const mock = createMockOts();
  const otsUrl = await mock.listen();
  try {
    const pub = (p, opts = {}) => fetch(base + '/api/access/' + p, opts).then(async r => ({ status: r.status, data: (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text(), type: r.headers.get('content-type') }));
    for (const p of ['/join/', '/access/', '/assets/tak.css']) assert.equal((await fetch(base + p)).status, 200, p);
    await api('takusers/registration', { method: 'POST', body: { open: true, emailConfirm: false, codeword: '' } });
    assert.equal((await pub('config')).data.open, true);
    // registration
    let r = await pub('register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Horst Huber', unit: 'Platoon 2', callsign: 'Horst', email: 'horst@example.com' }) });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'pending');
    const token = r.data.token;
    r = await pub('me', { headers: { 'X-Access-Token': token } });
    assert.equal(r.data.status, 'pending');
    assert.equal(r.data.password, undefined);
    assert.equal((await pub('qr/atak.svg?t=' + token)).status, 403);
    assert.equal((await pub('me', { headers: { 'X-Access-Token': 'x'.repeat(48) } })).status, 404);
    // admin: connect OTS, teams, approval
    let a = await api('takusers/ots', { method: 'POST', body: { url: otsUrl, username: 'otsadmin', password: 'otspass', host: 'tak.example.com' } });
    assert.equal(a.status, 200);
    assert.equal((await api('takusers/ots/test', { method: 'POST', body: {} })).status, 200);
    a = await api('takusers/teams', { method: 'POST', body: { teams: [{ name: 'Alpha', color: 'Blue' }, { name: 'Bravo', color: 'Red' }], blocks: [] } });
    assert.deepEqual(a.data.errors, []);
    let st = await api('takusers/state');
    assert.equal(st.data.users.length, 1);
    assert.equal(st.data.ots.password, undefined, 'the OTS password is not sent to the browser');
    const [alpha] = st.data.teams;
    const id = st.data.users[0].id;
    assert.equal(st.data.users[0].token, undefined, 'access token not in the admin list');
    a = await api(`takusers/user/${id}/approve`, { method: 'POST', body: { callsign: 'Alpha 10', team: alpha.id, role: 'Team Lead' } });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.match(a.data.link, /\/access\/#t=[a-f0-9]{48}$/);
    assert.equal(mock.state.users.alpha_10.active, true);
    // access page: data, QR codes, truststore
    r = await pub('me', { headers: { 'X-Access-Token': token } });
    assert.equal(r.data.status, 'active');
    assert.equal(r.data.callsign, 'Alpha 10');
    assert.equal(r.data.username, 'alpha_10');
    assert.equal(r.data.teamColor, 'Blue');
    assert.equal(r.data.password, mock.state.users.alpha_10.password);
    for (const q of ['qr/atak.svg', 'qr/itak.svg', 'qr/eud.svg']) {
      const x = await pub(q + '?t=' + token);
      assert.equal(x.status, 200, q);
      assert.match(x.data, /<svg/);
    }
    const ts = await fetch(base + '/api/access/truststore.p12?t=' + token);
    assert.equal(ts.status, 200);
    assert.equal(Buffer.from(await ts.arrayBuffer()).toString(), 'P12DATA');
    // ATAK setup package: everything included, nothing to type; QR = https link to the package page
    const pk = await fetch(base + '/api/access/atak-package.zip?t=' + token);
    assert.equal(pk.status, 200);
    assert.match(pk.headers.get('content-disposition'), /TAKweb-Alpha_10\.zip/);
    const files = require('../lib/tak').unzip(Buffer.from(await pk.arrayBuffer()));
    assert.equal(files['certs/truststore.p12'].toString(), 'P12DATA');
    const pref = files['certs/config.pref'].toString();
    assert.match(pref, /key="username0"[^>]*>alpha_10</);
    assert.match(pref, new RegExp(`key="password0"[^>]*>${mock.state.users.alpha_10.password}<`));
    assert.match(pref, /key="connectString0"[^>]*>tak\.example\.com:8089:ssl</);
    assert.equal((await fetch(base + '/api/access/atak-package.zip?t=' + 'x'.repeat(48))).status, 404);
    assert.equal((await fetch(base + '/access/atak.html')).status, 200);
    assert.match((await pub('atak-link', { headers: { 'X-Access-Token': token } })).data.link, /^tak:\/\/com\.atakmap\.app\/enroll/);
    // drone address in the web EUD without typing: connected to our OTS with the certificate of the user ->
    // TAKweb hands over the login; another certificate / not connected -> nothing
    const drone = await droneLogin(otsUrl, 'alpha_10');
    assert.equal(drone.username, 'alpha_10');
    assert.equal(drone.password, mock.state.users.alpha_10.password);
    assert.equal(drone.host, 'tak.example.com');
    assert.equal((await droneLogin(otsUrl, 'somebody')).error, 'unknown');
    assert.equal((await droneLogin(otsUrl, 'alpha_10', { connect: false })).error, 'unknown');
    // block -> no more data
    await api(`takusers/user/${id}/block`, { method: 'POST', body: {} });
    assert.equal(mock.state.users.alpha_10.active, false);
    r = await pub('me', { headers: { 'X-Access-Token': token } });
    assert.equal(r.data.status, 'blocked');
    assert.equal(r.data.password, undefined);
    // no management without login
    const anon = await fetch(base + '/api/admin/takusers/state');
    assert.equal(anon.status, 401);
    await api(`takusers/user/${id}`, { method: 'DELETE' });
    assert.equal(mock.state.users.alpha_10, undefined);
  } finally {
    mock.close();
  }
});
