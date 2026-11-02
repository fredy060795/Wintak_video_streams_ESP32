// Mesh <-> TAK server gateway on the server, through LPU5 field devices as radios (lib/lpu5.js).
// The same rules as the bridge in the TAKweb app (public/eud/mesh.js), so app gateways and LPU5 gateways work together
// without duplicates or loops – but no phone has to stay awake:
// - up (LoRa -> TAK server): TAK packets (port 72: positions, chat) and CoT over port 257 (markers, drawings, deletions,
//   zlib, larger ones as fountain blocks) become CoT for the TAK server, marked <__takwebmesh/> so they never go back
// - down (TAK server -> LoRa): positions (at most every 5 min per contact), chat "All", markers/drawings/deletions,
//   through every LPU5 whose gateway is set to "send and receive"
// - several LPU5 hear the same packet: only once (sender + packet id); packets sent by an LPU5 radio are its own
// - only live content: what the server sends again on (re)connecting stays off LoRa
// - plain Meshtastic nodes (no TAK) only with "Meshtastic nodes to TAK" (admin)

const zlib = require('zlib');
const crypto = require('crypto');
const P = require('../public/eud/meshproto');

const MARK = '__takwebmesh';
const SEEN_MS = 10 * 60000, PLI_SAME_MS = 90000, PLI_DOWN_MS = 5 * 60000, LIVE_MS = 15 * 60000;
const MAX_DIRECT = 232, MAX_SOURCE_BLOCKS = 10;
const NODE_MAX_AGE = 2 * 3600;

// attribute of the <event> tag (WinTAK puts <?xml …?> in front)
const attr = (xml, a) => { const i = Math.max(0, xml.indexOf('<event')); const m = new RegExp(`\\s${a}="([^"]*)"`).exec(xml.slice(i, xml.indexOf('>', i) + 1)); return m ? m[1] : ''; };
const tagAttr = (xml, tag, a) => { const t = new RegExp(`<${tag}\\b[^>]*>`).exec(xml); if (!t) return null; const m = new RegExp(`\\s${a}="([^"]*)"`).exec(t[0]); return m ? m[1] : null; };
const unesc = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const isPli = (type, xml) => type.startsWith('a-') && xml.includes('<__group');
const live = xml => { const t = Date.parse(attr(xml, 'time')); return !t || Math.abs(Date.now() - t) < LIVE_MS; };

function bridgeKey(xml) {
  const type = attr(xml, 'type'), uid = attr(xml, 'uid');
  if (!type || !uid) return null;
  if (type === 'b-t-f') return { type, uid, key: 'c|' + uid, pli: false };
  if (isPli(type, xml)) return { type, uid, key: 'p|' + uid, pli: true };
  return { type, uid, key: uid + '|' + attr(xml, 'time'), pli: false };
}

const marked = xml => (/<detail\s*\/>/.test(xml) ? xml.replace(/<detail\s*\/>/, `<detail><${MARK}/></detail>`)
  : xml.includes('</detail>') ? xml.replace(/<\/detail>(?![\s\S]*<\/detail>)/, `<${MARK}/></detail>`) : xml.replace(/<\/event>\s*$/, `<detail><${MARK}/></detail></event>`));

// for LoRa only what a TAK client needs (like slimCot in the app, without a DOM): known detail elements, short remarks
const KEEP = ['contact', 'link', 'remarks', 'color', 'usericon', '__milsym', 'archive', 'strokeColor', 'strokeWeight', 'fillColor',
  'shape', 'labels_on', 'closed', 'height', 'height_unit', 'range', 'bearing', 'inclination', 'rangeUnits', 'bearingUnits', 'northRef', '__group', 'track'];
