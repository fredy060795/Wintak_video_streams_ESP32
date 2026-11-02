// HQ: the live picture of the own TAK server for the HQ pages (/hq/) – every user and device with status, team, role and
// map objects, video feeds; geofences (e.g. the base) with departure/arrival times; warnings for hostile
// markers; the situation log (troop list with status and log entries like a TSL). Fed by the server-side TAK connection.
// Stored: store.data.hq = { enabled, fences: [...], units: [...], log: [...], events: [...], seq }.

const crypto = require('crypto');
const { parsePli, parseObject, distance } = require('./tracks');

const EVENTS_MAX = 500;
const LOG_MAX = 5000;
const OBJECTS_MAX = 3000;
const LOG_KINDS = ['Request', 'Troop report', 'Enemy report', 'Report', 'Medical', 'Departure', 'Arrival', 'Other'];
const UNIT_STATES = ['Ready', 'Moving', 'In action', 'Break', 'Casualty', 'Out'];

const attr = (s, a) => { const m = new RegExp(`\\s${a}="([^"]*)"`).exec(s); return m ? m[1] : ''; };
const tag = (xml, name) => { const m = new RegExp(`<${name}\\b[^>]*>`).exec(xml); return m ? m[0] : ''; };
const unesc = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const clean = (s, n = 200) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const rid = () => crypto.randomBytes(5).toString('hex');

