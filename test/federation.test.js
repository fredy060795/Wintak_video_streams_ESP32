// Tests the federation (lib/federation.js) between two mock TAK servers: TLS with client certificates,
// CoT to all other connections (not back to the sender, like a TAK server) and the data package API.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const forge = require('node-forge');
const tak = require('../lib/tak');
const { Federation } = require('../lib/federation');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ca, serverKey, serverCert, clientKey, clientCert;

function makeCert(cn, pub, signer, isCa, server) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = pub;
  cert.serialNumber = crypto.randomBytes(4).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000 * 30);
  cert.setSubject([{ shortName: 'CN', value: cn }]);
  cert.setIssuer(signer ? signer.cert.subject.attributes : [{ shortName: 'CN', value: cn }]);
  cert.setExtensions(isCa ? [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true }]
    : server ? [{ name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }] : [{ name: 'extKeyUsage', clientAuth: true }]);
  return cert;
}

// a small TAK server: CoT port (to all connections except the sender) and API (packages)
function mockTak(name) {
  const t = { name, socks: new Set(), packages: new Map(), uploads: 0 };
  t.cot = tls.createServer({ key: serverKey, cert: serverCert, ca: [ca.pem], requestCert: true, rejectUnauthorized: true }, sock => {
    t.socks.add(sock);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', d => {
      const r = tak.splitEvents(buf + d);
      buf = r.rest;
      for (const ev of r.events) for (const o of t.socks) if (o !== sock) o.write(ev);
    });
    sock.on('close', () => t.socks.delete(sock));
    sock.on('error', () => {});
  });
  t.api = https.createServer({ key: serverKey, cert: serverCert, ca: [ca.pem], requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const u = new URL(req.url, 'https://x');
    if (u.pathname === '/Marti/sync/search') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: [...t.packages].map(([hash, p]) => ({ Hash: hash, Name: p.name, MIMEType: 'application/zip', Size: p.data.length })) }));
    }
    if (u.pathname === '/Marti/sync/content') {
      const p = t.packages.get(u.searchParams.get('hash'));
      res.writeHead(p ? 200 : 404);
      return res.end(p ? p.data : '');
    }
    if (u.pathname === '/Marti/sync/missionupload' && req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const start = body.indexOf('\r\n\r\n') + 4, end = body.lastIndexOf('\r\n--');
        const data = body.subarray(start, end);
        const hash = u.searchParams.get('hash');
        assert.equal(crypto.createHash('sha256').update(data).digest('hex'), hash, 'the hash fits the content');
        t.packages.set(hash, { name: u.searchParams.get('filename') + '.zip', data });
        t.uploads++;
        res.writeHead(200);
        res.end('https://x/Marti/api/sync/metadata/' + hash + '/tool');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return t;
}

// a device on a mock server (sends and receives CoT)
async function device(t) {
  const sock = tls.connect({ host: '127.0.0.1', port: t.cot.address().port, cert: clientCert, key: clientKey, ca: [ca.pem] });
  await new Promise(r => sock.once('secureConnect', r));
  const d = { got: [], send: xml => sock.write(xml), close: () => sock.destroy() };
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', x => { const r = tak.splitEvents(buf + x); buf = r.rest; d.got.push(...r.events); });
  return d;
}

const ev = (uid, type = 'a-f-G-U-C', time = '2026-10-25T10:00:00.000Z', detail = '<contact callsign="X"/>') =>
  `<event version="2.0" uid="${uid}" type="${type}" how="m-g" time="${time}" start="${time}" stale="2030-01-01T00:00:00Z"><point lat="48" lon="14" hae="0" ce="9" le="9"/><detail>${detail}</detail></event>`;

let A, B, fed, devA, devB;
const members = [];

before(async () => {
  const ck = forge.pki.rsa.generateKeyPair(2048), sk = forge.pki.rsa.generateKeyPair(2048), kk = forge.pki.rsa.generateKeyPair(2048);
  const caCert = makeCert('Fed CA', ck.publicKey, null, true);
  caCert.sign(ck.privateKey, forge.md.sha256.create());
  ca = { cert: caCert, pem: forge.pki.certificateToPem(caCert) };
  const sc = makeCert('tak', sk.publicKey, ca, false, true); sc.sign(ck.privateKey, forge.md.sha256.create());
  const cc = makeCert('webtak-fed', kk.publicKey, ca, false, false); cc.sign(ck.privateKey, forge.md.sha256.create());
  serverKey = forge.pki.privateKeyToPem(sk.privateKey); serverCert = forge.pki.certificateToPem(sc);
  clientKey = forge.pki.privateKeyToPem(kk.privateKey); clientCert = forge.pki.certificateToPem(cc);
  A = mockTak('A'); B = mockTak('B');
  for (const t of [A, B]) {
    await new Promise(r => t.cot.listen(0, '127.0.0.1', r));
    await new Promise(r => t.api.listen(0, '127.0.0.1', r));
    members.push({ id: t.name, name: t.name, host: '127.0.0.1', port: t.cot.address().port, apiPort: t.api.address().port,
      certPem: clientCert, keyPem: clientKey, caPems: [ca.pem], cot: true, packages: true });
  }
  devA = await device(A);
  devB = await device(B);
  fed = new Federation({ tak, id: 'f1', members: () => members, intervalMin: () => 60 });
  fed.apply();
  for (let i = 0; i < 50 && fed.state().members.some(m => m.state !== 'connected'); i++) await sleep(100);
});

