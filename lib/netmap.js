// Network picture for the admin (Network view): how every device reaches the TAK server right now, which devices are
// gateways, and – over time – where internet worked, where only the mesh reached the server and where connections broke.
//
// Ways to the server, read from the CoT that arrives over the server-side TAK connection (lib/hq.js gets the same):
//   internet – the device itself is connected (TAKweb, ATAK, iTAK, WinTAK)
//   lora     – a TAKweb phone with a radio passed it from the mesh on (<__takwebmesh gw="<uid of that phone>"/>)
//   mqtt     – the TAK server made it from Meshtastic MQTT (contact endpoint "MQTT" / takv platform Meshtastic): a radio
//              with internet (HQ gateway) uplinked it. WebTAK Server names that radio (<__mqtt gateway="!…"/>);
//              OpenTAKServer does not, then the nearest gateway radio is assumed.
// Gateways: TAKweb phones that report <__takwebnet bridge="1"/> (radio connected, gateway on) or passed something on,
// and the radios set up as "HQ gateway" in the admin (store.data.meshRadios, matched by their Meshtastic node id).
// Stored: store.data.netmap = { cells: { "<row>:<col>": [internet, mesh, lost, lastTime] } }.

const { parsePli, distance } = require('./tracks');

const CELL = 0.005;            // grid of the coverage map in degrees (≈ 550 m north–south)
const CELLS_MAX = 20000;
const TRAFFIC_MS = 15 * 60000; // traffic counted over the last 15 minutes
const SAME_CELL_MS = 60000;    // a device counts once a minute per cell

const attr = (s, a) => { const m = new RegExp(`\\s${a}="([^"]*)"`).exec(s); return m ? m[1] : ''; };
const tag = (xml, name) => { const m = new RegExp(`<${name}\\b[^>]*>`).exec(xml); return m ? m[0] : ''; };
const unesc = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// Meshtastic node id as 8 hex digits ("!a1b2c3d4", "a1b2c3d4", OTS writes it without zeros in front)
const hexId = s => { const m = /^!?([0-9a-f]{1,8})$/i.exec(String(s || '').trim()); return m ? m[1].toLowerCase().padStart(8, '0') : ''; };
const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

// how a CoT came to the server
function route(xml) {
  const mark = tag(xml, '__takwebmesh');
  const takv = tag(xml, 'takv');
  const contact = tag(xml, 'contact');
  const mqtt = attr(contact, 'endpoint') === 'MQTT' || attr(takv, 'platform') === 'Meshtastic';
  const n = tag(xml, '__takwebnet');
  const mq = tag(xml, '__mqtt');
  return {
    link: mark ? 'lora' : mqtt ? 'mqtt' : 'internet',
    via: mark ? unesc(attr(mark, 'gw')) : '',
    gateway: mq ? hexId(attr(mq, 'gateway')) : '', // radio that passed it to MQTT (WebTAK Server)
    hops: mq && attr(mq, 'hops') !== '' ? Number(attr(mq, 'hops')) : null,
    meshId: hexId(attr(takv, 'meshtastic_id')),
    net: n ? { radio: unesc(attr(n, 'radio')), bridge: attr(n, 'bridge') === '1', node: hexId(attr(n, 'node')) } : null,
  };
}

class Netmap {
  constructor({ data, save, hq, radios }) {
    this.data = data;
    this.save = save;
    this.hq = hq;
    this.radios = radios || (() => ({}));
    this.info = new Map();    // uid -> { link, via, meshId, net, time }
    this.traffic = new Map(); // gateway uid / 'mqtt' -> [times]
    this.seenCell = new Map(); // uid -> { key, t }
    this.wasOnline = new Set();
    this.saveTimer = null;
    const d = this.data();
    d.cells = d.cells || {};
  }

