// TAKweb on a Meshtastic radio: the mesh-only build (lib/meshsite.js) and the installer (public/eud/meshinstall.js)
// against a radio that behaves like the firmware (xmodem.cpp, PhoneAPI file manifest, AdminModule set_config).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const P = require('../public/eud/meshproto');
const { RadioInstaller, SerialLink } = require('../public/eud/meshinstall');
const meshsite = require('../lib/meshsite');

const W = () => new P.Writer();
class FakeRadio {
  constructor({ capacity = 1e9, files = {} } = {}) {
    this.fs = new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
    this.capacity = capacity;
    this.network = W().str(5, 'meshtastic.pool.ntp.org').uint(7, 0).done(); // existing settings that must stay
    this.out = [];
    this.rx = null; // open file while receiving
  }
  used() { let n = 0; for (const v of this.fs.values()) n += v.length; return n; }
  emit(w) { this.out.push(w.done()); }
  ack(c) { this.emit(W().msg(12, W().uint(1, c))); }
  handle(bytes) {
    const f = P.decode(bytes);
    const X = P.XMODEM;
    if (f.has(3)) {
      const nonce = f.get(3)[0].v;
      this.emit(W().msg(3, W().uint(1, 0x1234abcd)));
      this.emit(W().msg(5, W().msg(4, { done: () => this.network })));
      this.emit(W().msg(5, W().msg(6, W().bool(1, true).uint(7, 3).uint(8, 5))));
      for (const [name, v] of this.fs) this.emit(W().msg(15, W().str(1, name).uint(2, v.length)));
      this.emit(W().uint(7, nonce));
    } else if (f.has(5)) {
      const x = P.decode(f.get(5)[0].v);
      const g = n => (x.has(n) ? x.get(n)[0].v : 0);
      const control = g(1), seq = g(2), crc = g(3), buf = x.has(4) ? Buffer.from(x.get(4)[0].v) : Buffer.alloc(0);
      if ((control === X.SOH) && seq === 0 && !this.rx) {
        const name = buf.toString();
        this.fs.delete(name); this.fs.set(name, Buffer.alloc(0)); this.rx = { name, packetno: 1 };
        return this.ack(X.ACK);
      }
      if (control === X.SOH && this.rx) {
        if (seq !== this.rx.packetno || P.crc16(buf) !== crc) return this.ack(X.NAK);
        const room = Math.max(0, this.capacity - this.used());
        this.fs.set(this.rx.name, Buffer.concat([this.fs.get(this.rx.name), buf.subarray(0, room)])); // short write, still ACK (like the firmware)
        this.rx.packetno++;
        return this.ack(X.ACK);
      }
      if (control === X.EOT) { this.rx = null; return this.ack(X.ACK); }
      if (control === X.CAN) { if (this.rx) this.fs.delete(this.rx.name); this.rx = null; return this.ack(X.ACK); }
    } else if (f.has(1)) {
      const pkt = P.decode(f.get(1)[0].v);
      const data = P.decode(pkt.get(4)[0].v);
      if (data.get(1)[0].v !== 6) return;
      const admin = P.decode(data.get(2)[0].v);
      if (admin.has(34)) {
        const c = P.decode(admin.get(34)[0].v);
        if (c.has(4)) this.network = Buffer.from(c.get(4)[0].v);
        if (c.has(6)) this.lora = Buffer.from(c.get(6)[0].v);
      }
      if (admin.has(33)) { const ch = P.decode(admin.get(33)[0].v); (this.channels = this.channels || {})[ch.has(1) ? ch.get(1)[0].v : 0] = ch; }
      if (admin.has(97)) this.rebooted = true;
    }
  }
}
// installer and radio talking (the radio answers right away)
function connect(radio) {
  let inst;
  const send = async b => { radio.handle(b); const out = radio.out.splice(0); for (const o of out) setImmediate(() => inst.feed(P.parseFromRadio(o))); };
  inst = new RadioInstaller({ P, send });
  return inst;
}

test('meshsite: TAKweb for the radio – flat names, gzipped, mesh-only flag, no server parts, fits 1 MB flash', () => {
  const b = meshsite.build('9.9.9');
  const names = b.files.map(f => f.name);
  for (const n of ['index.html', 'eud.js', 'mesh.js', 'meshproto.js', 'leaflet.js', 'milsymbol.js', 'codec2.wasm']) assert.ok(names.includes(n), n);
  assert.ok(!names.some(n => n.includes('/')), 'flat (the firmware upload knows no folders)');
  assert.ok(b.total < 700 * 1024, `fits a 1 MB flash with room for settings: ${b.total}`);
  const idx = zlib.gunzipSync(b.files.find(f => f.name === 'index.html').gz).toString();
  assert.match(idx, /window\.TAKWEB_MESH = true/);
  assert.doesNotMatch(idx, /vendor\/|\?v=|jsQR|view3d|blenative|manifest\.webmanifest/);
  assert.match(idx, /<script src="leaflet\.js"><\/script>/);
  assert.match(idx, /9\.9\.9/);
});