function slimCot(xml) {
  xml = xml.replace(/^<\?xml[^>]*>\s*/, '').trim();
  const d0 = xml.indexOf('<detail'), d1 = xml.lastIndexOf('</detail>');
  let head = d0 >= 0 ? xml.slice(0, d0) : xml.replace(/<\/event>\s*$/, '');
  head = head.replace(/\saccess="[^"]*"/, '')
    .replace(/(<point\b[^>]*\slat=")([-\d.]+)/, (m, a, v) => a + Number(v).toFixed(6))
    .replace(/(<point\b[^>]*\slon=")([-\d.]+)/, (m, a, v) => a + Number(v).toFixed(6))
    .replace(/(<point\b[^>]*\shae=")([-\d.e+]+)/, (m, a, v) => a + (Number(v) < 9e6 ? Math.round(Number(v)) : v));
  if (d0 < 0 || d1 < 0) return head + '</event>';
  const body = xml.slice(xml.indexOf('>', d0) + 1, d1);
  const out = [];
  let archived = false;
  // top-level children of <detail>: <name …/> or <name …>…</name>
  const re = /<([A-Za-z_][\w.-]*)\b[^>]*?(\/>|>[\s\S]*?<\/\1>)/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1];
    if (!KEEP.includes(name)) continue;
    let part = m[0];
    if (name === 'archive') { if (archived) continue; archived = true; }
    if (name === 'link') part = part.replace(/\sproduction_time="[^"]*"/, '');
    if (name === 'remarks') {
      const text = (/>([\s\S]*)<\/remarks>/.exec(part) || [])[1] || '';
      part = text ? `<remarks>${text.length > 200 ? text.slice(0, 200) : text}</remarks>` : '<remarks/>';
    }
    out.push(part);
  }
  return `${head}<detail>${out.join('')}</detail></event>`;
}

const sha8 = b => new Uint8Array(crypto.createHash('sha256').update(b).digest().subarray(0, 8));
function unzlib(b) {
  for (const f of [zlib.inflateSync, zlib.inflateRawSync]) { try { return f(Buffer.from(b)); } catch (e) { /* next */ } }
  return Buffer.from(b);
}

class MeshGateway {
  // send(name, {portnum, payload(base64), to, channel}): one LPU5 radio sends; radios(): names that may send;
  // cot(xml): to the TAK server; settings(): { channel, nodesToTak }
  constructor({ send, radios, cot, settings, log, delayMs }) {
    this.delay = delayMs || (() => 1000 + Math.random() * 2000);
    this.send = send;
    this.radios = radios || (() => []);
    this.cot = cot;
    this.settings = settings || (() => ({ channel: 0, nodesToTak: false }));
    this.log = log || (() => {});
    this.seenServer = new Map();
    this.seenMesh = new Map();
    this.seenPacket = new Map();  // "from:id" – several LPU5 hear the same packet
    this.pliDown = new Map();
    this.ownRadios = new Map();   // node number -> LPU5 name (what they send is ours)
    this.receiving = new Map();
    this.meshNodes = new Map();   // num -> { user, position, heard }
    this.counters = { up: 0, down: 0, dropped: 0 };
    this.timer = setInterval(() => this.cleanup(), 60000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }
  stats() { return { ...this.counters, radios: this.radios().length, meshNodes: this.meshNodes.size }; }

  radio(name, num, gatewayMode) { if (num) this.ownRadios.set(num >>> 0, name); }

  heardRecently(key) {
    const t = this.seenPacket.get(key);
    this.seenPacket.set(key, Date.now());
    return t != null && Date.now() - t < SEEN_MS;
  }

  // ---------------- up: LoRa -> TAK server ----------------

  rx(name, msg) {
    let pkt;
    try { pkt = P.parseMeshPacket(new Uint8Array(Buffer.from(String(msg.b64 || ''), 'base64'))); } catch (e) { return; }
    if (!pkt || !pkt.payload) return; // encrypted for another channel
    if (this.ownRadios.has(pkt.from >>> 0)) return; // sent by an LPU5 radio = came from the TAK server
    if (pkt.id && this.heardRecently(pkt.from + ':' + pkt.id)) return;
    const ch = this.settings().channel;
    if (pkt.portnum === P.PORT.ATAK) return this.rxTak(pkt);
    if (pkt.portnum === P.PORT.FORWARDER) return this.rxForwarder(name, pkt, ch);
    if (pkt.portnum === P.PORT.NODEINFO || pkt.portnum === P.PORT.POSITION) return this.rxNode(pkt);
  }

  rxTak(pkt) {
    const t = P.parseTak(pkt.payload);
    if (t.compressed) return; // older firmware compressed it on the radio – cannot be read
    if (t.pli) return this.up(P.pliCot(t, pkt.from));
    if (t.chat) {
      const all = !t.chat.to || t.chat.to === P.ALL_CHAT;
      const msgId = t.msgId || crypto.randomBytes(6).toString('hex');
      let xml = P.chatCot({ senderUid: t.uid || 'MESH-' + P.nodeId(pkt.from), senderCallsign: t.callsign || P.nodeId(pkt.from), msgId, text: t.chat.message, toUid: all ? '' : t.chat.to });
      // direct message to a device that is only online: to the TAK server addressed to it alone
      if (!all) xml = xml.replace('</detail>', `<marti><dest uid="${String(t.chat.to).replace(/[<>"&]/g, '')}"/></marti></detail>`);
      return this.up(xml, !all);
    }
  }

  rxForwarder(name, pkt, ch) {
    const b = pkt.payload;
    const f = P.parseFountain(b);
    if (f && f.ack) return; // we send one round only (like the app's bridge)
    if (f && f.block) return this.rxBlock(name, pkt, f.block);
    if (b[0] === 0xc2 || (b[0] === 0x4d && b[1] === 0x46 && b[2] === 0x54)) return; // codec2 voice, file transfer receipt
    this.rxCot(unzlib(b));
  }

  rxBlock(name, pkt, blk) {
    const key = pkt.from + ':' + blk.transferId;
    let st = this.receiving.get(key);
    if (st && (st.K !== blk.K || st.totalLength !== blk.totalLength)) st = null;
    if (!st) { st = { K: blk.K, totalLength: blk.totalLength, blocks: [], seeds: new Set(), done: false }; this.receiving.set(key, st); }
    st.t = Date.now();
    if (st.done || st.seeds.has(blk.seed)) return;
    st.seeds.add(blk.seed);
    st.blocks.push(blk);
    if (st.blocks.length < st.K) return;
    const data = P.fountainDecode(st.blocks, st.K, st.totalLength, blk.transferId);
    if (!data) return;
    st.done = true;
    // ACK like the plugin so the sender stops repeating – through the LPU5 that heard it
    const ack = P.fountainAck(blk.transferId, P.FOUNTAIN.COMPLETE, st.blocks.length, 0, sha8(data));
    const pktOut = { portnum: P.PORT.FORWARDER, payload: Buffer.from(ack).toString('base64'), channel: pkt.channel || 0 };
    this.send(name, pktOut);
    this.send(name, pktOut);
    if (data[0] === 0x00 || data[0] === 0x30) this.rxCot(unzlib(data.subarray(1)));
  }

  rxCot(bytes) {
    const xml = Buffer.from(bytes).toString('utf8').trim();
    if (xml.startsWith('<')) this.up(xml);
  }

  rxNode(pkt) {
    const n = this.meshNodes.get(pkt.from) || { num: pkt.from };
    try {
      if (pkt.portnum === P.PORT.NODEINFO) n.user = P.parseUserPayload(pkt.payload) || n.user;
      else n.position = P.parsePositionPayload(pkt.payload) || n.position;
    } catch (e) { return; }
    n.heard = Math.floor(Date.now() / 1000);
    this.meshNodes.set(pkt.from, n);
    this.nodeUp(n);
  }

  // node list of a radio (names and positions of plain Meshtastic users)
  nodes(name, msg) {
    for (const x of Array.isArray(msg.nodes) ? msg.nodes : []) {
      if (!x || !Number.isFinite(x.num) || this.ownRadios.has(x.num >>> 0)) continue;
      const n = this.meshNodes.get(x.num) || { num: x.num };
      if (x.long_name || x.short_name) n.user = { id: x.id || '', longName: x.long_name || '', shortName: x.short_name || '' };
      if (Number.isFinite(x.lat) && Number.isFinite(x.lon) && (x.lat || x.lon)) n.position = { lat: x.lat, lon: x.lon, alt: x.alt, time: x.time || 0 };
      n.heard = Math.max(n.heard || 0, x.last_heard || 0);
      this.meshNodes.set(x.num, n);
      this.nodeUp(n);
    }
  }

  nodeUp(n) {
    if (!this.settings().nodesToTak || !n.position) return;
    const heard = Math.max(n.heard || 0, n.position.time || 0);
    if (!heard || Date.now() / 1000 - heard > NODE_MAX_AGE) return;
    const key = 'n|' + n.num;
    const last = this.seenServer.get(key);
    if (last && Date.now() - last < 60000) return;
    this.seenServer.set(key, Date.now());
    this.cot(P.nodeCot({ num: n.num, user: n.user, position: n.position, heard }));
    this.counters.up++;
  }

  up(xml, direct = false) {
    const k = bridgeKey(xml);
    if (!k || xml.includes('<' + MARK) || !live(xml)) return;
    this.seenMesh.set(k.key, Date.now());
    if (k.type === 'b-t-f' && !direct && !xml.includes('.' + P.ALL_CHAT + '.')) return;
    if (this.seen(this.seenServer, k)) return; // the TAK server has it already (e.g. from an app gateway)
    this.seenServer.set(k.key, Date.now());
    this.counters.up++;
    this.cot(marked(xml));
  }

  // ---------------- down: TAK server -> LoRa ----------------

  seen(map, k) { const t = map.get(k.key); return t != null && Date.now() - t < (k.pli ? PLI_SAME_MS : SEEN_MS); }

  fromTak(xml, { replay = false } = {}) {
    const k = bridgeKey(xml);
    if (!k) return;
    const fresh = !this.seen(this.seenServer, k);
    this.seenServer.set(k.key, Date.now());
    if (replay || !fresh || xml.includes('<' + MARK) || !live(xml)) return;
    if (k.uid.startsWith('LPU5-') || k.uid.startsWith('ICAO-') || k.uid.startsWith('MESH-') || k.uid.startsWith('TAKWEB-')) return;
    const chat = k.type === 'b-t-f';
    if (chat && !xml.includes('.' + P.ALL_CHAT + '.')) return; // team/group/direct chat: not over LoRa (like the plugin)
    if (!chat && !k.pli && !/^(a-|b-m-|u-d-|u-rb-a|t-x-d-d)/.test(k.type)) return;
    if (k.pli) {
      if (Date.parse(attr(xml, 'stale')) < Date.now()) return;
      const last = this.pliDown.get(k.uid);
      if (last && Date.now() - last < PLI_DOWN_MS) return;
    }
    const radios = this.radios();
    if (!radios.length) return;
    // a short wait: an app gateway that heard it on the mesh meanwhile has priority
    const t = setTimeout(() => {
      if (this.seen(this.seenMesh, k)) return;
      this.seenMesh.set(k.key, Date.now());
      if (k.pli) this.pliDown.set(k.uid, Date.now());
      let pkts;
      try { pkts = this.encode(xml, k); } catch (e) { this.log('Mesh gateway: ' + e.message); return; }
      if (!pkts.length) { this.counters.dropped++; return; }
      this.counters.down++;
      const ch = this.settings().channel;
      for (const name of this.radios()) for (const p of pkts) this.send(name, { ...p, payload: Buffer.from(p.payload).toString('base64'), channel: ch });
    }, this.delay());
    t.unref?.();
  }

  // CoT -> Meshtastic packets (TAK packet on port 72, or zlib CoT / fountain blocks on port 257)
  encode(xml, k) {
    const num = v => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
    if (k.type === 'b-t-f') {
      const sender = unesc(tagAttr(xml, '__chat', 'senderCallsign') || '');
      const senderUid = tagAttr(xml, 'link', 'uid') || k.uid.split('.')[1] || '';
      let text = unesc((/<remarks\b[^>]*>([\s\S]*?)<\/remarks>/.exec(xml) || [])[1] || '');
      while (Buffer.byteLength(text) > 200) text = text.slice(0, -1);
      return [{ portnum: P.PORT.ATAK, payload: P.takChat({ callsign: sender, uid: senderUid, msgId: tagAttr(xml, '__chat', 'messageId') || k.uid.split('.').pop(), message: text, to: P.ALL_CHAT }) }];
    }
    if (k.pli) {
      const hae = num(tagAttr(xml, 'point', 'hae'));
      return [{ portnum: P.PORT.ATAK, payload: P.takPli({
        callsign: unesc(tagAttr(xml, 'contact', 'callsign')) || k.uid, uid: k.uid, team: unesc(tagAttr(xml, '__group', 'name')), role: unesc(tagAttr(xml, '__group', 'role')),
        battery: num(tagAttr(xml, 'status', 'battery')), lat: num(tagAttr(xml, 'point', 'lat')), lon: num(tagAttr(xml, 'point', 'lon')),
        alt: hae != null && hae < 9e6 ? hae : null, speed: num(tagAttr(xml, 'track', 'speed')), course: num(tagAttr(xml, 'track', 'course')),
      }) }];
    }
    const z = zlib.deflateSync(Buffer.from(marked(slimCot(xml))));
    if (z.length <= MAX_DIRECT) return [{ portnum: P.PORT.FORWARDER, payload: new Uint8Array(z) }];
    const data = new Uint8Array(z.length + 1);
    data[0] = P.FOUNTAIN.TYPE_COT;
    data.set(z, 1);
    const K = Math.ceil(data.length / P.FOUNTAIN.BLOCK);
    if (K > MAX_SOURCE_BLOCKS) return []; // too large for LoRa (long routes …)
    const transferId = 1 + Math.floor(Math.random() * 0xfffffe);
    return P.fountainEncode(data, P.fountainBlockCount(K), transferId).map(b => ({ portnum: P.PORT.FORWARDER, payload: b }));
  }

  cleanup() {
    const t = Date.now() - SEEN_MS;
    for (const m of [this.seenServer, this.seenMesh, this.seenPacket]) for (const [k, v] of m) if (v < t) m.delete(k);
    for (const [k, st] of this.receiving) if (Date.now() - st.t > 300000) this.receiving.delete(k);
    for (const [k, v] of this.pliDown) if (Date.now() - v > PLI_DOWN_MS) this.pliDown.delete(k);
  }
}

module.exports = { MeshGateway, slimCot, bridgeKey, marked, MARK };
