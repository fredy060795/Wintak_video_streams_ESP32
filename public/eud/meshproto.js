// Meshtastic protocol for the EUD: a small protobuf codec (only the fields we need) and the conversion
// between Meshtastic packets and CoT. Field numbers from github.com/meshtastic/protobufs (mesh.proto,
// atak.proto, channel.proto, portnums.proto). TAK data uses ATAK_PLUGIN (port 72, TAKPacket V1,
// uncompressed) like the official Meshtastic ATAK plugin. Runs in the browser and in Node (tests).
'use strict';

(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.meshProto = m;
})(this, () => {
  const PORT = { TEXT: 1, POSITION: 3, NODEINFO: 4, ATAK: 72, PRIVATE: 256, FORWARDER: 257 };
  const BROADCAST = 0xffffffff;
  const ALL_CHAT = 'All Chat Rooms';
  // TAKPacket Team / MemberRole enums: index = enum value (0 = unspecified)
  const TEAMS = ['', 'White', 'Yellow', 'Orange', 'Magenta', 'Red', 'Maroon', 'Purple', 'Dark Blue', 'Blue', 'Cyan', 'Teal', 'Green', 'Dark Green', 'Brown'];
  const ROLES = ['', 'Team Member', 'Team Lead', 'HQ', 'Sniper', 'Medic', 'Forward Observer', 'RTO', 'K9'];

  const utf8 = new TextEncoder();
  const utf8d = new TextDecoder();

  // ---------------- Writing ----------------

  class Writer {
    constructor() { this.b = []; }
    varint(n) {
      // int32 below 0 is sent as a 64-bit two's complement (10 bytes) like protobuf does
      if (n < 0) {
        let v = BigInt.asUintN(64, BigInt(n));
        while (v > 0x7fn) { this.b.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
        this.b.push(Number(v));
        return this;
      }
      n = Math.floor(n);
      while (n > 0x7f) { this.b.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
      this.b.push(n);
      return this;
    }
    tag(field, wt) { return this.varint(field * 8 + wt); }
    uint(field, n) { return n ? this.tag(field, 0).varint(n >>> 0) : this; }
    int(field, n) { return n ? this.tag(field, 0).varint(n | 0) : this; }
    bool(field, v) { return v ? this.tag(field, 0).varint(1) : this; }
    fixed(field, n, signed) {
      if (!n) return this;
      const d = new DataView(new ArrayBuffer(4));
      if (signed) d.setInt32(0, n, true); else d.setUint32(0, n >>> 0, true);
      this.tag(field, 5);
      for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i));
      return this;
    }
    bytes(field, bytes, always) {
      if (!bytes || (!bytes.length && !always)) return this;
      this.tag(field, 2).varint(bytes.length);
      for (const x of bytes) this.b.push(x);
      return this;
    }
    str(field, s) { return s ? this.bytes(field, utf8.encode(String(s))) : this; }
    msg(field, w) { return w ? this.bytes(field, w.done(), true) : this; }
    done() { return Uint8Array.from(this.b); }
  }

  // ---------------- Reading ----------------

  // -> Map(field -> [{ wt, v }]); varints as uint32 (low 32 bits – all our varint fields are 32 bit)
  function decode(buf) {
    const out = new Map();
    let i = 0;
    const varint = () => {
      let lo = 0, shift = 0, byte;
      do {
        if (i >= buf.length) throw new Error('truncated varint');
        byte = buf[i++];
        if (shift < 32) lo += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      } while (byte & 0x80);
      return lo % 2 ** 32;
    };
    while (i < buf.length) {
      const key = varint();
      const field = Math.floor(key / 8), wt = key & 7;
      let v;
      if (wt === 0) v = varint();
      else if (wt === 2) { const len = varint(); if (i + len > buf.length) throw new Error('truncated field'); v = buf.subarray(i, i + len); i += len; }
      else if (wt === 5) { if (i + 4 > buf.length) throw new Error('truncated field'); v = buf.subarray(i, i + 4); i += 4; }
      else if (wt === 1) { if (i + 8 > buf.length) throw new Error('truncated field'); v = buf.subarray(i, i + 8); i += 8; }
      else throw new Error('unsupported wire type ' + wt);
      if (!out.has(field)) out.set(field, []);
      out.get(field).push({ wt, v });
    }
    return out;
  }
  const one = (f, n) => { const l = f.get(n); return l ? l[l.length - 1] : null; };
  const has = (f, n) => f.has(n);
  const u32 = (f, n) => { const x = one(f, n); return x && x.wt === 0 ? x.v : 0; };
  const i32 = (f, n) => u32(f, n) | 0;
  const fixed = (f, n, signed) => {
    const x = one(f, n);
    if (!x || x.wt !== 5) return 0;
    const d = new DataView(x.v.buffer, x.v.byteOffset, 4);
    return signed ? d.getInt32(0, true) : d.getUint32(0, true);
  };
  const bytes = (f, n) => { const x = one(f, n); return x && x.wt === 2 ? x.v : null; };
  const str = (f, n) => { const b = bytes(f, n); return b ? utf8d.decode(b) : ''; };
  const sub = (f, n) => { const b = bytes(f, n); return b ? decode(b) : null; };

  // ---------------- ToRadio ----------------

  function wantConfig(nonce) { return new Writer().uint(3, nonce).done(); }

  // MeshPacket with Data to the mesh; hop_limit must be set (0 = the node would not rebroadcast)
  function toRadioPacket({ to = BROADCAST, channel = 0, portnum, payload, id, hopLimit = 3, wantAck = false }) {
    const data = new Writer().uint(1, portnum).bytes(2, payload);
    const pkt = new Writer().fixed(2, to).uint(3, channel).msg(4, data).fixed(6, id).uint(9, hopLimit).bool(10, wantAck);
    return new Writer().msg(1, pkt).done();
  }

  // ---------------- TAKPacket (ATAK plugin, V1) ----------------

  const enumOf = (list, name) => Math.max(0, list.indexOf(name));

  function takPli({ callsign, uid, team, role, battery, lat, lon, alt, speed, course }) {
    const contact = new Writer().str(1, callsign).str(2, uid);
    const group = new Writer().uint(1, enumOf(ROLES, role) || 1).uint(2, enumOf(TEAMS, team) || 10);
    const status = new Writer().uint(1, Math.max(0, Math.min(100, Math.round(battery || 0))));
    const pli = new Writer()
      .fixed(1, Math.round(lat * 1e7), true).fixed(2, Math.round(lon * 1e7), true)
      .int(3, Number.isFinite(alt) ? Math.round(alt) : 0)
      .uint(4, Number.isFinite(speed) && speed > 0 ? Math.round(speed) : 0)
      .uint(5, Number.isFinite(course) && course > 0 ? Math.round(course) % 360 : 0);
    return new Writer().msg(2, contact).msg(3, group).msg(4, status).msg(5, pli).done();
  }

  // the ATAK plugin carries the GeoChat messageId in device_callsign ("uid|messageId")
  function takChat({ callsign, uid, msgId, message, to = ALL_CHAT }) {
    const contact = new Writer().str(1, callsign).str(2, msgId ? `${uid}|${msgId}` : uid);
    const chat = new Writer().str(1, message).str(2, to);
    return new Writer().msg(2, contact).msg(6, chat).done();
  }

  function parseTak(buf) {
    const f = decode(buf);
    const c = sub(f, 2), g = sub(f, 3), s = sub(f, 4), p = sub(f, 5), ch = sub(f, 6);
    const [uid, msgId] = (c ? str(c, 2) : '').split('|');
    return {
      compressed: !!u32(f, 1),
      callsign: c ? str(c, 1) : '',
      uid: uid || '',
      msgId: msgId || '',
      team: g ? TEAMS[u32(g, 2)] || '' : '',
      role: g ? ROLES[u32(g, 1)] || '' : '',
      battery: s && has(s, 1) ? u32(s, 1) : null,
      pli: p ? { lat: fixed(p, 1, true) / 1e7, lon: fixed(p, 2, true) / 1e7, alt: i32(p, 3), speed: u32(p, 4), course: u32(p, 5) } : null,
      chat: ch ? { message: str(ch, 1), to: str(ch, 2), toCallsign: str(ch, 3) } : null,
    };
  }

  // ---------------- FromRadio ----------------

  function parseUser(f) {
    return f ? { id: str(f, 1), longName: str(f, 2), shortName: str(f, 3) } : null;
  }

  function parsePosition(f) {
    if (!f || !has(f, 1) || !has(f, 2)) return null;
    const lat = fixed(f, 1, true) / 1e7, lon = fixed(f, 2, true) / 1e7;
    if (!lat && !lon) return null;
    return { lat, lon, alt: has(f, 3) ? i32(f, 3) : null, time: fixed(f, 4) || fixed(f, 7) || 0, speed: has(f, 15) ? u32(f, 15) : null, course: has(f, 16) ? u32(f, 16) : null };
  }

  function parsePacket(f) {
    const d = sub(f, 4);
    return {
      from: fixed(f, 1), to: fixed(f, 2), channel: u32(f, 3), id: fixed(f, 6), rxTime: fixed(f, 7),
      portnum: d ? u32(d, 1) : 0, payload: d ? bytes(d, 2) || new Uint8Array(0) : null, // null = encrypted (not for us)
    };
  }

  function parseFromRadio(buf) {
    const f = decode(buf);
    if (has(f, 2)) return { kind: 'packet', packet: parsePacket(sub(f, 2)) };
    if (has(f, 3)) return { kind: 'myInfo', nodeNum: u32(sub(f, 3), 1) };
    if (has(f, 4)) {
      const n = sub(f, 4);
      return { kind: 'nodeInfo', node: { num: u32(n, 1), user: parseUser(sub(n, 2)), position: parsePosition(sub(n, 3)), lastHeard: fixed(n, 5) } };
    }
    if (has(f, 10)) {
      const c = sub(f, 10), s = sub(c, 2);
      const psk = s ? bytes(s, 2) : null;
      // key: none = unencrypted, 1 byte 0x01 = the public default key ("AQ=="), otherwise an own key
      const key = !psk || !psk.length ? 'none' : (psk.length === 1 ? (psk[0] === 1 ? 'default' : 'simple') : 'own');
      return { kind: 'channel', channel: { index: i32(c, 1), role: u32(c, 3), name: s ? str(s, 3) : '', key } };
    }
    if (has(f, 7)) return { kind: 'configComplete', id: u32(f, 7) };
    if (has(f, 8)) return { kind: 'rebooted' };
    if (has(f, 12)) { const x = sub(f, 12); return { kind: 'xmodem', control: u32(x, 1), seq: u32(x, 2) }; }
    if (has(f, 15)) { const x = sub(f, 15); return { kind: 'fileInfo', name: str(x, 1), size: u32(x, 2) }; }
    if (has(f, 5)) {
      const cf = decode(bytes(f, 5));
      const lora = has(cf, 6) ? (bytes(cf, 6) || new Uint8Array(0)) : null;
      // LoRaConfig.region (7): 0 = UNSET – then the radio neither sends nor receives
      const lc = lora ? decode(lora) : null;
      const position = has(cf, 2) ? (bytes(cf, 2) || new Uint8Array(0)) : null;
      return { kind: 'config', network: bytes(cf, 4), lora, position, region: lc ? u32(lc, 7) : undefined, preset: lc ? u32(lc, 2) : undefined, usePreset: lc ? !!u32(lc, 1) : undefined };
    }
    return { kind: 'other' };
  }

  // ---------------- Files on the radio (XModem over the client API) and settings ----------------
  // Used to put TAKweb onto a radio's flash (its web server then serves it over WLAN).
  const XMODEM = { NUL: 0, SOH: 1, STX: 2, EOT: 4, ACK: 6, NAK: 21, CAN: 24 };
  // CRC-16/CCITT exactly like the firmware (xmodem.cpp)
  // SHA-256 for pages without crypto.subtle (plain http on the radio's own WLAN)
  const SHA_K = Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(data) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    const len = b.length, n = ((len + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(n);
    m.set(b); m[len] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(n - 8, Math.floor(len / 0x20000000)); dv.setUint32(n - 4, (len * 8) >>> 0);
    const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, bb, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
    return out;
  }

  function crc16(buf) {
    let c = 0;
    for (const b of buf) {
      c = ((c >> 8) & 0xff) | ((c << 8) & 0xffff);
      c ^= b;
      c ^= (c & 0xff) >> 4;
      c ^= (c << 12) & 0xffff;
      c ^= ((c & 0xff) << 5) & 0xffff;
    }
    return c & 0xffff;
  }
  function toRadioXmodem({ control, seq = 0, buffer = null }) {
    const x = new Writer().uint(1, control).uint(2, seq);
    if (buffer) x.uint(3, crc16(buffer)).bytes(4, buffer, true);
    return new Writer().msg(5, x).done();
  }
  // a protobuf message again, without some fields (unknown fields stay as they are)
  function withoutFields(buf, drop) {
    const w = new Writer();
    for (const [field, list] of decode(buf || new Uint8Array(0))) {
      if (drop.includes(field)) continue;
      for (const { wt, v } of list) {
        w.tag(field, wt);
        if (wt === 0) w.varint(v);
        else if (wt === 2) { w.varint(v.length); for (const x of v) w.b.push(x); }
        else for (const x of v) w.b.push(x);
      }
    }
    return w;
  }
  const PORT_ADMIN = 6;
  const adminPacket = (node, admin) => toRadioPacket({ to: node, portnum: PORT_ADMIN, payload: admin.done(), id: 1 + Math.floor(Math.random() * 0xfffffff0), hopLimit: 0 });
  // WLAN of the radio on (client of e.g. a phone hotspot), the other network settings stay
  // fixed address in an iPhone hotspot: always 172.20.10.0/28 (router .1, devices from .2) – .14 is the last one
  const IPHONE_IP = '172.20.10.14';
  const ipBytes = ip => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip).trim());
    if (!m || m.slice(1).some(x => +x > 255)) throw new Error('Not an IPv4 address: ' + ip);
    return m.slice(1).map(Number);
  };
  // as the firmware stores it (ESP32 IPAddress: first byte lowest)
  const ipU32 = ip => { const b = ipBytes(ip); return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0; };
  // fixed IP -> { ip, gateway, subnet, dns }: iPhone hotspot /28, otherwise /24 with the router on .1
  function staticNet(ip) {
    const b = ipBytes(ip);
    if (b[0] === 172 && b[1] === 20 && b[2] === 10 && b[3] < 16) return { ip: b.join('.'), gateway: '172.20.10.1', subnet: '255.255.255.240', dns: '172.20.10.1' };
    const gw = `${b[0]}.${b[1]}.${b[2]}.1`;
    if (b[3] === 1 || b[3] === 0 || b[3] === 255) throw new Error('Not usable for the radio: ' + ip);
    return { ip: b.join('.'), gateway: gw, subnet: '255.255.255.0', dns: gw };
  }
  // NetworkConfig: wifi_enabled 1, ssid 3, psk 4, address_mode 7 (DHCP 0 / STATIC 1), ipv4_config 8 { ip, gateway, subnet, dns }
  function adminSetWifi(node, networkRaw, { ssid, psk, enabled = true, ip = '' }) {
    const net = withoutFields(networkRaw, ip ? [1, 3, 4, 7, 8] : [1, 3, 4, 7]).bool(1, enabled).str(3, ssid).str(4, psk);
    if (ip) {
      const s = staticNet(ip);
      net.uint(7, 1).msg(8, new Writer().fixed(1, ipU32(s.ip)).fixed(2, ipU32(s.gateway)).fixed(3, ipU32(s.subnet)).fixed(4, ipU32(s.dns)));
    }
    return adminPacket(node, new Writer().msg(34, new Writer().msg(4, net)));
  }
  // LoRa region (Config.lora = 6, LoRaConfig.region = 7), the other LoRa settings stay
  const REGIONS = { US: 1, EU_433: 2, EU_868: 3, CN: 4, JP: 5, ANZ: 6, KR: 7, TW: 8, RU: 9, IN: 10, NZ_865: 11, TH: 12, UA_433: 14, UA_868: 15, MY_433: 16, MY_919: 17, SG_923: 18, UK_868: 23 };
  function adminSetRegion(node, loraRaw, region) {
    const lora = withoutFields(loraRaw, [7]).uint(7, region);
    return adminPacket(node, new Writer().msg(34, new Writer().msg(6, lora)));
  }
  const PRESETS = ['LONG_FAST', 'LONG_SLOW', 'VERY_LONG_SLOW', 'MEDIUM_SLOW', 'MEDIUM_FAST', 'SHORT_SLOW', 'SHORT_FAST', 'LONG_MODERATE', 'SHORT_TURBO', 'LONG_TURBO'];
  // Meshtastic channel link (https://meshtastic.org/e/#<base64url ChannelSet>): ChannelSet { settings (1, repeated), lora_config (2) }
  function parseChannelUrl(url) {
    const m = /#([A-Za-z0-9_\-+/=]+)/.exec(String(url || '').trim());
    if (!m) throw new Error('Not a Meshtastic channel link (https://meshtastic.org/e/#…)');
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
    const f = decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    const settings = (f.get(1) || []).filter(x => x.wt === 2).map(x => x.v);
    if (!settings.length) throw new Error('The link contains no channel.');
    return { settings, names: settings.map(s => str(decode(s), 3)), lora: bytes(f, 2) };
  }
  // AdminMessage.set_channel (33): Channel { index 1, settings 2, role 3 (1 primary, 2 secondary, 0 off) }
  const adminSetChannel = (node, index, settingsRaw, role) =>
    adminPacket(node, new Writer().msg(33, new Writer().int(1, index).bytes(2, settingsRaw, true).uint(3, role)));
  // the LoRa settings of a link; a link without region keeps the radio's region. TAKweb radios are crisis radios:
  // override_duty_cycle (12) always on – they send whatever the channel load
  function adminSetLora(node, loraRaw, keepRegion) {
    const lf = decode(loraRaw || new Uint8Array(0));
    // config_ok_to_mqtt (105): the radio's packets may go to the server (MQTT gateway)
    const lora = withoutFields(loraRaw, u32(lf, 7) ? [12, 105] : [7, 12, 105]).bool(12, true).bool(105, true);
    if (!u32(lf, 7) && keepRegion) lora.uint(7, keepRegion);
    return adminPacket(node, new Writer().msg(34, new Writer().msg(6, lora)));
  }
  // all packets to put a channel link onto the radio (primary + secondary channels, the rest off, LoRa settings)
  function applyChannelUrl(node, url, { region = 0, max = 8 } = {}) {
    const c = parseChannelUrl(url);
    const out = c.settings.slice(0, max).map((s, i) => adminSetChannel(node, i, s, i ? 2 : 1));
    for (let i = c.settings.length; i < max; i++) out.push(adminSetChannel(node, i, new Uint8Array(0), 0));
    if (c.lora) out.push(adminSetLora(node, c.lora, region));
    return { packets: out, names: c.names };
  }
  // MQTT to the server (OpenTAKServer: RabbitMQ MQTT, topic <root>/2/e/<channel>/…, encrypted with the channel key –
  // OTS decrypts it): AdminMessage.set_module_config (35) { mqtt (1) { enabled 1, address 2, username 3, password 4,
  // encryption_enabled 5, json_enabled 6, tls_enabled 7, root 8, proxy_to_client 9, map_reporting 10 } }
  function adminSetMqtt(node, { address, username, password, root = 'opentakserver', tls = true }) {
    const mqtt = new Writer().bool(1, true).str(2, address).str(3, username).str(4, password).bool(5, true).bool(7, tls).str(8, root);
    return adminPacket(node, new Writer().msg(35, new Writer().msg(1, mqtt)));
  }
  // position: GPS on, smart broadcast with a fixed interval; hand-set GPS pins (8, 9, 12) cleared – the board's pins.
  // Config.position (2) { position_broadcast_secs 1, smart 2, rx_gpio 8, tx_gpio 9, gps_en_gpio 12, gps_mode 13 }
  function adminSetPosition(node, positionRaw, { secs = 120 } = {}) {
    const pos = withoutFields(positionRaw, [1, 2, 8, 9, 12, 13]).uint(1, secs).bool(2, true).uint(13, 1);
    return adminPacket(node, new Writer().msg(34, new Writer().msg(2, pos)));
  }
  const adminReboot = (node, seconds = 2) => adminPacket(node, new Writer().int(97, seconds));

  const parseUserPayload = buf => parseUser(decode(buf));
  const parsePositionPayload = buf => parsePosition(decode(buf));

  // ---------------- CoT ----------------

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cotTime = d => d.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');
  const nodeId = num => '!' + (num >>> 0).toString(16).padStart(8, '0');

  function event({ uid, type, how, time, staleMs, lat, lon, hae, detail }) {
    return `<event version="2.0" uid="${esc(uid)}" type="${type}" how="${how}" time="${cotTime(time)}" start="${cotTime(time)}" stale="${cotTime(new Date(+time + staleMs))}">`
      + `<point lat="${lat}" lon="${lon}" hae="${hae == null ? 9999999 : hae}" ce="9999999" le="9999999"/><detail>${detail}<__meshtastic/></detail></event>`;
  }

  // TAK PLI from the mesh -> contact (like the ATAK plugin: UID = device_callsign, stale 10 min)
  function pliCot(tak, from, now = new Date()) {
    const p = tak.pli;
    return event({
      uid: tak.uid || 'MESH-' + nodeId(from), type: 'a-f-G-U-C', how: 'm-g', time: now, staleMs: 600000, lat: p.lat, lon: p.lon, hae: p.alt || null,
      detail: `<contact callsign="${esc(tak.callsign || nodeId(from))}" endpoint="0.0.0.0:4242:tcp"/>`
        + `<__group name="${esc(tak.team || 'Cyan')}" role="${esc(tak.role || 'Team Member')}"/>`
        + (tak.battery != null ? `<status battery="${tak.battery}"/>` : '')
        + `<track course="${p.course}" speed="${p.speed}"/><takv platform="Meshtastic" device="Mesh"/>`,
    });
  }

  // GeoChat: to "All Chat Rooms" or directly to us (to = our UID)
  function chatCot({ senderUid, senderCallsign, msgId, text, toUid = '', now = new Date() }) {
    const direct = !!toUid;
    const room = direct ? senderCallsign : ALL_CHAT;
    const id = direct ? toUid : ALL_CHAT;
    return event({
      uid: `GeoChat.${senderUid}.${direct ? toUid : ALL_CHAT}.${msgId}`, type: 'b-t-f', how: 'h-g-i-g-o', time: now, staleMs: 86400000, lat: 0, lon: 0,
      detail: `<__chat parent="RootContactGroup" groupOwner="false" messageId="${esc(msgId)}" chatroom="${esc(room)}" id="${esc(id)}" senderCallsign="${esc(senderCallsign)}">`
        + `<chatgrp uid0="${esc(senderUid)}" uid1="${esc(id)}" id="${esc(id)}"/></__chat>`
        + `<link uid="${esc(senderUid)}" type="a-f-G-U-C" relation="p-p"/>`
        + `<remarks source="BAO.F.ATAK.${esc(senderUid)}" to="${esc(id)}" time="${cotTime(now)}">${esc(text)}</remarks>`,
    });
  }

  // team from the node name like the ATAK plugin: "Hans -5" = Red (-0/-1 White … -14 Brown), without a suffix Cyan
  function nodeTeam(name) {
    const m = / -(\d+)$/.exec(name);
    if (!m) return { callsign: name, team: 'Cyan' };
    const n = Number(m[1]);
    return { callsign: name.slice(0, m.index), team: n === 0 ? 'White' : TEAMS[n] || 'Cyan' };
  }

  // plain Meshtastic node (Meshtastic app, no TAK) with a position -> user on the map like in ATAK, stale 30 min.
  // Time = when the node was last heard (or its position fix), never "now" for old data – otherwise every
  // reconnect (the radio sends its whole node list) would make long gone nodes fresh again.
  function nodeCot({ num, user, position, heard }, now = new Date()) {
    const t = Math.max(position.time || 0, heard || 0);
    const time = t ? new Date(Math.min(t * 1000, +now)) : now;
    const { callsign, team } = nodeTeam((user && (user.longName || user.shortName)) || nodeId(num));
    return event({
      uid: 'MESH-' + nodeId(num), type: 'a-f-G-E-S', how: 'm-g', time, staleMs: 1800000, lat: position.lat, lon: position.lon, hae: position.alt,
      detail: `<contact callsign="${esc(callsign)}"/><__group name="${team}" role="Team Member"/>`
        + (position.course != null ? `<track course="${position.course}" speed="${position.speed || 0}"/>` : '')
        + `<remarks>Meshtastic ${esc(nodeId(num))}${user && user.shortName ? ' (' + esc(user.shortName) + ')' : ''}</remarks>`,
    });
  }

  // ---------------- ATAK_FORWARDER (port 257): other CoT (markers, deletions …) like the ATAK plugin ----------------
  // The plugin sends the CoT XML zlib-compressed: below 233 bytes as one packet, larger as fountain blocks
  // (util/fountain in the plugin): an LT code whose blocks are chosen with java.util.Random from a seed.

  const FTN = [0x46, 0x54, 0x4e]; // "FTN"
  const FOUNTAIN = { BLOCK: 214, HEADER: 11, ACK_SIZE: 19, DATA: 1, COMPLETE: 2, NEED_MORE: 3, TYPE_COT: 0x00 };
  const MASK48 = (1n << 48n) - 1n;

  // java.util.Random – exactly the same numbers as in Java/Android
  class JavaRandom {
    constructor(seed) { this.s = (BigInt(seed) ^ 0x5DEECE66Dn) & MASK48; }
    next(bits) {
      this.s = (this.s * 0x5DEECE66Dn + 0xBn) & MASK48;
      return Number(BigInt.asIntN(32, this.s >> BigInt(48 - bits)));
    }
    nextDouble() { return (this.next(26) * 134217728 + this.next(27)) / 9007199254740992; }
    nextInt(bound) {
      if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
      let bits, val;
      do { bits = this.next(31); val = bits % bound; } while (((bits - val + (bound - 1)) | 0) < 0);
      return val;
    }
  }

  // robust soliton distribution (c = 0.1, delta = 0.5 like the plugin)
  function solitonCdf(K, c = 0.1, delta = 0.5) {
    const mu = new Array(K + 1).fill(0), cdf = new Array(K + 1).fill(0);
    const S = c * Math.log(K / delta) * Math.sqrt(K);
    const threshold = Math.floor(K / S);
    let Z = 0;
    for (let d = 1; d <= K; d++) {
      const rho = d === 1 ? 1 / K : 1 / (d * (d - 1));
      const tau = d < threshold ? S / (K * d) : d === threshold ? S * Math.log(S / delta) / K : 0;
      mu[d] = rho + tau;
      Z += mu[d];
    }
    let cum = 0;
    for (let d = 1; d <= K; d++) { cum += mu[d] / Z; cdf[d] = cum; }
    return cdf;
  }
  function sampleDegree(rng, K) {
    const cdf = solitonCdf(K), u = rng.nextDouble();
    for (let d = 1; d <= K; d++) if (u <= cdf[d]) return d;
    return K;
  }
  function selectIndices(rng, K, degree) {
    degree = Math.min(degree, K);
    const set = new Set();
    while (set.size < degree) set.add(rng.nextInt(K));
    return [...set].sort((a, b) => a - b);
  }
  // which source blocks a seed combines (the first block of a transfer is always a single source block)
  function fountainIndices(seed, K, transferId) {
    const rng = new JavaRandom(seed);
    const deg = sampleDegree(rng, K);
    return selectIndices(rng, K, seed === (Math.imul(transferId, 31337) & 0xffff) ? 1 : deg);
  }

  // data (transfer type byte + zlib data) -> packets for port 257
  function fountainEncode(data, numBlocks, transferId) {
    const B = FOUNTAIN.BLOCK, K = Math.ceil(data.length / B);
    const src = [];
    for (let i = 0; i < K; i++) { const b = new Uint8Array(B); b.set(data.subarray(i * B, (i + 1) * B)); src.push(b); }
    const out = [];
    for (let i = 0; i < numBlocks; i++) {
      const seed = (Math.imul(transferId, 31337) + i * 7919) & 0xffff;
      const pkt = new Uint8Array(FOUNTAIN.HEADER + B);
      pkt.set(FTN);
      pkt[3] = (transferId >> 16) & 0xff; pkt[4] = (transferId >> 8) & 0xff; pkt[5] = transferId & 0xff;
      pkt[6] = seed >> 8; pkt[7] = seed & 0xff; pkt[8] = K; pkt[9] = (data.length >> 8) & 0xff; pkt[10] = data.length & 0xff;
      for (const idx of fountainIndices(seed, K, transferId)) for (let j = 0; j < B; j++) pkt[FOUNTAIN.HEADER + j] ^= src[idx][j];
      out.push(pkt);
    }
    return out;
  }

  // blocks [{ seed, payload }] -> data, or null while not decodable yet (peeling decoder)
  function fountainDecode(blocks, K, totalLength, transferId) {
    const decoded = new Array(K).fill(null);
    let count = 0;
    const work = blocks.map(b => ({ payload: Uint8Array.from(b.payload), idx: new Set(fountainIndices(b.seed, K, transferId)) }));
    let progress = true;
    while (progress && count < K) {
      progress = false;
      for (const w of work) {
        if (!w.idx) continue;
        for (const i of [...w.idx]) {
          if (!decoded[i]) continue;
          for (let j = 0; j < w.payload.length; j++) w.payload[j] ^= decoded[i][j];
          w.idx.delete(i);
        }
        if (w.idx.size === 1) {
          const i = w.idx.values().next().value;
          decoded[i] = w.payload;
          count++;
          w.idx = null;
          progress = true;
        } else if (!w.idx.size) w.idx = null;
      }
    }
    if (count < K) return null;
    const out = new Uint8Array(totalLength);
    for (let i = 0; i < K; i++) out.set(decoded[i].subarray(0, Math.min(FOUNTAIN.BLOCK, totalLength - i * FOUNTAIN.BLOCK)), i * FOUNTAIN.BLOCK);
    return out;
  }

  // port 257 payload: fountain data block / ACK, or null (plain zlib CoT, codec2 audio …)
  function parseFountain(b) {
    if (b.length < 7 || b[0] !== FTN[0] || b[1] !== FTN[1] || b[2] !== FTN[2]) return null;
    const transferId = (b[3] << 16) | (b[4] << 8) | b[5];
    if (b.length === FOUNTAIN.ACK_SIZE) {
      return { ack: { transferId, type: b[6], received: (b[7] << 8) | b[8], needed: (b[9] << 8) | b[10], hash: b.slice(11, 19) } };
    }
    if (b.length < FOUNTAIN.HEADER) return null;
    return { block: { transferId, seed: (b[6] << 8) | b[7], K: b[8], totalLength: (b[9] << 8) | b[10], payload: b.subarray(FOUNTAIN.HEADER) } };
  }

  function fountainAck(transferId, type, received, needed, hash) {
    const p = new Uint8Array(FOUNTAIN.ACK_SIZE);
    p.set(FTN);
    p[3] = (transferId >> 16) & 0xff; p[4] = (transferId >> 8) & 0xff; p[5] = transferId & 0xff; p[6] = type;
    p[7] = (received >> 8) & 0xff; p[8] = received & 0xff; p[9] = (needed >> 8) & 0xff; p[10] = needed & 0xff;
    p.set(hash.subarray(0, 8), 11);
    return p;
  }

  // blocks to send for K source blocks (50 % / 25 % / 15 % extra like the plugin)
  const fountainBlockCount = K => Math.ceil(K * (1 + (K <= 10 ? 0.5 : K <= 50 ? 0.25 : 0.15)));

  // ---------------- Voice messages (TAKweb, port PRIVATE_APP 256) ----------------
  // Codec 2 speech in small packets: every packet starts with 'V', version, kind (0 data, 1 request), message id
  // (8 bytes = the GeoChat messageId, so the same message from the TAK server is not shown twice), index, count.
  // Packet 0 carries the details (mode, length, sender, callsign, recipient), the others the speech.
  // A receiver that misses packets asks for them (kind 1 with the missing indices).
  const VOICE_MAGIC = 0x56, VOICE_VER = 1, VOICE_CHUNK = 200, VOICE_HEAD = 13;
  const VOICE_MODES = [1300, 1200, 700, 1600, 2400, 3200];
  const hexBytes = h => Uint8Array.from((String(h).padEnd(16, '0').slice(0, 16).match(/../g) || []).map(x => parseInt(x, 16) || 0));
  const bytesHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  function voiceHead(kind, id, idx, count) {
    const h = new Uint8Array(VOICE_HEAD);
    h[0] = VOICE_MAGIC; h[1] = VOICE_VER; h[2] = kind; h.set(hexBytes(id), 3); h[11] = idx; h[12] = count;
    return h;
  }
  function voicePackets({ id, from, callsign, to = '', mode = 1300, ms, bits }) {
    const str = s => { const b = utf8.encode(String(s || '')).slice(0, 255); return [b.length, ...b]; };
    const meta = Uint8Array.from([Math.max(0, VOICE_MODES.indexOf(mode)), (Math.round(ms / 100) >> 8) & 255, Math.round(ms / 100) & 255, ...str(from), ...str(callsign), ...str(to)]);
    const parts = [meta];
    for (let i = 0; i < bits.length; i += VOICE_CHUNK) parts.push(bits.subarray(i, i + VOICE_CHUNK));
    if (parts.length > 255) throw new Error('voice message too long');
    return parts.map((p, i) => { const out = new Uint8Array(VOICE_HEAD + p.length); out.set(voiceHead(0, id, i, parts.length)); out.set(p, VOICE_HEAD); return out; });
  }
  function voiceRequest(id, missing) {
    const out = new Uint8Array(VOICE_HEAD + missing.length);
    out.set(voiceHead(1, id, 0, 0));
    out.set(missing.slice(0, 200), VOICE_HEAD);
    return out;
  }
  function parseVoice(buf) {
    if (!buf || buf.length < VOICE_HEAD || buf[0] !== VOICE_MAGIC || buf[1] !== VOICE_VER) return null;
    return { kind: buf[2], id: bytesHex(buf.subarray(3, 11)), idx: buf[11], count: buf[12], data: buf.subarray(VOICE_HEAD) };
  }
  // collects the packets of voice messages; add() returns the message once it is complete
  class VoiceAssembler {
    constructor() { this.m = new Map(); }
    add(p, now = Date.now()) {
      if (!p || p.kind !== 0 || !p.count) return null;
      let e = this.m.get(p.id);
      if (!e) { e = { parts: new Array(p.count), got: 0, at: now, done: false, asked: 0 }; this.m.set(p.id, e); }
      e.at = now;
      if (e.done || p.idx >= p.count || e.parts[p.idx]) return null;
      e.parts[p.idx] = Uint8Array.from(p.data);
      if (++e.got < p.count) return null;
      e.done = true;
      const meta = e.parts[0];
      let o = 3;
      const str = () => { const n = meta[o]; const s = utf8d.decode(meta.subarray(o + 1, o + 1 + n)); o += 1 + n; return s; };
      const from = str(), callsign = str(), to = str();
      const len = e.parts.slice(1).reduce((n, x) => n + x.length, 0);
      const bits = new Uint8Array(len);
      let k = 0;
      for (const x of e.parts.slice(1)) { bits.set(x, k); k += x.length; }
      return { id: p.id, mode: VOICE_MODES[meta[0]] || 1300, ms: ((meta[1] << 8) | meta[2]) * 100, from, callsign, to, bits };
    }
    // incomplete messages without news for waitMs: [{ id, missing: [idx…] }] (to ask the sender again)
    stale(now = Date.now(), waitMs = 15000) {
      const out = [];
      for (const [id, e] of this.m) {
        if (now - e.at > 10 * 60000) { this.m.delete(id); continue; }
        if (e.done || now - e.at < waitMs || e.asked >= 3) continue;
        e.asked++; e.at = now;
        const missing = [];
        for (let i = 0; i < e.parts.length; i++) if (!e.parts[i]) missing.push(i);
        out.push({ id, missing });
      }
      return out;
    }
  }

  return {
    XMODEM, crc16, sha256, toRadioXmodem, adminSetWifi, adminReboot, adminSetRegion, REGIONS, PRESETS,
    parseChannelUrl, adminSetChannel, adminSetLora, applyChannelUrl, adminSetMqtt, adminSetPosition, withoutFields, IPHONE_IP, ipU32, staticNet,
    voicePackets, voiceRequest, parseVoice, VoiceAssembler, VOICE_CHUNK,
    PORT, BROADCAST, ALL_CHAT, TEAMS, ROLES, FOUNTAIN, Writer, decode,
    wantConfig, toRadioPacket, takPli, takChat, parseTak, parseFromRadio, parseUserPayload, parsePositionPayload,
    pliCot, chatCot, nodeCot, nodeTeam, nodeId, utf8,
    JavaRandom, fountainIndices, fountainEncode, fountainDecode, parseFountain, fountainAck, fountainBlockCount,
  };
});
