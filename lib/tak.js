// TAK connection for the EUD: certificate enrollment (like ATAK "enroll") and CoT connection
// to the TAK server (SSL with client certificate, TCP or UDP). The browser cannot do this itself,
// so this server only relays the data – certificates are kept in memory only.

const tls = require('tls');
const net = require('net');
const dgram = require('dgram');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const dns = require('dns');
const forge = require('node-forge');

const ENROLL_PORT = 8446;
const MAX_BUFFER = 1024 * 1024;

// ----------------------------------------------------------------------
// Certificates
// ----------------------------------------------------------------------

function fingerprintOf(pemOrDer) {
  let der = pemOrDer;
  if (typeof pemOrDer === 'string') {
    der = Buffer.from(pemOrDer.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  }
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

function pemBodyToPem(text) {
  text = String(text || '').trim();
  if (!text) return null;
  if (text.includes('BEGIN CERTIFICATE')) return text.endsWith('\n') ? text : text + '\n';
  const body = text.replace(/\s+/g, '');
  return '-----BEGIN CERTIFICATE-----\n' + body.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
}

function certInfo(pem) {
  const c = forge.pki.certificateFromPem(pem);
  const name = attrs => attrs.map(a => `${a.shortName || a.name}=${a.value}`).join(', ');
  return { subject: name(c.subject.attributes), issuer: name(c.issuer.attributes), validTo: c.validity.notAfter.toISOString() };
}

// .p12 (client certificate or truststore) -> PEM
function readP12(base64, password) {
  let p12;
  try {
    const der = forge.util.decode64(base64);
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, password || '');
  } catch (e) {
    throw new Error('Cannot open file – wrong password or not a .p12 file.');
  }
  const keys = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [])
    .filter(b => b.cert).map(b => b.cert);
  const keyPem = keys.length ? forge.pki.privateKeyToPem(keys[0].key) : null;
  let certPem = null;
  const caPems = [];
  for (const c of certs) {
    const pem = forge.pki.certificateToPem(c);
    // certificate matching the key = client certificate, the rest = CA
    if (keys.length && !certPem && c.publicKey.n && keys[0].key.n && c.publicKey.n.equals(keys[0].key.n)) certPem = pem;
    else caPems.push(pem);
  }
  if (keys.length && !certPem) throw new Error('The .p12 file has no certificate for its key.');
  return { kind: keyPem ? 'client' : 'truststore', keyPem, certPem, caPems };
}

// TLS options: check the chain against the CA(s) (without name check, like ATAK), otherwise
// public CAs, otherwise only a fingerprint confirmed by the user.
function trustOptions({ caPems, fingerprint }) {
  const opts = { rejectUnauthorized: false };
  const check = sock => {
    const peer = sock.getPeerCertificate(true);
    if (!peer || !peer.raw) return 'Server sent no certificate.';
    const fp = fingerprintOf(peer.raw);
    if (fingerprint && fp === fingerprint.toUpperCase()) return null;
    if (sock.authorized) return null;
    return { untrusted: true, fingerprint: fp, subject: peer.subject ? Object.entries(peer.subject).map(([k, v]) => `${k}=${v}`).join(', ') : '' };
  };
  if (caPems && caPems.length) opts.ca = caPems;
  opts.checkServerIdentity = () => undefined; // TAK server certificates often do not match the host name
  return { opts, check };
}

// ----------------------------------------------------------------------
// certificate enrollment (TAK Server / OpenTAKServer, port 8446)
// ----------------------------------------------------------------------

// errors where the address itself did not answer (worth trying another address of the same server)
const NET_ERRORS = /^(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET)$/;
const isNetError = e => NET_ERRORS.test(e.code || '') || /^(Timeout|connect timeout)$/.test(e.message);

// Open a TLS connection and check the server certificate BEFORE anything (e.g. the
// password) is sent. Not trusted -> error with fingerprint to confirm.
// altHost: another address of the same server (e.g. internal), tried when host does not answer.
function secureSocket({ altHost, ...o }) {
  return connectSecure(o).catch(e => {
    if (!altHost || altHost === o.host || !e.network) throw e;
    return connectSecure({ ...o, dial: altHost });
  });
}

function connectSecure({ host, dial = host, port, caPems, fingerprint, cert, key, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const { opts, check } = trustOptions({ caPems, fingerprint });
    const sock = tls.connect({ host: dial, port, ...opts, cert, key, servername: net.isIP(host) ? undefined : host });
    const timer = setTimeout(() => sock.destroy(new Error('Timeout')), timeout);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const problem = check(sock);
      if (!problem) return resolve(sock);
      sock.destroy();
      const err = new Error(problem.untrusted ? 'Server certificate is not trusted.' : problem);
      if (problem.untrusted) Object.assign(err, { code: 'UNTRUSTED', fingerprint: problem.fingerprint, subject: problem.subject });
      reject(err);
    });
    sock.once('error', e => {
      clearTimeout(timer);
      if (/certificate required|alert number 116|handshake failure|alert number 40/i.test(e.message)) {
        return reject(new Error(`Port ${port} already requires a client certificate – enrollment usually uses port ${ENROLL_PORT}.`));
      }
      reject(Object.assign(new Error(`${dial}:${port} not reachable: ${e.message}`), { network: isNetError(e) }));
    });
  });
}

