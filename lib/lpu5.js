// LPU5 field devices (Raspberry Pi + Meshtastic + RTL-SDR, github.com/fredy060795/LPU5-Pi-Meshradio-IOT):
// TAKweb talks to them over MQTT inside their WireGuard VPN. Every device that comes online appears here; the admin
// decides per device (or with defaults for new ones) what it does – the one BLE link for the Meshtastic radio or the
// helmet camera, mesh <-> TAK gateway, SDR (rtl_tcp / ADS-B), hotspot, open Wi-Fi – and manages its Meshtastic radio.
//
//   lpu5/<node>/status        retained, from the device (uplink, VPN, mesh, GPS, profile it runs)
//   lpu5/<node>/profile       retained, from TAKweb (what the admin chose)
//   lpu5/<node>/cmd           TAKweb -> device: {id, cmd} (text command) or {id, op, args} (Meshtastic management)
//   lpu5/<node>/cmd/result    device -> TAKweb
//   lpu5/<node>/mesh/rx|tx    raw Meshtastic packets for the gateway (lib/meshgw.js)
//   lpu5/<node>/mesh/nodes    node list of the radio
//   lpu5/<node>/adsb          aircraft from the SDR
//   lpu5/<node>/bodycam       helmet camera state
//
// Stored: store.data.lpu5 = { enabled, url, username, password, autoAdopt, defaults, gateway: {...}, team, nodes: { name: {...} } }

const crypto = require('crypto');

const BLE = ['mesh', 'bodycam', 'off'];
const GATEWAY = ['off', 'rx', 'rxtx'];
const SDR = ['off', 'rtl_tcp', 'adsb'];
const HOTSPOT = ['auto', 'on', 'off'];
const FRAMESIZES = [1, 5, 8, 11];
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const REQUEST_MS = 60000;
const OFFLINE_MS = 3 * 60000;

const DEFAULT_PROFILE = { ble: 'mesh', gateway: 'rxtx', sdr: 'off', hotspot: 'auto', open_wifi: true, position_interval: 0, bodycam: { address: '', url: '', framesize: 5 } };
const DEFAULT_GATEWAY = { channel: 0, nodesToTak: false, adsbToTak: true, textsToLog: true, adsbMaxKm: 150 };

const pick = (v, list, d) => (list.includes(v) ? v : d);
const clean = (s, n = 60) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>"&]/g, ' ').trim().slice(0, n);

// same rules as lpu5/profile.py on the device
function normProfile(p = {}) {
  const cam = p.bodycam && typeof p.bodycam === 'object' ? p.bodycam : {};
  const fs = Number(cam.framesize);
  const pos = Math.floor(Number(p.position_interval));
  return {
    ble: pick(p.ble, BLE, DEFAULT_PROFILE.ble),
    gateway: pick(p.gateway, GATEWAY, DEFAULT_PROFILE.gateway),
    sdr: pick(p.sdr, SDR, DEFAULT_PROFILE.sdr),
    hotspot: pick(p.hotspot, HOTSPOT, DEFAULT_PROFILE.hotspot),
    open_wifi: p.open_wifi === undefined ? true : !!p.open_wifi,
    position_interval: Number.isFinite(pos) ? Math.max(0, Math.min(86400, pos)) : 0,
    bodycam: {
      address: clean(cam.address, 40),
      url: /^wss?:\/\//.test(String(cam.url || '')) ? String(cam.url) : '',
      framesize: FRAMESIZES.includes(fs) ? fs : 5,
    },
  };
}