test('installer: removes the old web files, writes TAKweb, checks the sizes, sets the WLAN, restarts', async () => {
  const radio = new FakeRadio({ files: { '/static/index.html.gz': 'old', '/static/assets/x.js.gz': 'x'.repeat(5000), '/prefs/config.proto': 'cfg' } });
  const inst = connect(radio);
  const files = [{ name: 'index.html', gz: Uint8Array.from(Buffer.from('<html>takweb')) }, { name: 'eud.js', gz: Uint8Array.from({ length: 1000 }, (_, i) => i & 255) }];
  const steps = new Set();
  await inst.install({ files, wifi: { ssid: 'TAKweb', psk: '12345678' }, onProgress: p => steps.add(p.step) });
  assert.deepEqual([...radio.fs.keys()].sort(), ['/prefs/config.proto', '/static/eud.js.gz', '/static/index.html.gz']);
  assert.equal(radio.fs.get('/static/index.html.gz').toString(), '<html>takweb');
  assert.deepEqual([...radio.fs.get('/static/eud.js.gz')], [...files[1].gz]);
  assert.equal(radio.fs.get('/prefs/config.proto').toString(), 'cfg', 'settings stay');
  const net = P.decode(radio.network);
  assert.equal(net.get(1)[0].v, 1, 'WLAN on');
  assert.equal(Buffer.from(net.get(3)[0].v).toString(), 'TAKweb');
  assert.equal(Buffer.from(net.get(4)[0].v).toString(), '12345678');
  assert.equal(Buffer.from(net.get(5)[0].v).toString(), 'meshtastic.pool.ntp.org', 'other network settings stay');
  assert.ok(radio.rebooted);
  assert.deepEqual([...steps], ['remove', 'upload', 'check', 'wifi', 'done']);
  const lora = P.decode(radio.lora);
  assert.equal(lora.get(12)[0].v, 1, 'duty-cycle override on: crisis radios always send');
  assert.equal(lora.get(8)[0].v, 5, 'the other LoRa settings stay');
});

test('installer: fixed address for the iPhone hotspot, back to DHCP without one', () => {
  assert.equal(P.ipU32('172.20.10.14'), (172 | 20 << 8 | 10 << 16 | 14 << 24) >>> 0);
  assert.deepEqual(P.staticNet('172.20.10.14'), { ip: '172.20.10.14', gateway: '172.20.10.1', subnet: '255.255.255.240', dns: '172.20.10.1' });
  assert.equal(P.staticNet('192.168.43.50').gateway, '192.168.43.1');
  assert.throws(() => P.staticNet('300.1.1.1'));
  assert.throws(() => P.staticNet('192.168.43.1'));
  const before = W().str(5, 'pool.ntp.org').uint(7, 1).msg(8, W().fixed(1, 99)).done();
  const admin = pkt => P.decode(P.decode(P.decode(P.decode(pkt).get(1)[0].v).get(4)[0].v).get(2)[0].v);
  const net = buf => P.decode(P.decode(admin(buf).get(34)[0].v).get(4)[0].v);
  const fixed = net(P.adminSetWifi(5, before, { ssid: 'TAKweb', psk: '12345678', ip: P.IPHONE_IP }));
  assert.equal(fixed.get(7)[0].v, 1, 'STATIC');
  const v4 = P.decode(fixed.get(8)[0].v);
  assert.equal(Buffer.from(v4.get(1)[0].v).readUInt32LE(0), P.ipU32('172.20.10.14'));
  assert.equal(Buffer.from(v4.get(3)[0].v).readUInt32LE(0), P.ipU32('255.255.255.240'));
  assert.equal(fixed.get(8).length, 1);
  assert.equal(Buffer.from(fixed.get(5)[0].v).toString(), 'pool.ntp.org');
  const dhcp = net(P.adminSetWifi(5, before, { ssid: 'TAKweb', psk: '12345678' }));
  assert.ok(!dhcp.has(7), 'DHCP (0) again');
});