// HTTP over an already checked TLS connection
async function httpsRequest({ host, altHost, port, path, method = 'GET', headers = {}, body, caPems, fingerprint, cert, key, timeout = 20000, raw = false, maxBytes = 150 * 1024 * 1024 }) {
  const sock = await secureSocket({ host, altHost, port, caPems, fingerprint, cert, key, timeout });
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method, headers: { Host: host, ...headers }, createConnection: () => sock, timeout }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('Response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        sock.destroy();
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: raw ? buf : buf.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', e => reject(new Error(`${host}:${port}: ${e.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

function parseEnrollResponse(text) {
  text = String(text || '').trim();
  let signed = null;
  const cas = [];
  if (text.startsWith('{')) {
    const data = JSON.parse(text);
    signed = data.signedCert;
    for (const k of Object.keys(data).sort()) if (/^ca/i.test(k) && data[k]) cas.push(data[k]);
  } else {
    const m = text.match(/<signedCert>([\s\S]*?)<\/signedCert>/);
    signed = m && m[1];
    for (const c of text.matchAll(/<(ca\d*)>([\s\S]*?)<\/\1>/g)) cas.push(c[2]);
  }
  if (!signed) throw new Error('Server response contains no signed certificate.');
  const seen = new Set();
  const caPems = [];
  for (const c of cas) {
    const pem = pemBodyToPem(c);
    const fp = fingerprintOf(pem);
    if (!seen.has(fp)) { seen.add(fp); caPems.push(pem); }
  }
  return { certPem: pemBodyToPem(signed), caPems };
}

async function enroll({ host, altHost = '', port = ENROLL_PORT, username, password, uid = 'EUD', caPems = [], fingerprint = '' }) {
  username = String(username || '').trim();
  if (!host || !username || !password) throw new Error('Enter server, user name and password.');
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const call = async (path, extra = {}) => {
    const r = await httpsRequest({ host, altHost, port, path, caPems, fingerprint, ...extra, headers: { Authorization: auth, ...(extra.headers || {}) } });
    if (r.status === 401 || r.status === 403) throw new Error('Server rejected user name/password.');
    return r;
  };

  // additional name parts (O, OU …) – optional
  const subject = [{ shortName: 'CN', value: username }];
  try {
    const cfg = await call('/Marti/api/tls/config');
    if (cfg.status === 200) {
      for (const m of cfg.body.matchAll(/nameEntry[^>]*name="([^"]+)"[^>]*value="([^"]+)"/g)) {
        if (['O', 'OU', 'C', 'ST', 'L'].includes(m[1].toUpperCase())) subject.push({ shortName: m[1].toUpperCase(), value: m[2] });
      }
    }
  } catch (e) {
    if (e.code === 'UNTRUSTED' || /rejected|not reachable|client certificate/i.test(e.message)) throw e;
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject(subject);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const b64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes());
  const body = b64.match(/.{1,64}/g).join('\n') + '\n';
  const query = new URLSearchParams({ clientUid: uid, version: 'TAKweb' }).toString();
  const r = await call(`/Marti/api/tls/signClient/v2?${query}`, {
    method: 'POST', body, headers: { 'Content-Type': 'text/plain', Accept: 'application/json' },
  });
  if (r.status !== 200) throw new Error(`Server answered HTTP ${r.status} to the certificate request.`);
  const { certPem, caPems: newCas } = parseEnrollResponse(r.body);
  return {
    certPem,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    caPems: newCas.length ? newCas : caPems,
    info: certInfo(certPem),
  };
}

// checks user + password at the enrollment port without a new certificate: the old signClient endpoint
// (no CSR). OpenTAKServer only checks the login there (401 or 200) – /tls/config does not check it at all;
// the TAK Server checks the login first and then refuses the empty request (4xx/5xx = login accepted).
async function checkLogin({ host, altHost = '', port = ENROLL_PORT, username, password, caPems = [], fingerprint = '' }) {
  username = String(username || '').trim();
  if (!host || !username || !password) throw new Error('Enter server, user name and password.');
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const r = await httpsRequest({ host, altHost, port, path: '/Marti/api/tls/signClient/', method: 'POST', body: '', caPems, fingerprint,
    headers: { Authorization: auth, 'Content-Type': 'text/plain' } });
  if (r.status === 401 || r.status === 403) throw new Error('Server rejected user name/password.');
  if (r.status === 404) throw new Error('The server has no enrollment here – login could not be checked.');
  return { ok: true };
}

// ----------------------------------------------------------------------
// CoT-Datenstrom
// ----------------------------------------------------------------------

// splits a data stream into complete <event>…</event> documents
function splitEvents(buffer) {
  const events = [];
  for (;;) {
    const start = buffer.indexOf('<event');
    if (start < 0) return { events, rest: buffer.slice(-16) };
    const end = buffer.indexOf('</event>', start);
    if (end < 0) return { events, rest: buffer.length > MAX_BUFFER ? '' : buffer.slice(start) };
    events.push(buffer.slice(start, end + 8));
    buffer = buffer.slice(end + 8);
  }
}

const cotTime = d => d.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');

function pingXml(uid) {
  const now = new Date();
  const stale = new Date(now.getTime() + 20000);
  return `<event version="2.0" uid="${uid}-ping" type="t-x-c-t" how="h-g-i-g-o" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(stale)}">`
    + '<point lat="0.0" lon="0.0" hae="0.0" ce="9999999.0" le="9999999.0"/><detail/></event>';
}

// A server connection that is not a device announces itself once per connection: OpenTAKServer only delivers data to a
// client after it sent an event with <contact> (until then the client gets nothing). Already stale on arrival, so
// ATAK/WinTAK do not show it; TAKweb ignores TAKWEB-* UIDs.
function helloXml(uid, callsign) {
  const now = cotTime(new Date());
  return `<event version="2.0" uid="${uid}" type="a-f-G-E-S" how="h-g-i-g-o" time="${now}" start="${now}" stale="${now}">`
    + '<point lat="0.0" lon="0.0" hae="0.0" ce="9999999.0" le="9999999.0"/>'
    + `<detail><contact callsign="${callsign}"/><takv platform="TAKweb" device="Server" os="" version="1.0"/></detail></event>`;
}

// One connection per EUD; reports via onStatus/onCot. Reconnects when dropped.
// hello: callsign for helloXml() on every (re)connection – for server-side connections (recorder, federation).
// altHost: another address of the same server (e.g. internal), used in turn while host does not answer.
class TakLink {
  constructor({ host, altHost = '', port, proto, certPem, keyPem, caPems, fingerprint, uid, hello = '', onStatus, onCot }) {
    Object.assign(this, { host, altHost: altHost !== host ? altHost : '', port: Number(port), proto: String(proto || 'ssl').toLowerCase(), certPem, keyPem, caPems: caPems || [], fingerprint, uid, hello });
    this.dial = host;
    this.onStatus = onStatus || (() => {});
    this.onCot = onCot || (() => {});
    this.sock = null;
    this.udp = null;
    this.closed = false;
    this.retry = 0;
    this.outbox = [];
    this.connected = false;
  }

  start() {
    if (this.proto === 'udp') return this.startUdp();
    this.open();
  }

  startUdp() {
    this.udp = dgram.createSocket(this.host.includes(':') ? 'udp6' : 'udp4');
    this.udp.on('error', e => this.onStatus('error', 'UDP: ' + e.message));
    this.connected = true;
    this.onStatus('connected', `UDP to ${this.host}:${this.port} (send only – UDP returns no data)`);
    this.flush();
  }

  open() {
    if (this.closed) return;
    this.onStatus('connecting', `Connecting to ${this.host}:${this.port} (${this.proto.toUpperCase()})${this.via()} …`);
    let sock;
    if (this.proto === 'ssl') {
      if (!this.certPem || !this.keyPem) return this.onStatus('error', 'SSL needs a client certificate (request or import one).');
      const { opts, check } = trustOptions({ caPems: this.caPems, fingerprint: this.fingerprint });
      sock = tls.connect({ host: this.dial, port: this.port, cert: this.certPem, key: this.keyPem, ...opts, servername: net.isIP(this.host) ? undefined : this.host });
      sock.once('secureConnect', () => {
        const problem = check(sock);
        if (problem) {
          this.closed = true; // do not retry without confirmation
          sock.destroy();
          return this.onStatus('untrusted', 'Server certificate is not trusted.', problem);
        }
        this.ready(sock);
      });
    } else {
      sock = net.connect({ host: this.dial, port: this.port }, () => this.ready(sock));
    }
    this.sock = sock;
    sock.setTimeout(20000);
    sock.on('timeout', () => sock.destroy(this.connected ? new Error('no data from server') : new Error('connect timeout')));
    sock.on('error', e => {
      // address does not answer: next attempt over the other address of the same server
      if (!this.connected && this.altHost && isNetError(e)) this.dial = this.dial === this.host ? this.altHost : this.host;
      const msg = /certificate (unknown|revoked|expired)|bad certificate|alert number 4[0-9]/i.test(e.message)
        ? 'Server rejected the client certificate (' + e.message + ').' : e.message;
      this.onStatus('error', msg);
    });
    sock.on('close', () => this.lost());
  }

  via() { return this.dial !== this.host ? ` via ${this.dial}` : ''; }

  ready(sock) {
    this.connected = true;
    this.retry = 0;
    sock.setTimeout(90000);
    this.onStatus('connected', `Connected to ${this.host}:${this.port} (${this.proto.toUpperCase()})${this.via()}`);
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      const r = splitEvents(buffer + chunk);
      buffer = r.rest;
      for (const ev of r.events) if (!/type="t-x-c-t/.test(ev)) this.onCot(ev);
    });
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.write(pingXml(this.uid)), 30000);
    if (this.hello) this.write(helloXml(this.uid, this.hello));
    this.flush();
  }

  lost() {
    this.connected = false;
    clearInterval(this.pingTimer);
    if (this.closed) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.onStatus('connecting', `Connection lost – retrying in ${Math.round(delay / 1000)} s`);
    this.timer = setTimeout(() => this.open(), delay);
  }

  write(xml) {
    if (this.proto === 'udp') {
      if (!this.udp) return false;
      this.udp.send(Buffer.from(xml), this.port, this.host);
      return true;
    }
    if (!this.connected || !this.sock) return false;
    this.sock.write(xml);
    return true;
  }

  // send CoT; buffer without a connection (max. 200)
  send(xml) {
    if (!this.write(xml)) {
      this.outbox.push(xml);
      if (this.outbox.length > 200) this.outbox.shift();
    }
  }

  flush() {
    while (this.outbox.length && this.write(this.outbox[0])) this.outbox.shift();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    if (this.sock) this.sock.destroy();
    if (this.udp) this.udp.close();
  }
}

