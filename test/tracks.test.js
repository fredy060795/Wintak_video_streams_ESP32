// Mission tracks (lib/tracks.js): positions of every user from the TAK server are recorded while a mission runs,
// thinned out (not every second), kept across a restart and exported as GPX/KML.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tracks, parsePli, parseObject, stateOf } = require('../lib/tracks');

const iso = t => new Date(t).toISOString();
const pli = (uid, lat, lon, { t = Date.now(), cs = uid, team = 'Cyan', extra = '' } = {}) =>
  `<event version="2.0" uid="${uid}" type="a-f-G-U-C" how="m-g" time="${iso(t)}" start="${iso(t)}" stale="${iso(t + 60000)}">`
  + `<point lat="${lat}" lon="${lon}" hae="250" ce="9" le="9"/><detail><contact callsign="${cs}" endpoint="*:-1:stcp"/>`
  + `<__group name="${team}" role="Team Member"/><track speed="1.5" course="90"/>${extra}</detail></event>`;

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takweb-tracks-'));
  const store = { tracks: {} };
  let saves = 0;
  const made = [];
  const make = () => { const t = new Tracks({ dir, data: () => store.tracks, save: () => { saves++; }, ...opts }); clearInterval(t.timer); made.push(t); return t; };
  return { dir, store, make, saves: () => saves };
}

// Date.now() under control: the recorder thins out by arrival time
function clock(start) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  return { add: ms => { now += ms; }, get: () => now, restore: () => { Date.now = real; } };
}

test('tracks: only positions of users, not markers or drawings', () => {
  const p = parsePli(pli('ANDROID-1', 47.1, 11.2, { cs: 'Alpha &amp; 1' }));
  assert.equal(p.uid, 'ANDROID-1');
  assert.equal(p.callsign, 'Alpha & 1');
  assert.equal(p.team, 'Cyan');
  assert.equal(p.hae, 250);
  assert.equal(p.speed, 1.5);
  const t = new Date().toISOString();
  assert.equal(parsePli(`<event uid="m1" type="a-h-G" time="${t}"><point lat="47" lon="11" hae="0"/><detail><contact callsign="Enemy"/></detail></event>`), null, 'marker');
  assert.equal(parsePli(`<event uid="d1" type="u-d-f" time="${t}"><point lat="47" lon="11" hae="0"/><detail/></event>`), null, 'drawing');
  assert.equal(parsePli(pli('TAKWEB-REC-ab', 47, 11)), null, 'own connection');
  assert.equal(parsePli(pli('X', 0, 0)), null, 'no position');
  // TAKweb in the browser (takv, no endpoint) and Meshtastic users (group only) count
  assert.ok(parsePli(`<event uid="EUD-1" type="a-f-G-U-C" time="${t}"><point lat="47" lon="11" hae="9999999"/><detail><takv platform="TAKweb"/><contact callsign="B"/></detail></event>`));
});