test('installer: a full flash is noticed (the firmware confirms anyway)', async () => {
  const radio = new FakeRadio({ capacity: 600 });
  const inst = connect(radio);
  await assert.rejects(inst.install({ files: [{ name: 'eud.js', gz: new Uint8Array(1000) }], wifi: null }), /flash full/);
  assert.ok(!radio.rebooted);
});

test('serial: frames between log text, split across reads', () => {
  const frames = [], text = [];
  const s = new SerialLink(null, f => frames.push([...f]), t => text.push(t));
  const frame = b => [0x94, 0xc3, 0, b.length, ...b];
  const bytes = Uint8Array.from([...Buffer.from('DEBUG boot\n'), ...frame([1, 2, 3]), ...Buffer.from('log'), ...frame([9])]);
  s.push(bytes.subarray(0, 14)); s.push(bytes.subarray(14));
  assert.deepEqual(frames, [[1, 2, 3], [9]]);
  assert.match(text.join(''), /DEBUG boot/);
});

test('sha256 without crypto.subtle (plain http on the radio\'s own WLAN) matches the real one', () => {
  const c = require('crypto');
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70000]) {
    const b = c.randomBytes(n);
    assert.equal(Buffer.from(P.sha256(b)).toString('hex'), c.createHash('sha256').update(b).digest('hex'));
  }
});

test('LoRa region: read from the config, set with the other LoRa settings kept', () => {
  const lora = W().bool(1, true).uint(2, 0).done(); // use_preset, region unset
  const fr = W().msg(5, W().msg(6, { done: () => lora })).done();
  const m = P.parseFromRadio(fr);
  assert.equal(m.kind, 'config');
  assert.equal(m.region, 0);
  const admin = pkt => P.decode(P.decode(P.decode(P.decode(pkt).get(1)[0].v).get(4)[0].v).get(2)[0].v);
  const set = P.decode(P.decode(admin(P.adminSetRegion(7, m.lora, P.REGIONS.EU_868)).get(34)[0].v).get(6)[0].v);
  assert.equal(set.get(7)[0].v, 3);
  assert.equal(set.get(1)[0].v, 1, 'use_preset stays');
});

test('radio site: world map, server badge and the installing server\'s address', () => {
  const site = require('../lib/meshsite').build('t1', 'https://tak.example/eud/', 'full');
  const names = site.files.map(f => f.name);
  for (const n of ['worldmap.json', 'tak-badge.png', 'index.html']) assert.ok(names.includes(n), n);
  const html = require('zlib').gunzipSync(site.files.find(f => f.name === 'index.html').gz).toString();
  assert.match(html, /window\.TAKWEB_SERVER = "https:\/\/tak\.example\/eud\/"/);
  const world = JSON.parse(require('zlib').gunzipSync(site.files.find(f => f.name === 'worldmap.json').gz));
  assert.ok(world.land1.length > 100 && world.cities.length > 1000);
  const small = require('../lib/meshsite').build('t1', '', 'small');
  assert.ok(small.total < 700 * 1024, 'the small map still fits radios with a 1 MB file system');
});

test('channel link: primary + secondary channels, the rest off, LoRa settings with the radio\'s region', async () => {
  const cs = W().msg(1, W().bytes(2, new Uint8Array(32).fill(7)).str(3, 'TAKNET')).msg(1, W().str(3, 'ops')).msg(2, W().bool(1, true).uint(2, 4)).done();
  const url = 'https://meshtastic.org/e/#' + Buffer.from(cs).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.deepEqual(P.parseChannelUrl(url).names, ['TAKNET', 'ops']);
  assert.throws(() => P.parseChannelUrl('https://example.org/'), /Not a Meshtastic channel link/);
  const radio = new FakeRadio({ files: {} });
  const inst = connect(radio);
  await inst.install({ files: [{ name: 'index.html', gz: Uint8Array.from(Buffer.from('x')) }], wifi: null, channelUrl: url });
  const role = i => (radio.channels[i].has(3) ? radio.channels[i].get(3)[0].v : 0);
  assert.deepEqual([role(0), role(1), role(2), role(7)], [1, 2, 0, 0]);
  assert.equal(Buffer.from(P.decode(radio.channels[0].get(2)[0].v).get(3)[0].v).toString(), 'TAKNET');
  const lora = P.decode(radio.lora);
  assert.equal(lora.get(2)[0].v, 4, 'modem preset from the link');
  assert.equal(lora.get(7)[0].v, 3, 'no region in the link: EU_868 / the radio\'s region');
  assert.equal(lora.get(12)[0].v, 1, 'duty-cycle override on (crisis radios always send)');
});