// allowed TAK servers (admin setting): empty = all
// ---------------------------------------------------------------------
// ATAK data package (.zip from the TAK server): .pref with server address + .p12 files
// ---------------------------------------------------------------------

function unzip(buf) {
  // find the central directory (end of the file)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count && n < 200; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || csize > 60 * 1024 * 1024) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + csize);
    if (method === 0) files[name] = data;
    else if (method === 8) files[name] = zlib.inflateRawSync(data);
  }
  return files;
}

function readPref(xml) {
  const out = {};
  const re = /<entry\s+key="([^"]+)"[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = m[2].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return out;
}

function readDataPackage(base64) {
  const files = unzip(Buffer.from(base64, 'base64'));
  const names = Object.keys(files);
  const base = n => n.split('/').pop();
  const prefName = names.find(n => /\.pref$/i.test(n));
  const pref = prefName ? readPref(files[prefName].toString('utf8')) : {};
  const result = { server: null, certPem: null, keyPem: null, caPems: [], enroll: false };
  const connect = pref.connectString0 || '';
  if (connect) {
    const [host, port, proto] = connect.split(':');
    result.server = { host, port: Number(port) || 8089, proto: (proto || 'ssl').toLowerCase(), description: pref.description0 || '' };
  }
  result.enroll = pref.enrollForCertificateWithTrust0 === 'true';
  const p12s = names.filter(n => /\.p12$/i.test(n));
  const find = loc => loc && p12s.find(n => base(n) === base(loc));
  const caFile = find(pref.caLocation0 || pref.caLocation);
  const clientFile = find(pref.certificateLocation0 || pref.certificateLocation);
  const tryRead = (file, passwords) => {
    for (const pw of passwords) {
      try { return readP12(files[file].toString('base64'), pw); } catch (e) { /* next password */ }
    }
    throw new Error(`Cannot open ${base(file)} (password missing or wrong in package).`);
  };
  const caPw = [pref.caPassword0, pref.caPassword, 'atakatak'].filter(x => x != null);
  const clPw = [pref.clientPassword0, pref.clientPassword, 'atakatak'].filter(x => x != null);
  for (const f of p12s) {
    const r = tryRead(f, f === caFile ? caPw : f === clientFile ? clPw : [...clPw, ...caPw]);
    if (r.kind === 'client' && !result.certPem) { result.certPem = r.certPem; result.keyPem = r.keyPem; }
    result.caPems.push(...r.caPems);
  }
  for (const n of names.filter(x => /\.(pem|crt)$/i.test(x))) {
    result.caPems.push(...(files[n].toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map(x => x + '\n'));
  }
  if (!result.server && !result.certPem && !result.caPems.length) throw new Error('Data package contains neither server settings nor certificates.');
  return result;
}

// entries may be written as in the browser: "https://tak.example.com:8443/" -> "tak.example.com"
const listHost = e => e.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/^([^:]+):\d+$/, '$1');