function normGateway(g = {}) {
  const ch = Math.floor(Number(g.channel));
  const km = Number(g.adsbMaxKm);
  return {
    channel: ch >= 0 && ch <= 7 ? ch : 0,
    nodesToTak: !!g.nodesToTak,
    adsbToTak: g.adsbToTak === undefined ? DEFAULT_GATEWAY.adsbToTak : !!g.adsbToTak,
    textsToLog: g.textsToLog === undefined ? DEFAULT_GATEWAY.textsToLog : !!g.textsToLog,
    adsbMaxKm: Number.isFinite(km) && km > 0 ? Math.min(1000, km) : DEFAULT_GATEWAY.adsbMaxKm,
  };
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cotTime = d => d.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');

// the device itself as a contact in TAK (role RTO = radio operator), at its GPS or its radio's position
function nodeCot({ name, label, team, st, pos }, now = new Date()) {
  const remarks = [
    `LPU5 ${name}`,
    st.uplink ? `uplink ${st.uplink}` : 'no uplink',
    st.vpn_handshake_age != null && st.vpn_handshake_age < 180 ? 'VPN ok' : 'VPN –',
    st.mesh ? 'mesh ok' : 'mesh –',
    st.sdr ? 'SDR on' : '',
    st.cpu_temp != null ? `${st.cpu_temp} °C` : '',
  ].filter(Boolean).join(' · ');
  return `<event version="2.0" uid="LPU5-${esc(name)}" type="a-f-G-U-C" how="m-g" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + OFFLINE_MS))}">`
    + `<point lat="${pos.lat}" lon="${pos.lon}" hae="${pos.alt == null ? 9999999 : Math.round(pos.alt)}" ce="${pos.ce || 9999999}" le="9999999"/>`
    + `<detail><contact callsign="${esc(label || name)}"/><__group name="${esc(team || 'Cyan')}" role="RTO"/>`
    + (pos.track != null ? `<track course="${pos.track}" speed="${pos.speed || 0}"/>` : '')
    + `<takv platform="LPU5" device="Raspberry Pi" os="Linux" version="${esc(st.version || '')}"/><remarks>${esc(remarks)}</remarks><__lpu5/></detail></event>`;
}

// aircraft from ADS-B as neutral air contacts (helicopter for category A7)
function aircraftCot(a, via, now = new Date()) {
  const type = a.category === 'A7' ? 'a-n-A-C-H' : 'a-n-A-C-F';
  const hae = a.alt_ft == null ? 9999999 : Math.round(a.alt_ft * 0.3048);
  const call = a.flight || a.hex.toUpperCase();
  const remarks = `ADS-B ${a.hex.toUpperCase()}${a.flight ? ' ' + a.flight : ''}${a.alt_ft != null ? ` · ${a.alt_ft} ft` : ''}${a.squawk ? ' · squawk ' + a.squawk : ''} · via ${via}`;
  return `<event version="2.0" uid="ICAO-${esc(a.hex)}" type="${type}" how="m-g" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 60000))}">`
    + `<point lat="${a.lat}" lon="${a.lon}" hae="${hae}" ce="50" le="50"/><detail><contact callsign="${esc(call)}"/>`
    + (a.track != null ? `<track course="${a.track}" speed="${a.speed_kt != null ? (a.speed_kt * 0.514444).toFixed(1) : 0}"/>` : '')
    + `<remarks>${esc(remarks)}</remarks><__adsb/></detail></event>`;
}

const km = (a, b) => {
  const r = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

class Lpu5 {
  // data(): the stored settings; save(); log(); cot(xml): CoT to the TAK server + HQ; gateway: MeshGateway;
  // bodycam(name): makes sure a TAKweb stream exists for the device and returns its publish address (wss://…)
  constructor({ data, save, log, cot, gateway, bodycam, hqLog, connect }) {
    this.data = data;
    this.save = save;
    this.log = log || (() => {});
    this.cot = cot || (() => {});
    this.gw = gateway || null;
    this.bodycamUrl = bodycam || (() => '');
    this.hqLog = hqLog || (() => {});
    this.connectMqtt = connect || ((url, opts) => require('mqtt').connect(url, opts));
    this.client = null;
    this.conn = { state: 'off', message: '' };
    this.live = new Map();     // name -> { status, seen, nodes, bodycam, adsb }
    this.pending = new Map();  // request id -> { resolve, reject, timer }
    this.planeSent = new Map();
    const d = this.d();
    d.nodes = d.nodes || {};
    d.defaults = normProfile(d.defaults || {});
    d.gateway = normGateway(d.gateway || {});
    if (d.autoAdopt === undefined) d.autoAdopt = true;
    this.sweepTimer = setInterval(() => this.sweep(), 60000);
    this.sweepTimer.unref?.();
  }

  d() { return this.data(); }
  configured() { const d = this.d(); return !!(d.enabled && d.url); }

  // ---------------- connection ----------------

  apply() {
    const d = this.d();
    if (this.client) { try { this.client.end(true); } catch (e) { /* closed */ } this.client = null; }
    if (!this.configured()) { this.conn = { state: 'off', message: d.enabled ? 'Enter the MQTT address of the LPU5 VPN.' : '' }; return; }
    this.conn = { state: 'connecting', message: `Connecting to ${d.url} …` };
    const c = this.connectMqtt(d.url, {
      username: d.username || undefined, password: d.password || undefined,
      clientId: 'takweb-' + crypto.randomBytes(4).toString('hex'), reconnectPeriod: 5000, connectTimeout: 15000, clean: true,
    });
    this.client = c;
    c.on('connect', () => {
      if (this.client !== c) return;
      this.conn = { state: 'connected', message: `Connected to ${d.url}` };
      this.log('LPU5: MQTT connected', d.url);
      c.subscribe(['lpu5/+/status', 'lpu5/+/cmd/result', 'lpu5/+/mesh/rx', 'lpu5/+/mesh/nodes', 'lpu5/+/mesh/text', 'lpu5/+/adsb', 'lpu5/+/bodycam'], { qos: 1 });
      for (const name of Object.keys(this.d().nodes)) this.publishProfile(name); // what the admin chose, also after a broker restart
    });
    c.on('reconnect', () => { if (this.client === c) this.conn = { state: 'connecting', message: 'Connection lost – retrying …' }; });
    c.on('error', e => { if (this.client === c) this.conn = { state: 'error', message: e.message }; });
    c.on('message', (topic, buf) => { try { this.message(topic, buf); } catch (e) { this.log('LPU5: ' + topic + ': ' + e.message); } });
  }

  stop() {
    clearInterval(this.sweepTimer);
    if (this.client) try { this.client.end(true); } catch (e) { /* closed */ }
    this.client = null;
  }

  publish(topic, obj, opts = {}) {
    if (!this.client || this.conn.state !== 'connected') return false;
    this.client.publish(topic, typeof obj === 'string' ? obj : JSON.stringify(obj), { qos: 1, ...opts });
    return true;
  }

  // ---------------- messages from the devices ----------------

  message(topic, buf) {
    const m = /^lpu5\/([a-z0-9][a-z0-9-]{0,30})\/(.+)$/.exec(topic);
    if (!m) return;
    const [, name, sub] = m;
    let msg;
    try { msg = JSON.parse(buf.toString('utf8') || 'null'); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const l = this.liveOf(name);
    if (sub === 'status') return this.status(name, msg);
    if (sub === 'cmd/result') {
      const p = msg.id && this.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg); }
      return;
    }
    if (sub === 'mesh/rx') { l.rx = (l.rx || 0) + 1; if (this.gw) this.gw.rx(name, msg); return; }
    if (sub === 'mesh/nodes') { l.meshNodes = Array.isArray(msg.nodes) ? msg.nodes : []; if (this.gw) this.gw.nodes(name, msg); return; }
    if (sub === 'mesh/text') {
      // plain Meshtastic text heard by a device (not TAK): into the HQ situation log if wanted
      if (this.d().gateway.textsToLog && msg.text && this.gw && !this.gw.heardRecently('text|' + msg.from + '|' + msg.text)) {
        this.hqLog({ from: `${msg.name || msg.from} (mesh)`, kind: 'Report', text: String(msg.text).slice(0, 500), auto: true });
      }
      return;
    }
    if (sub === 'bodycam') { l.bodycam = msg; return; }
    if (sub === 'adsb') return this.adsb(name, msg);
  }

  liveOf(name) {
    let l = this.live.get(name);
    if (!l) { l = { status: null, seen: 0 }; this.live.set(name, l); }
    return l;
  }

  status(name, st) {
    const l = this.liveOf(name);
    const was = l.status && l.status.online;
    l.status = st;
    l.seen = Date.now();
    const d = this.d();
    let n = d.nodes[name];
    if (!n && st.online) {
      // a new device: with "automatically" it gets the defaults right away, otherwise it waits for the admin
      n = d.nodes[name] = { label: '', team: '', profile: normProfile(d.defaults), adopted: !!d.autoAdopt, created: Date.now() };
      this.save();
      this.log('LPU5: new device', name, n.adopted ? '(defaults applied)' : '(waiting for approval)');
      this.hqLog({ from: name, kind: 'Other', text: `New LPU5 device ${name} online${n.adopted ? '' : ' – waiting for approval in the admin'}`, auto: true });
      if (n.adopted) this.publishProfile(name);
    }
    if (n && st.online && !was) n.lastOnline = Date.now();
    if (this.gw && st.mesh_num) this.gw.radio(name, st.mesh_num, st.mesh && st.profile && st.profile.gateway);
    if (st.online && n && n.adopted) this.sendNodeCot(name);
  }

  position(name) {
    const l = this.live.get(name);
    const st = l && l.status;
    if (!st) return null;
    const g = st.gps;
    if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) return { lat: g.lat, lon: g.lon, alt: g.alt, track: g.track, speed: g.speed, ce: 10 };
    // no GPS on the Pi: position of its own Meshtastic radio
    const me = (l.meshNodes || []).find(x => x.num === st.mesh_num);
    if (me && Number.isFinite(me.lat) && Number.isFinite(me.lon)) return { lat: me.lat, lon: me.lon, alt: me.alt, ce: 30 };
    return null;
  }

  sendNodeCot(name) {
    const pos = this.position(name);
    if (!pos) return;
    const d = this.d(), n = d.nodes[name] || {};
    this.cot(nodeCot({ name, label: n.label, team: n.team || d.team, st: this.live.get(name).status, pos }));
  }

  adsb(name, msg) {
    const l = this.liveOf(name);
    const planes = Array.isArray(msg.aircraft) ? msg.aircraft : [];
    l.adsb = { count: planes.length, t: Date.now() };
    const g = this.d().gateway;
    if (!g.adsbToTak) return;
    const here = this.position(name);
    const now = Date.now();
    for (const a of planes) {
      if (!a || !/^[0-9a-f]{6}$/.test(a.hex) || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
      if (here && km(here, a) > g.adsbMaxKm) continue;
      const last = this.planeSent.get(a.hex);
      if (last && now - last < 10000) continue; // several devices hear the same aircraft
      this.planeSent.set(a.hex, now);
      this.cot(aircraftCot(a, name));
    }
  }

  sweep(now = Date.now()) {
    for (const [hex, t] of this.planeSent) if (now - t > 120000) this.planeSent.delete(hex);
    for (const [name, l] of this.live) {
      if (l.status && l.status.online && now - l.seen > OFFLINE_MS) l.status.online = false; // missed status messages
      if (!this.d().nodes[name] && now - l.seen > 24 * 3600000) this.live.delete(name);
    }
  }

  // ---------------- admin: profiles and commands ----------------

  node(name) {
    if (!NAME.test(name)) throw new Error('Unknown device.');
    const n = this.d().nodes[name];
    if (!n) throw new Error('Unknown device.');
    return n;
  }

  publishProfile(name) {
    const n = this.d().nodes[name];
    if (!n || !n.adopted) return false;
    const p = normProfile(n.profile);
    if (p.ble === 'bodycam') {
      try { p.bodycam.url = this.bodycamUrl(name) || ''; } catch (e) { p.bodycam.url = ''; n.bodycamError = e.message; }
    }
    return this.publish(`lpu5/${name}/profile`, p, { retain: true });
  }

  setNode(name, { profile, label, team, adopted } = {}) {
    const d = this.d();
    if (!NAME.test(name)) throw new Error('Unknown device.');
    const n = d.nodes[name] || (d.nodes[name] = { label: '', team: '', profile: normProfile(d.defaults), adopted: false, created: Date.now() });
    if (profile) n.profile = normProfile({ ...n.profile, ...profile, bodycam: { ...(n.profile || {}).bodycam, ...(profile.bodycam || {}) } });
    if (label !== undefined) n.label = clean(label, 40);
    if (team !== undefined) n.team = clean(team, 20);
    if (adopted !== undefined) n.adopted = !!adopted;
    delete n.bodycamError;
    this.save();
    this.publishProfile(name);
    if (this.live.get(name)) this.sendNodeCot(name);
    return n;
  }

  forget(name) {
    const d = this.d();
    if (!d.nodes[name]) return false;
    delete d.nodes[name];
    this.save();
    this.publish(`lpu5/${name}/profile`, '', { retain: true }); // clears the retained profile
    this.live.delete(name);
    return true;
  }

  // text command (status, sdr start, wifi scan, update, reboot …) or Meshtastic management (op + args)
  request(name, body, timeoutMs = REQUEST_MS) {
    if (!NAME.test(name) && name !== 'all') return Promise.reject(new Error('Unknown device.'));
    const id = crypto.randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      if (!this.publish(`lpu5/${name}/cmd`, { id, ...body })) return reject(new Error('Not connected to the LPU5 MQTT broker.'));
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('No answer from the device (offline or busy).')); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  tx(name, pkt) { return this.publish(`lpu5/${name}/mesh/tx`, pkt, { qos: 0 }); }

  // devices that send into the mesh for the gateway: online, approved, radio connected, gateway "send and receive"
  gatewayRadios(now = Date.now()) {
    const out = [];
    for (const [name, n] of Object.entries(this.d().nodes)) {
      const l = this.live.get(name);
      const st = l && l.status;
      if (n.adopted && st && st.online && now - l.seen < OFFLINE_MS && st.mesh && normProfile(n.profile).gateway === 'rxtx') out.push(name);
    }
    return out.sort();
  }

  // ---------------- view for the admin ----------------

  view() {
    const d = this.d();
    const names = new Set([...Object.keys(d.nodes), ...this.live.keys()]);
    const now = Date.now();
    const nodes = [...names].sort().map(name => {
      const n = d.nodes[name] || null;
      const l = this.live.get(name) || {};
      const st = l.status || {};
      return {
        name, known: !!n, adopted: !!(n && n.adopted), label: n ? n.label : '', team: n ? n.team : '',
        profile: n ? normProfile(n.profile) : null, running: st.profile || null, bodycamError: n && n.bodycamError || '',
        online: !!st.online && now - l.seen < OFFLINE_MS, seen: l.seen || (n && n.lastOnline) || null,
        status: l.status ? {
          uplink: st.uplink, uplinkDev: st.uplink_dev, vpn: st.vpn_handshake_age, mesh: st.mesh, meshNum: st.mesh_num, meshDevice: st.mesh_device,
          sdr: st.sdr, vpnIp: st.vpn_ip || null, temp: st.cpu_temp, load: st.load, uptime: st.uptime, version: st.version, gps: st.gps || null, gateway: st.gateway || null,
        } : null,
        position: this.position(name), rx: l.rx || 0, meshNodes: (l.meshNodes || []).length, bodycam: l.bodycam || null, adsb: l.adsb || null,
      };
    });
    return {
      settings: { enabled: !!d.enabled, url: d.url || '', username: d.username || '', password: d.password ? '********' : '', autoAdopt: d.autoAdopt !== false, defaults: d.defaults, gateway: d.gateway, team: d.team || '' },
      connection: { ...this.conn }, nodes, gatewayStats: this.gw ? this.gw.stats() : null,
    };
  }

  setSettings(body = {}) {
    const d = this.d();
    if (body.enabled !== undefined) d.enabled = !!body.enabled;
    if (body.url !== undefined) {
      const url = String(body.url || '').trim();
      if (url && !/^(mqtts?|wss?):\/\/[^\s/]+/.test(url)) throw new Error('MQTT address like mqtt://10.55.0.1:1883');
      d.url = url;
    }
    if (body.username !== undefined) d.username = clean(body.username, 64);
    if (body.password !== undefined && body.password !== '********') d.password = String(body.password || '').slice(0, 200);
    if (body.autoAdopt !== undefined) d.autoAdopt = !!body.autoAdopt;
    if (body.defaults) d.defaults = normProfile({ ...d.defaults, ...body.defaults });
    if (body.gateway) d.gateway = normGateway({ ...d.gateway, ...body.gateway });
    if (body.team !== undefined) d.team = clean(body.team, 20);
    this.save();
  }
}

module.exports = { Lpu5, normProfile, normGateway, nodeCot, aircraftCot, DEFAULT_PROFILE, BLE, GATEWAY, SDR, HOTSPOT };