test('tracks: recording, thinning out, stop, GPX/KML, delete', () => {
  const s = setup();
  const c = clock(Date.UTC(2026, 10, 2, 8, 0, 0));
  try {
    const tr = s.make();
    tr.cot(pli('A', 47, 11)); // nothing recorded without a mission
    const m = tr.create({ name: 'Exercise North' });
    assert.equal(stateOf(m), 'recording');
    assert.throws(() => tr.create({ name: 'second' }), /only one recording/);
    // stored picture from before the mission (sent by the server on connect) is left out
    tr.cot(pli('OLD', 47, 11, { t: c.get() - 3600000 }));
    for (let i = 0; i < 10; i++) { tr.cot(pli('A', 47 + i * 0.001, 11, { t: c.get() })); c.add(1000); } // 1 per second, moving
    for (let i = 0; i < 10; i++) { tr.cot(pli('B', 48, 12, { t: c.get(), team: 'Red' })); c.add(10000); } // standing still
    tr.cot(pli('B', 48.01, 12, { t: c.get(), team: 'Red' }));
    assert.deepEqual(Object.keys(m.users).sort(), ['A', 'B']);
    assert.equal(m.users.A.points, 2, 'one point per 5 s');
    assert.equal(m.users.B.points, 3, 'standing still: one a minute, then the move');
    assert.ok(m.users.B.meters > 1000 && m.users.B.meters < 1200, 'distance ' + m.users.B.meters);
    tr.stop();
    assert.ok(m.end);
    tr.cot(pli('A', 47.5, 11)); // after the end
    const pts = tr.points(m.id);
    assert.equal(pts.length, 5);
    assert.deepEqual(pts[0].slice(1, 4), ['A', 47, 11]);
    const gpx = tr.gpx(m.id);
    assert.match(gpx, /<name>Exercise North<\/name>/);
    assert.equal((gpx.match(/<trk>/g) || []).length, 2);
    assert.match(gpx, /<trkpt lat="48.01" lon="12"><ele>250<\/ele><time>/);
    const kml = tr.kml(m.id);
    assert.match(kml, /<gx:Track>/);
    assert.match(kml, /<gx:coord>12 48.01 250<\/gx:coord>/);
    assert.match(kml, /<color>ff0000ff<\/color>/, 'team Red');
    assert.ok(tr.remove(m.id));
    assert.equal(tr.missions().length, 0);
    assert.equal(fs.existsSync(tr.file(m.id)), false);
  } finally {
    c.restore();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('tracks: a recording goes on after a server restart', async () => {
  const s = setup();
  try {
    const a = s.make();
    const m = a.create({ name: 'Night' });
    a.cot(pli('A', 47, 11));
    a.close(); // the server stops
    const b = s.make();
    assert.equal(b.active().id, m.id);
    b.cot(pli('C', 46, 10));
    b.stop();
    assert.deepEqual(b.points(m.id).map(p => p[1]), ['A', 'C']);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('tracks: planned start and end, missed window, start a planned mission now', () => {
  const s = setup();
  const t0 = Date.UTC(2026, 10, 2, 8, 0, 0);
  const c = clock(t0);
  try {
    const tr = s.make();
    const m = tr.create({ name: 'Day 2', from: t0 + 3600000, to: t0 + 7200000 });
    assert.equal(stateOf(m), 'planned');
    assert.throws(() => tr.create({ name: 'clash', from: t0 + 5400000 }), /Another mission/);
    tr.cot(pli('A', 47, 11)); // not yet
    c.add(3600000); tr.tick();
    assert.equal(stateOf(m), 'recording');
    assert.equal(m.start, t0 + 3600000);
    tr.cot(pli('A', 47, 11));
    c.add(3600000); tr.tick();
    assert.equal(stateOf(m), 'done');
    assert.equal(m.end, t0 + 7200000);
    assert.equal(m.points, 1);
    // the server was off during the whole window
    const gone = tr.create({ name: 'Night', from: c.get() + 60000, to: c.get() + 120000 });
    c.add(600000); tr.tick();
    assert.equal(stateOf(gone), 'done');
    assert.equal(gone.missed, true);
    // planned, but started by hand right away; the planned end stays
    const end = c.get() + 90000000;
    const p = tr.create({ name: 'Day 3', from: c.get() + 86400000, to: end });
    tr.startNow(p.id);
    assert.equal(stateOf(p), 'recording');
    assert.equal(p.to, end, 'the planned end stays');
  } finally {
    c.restore();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('tracks: only chosen users, their markers and drawings with every change and the deletion', () => {
  const s = setup({ accept: (m, uid) => m.who.mode === 'all' || m.who.users.includes(uid) });
  const c = clock(Date.UTC(2026, 10, 2, 8, 0, 0));
  try {
    const tr = s.make();
    const m = tr.create({ name: 'Alpha only', who: { mode: 'users', users: ['A'] } });
    tr.cot(pli('A', 47, 11));
    tr.cot(pli('B', 48, 12));
    const t = () => iso(c.get());
    const marker = (uid, by, lat) => `<event version="2.0" uid="${uid}" type="a-h-G" how="h-g-i-g-o" time="${t()}" start="${t()}" stale="${t()}"><point lat="${lat}" lon="11" hae="0" ce="9" le="9"/><detail><contact callsign="Enemy"/><link uid="${by}" relation="p-p" type="a-f-G-U-C"/></detail></event>`;
    tr.cot(marker('M1', 'A', 47.1));
    c.add(2000);
    tr.cot(marker('M1', 'A', 47.1)); // the server repeats it: kept once
    tr.cot(marker('M1', 'A', 47.2)); // moved: kept
    tr.cot(marker('M2', 'B', 47.3)); // placed by somebody who is not recorded
    tr.cot(`<event version="2.0" uid="D1" type="t-x-d-d" how="h-g-i-g-o" time="${t()}" start="${t()}" stale="${t()}"><point lat="0" lon="0" hae="0" ce="9" le="9"/><detail><link uid="M1" relation="none" type="none"/><__forcedelete/></detail></event>`);
    assert.deepEqual(Object.keys(m.users), ['A']);
    const objs = tr.objects(m.id);
    assert.deepEqual(objs.map(o => [o[1], o[2]]), [['M1', 'a-h-G'], ['M1', 'a-h-G'], ['D1', 't-x-d-d']]);
    assert.match(objs[1][3], /lat="47.2"/);
    assert.equal(m.objectCount, 3);
    assert.equal(parseObject(pli('A', 47, 11)), null, 'a device is a track, not an object');
    assert.equal(parseObject(`<event uid="u1" type="u-d-f" time="${t()}"><point lat="1" lon="1"/><detail><link uid="A" relation="p-p"/></detail></event>`).creator, 'A');
    tr.stop();
  } finally {
    c.restore();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

// OpenTAKServer delivers data to a client only after it sent an event with <contact> – the recorder announces itself
test('tracks: the recorder gets positions from a TAK server that only serves announced clients (like OTS)', async () => {
  const tls = require('tls');
  const crypto = require('crypto');
  const forge = require('node-forge');
  const tak = require('../lib/tak');
  const cert = (cn, pub, signer, isCa, server) => {
    const c = forge.pki.createCertificate();
    c.publicKey = pub;
    c.serialNumber = crypto.randomBytes(4).toString('hex');
    c.validity.notBefore = new Date(Date.now() - 86400000);
    c.validity.notAfter = new Date(Date.now() + 86400000);
    c.setSubject([{ shortName: 'CN', value: cn }]);
    c.setIssuer(signer ? signer.subject.attributes : [{ shortName: 'CN', value: cn }]);
    c.setExtensions(isCa ? [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true }]
      : server ? [{ name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] : [{ name: 'extKeyUsage', clientAuth: true }]);
    return c;
  };
  const k = () => forge.pki.rsa.generateKeyPair(1024);
  const ck = k(), ca = cert('CA', ck.publicKey, null, true); ca.sign(ck.privateKey, forge.md.sha256.create());
  const sk = k(), sc = cert('127.0.0.1', sk.publicKey, ca, false, true); sc.sign(ck.privateKey, forge.md.sha256.create());
  const uk = k(), uc = cert('rec', uk.publicKey, ca, false, false); uc.sign(ck.privateKey, forge.md.sha256.create());
  const pem = { ca: forge.pki.certificateToPem(ca), sKey: forge.pki.privateKeyToPem(sk.privateKey), sCert: forge.pki.certificateToPem(sc), uKey: forge.pki.privateKeyToPem(uk.privateKey), uCert: forge.pki.certificateToPem(uc) };
  const known = new Set();
  const server = tls.createServer({ key: pem.sKey, cert: pem.sCert, ca: [pem.ca], requestCert: true, rejectUnauthorized: true }, sock => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', d => {
      const r = tak.splitEvents(buf + d);
      buf = r.rest;
      for (const ev of r.events) {
        if (/type="t-x-c-t"/.test(ev)) continue; // pings do not announce a client (OTS answers them only)
        if (/<contact\b/.test(ev)) known.add(sock);
        for (const o of known) if (o !== sock) o.write(ev);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => known.delete(sock));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const s = setup();
  const tr = s.make();
  const m = tr.create({ name: 'Live' });
  const links = [];
  const connect = hello => new Promise(resolve => {
    const l = new tak.TakLink({ host: '127.0.0.1', port, proto: 'ssl', certPem: pem.uCert, keyPem: pem.uKey, caPems: [pem.ca], uid: 'TAKWEB-REC-t', hello, onCot: xml => tr.cot(xml), onStatus: st => { if (st === 'connected') resolve(l); } });
    links.push(l);
    l.start();
  });
  try {
    await connect(''); // silent like before: gets nothing
    const device = tls.connect({ host: '127.0.0.1', port, cert: pem.uCert, key: pem.uKey, ca: [pem.ca] });
    await new Promise(r => device.once('secureConnect', r));
    await new Promise(r => setTimeout(r, 200));
    device.write(pli('ANDROID-X', 47.2, 11.4, { cs: 'Xray' }));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(m.points, 0, 'a silent client gets nothing from such a server');
    links[0].stop();
    await connect('TAKweb recorder');
    await new Promise(r => setTimeout(r, 200));
    device.write(pli('ANDROID-X', 47.3, 11.4, { cs: 'Xray' }));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(m.points, 1);
    assert.equal(m.users['ANDROID-X'].callsign, 'Xray');
    device.destroy();
  } finally {
    for (const l of links) l.stop();
    tr.stop();
    server.close();
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});