function hostAllowed(allowList, host) {
  const list = String(allowList || '').split(/[\s,;]+/).map(listHost).filter(Boolean);
  return !list.length || list.includes(String(host || '').toLowerCase());
}

// Check the target: if a list is set, only it applies. Without a list all servers are allowed except
// this machine and link-local (e.g. cloud metadata 169.254.169.254) – also after DNS resolution.
function blockedAddress(ip) {
  if (net.isIPv4(ip)) return /^(127\.|0\.|169\.254\.)/.test(ip);
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return blockedAddress(v.slice(7));
  return v === '::1' || v === '::' || /^fe[89ab]/.test(v);
}

// Same check with the reason ('' = allowed). localPorts: TAK ports on which a server on this machine
// (localhost, or the own domain at 127.0.1.1 in /etc/hosts) is allowed – the TAK server next to TAKweb.
async function targetProblem(allowList, host, { port, localPorts = [] } = {}) {
  if (!host || !/^[a-z0-9.:_-]+$/i.test(host)) return `Invalid TAK server address "${host}".`;
  if (String(allowList || '').trim()) {
    return hostAllowed(allowList, host) ? '' : `TAK server ${host} is not allowed on this server: it is missing in the list "Allowed TAK servers" in the admin (empty list = all allowed).`;
  }
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); } catch (e) { return ''; } // the connection then reports the error
  const bad = addrs.find(a => blockedAddress(a.address));
  if (!bad) return '';
  const loopback = addrs.every(a => /^(127\.|::1$|::ffff:127\.)/i.test(a.address));
  if (loopback && localPorts.map(Number).includes(Number(port))) return '';
  return `TAK server ${host} is not allowed on this server: it points to this machine (${bad.address}) and port ${port} is not a TAK port set in the admin (OpenTAKServer ports).`;
}