// point in polygon (lat/lon pairs), ray casting – fine for fences of a few km
function inPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i], [yj, xj] = pts[j];
    if ((yi > p.lat) !== (yj > p.lat) && p.lon < (xj - xi) * (p.lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inFence = (f, p) => (f.kind === 'circle' ? distance(f, p) <= f.radius : inPolygon(p, f.points));

class Hq {
  constructor({ data, save, log }) {
    this.data = data;
    this.save = save;
    this.log = log || (() => {});
    this.live = new Map();    // uid -> device
    this.objects = new Map(); // uid -> map object { uid, type, xml, time, creator }
    this.inside = new Map();  // `${fence}|${uid}` -> true/false
    this.saveTimer = null;
    this.quietUntil = 0;      // right after connecting the server sends its stored picture: old markers are no warning
    const d = this.d();
    for (const k of ['fences', 'units', 'log', 'events']) d[k] = d[k] || [];
    d.seq = d.seq || 0;
  }

  d() { return this.data(); }
  connected(ms = 15000) { this.quietUntil = Date.now() + ms; }
  enabled() { return this.d().enabled !== false; }
  later() { if (!this.saveTimer) { this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 5000); this.saveTimer.unref?.(); } }

  event(kind, text, extra = {}) {
    const d = this.d();
    const ev = { seq: ++d.seq, t: Date.now(), kind, text, ...extra };
    d.events.push(ev);
    if (d.events.length > EVENTS_MAX) d.events.splice(0, d.events.length - EVENTS_MAX);
    this.later();
    return ev;
  }

  // ---------------- situation log (TSL) ----------------

  addLog({ from = '', to = '', kind = 'Report', text = '', auto = false } = {}) {
    const d = this.d();
    const e = { id: rid(), t: Date.now(), from: clean(from, 80), to: clean(to, 80), kind: LOG_KINDS.includes(kind) ? kind : 'Other', text: clean(text, 2000), auto: !!auto };
    if (!e.text) throw new Error('Enter the content.');
    d.log.push(e);
    if (d.log.length > LOG_MAX) d.log.splice(0, d.log.length - LOG_MAX);
    this.event('log', `${e.kind}: ${e.text}`, { log: e.id, auto: e.auto });
    return e;
  }
  removeLog(id) {
    const d = this.d();
    const i = d.log.findIndex(e => e.id === id);
    if (i >= 0) { d.log.splice(i, 1); this.later(); }
    return i >= 0;
  }
  csv() {
    const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    return ['No;Time;From;To;Kind;Content'].concat(this.d().log.map((e, i) => [i + 1, new Date(e.t).toISOString(), e.from, e.to, e.kind, e.text].map(q).join(';'))).join('\r\n') + '\r\n';
  }

  // troop list: units with status (and the TAK callsigns that belong to them)
  setUnits(list) {
    const d = this.d();
    d.units = (Array.isArray(list) ? list : []).slice(0, 300).map(u => ({
      id: /^[a-f0-9]{10}$/.test(u.id) ? u.id : rid(), name: clean(u.name, 60), kind: clean(u.kind, 40),
      status: UNIT_STATES.includes(u.status) ? u.status : 'Ready', strength: Math.max(0, Math.min(999, Number(u.strength) || 0)),
      callsigns: (Array.isArray(u.callsigns) ? u.callsigns : String(u.callsigns || '').split(',')).map(s => clean(s, 60)).filter(Boolean).slice(0, 50),
      note: clean(u.note, 300),
    })).filter(u => u.name);
    this.later();
    return d.units;
  }
  setUnitStatus(id, status, by = '') {
    const u = this.d().units.find(x => x.id === id);
    if (!u || !UNIT_STATES.includes(status) || u.status === status) return u || null;
    u.status = status;
    this.addLog({ from: u.name, kind: 'Troop report', text: `Status: ${status}${by ? ' (' + by + ')' : ''}`, auto: true });
    return u;
  }

  // ---------------- geofences ----------------

  setFences(list) {
    const d = this.d();
    d.fences = (Array.isArray(list) ? list : []).slice(0, 100).map(f => {
      const kind = f.kind === 'polygon' ? 'polygon' : 'circle';
      const out = { id: /^[a-f0-9]{10}$/.test(f.id) ? f.id : rid(), name: clean(f.name, 60) || 'Area', kind, color: /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#ffcc00', base: !!f.base, alert: f.alert !== false };
      if (kind === 'circle') Object.assign(out, { lat: Number(f.lat), lon: Number(f.lon), radius: Math.max(10, Math.min(100000, Number(f.radius) || 200)) });
      else out.points = (f.points || []).map(p => [Number(p[0]), Number(p[1])]).filter(p => p.every(Number.isFinite)).slice(0, 200);
      return out;
    }).filter(f => (f.kind === 'circle' ? Number.isFinite(f.lat) && Number.isFinite(f.lon) : f.points.length >= 3));
    // inside/outside is worked out again for the new areas (no departure/arrival from the change itself)
    this.inside.clear();
    for (const dev of this.live.values()) this.fenceCheck(dev, true);
    this.later();
    return d.fences;
  }

  fenceCheck(dev, quiet = false) {
    const changes = [];
    for (const f of this.d().fences) {
      const key = f.id + '|' + dev.uid;
      const now = inFence(f, dev);
      const was = this.inside.get(key);
      this.inside.set(key, now);
      if (was !== undefined && was !== now && !quiet) changes.push([f, now]);
    }
    // leaving one area before entering the next
    for (const [f, now] of changes.sort((a, b) => a[1] - b[1])) {
      const word = now ? (f.base ? 'arrived at' : 'entered') : (f.base ? 'departed from' : 'left');
      const text = `${dev.callsign} ${word} ${f.name}`;
      this.event(now ? 'fence-in' : 'fence-out', text, { uid: dev.uid, fence: f.id, alert: f.alert });
      if (f.base) this.addLog({ from: dev.callsign, kind: now ? 'Arrival' : 'Departure', text, auto: true });
    }
  }

  // ---------------- live picture ----------------

  cot(xml) {
    const ev = tag(xml, 'event');
    const type = attr(ev, 'type');
    if (!type || type.startsWith('t-x-c-t')) return;
    const p = parsePli(xml);
    if (p) return this.device(p, xml);
    const o = parseObject(xml);
    if (!o) return;
    if (o.type === 't-x-d-d') {
      const dev = this.live.get(o.target);
      if (dev && !xml.includes('__forcedelete')) { dev.offline = true; return; } // lost connection: greyed like in ATAK
      this.live.delete(o.target);
      this.objects.delete(o.target);
      return;
    }
    const first = !this.objects.has(o.uid);
    const pt = tag(xml, 'point');
    const obj = {
      uid: o.uid, type: o.type, creator: o.creator, time: Date.now(), xml,
      lat: Number(attr(pt, 'lat')), lon: Number(attr(pt, 'lon')),
      callsign: unesc(attr(tag(xml, 'contact'), 'callsign')), remarks: unesc((/<remarks\b[^>]*>([^<]*)</.exec(xml) || [])[1] || ''),
      video: unesc(attr(tag(xml, '__video'), 'url')),
    };
    this.objects.set(o.uid, obj);
    if (this.objects.size > OBJECTS_MAX) this.objects.delete(this.objects.keys().next().value);
    // a new hostile marker: warning on every HQ page and an entry in the log
    if (first && /^a-h-/.test(o.type) && Date.now() > this.quietUntil) {
      const by = (this.live.get(o.creator) || {}).callsign || o.creator || 'unknown';
      const text = `Hostile: ${obj.callsign || o.type}${obj.remarks ? ' – ' + obj.remarks : ''} (by ${by})`;
      this.event('hostile', text, { uid: o.uid, lat: obj.lat, lon: obj.lon, alert: true });
      this.addLog({ from: by, kind: 'Enemy report', text, auto: true });
    }
  }

  device(p, xml) {
    const now = Date.now();
    const takv = tag(xml, 'takv');
    const prev = this.live.get(p.uid);
    const dev = prev || { uid: p.uid, first: now };
    Object.assign(dev, {
      type: p.type, callsign: p.callsign, team: p.team, role: p.role, lat: p.lat, lon: p.lon, hae: p.hae, speed: p.speed, course: p.course,
      time: now, stale: Date.parse(attr(tag(xml, 'event'), 'stale')) || now + 120000, offline: false,
      platform: unesc(attr(takv, 'platform')), device: unesc(attr(takv, 'device')),
      mesh: /__meshtastic|platform="Meshtastic"/.test(xml) || p.uid.startsWith('MESH-'),
      battery: Number(attr(tag(xml, 'status'), 'battery')) || null,
      video: unesc(attr(tag(xml, '__video'), 'url')) || dev.video || '',
    });
    this.live.set(p.uid, dev);
    this.fenceCheck(dev);
  }

  // devices and objects without news for a long time leave the picture (like the 60 min in the app)
  sweep(now = Date.now()) {
    for (const [uid, dev] of this.live) if (now - dev.time > 60 * 60000) this.live.delete(uid);
  }

  // clean up the situation for long missions: hide earlier events, drop offline users / map objects from the view
  clear(what = []) {
    const d = this.d();
    if (what.includes('events')) d.clearedAt = Date.now();
    if (what.includes('offline')) {
      const now = Date.now();
      for (const [uid, x] of this.live) if (x.offline || now >= Math.max(x.stale, x.time + 120000)) this.live.delete(uid);
    }
    if (what.includes('objects')) this.objects.clear();
    this.later();
  }

  // everything for the HQ pages; events only after "since"
  state(since = 0) {
    const d = this.d();
    const now = Date.now();
    const devices = [...this.live.values()].map(x => ({
      uid: x.uid, callsign: x.callsign, team: x.team, role: x.role, type: x.type, lat: x.lat, lon: x.lon, speed: x.speed, course: x.course,
      time: x.time, first: x.first, online: !x.offline && now < Math.max(x.stale, x.time + 120000), mesh: x.mesh, platform: x.platform,
      battery: x.battery, video: x.video,
      fences: d.fences.filter(f => this.inside.get(f.id + '|' + x.uid)).map(f => f.id),
    }));
    const objects = [...this.objects.values()].map(o => ({ uid: o.uid, type: o.type, creator: o.creator, time: o.time, lat: o.lat, lon: o.lon, callsign: o.callsign, remarks: o.remarks, video: o.video, xml: o.xml.length < 8000 ? o.xml : '' }));
    return {
      seq: d.seq, now, enabled: this.enabled(), clearedAt: d.clearedAt || 0, devices, objects, fences: d.fences, units: d.units,
      events: d.events.filter(e => e.seq > since).slice(-200), log: d.log.slice(-500), kinds: LOG_KINDS, unitStates: UNIT_STATES,
    };
  }
}

module.exports = { Hq, inFence, inPolygon, LOG_KINDS, UNIT_STATES };