  later() { if (!this.saveTimer) { this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 10000); this.saveTimer.unref?.(); } }

  bump(key, now) {
    const a = this.traffic.get(key) || [];
    a.push(now);
    while (a.length && now - a[0] > TRAFFIC_MS) a.shift();
    this.traffic.set(key, a);
  }

  count(key, now = Date.now()) { return (this.traffic.get(key) || []).filter(t => now - t <= TRAFFIC_MS).length; }

  // one cell of the coverage map: k 0 = internet, 1 = only mesh, 2 = connection lost
  mark(lat, lon, k, now) {
    const cells = this.data().cells;
    const key = cellKey(lat, lon);
    const c = cells[key] || (cells[key] = [0, 0, 0, 0]);
    c[k]++;
    c[3] = now;
    const keys = Object.keys(cells);
    if (keys.length > CELLS_MAX) { // the oldest go
      keys.sort((a, b) => cells[a][3] - cells[b][3]).slice(0, keys.length - CELLS_MAX).forEach(x => delete cells[x]);
    }
    this.later();
  }

  cot(xml, now = Date.now()) {
    const r = route(xml);
    if (r.link === 'lora' && r.via) this.bump(r.via, now);
    if (r.link === 'mqtt') { this.bump('mqtt', now); if (r.gateway) this.bump('gw:' + r.gateway, now); }
    const p = parsePli(xml);
    if (!p) return;
    const prev = this.info.get(p.uid);
    this.info.set(p.uid, { ...r, net: r.net || (prev && r.link === prev.link ? prev.net : null), time: now });
    const key = cellKey(p.lat, p.lon), seen = this.seenCell.get(p.uid);
    if (seen && seen.key === key && now - seen.t < SAME_CELL_MS) return;
    this.seenCell.set(p.uid, { key, t: now });
    this.mark(p.lat, p.lon, r.link === 'internet' ? 0 : 1, now);
  }

  // devices that went offline: "connection lost" at their last position (once per loss)
  sweep(now = Date.now()) {
    for (const d of this.hq.state(Infinity).devices) {
      if (d.online) { this.wasOnline.add(d.uid); continue; }
      if (!this.wasOnline.delete(d.uid)) continue;
      this.mark(d.lat, d.lon, 2, now);
    }
    for (const [uid, x] of this.info) if (now - x.time > 2 * 3600000) { this.info.delete(uid); this.seenCell.delete(uid); }
  }

  clear() { this.data().cells = {}; this.save(); }

  picture(now = Date.now()) {
    const devices = this.hq.state(Infinity).devices;
    const radios = this.radios() || {};
    const byUid = new Map(devices.map(d => [d.uid, d]));
    const nodes = devices.map(d => {
      const i = this.info.get(d.uid) || { link: d.mesh ? 'mqtt' : 'internet', via: '', meshId: '', net: null };
      const id = i.meshId || hexId(d.uid);
      const radio = id ? radios[id] : null;
      const bridged = this.count(d.uid, now);
      const uplinks = id ? this.count('gw:' + id, now) : 0; // this radio passed packets to MQTT (WebTAK Server says so)
      const phoneGw = i.link === 'internet' && ((i.net && i.net.bridge) || bridged > 0);
      const radioGw = (radio && radio.role === 'gateway') || uplinks > 0;
      const kind = !d.online ? 'offline' : radioGw ? 'gateway' : phoneGw ? 'gateway' : i.link === 'internet' ? 'internet' : 'mesh';
      return {
        uid: d.uid, callsign: d.callsign, lat: d.lat, lon: d.lon, time: d.time, online: d.online, platform: d.platform, battery: d.battery,
        kind, link: i.link, via: i.via, gateway: i.gateway || '', hops: i.hops != null ? i.hops : null, radio: i.net ? i.net.radio : '', bridge: !!(i.net && i.net.bridge), meshNode: id || (i.net && i.net.node) || '',
        gatewayType: kind === 'gateway' ? (radioGw ? 'radio' : 'phone') : '',
        registered: radio ? { name: radio.name, ssid: radio.ssid, role: radio.role } : null,
        traffic: kind === 'gateway' ? (radioGw ? (uplinks || null) : bridged) : null,
      };
    });
    const gwRadios = nodes.filter(n => n.gatewayType === 'radio' && n.online);
    const edges = [];
    for (const n of nodes) {
      if (!n.online) continue;
      if (n.link === 'lora' && n.via && byUid.has(n.via)) edges.push({ from: n.uid, to: n.via, kind: 'lora' });
      else if (n.link === 'mqtt' && n.gateway && n.gateway !== n.meshNode) { // named by the server: exact
        const g = nodes.find(x => x.meshNode === n.gateway);
        if (g) edges.push({ from: n.uid, to: g.uid, kind: 'mqtt', hops: n.hops });
      } else if (n.link === 'mqtt' && !n.gateway && n.gatewayType !== 'radio' && gwRadios.length) {
        const g = gwRadios.reduce((a, b) => (distance(n, a) <= distance(n, b) ? a : b));
        edges.push({ from: n.uid, to: g.uid, kind: 'mqtt', assumed: true });
      }
    }
    const cells = Object.entries(this.data().cells).map(([k, c]) => {
      const [row, col] = k.split(':').map(Number);
      return [row * CELL, col * CELL, c[0], c[1], c[2], c[3]];
    });
    const regs = Object.entries(radios).map(([id, r]) => {
      const n = nodes.find(x => x.meshNode === id);
      return { node: id, name: r.name || '', ssid: r.ssid || '', role: r.role || 'field', mqtt: !!r.mqtt, time: r.time || 0, seen: n ? n.time : 0, online: !!(n && n.online), uid: n ? n.uid : '' };
    });
    return { now, cell: CELL, nodes, edges, cells, radios: regs, mqtt: this.count('mqtt', now) };
  }
}

module.exports = { Netmap, route, hexId, cellKey, CELL };