async function targetAllowed(allowList, host) {
  return !(await targetProblem(allowList, host));
}

// ---------------------------------------------------------------------
// TAK server API (port 8443, client certificate): data packages, missions (Data Sync), videos
// ---------------------------------------------------------------------

const API_PORT = 8443;
const isZip = buf => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// XML text in its real encoding: UTF-16 (BOM, e.g. from Windows tools), the declared one (ISO-8859-1 …), else UTF-8
function xmlText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf[0] === 0x3c && buf[1] === 0x00) return new TextDecoder('utf-16le').decode(buf); // UTF-16 without BOM
  if (buf[0] === 0x00 && buf[1] === 0x3c) return new TextDecoder('utf-16be').decode(buf);
  const enc = (/^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(buf.subarray(0, 200).toString('latin1')) || [])[1];
  if (enc && !/^utf-?8$/i.test(enc)) {
    try { return new TextDecoder(enc).decode(buf).replace(/^\s*<\?xml[^>]*\?>/, ''); } catch (e) { /* unknown encoding: UTF-8 */ }
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

// a KML that only links to data elsewhere (Google My Maps "keep up to date", NetworkLink) shows nothing by itself
function kmlLinkOnly(text, out) {
  if (!/<(\w+:)?NetworkLink[\s>]/.test(text) || /<(\w+:)?(Placemark|GroundOverlay)[\s>]/.test(text)) return;
  const href = (/<(?:\w+:)?href>\s*([^<\s]+)/.exec(text) || [])[1] || '';
  (out.warnings = out.warnings || []).push(`the file only links to ${href.replace(/&amp;/g, '&').slice(0, 80) || 'data elsewhere'} – export it with the data included (Google My Maps: without "Keep data up to date")`);
}

// evaluate a file: CoT messages and map overlays (KML/KMZ, also in .zip packages)
function extractContent(name, buf, out = { cot: [], overlays: [], files: [] }, depth = 0) {
  const lower = String(name || '').toLowerCase();
  if (isZip(buf) && depth < 2) {
    const files = unzip(buf);
    if (lower.endsWith('.kmz') || (!lower.endsWith('.zip') && Object.keys(files).some(n => /\.kml$/i.test(n)) && !Object.keys(files).some(n => /manifest\.xml$/i.test(n)))) {
      // main KML (doc.kml or the top one), take all further KML too (super overlays: detail levels)
      const kmls = Object.keys(files).filter(n => /\.kml$/i.test(n)).sort((x, y) => x.split('/').length - y.split('/').length || (/doc\.kml$/i.test(y) ? 1 : 0) - (/doc\.kml$/i.test(x) ? 1 : 0));
      const kmlName = kmls[0];
      if (kmlName) {
        const extra = {};
        for (const n of kmls.slice(1, 2000)) extra[n] = xmlText(files[n]);
        const images = {};
        for (const [n, data] of Object.entries(files)) {
          const ext = n.split('.').pop().toLowerCase();
          // large map images: reduced by lib/raster.js (overview + detail pieces) before they go to the app
          if (IMG_TYPES[ext]) images[n] = data.length > 1024 * 1024 ? { raw: data } : `data:${IMG_TYPES[ext]};base64,${data.toString('base64')}`;
        }
        const kml = xmlText(files[kmlName]);
        if (!kmls.slice(1).length) kmlLinkOnly(kml, out);
        out.overlays.push({ name: String(name).split('/').pop().replace(/\.kmz$/i, ''), kml, path: kmlName, extra, images });
      }
      return out;
    }
    for (const [n, data] of Object.entries(files)) {
      if (/(^|\/)manifest\.xml$|\.pref$|\.p12$/i.test(n)) continue;
      out.files.push(n.split('/').pop());
      extractContent(n, data, out, depth + 1);
    }
    return out;
  }
  if (lower.endsWith('.kml')) {
    const kml = xmlText(buf);
    kmlLinkOnly(kml, out);
    out.overlays.push({ name: String(name).split('/').pop().replace(/\.kml$/i, ''), kml, images: {} });
  } else if (/\.(cot|xml)$/i.test(lower) || buf.slice(0, 200).toString('utf8').includes('<event')) {
    const text = buf.toString('utf8');
    if (text.includes('<event')) out.cot.push(...splitEvents(text).events);
  }
  return out;
}

function parseVideoFeeds(text) {
  const feeds = [];
  const tag = (block, t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(block); return m ? m[1].trim() : ''; };
  const re = /<feed>([\s\S]*?)<\/feed>/g;
  let m;
  while ((m = re.exec(text))) {
    const b = m[1];
    let url = tag(b, 'url');
    if (!url) {
      const proto = tag(b, 'protocol') || 'rtsp';
      const addr = tag(b, 'address');
      const port = tag(b, 'port');
      const p = tag(b, 'path');
      if (addr) url = `${proto}://${addr}${port && port !== '-1' ? ':' + port : ''}${p && !p.startsWith('/') ? '/' : ''}${p}`;
    }
    if (url) feeds.push({ alias: tag(b, 'alias') || url, url });
  }
  // newer servers: JSON
  if (!feeds.length && text.trim().startsWith('{')) {
    try {
      const j = JSON.parse(text);
      for (const c of j.videoConnections || []) for (const f of c.feeds || [c]) if (f.url) feeds.push({ alias: f.alias || c.alias || f.url, url: f.url });
    } catch (e) { /* not JSON */ }
  }
  return feeds;
}

// ATAK map source (customMapSource XML, e.g. maps/*.xml in a device profile) -> { name, url, minZoom, maxZoom }
// {$z}/{$x}/{$y} like ATAK; {$serverpart} -> the first server part; quadkey ({$q}) sources are not supported
function readMapSource(xml) {
  const tag = t => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i').exec(xml); return m ? m[1].trim().replace(/&amp;/g, '&') : ''; };
  if (!/<customMapSource/i.test(xml)) return null;
  let url = tag('url');
  if (!/^https?:\/\//i.test(url) || /\{\$q\}/i.test(url)) return null;
  url = url.replace(/\{\$serverpart\}/gi, (tag('serverParts').split(/\s+/)[0] || ''))
    .replace(/\{\$z\}/gi, '{z}').replace(/\{\$x\}/gi, '{x}').replace(/\{\$y\}/gi, '{y}');
  if (!/\{z\}/.test(url) || !/\{x\}/.test(url) || !/\{y\}/.test(url) || /\{\$/.test(url)) return null;
  const maxZoom = Math.min(22, Math.max(1, Number(tag('maxZoom')) || 19));
  return { name: tag('name').slice(0, 60) || new URL(url.replace(/\{\w\}/g, '0')).hostname, url, minZoom: Number(tag('minZoom')) || 0, maxZoom };
}

// device profile from the TAK server (ZIP like a data package): settings, map sources, data packages
function readProfile(buf) {
  const out = { cot: [], overlays: [], files: [], errors: [], maps: [], prefs: {} };
  if (!isZip(buf)) return out;
  const files = unzip(buf);
  for (const [n, data] of Object.entries(files)) {
    if (/\.pref$/i.test(n)) Object.assign(out.prefs, readPref(data.toString('utf8')));
    else if (/\.xml$/i.test(n) && !/manifest\.xml$/i.test(n)) {
      const m = readMapSource(xmlText(data));
      if (m) out.maps.push(m);
    } else if (isZip(data)) {
      try { extractContent(n, data, out); } catch (e) { out.errors.push(`${n.split('/').pop()}: ${e.message}`); }
    } else if (/\.(kml|kmz|cot)$/i.test(n)) {
      extractContent(n, data, out);
    }
  }
  // only the settings TAKweb uses (callsign, team, role); the rest (update server, channels …) is ATAK's
  const p = out.prefs;
  out.prefs = { callsign: p.locationCallsign || '', team: p.locationTeam || '', role: p.atakRoleType || '' };
  return out;
}

// data packages between TAK servers (federation): download the raw ZIP / upload it like ATAK does
// (multipart "assetfile" to /Marti/sync/missionupload with its SHA-256 – the server keeps it under that hash)
const apiConn = conn => ({ host: conn.host, altHost: conn.altHost || '', port: Number(conn.apiPort) || API_PORT, caPems: conn.caPems || [], fingerprint: conn.fingerprint || '', cert: conn.certPem, key: conn.keyPem });
async function packageDownload(conn, hash) {
  if (!/^[a-f0-9]{16,128}$/i.test(String(hash || ''))) throw new Error('Invalid id.');
  const r = await httpsRequest({ ...apiConn(conn), path: '/Marti/sync/content?hash=' + encodeURIComponent(hash), raw: true, timeout: 120000 });
  if (r.status !== 200) throw new Error('Download answered ' + r.status);
  return r.body;
}
async function packageUpload(conn, { data, name, hash, creatorUid = '' }) {
  const boundary = '----takweb' + crypto.randomBytes(8).toString('hex');
  const file = String(name || 'package.zip').replace(/["\r\n]/g, '_');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="assetfile"; filename="${file}"\r\nContent-Type: application/x-zip-compressed\r\n\r\n`),
    data, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const q = new URLSearchParams({ hash, filename: file.replace(/\.zip$/i, ''), creatorUid }).toString();
  const r = await httpsRequest({ ...apiConn(conn), path: '/Marti/sync/missionupload?' + q, method: 'POST', body, timeout: 120000,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } });
  if (r.status !== 200) throw new Error('Upload answered ' + r.status + (r.body ? ': ' + String(r.body).slice(0, 120) : ''));
}

// a request to the TAK server API on behalf of the EUD
async function marti(conn, action, args = {}) {
  const base = { host: conn.host, altHost: conn.altHost || '', port: Number(conn.apiPort) || API_PORT, caPems: conn.caPems || [], fingerprint: conn.fingerprint || '', cert: conn.certPem, key: conn.keyPem };
  if (!base.cert || !base.key) throw new Error('TAK server data needs a client certificate.');
  const get = async (path, raw) => {
    const r = await httpsRequest({ ...base, path, raw, headers: { Accept: '*/*' }, timeout: 30000 });
    if (r.status === 401 || r.status === 403) throw new Error('TAK server denied access (certificate/permissions).');
    if (r.status === 404) throw new Error('Not available on this TAK server (' + path.split('?')[0] + ').');
    if (r.status >= 400) throw new Error('TAK server answered with error ' + r.status + '.');
    return r.body;
  };
  const json = async path => { const t = await get(path); try { return JSON.parse(t); } catch (e) { throw new Error('Unexpected response from TAK server.'); } };
  const hashOk = h => /^[a-f0-9]{16,128}$/i.test(String(h || ''));
  const mname = n => encodeURIComponent(String(n || '').slice(0, 200));
  const list = r => (Array.isArray(r) ? r : r.data || r.missions || r.results || []);

  if (action === 'packages') {
    let r = await json('/Marti/sync/search?keywords=missionpackage');
    if (!list(r).length) r = await json('/Marti/sync/search'); // some servers do not tag packages
    const pkgs = list(r).filter(x => /zip/i.test(x.MIMEType || x.mimeType || '') || /\.zip$/i.test(x.Name || x.name || '')).map(x => ({
      hash: x.Hash || x.hash, name: x.Name || x.name || x.filename, size: x.Size || x.size || 0,
      user: x.SubmissionUser || x.submissionUser || x.CreatorUid || '', time: x.SubmissionDateTime || x.submissionDateTime || '',
    })).filter(x => hashOk(x.hash));
    return { packages: pkgs.sort((a, b) => String(b.time).localeCompare(String(a.time))) };
  }
  if (action === 'package' || action === 'file') {
    if (!hashOk(args.hash)) throw new Error('Invalid id.');
    const buf = await get('/Marti/sync/content?hash=' + encodeURIComponent(args.hash), true);
    return extractContent(String(args.name || 'package.zip'), buf);
  }
  if (action === 'profile') {
    // device profile like ATAK: once after enrolling, and on every connection only what is new since the last sync
    const uid = encodeURIComponent(String(args.uid || '').slice(0, 100));
    const secago = Math.floor(Number(args.secago));
    const path = args.kind === 'enrollment' ? `/Marti/api/tls/profile/enrollment?clientUid=${uid}`
      : `/Marti/api/device/profile/connection?syncSecago=${Number.isFinite(secago) && secago > 0 ? secago : -1}&clientUid=${uid}`;
    const r = await httpsRequest({ ...base, path, raw: true, headers: { Accept: '*/*' }, timeout: 60000 });
    if (r.status === 204 || r.status === 404 || !r.body || !r.body.length) return { empty: true, unsupported: r.status === 404 };
    if (r.status >= 400) throw new Error('TAK server answered with error ' + r.status + '.');
    return readProfile(r.body);
  }
  if (action === 'videos') {
    return { feeds: parseVideoFeeds(await get('/Marti/api/video')) };
  }
  if (action === 'missions') {
    // Like ATAK: also query password-protected/role-based missions. OpenTAKServer only returns missions
    // whose "tool" matches exactly – without tool=public all Data Sync missions created in ATAK are missing.
    // So both queries are merged (the official TAK Server returns the same for both).
    const queries = ['/Marti/api/missions?passwordProtected=true&defaultRole=true&tool=public',
      '/Marti/api/missions?passwordProtected=true&defaultRole=true', '/Marti/api/missions'];
    const byName = new Map();
    let lastErr = null, okCount = 0;
    for (const q of queries) {
      try {
        for (const m of list(await json(q))) if (m && m.name && !byName.has(m.name)) byName.set(m.name, m);
        okCount++;
        if (okCount === 2) break; // the third query only as a fallback for very old servers
      } catch (e) { lastErr = e; }
    }
    if (!okCount && lastErr) throw lastErr;
    return {
      missions: [...byName.values()].map(m => ({
        name: m.name, description: m.description || '', creator: m.creatorUid || '', tool: m.tool || '',
        files: (m.contents || []).length, items: (m.uids || []).length, password: !!m.passwordProtected,
        groups: (m.groups || []).map(g => (typeof g === 'string' ? g : g.name)).filter(Boolean),
      })).filter(m => m.tool !== 'vbm').sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  if (action === 'mission') {
    const name = mname(args.name);
    const uid = encodeURIComponent(String(args.uid || 'EUD').slice(0, 64));
    const pw = args.password ? '&password=' + encodeURIComponent(String(args.password)) : '';
    // subscribe: the TAK server then sends changes over the running connection; the answer may contain a token
    let token = '';
    const warnings = [];
    try {
      const sub = await httpsRequest({ ...base, method: 'PUT', path: `/Marti/api/missions/${name}/subscription?uid=${uid}${pw}`, headers: { 'Content-Length': 0, Accept: 'application/json' } });
      let j = {};
      try { j = JSON.parse(sub.body); } catch (e) { /* not JSON */ }
      const err = String(j.error || j.message || '');
      if (sub.status === 401 || /password/i.test(err)) {
        throw Object.assign(new Error(args.password ? 'Wrong mission password.' : 'Mission is password protected.'), { code: 'PASSWORD' });
      }
      if (sub.status === 403) throw Object.assign(new Error('No access to this mission (not in the same group).'), { code: 'PASSWORD' });
      if (sub.status >= 400) {
        // e.g. OpenTAKServer "Invalid UID": the device has not been connected to the server yet – content still works
        warnings.push(/uid/i.test(err)
          ? 'Not subscribed yet: connect this device to the server first, then sync again to get live updates.'
          : `Subscription failed (${sub.status}${err ? ': ' + err : ''}) – content loaded, but no live updates.`);
      }
      token = (j.data && j.data.token) || j.token || '';
    } catch (e) { if (e.code === 'PASSWORD') throw e; warnings.push('Subscription failed: ' + e.message); }
    const auth = token ? { Authorization: 'Bearer ' + token } : {};
    const getA = async (path, raw) => {
      const r = await httpsRequest({ ...base, path, raw, headers: { Accept: '*/*', ...auth }, timeout: 30000 });
      if (r.status >= 400) throw new Error('TAK server answered with error ' + r.status + ' (' + path.split('?')[0] + ').');
      return r.body;
    };
    const out = { cot: [], overlays: [], files: [], errors: [], warnings, subscribed: !!token };
    try { out.cot = splitEvents(await getA(`/Marti/api/missions/${name}/cot`)).events; } catch (e) { out.errors.push(e.message); }
    let m = {};
    try { m = list(JSON.parse(await getA(`/Marti/api/missions/${name}?changes=false&logs=false${pw}`)))[0] || {}; } catch (e) { out.errors.push(e.message); }
    // mission points for which the server returns no CoT (only metadata in "uids"): build simple markers from them
    const have = new Set(out.cot.map(x => (/\buid="([^"]+)"/.exec(x) || [])[1]));
    for (const u of m.uids || []) {
      const d = u.details || {};
      const loc = d.location || {};
      const uidv = typeof u.data === 'string' ? u.data : u.uid;
      if (!uidv || have.has(uidv) || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lon)) || (+loc.lat === 0 && +loc.lon === 0)) continue;
      const t = new Date().toISOString();
      const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
      out.cot.push(`<event version="2.0" uid="${esc(uidv)}" type="${esc(d.type || 'a-u-G')}" how="h-g-i-g-o" time="${t}" start="${t}" stale="${new Date(Date.now() + 365 * 864e5).toISOString()}">`
        + `<point lat="${+loc.lat}" lon="${+loc.lon}" hae="9999999" ce="9999999" le="9999999"/><detail><contact callsign="${esc(d.callsign || uidv)}"/></detail></event>`);
    }
    for (const c of (m.contents || []).slice(0, 30)) {
      const d = c.data || c;
      const fname = d.name || d.filename || '';
      out.files.push(fname);
      if (!hashOk(d.hash) || !/\.(kml|kmz|zip|cot|xml)$/i.test(fname) || (d.size && d.size > 150 * 1024 * 1024)) continue;
      try { extractContent(fname, await getA('/Marti/sync/content?hash=' + encodeURIComponent(d.hash), true), out); } catch (e) { out.errors.push(fname + ': ' + e.message); }
    }
    if (!out.cot.length && !out.overlays.length && out.errors.length) throw new Error(out.errors[0]);
    return out;
  }
  if (action === 'unsubscribe') {
    const r = await httpsRequest({ ...base, method: 'DELETE', path: `/Marti/api/missions/${mname(args.name)}/subscription?uid=${encodeURIComponent(String(args.uid || ''))}` });
    return { ok: r.status < 400 };
  }
  throw new Error('Unknown action.');
}

module.exports = { helloXml, targetProblem, readProfile, readMapSource, packageDownload, packageUpload, pingXml, marti, extractContent, parseVideoFeeds, unzip, API_PORT, targetAllowed, enroll, checkLogin, readP12, readDataPackage, TakLink, splitEvents, fingerprintOf, certInfo, parseEnrollResponse, hostAllowed, ENROLL_PORT };
