// Federation between TAK servers through TAKweb: TAKweb connects to every member server as a TAK client
// (own client certificate per server) and passes data on in all directions –
// - live CoT (positions, markers, drawings, chat, deletions) to every other member,
// - data packages: what one server has and another does not (by SHA-256) is copied over.
// No duplicates and no loops: forwarded CoT carries a marker (<__takwebfed>) and is never passed on again;
// the same event from two servers is forwarded only once; packages are only copied when the hash is missing.
// OpenTAKServer has no federation of its own.

const crypto = require('crypto');

const MARK = '__takwebfed';
const SEEN_MS = 10 * 60 * 1000;
const PKG_MAX = 100 * 1024 * 1024; // larger packages are not copied
const PKG_PER_RUN = 20;
// not forwarded: pings, server-specific messages (mission changes, file transfer requests with server URLs)
const SKIP = /^(t-x-c-t|t-x-m-|b-f-t-r|t-x-takp)/;

const attr = (xml, a) => { const m = new RegExp(`\\s${a}="([^"]*)"`).exec(xml.slice(0, xml.indexOf('>') + 1)); return m ? m[1] : ''; };

class Federation {
  // members() -> [{ id, name, host, altHost, port, apiPort, certPem, keyPem, caPems, fingerprint, cot, packages }]
  constructor({ tak, log, id, members, intervalMin = () => 5 }) {
    this.tak = tak;
    this.log = log || (() => {});
    this.id = id; // this TAKweb installation (loop marker)
    this.members = members;
    this.intervalMin = intervalMin;
    this.links = new Map(); // member id -> { m, link, state, message, stats }
    this.seen = new Map();  // event key -> time
    this.timer = null;
    this.syncing = false;
    this.lastSync = null;
    this.cleanup = setInterval(() => { const t = Date.now() - SEEN_MS; for (const [k, v] of this.seen) if (v < t) this.seen.delete(k); }, 60000);
    this.cleanup.unref && this.cleanup.unref();
  }