after(() => {
  fed.stop();
  devA.close(); devB.close();
  for (const t of [A, B]) { t.cot.close(); t.api.close(); }
});

test('live data goes from one server to the other – marked, once, not back', async () => {
  assert.deepEqual(fed.state().members.map(m => m.state), ['connected', 'connected']);
  devA.send(ev('ANDROID-A1'));
  await sleep(300);
  const got = devB.got.filter(x => x.includes('uid="ANDROID-A1"'));
  assert.equal(got.length, 1, 'arrives on B once');
  assert.match(got[0], /<__webtakfed id="f1" from="A"\/><\/detail>/);
  assert.equal(devA.got.filter(x => x.includes('ANDROID-A1')).length, 0, 'not back to A');
  // B -> A (both directions), also chat and deletions
  devB.send(ev('GeoChat.ANDROID-B1.All Chat Rooms.1', 'b-t-f', undefined, '<remarks>hello</remarks>'));
  devB.send(ev('del-1', 't-x-d-d', undefined, '<link uid="M-1" relation="none" type="none"/>'));
  await sleep(300);
  assert.equal(devA.got.filter(x => x.includes('type="b-t-f"')).length, 1);
  assert.equal(devA.got.filter(x => x.includes('type="t-x-d-d"')).length, 1);
});

test('no loops, no duplicates, no server-specific messages', async () => {
  const before = devA.got.length + devB.got.length;
  // already passed through a TAKweb federation (e.g. a second bridge): not passed on again
  devA.send(ev('LOOP-1', undefined, undefined, '<__webtakfed id="other" from="X"/>'));
  // the same event on both servers (e.g. sent by a device to both): passed on only once
  devA.send(ev('DUP-1', undefined, '2026-10-25T11:00:00.000Z'));
  await sleep(150);
  devB.send(ev('DUP-1', undefined, '2026-10-25T11:00:00.000Z'));
  // pings and mission changes stay on their server
  devA.send(ev('PING-1', 't-x-c-t'));
  devA.send(ev('MIS-1', 't-x-m-c'));
  await sleep(300);
  const all = devA.got.concat(devB.got).slice(0);
  assert.equal(all.filter(x => x.includes('LOOP-1')).length, 0);
  assert.equal(devB.got.filter(x => x.includes('DUP-1')).length, 0 + 1, 'B got it once (from A)');
  assert.equal(devA.got.filter(x => x.includes('DUP-1')).length, 0, 'A not again');
  assert.ok(!all.some(x => /PING-1|MIS-1/.test(x)));
  assert.ok(devA.got.length + devB.got.length - before >= 1);
  // a member without live data neither sends nor receives
  members[1].cot = false;
  fed.apply();
  devA.send(ev('OFF-1'));
  await sleep(300);
  assert.equal(devB.got.filter(x => x.includes('OFF-1')).length, 0);
  members[1].cot = true;
  fed.apply();
});

test('data packages: what is missing is copied in both directions, by hash, once', async () => {
  const pkg = n => { const data = crypto.randomBytes(3000 + n); return [crypto.createHash('sha256').update(data).digest('hex'), { name: `Pkg${n}.zip`, data }]; };
  const [h1, p1] = pkg(1), [h2, p2] = pkg(2), [h3, p3] = pkg(3);
  A.packages.set(h1, p1);
  B.packages.set(h2, p2);
  A.packages.set(h3, p3); B.packages.set(h3, { ...p3, name: 'Same content.zip' }); // already on both
  await fed.syncPackages();
  assert.deepEqual([...A.packages.keys()].sort(), [h1, h2, h3].sort());
  assert.deepEqual([...B.packages.keys()].sort(), [h1, h2, h3].sort());
  assert.equal(A.uploads + B.uploads, 2, 'only the missing ones');
  assert.equal(B.packages.get(h1).name, 'Pkg1.zip');
  assert.equal(fed.state().lastSync.copied, 2);
  await fed.syncPackages();
  assert.equal(A.uploads + B.uploads, 2, 'second run: nothing to do');
  const st = fed.state().members;
  assert.equal(st.find(m => m.id === 'A').stats.pkgOut, 1);
  assert.equal(st.find(m => m.id === 'B').stats.pkgIn, 1);
});