  // (re)connect after a configuration change; keeps connections whose settings did not change
  apply() {
    const want = new Map(this.members().filter(m => m.certPem && m.keyPem).map(m => [m.id, m]));
    for (const [id, r] of this.links) {
      const m = want.get(id);
      if (!m || connKey(m) !== connKey(r.m)) { r.link.closed = true; clearTimeout(r.link.timer); if (r.link.sock) r.link.sock.destroy(); this.links.delete(id); }
      else r.m = m; // switches (cot/packages) take effect right away
    }
    for (const [id, m] of want) {
      if (this.links.has(id)) continue;
      const r = { m, state: 'connecting', message: '', stats: { cotIn: 0, cotOut: 0, pkgIn: 0, pkgOut: 0 } };
      r.link = new this.tak.TakLink({
        host: m.host, altHost: m.altHost, port: m.port, proto: 'ssl', certPem: m.certPem, keyPem: m.keyPem, caPems: m.caPems, fingerprint: m.fingerprint,
        uid: 'TAKWEB-FED-' + this.id, hello: 'TAKweb federation',
        onStatus: (state, message) => { if (r.state !== state) this.log(`Federation ${m.name}: ${message || state}`); r.state = state; r.message = message || ''; },
        onCot: xml => this.cot(r, xml),
      });
      this.links.set(id, r);
      r.link.start();
    }
    clearInterval(this.timer);
    const any = [...want.values()].some(m => m.packages);
    if (any) {
      this.timer = setInterval(() => this.syncPackages().catch(e => this.log('Federation packages: ' + e.message)), Math.max(1, this.intervalMin()) * 60000);
      setTimeout(() => this.syncPackages().catch(e => this.log('Federation packages: ' + e.message)), 5000);
    }
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.cleanup);
    for (const r of this.links.values()) { r.link.closed = true; clearTimeout(r.link.timer); if (r.link.sock) r.link.sock.destroy(); }
    this.links.clear();
  }

  // live CoT from one member -> all others
  cot(from, xml) {
    if (!from.m.cot) return;
    const type = attr(xml, 'type');
    if (!type || SKIP.test(type)) return;
    if (xml.includes('<' + MARK)) return; // already passed through a TAKweb federation: no loop
    const uid = attr(xml, 'uid');
    if (uid.startsWith('TAKWEB-')) return; // TAKweb's own server connections (federation, recorder)
    const key = uid + '|' + type + '|' + attr(xml, 'time');
    if (this.seen.has(key)) return; // the same event from another member
    this.seen.set(key, Date.now());
    from.stats.cotIn++;
    const out = mark(xml, this.id, from.m.id);
    for (const r of this.links.values()) {
      if (r === from || !r.m.cot || r.state !== 'connected') continue;
      r.link.send(out);
      r.stats.cotOut++;
    }
  }

  // data packages: copy what a member is missing (by hash)
  async syncPackages() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const ms = [...this.links.values()].filter(r => r.m.packages);
      if (ms.length < 2) return;
      const have = new Map(); // member id -> Set(hash)
      const where = new Map(); // hash -> { r, name }
      for (const r of ms) {
        try {
          const { packages } = await this.tak.marti(r.m, 'packages');
          have.set(r.m.id, new Set(packages.map(p => p.hash.toLowerCase())));
          for (const p of packages) if (!where.has(p.hash.toLowerCase())) where.set(p.hash.toLowerCase(), { r, name: p.name, size: p.size });
          r.pkgError = '';
        } catch (e) { r.pkgError = e.message; }
      }
      let copied = 0;
      for (const [hash, src] of where) {
        if (copied >= PKG_PER_RUN) break;
        const missing = ms.filter(r => have.has(r.m.id) && !have.get(r.m.id).has(hash));
        if (!missing.length || (src.size && src.size > PKG_MAX)) continue;
        let data;
        try {
          data = await this.tak.packageDownload(src.r.m, hash);
        } catch (e) { src.r.pkgError = `${src.name}: ${e.message}`; continue; }
        const real = crypto.createHash('sha256').update(data).digest('hex');
        if (data.length > PKG_MAX) continue;
        for (const r of missing) {
          if (real !== hash && have.get(r.m.id).has(real)) continue; // the server lists another hash than the content: already there
          try {
            await this.tak.packageUpload(r.m, { data, name: src.name, hash: real, creatorUid: 'TAKWEB-FED-' + this.id });
            have.get(r.m.id).add(real);
            r.stats.pkgIn++;
            src.r.stats.pkgOut++;
            copied++;
            this.log(`Federation: package "${src.name}" ${src.r.m.name} -> ${r.m.name}`);
          } catch (e) { r.pkgError = `${src.name}: ${e.message}`; }
        }
      }
      this.lastSync = { time: new Date().toISOString(), copied };
    } finally {
      this.syncing = false;
    }
  }

  state() {
    return {
      lastSync: this.lastSync,
      members: [...this.links.values()].map(r => ({ id: r.m.id, state: r.state, message: r.message, stats: r.stats, pkgError: r.pkgError || '' })),
    };
  }
}

const connKey = m => [m.host, m.altHost, m.port, m.apiPort, m.certPem, m.fingerprint].join('|');

// marker in <detail>: this federation passed the event on (from member …)
function mark(xml, id, from) {
  const tag = `<${MARK} id="${id}" from="${String(from).replace(/[^\w.-]/g, '')}"/>`;
  if (/<detail\s*\/>/.test(xml)) return xml.replace(/<detail\s*\/>/, `<detail>${tag}</detail>`);
  if (xml.includes('</detail>')) return xml.replace(/<\/detail>(?![\s\S]*<\/detail>)/, tag + '</detail>');
  return xml.replace(/<\/event>\s*$/, `<detail>${tag}</detail></event>`);
}

module.exports = { Federation, mark, MARK };
