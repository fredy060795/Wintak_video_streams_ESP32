// Mission tracks: while a mission is recorded, TAKweb listens to the own TAK server as a silent client and keeps every
// user's position (ATAK, iTAK, WinTAK, TAKweb, Meshtastic users passed on by a gateway). Afterwards the admin replays
// the mission on a map or exports it (GPX/KML).
// A mission starts now or at a planned time and ends by hand or at a planned time; it records everybody, chosen OTS groups
// or chosen users, and optionally the map objects (markers, drawings, routes …) with every change.
// Storage: mission list in the store (store.data.tracks.missions), the points of each mission as one line per point in
// DATA_DIR/tracks/<id>.jsonl: [time ms, uid, lat, lon, hae|null, speed m/s|null, course °|null], map objects in
// DATA_DIR/tracks/<id>.objects.jsonl: [time ms, uid, type, CoT XML].

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_GAP_MS = 5000;      // at most one point per user every 5 s
const KEEP_MS = 60000;        // standing still: one point a minute is enough
const MIN_MOVE_M = 3;
const SAVE_MS = 30000;        // mission summary (users, counts) saved at most this often while recording

const attr = (s, a) => { const m = new RegExp(`\\s${a}="([^"]*)"`).exec(s); return m ? m[1] : ''; };
const tag = (xml, name) => { const m = new RegExp(`<${name}\\b[^>]*>`).exec(xml); return m ? m[0] : ''; };
const num = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// position of a user (PLI) from a CoT event – null for markers, drawings, chat …
function parsePli(xml) {
  const ev = tag(xml, 'event');
  const type = attr(ev, 'type');
  if (!/^a-[fhnuajksop]-G/.test(type)) return null;
  // a user's device reports itself with group/takv/endpoint – a marker placed on the map has none of them
  if (!/<__group\b|<takv\b|<contact\b[^>]*\sendpoint="/.test(xml)) return null;
  const uid = attr(ev, 'uid');
  if (!uid || /^TAKWEB-/.test(uid)) return null;
  const pt = tag(xml, 'point');
  const lat = num(attr(pt, 'lat')), lon = num(attr(pt, 'lon'));
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const hae = num(attr(pt, 'hae'));
  const tr = tag(xml, 'track');
  const grp = tag(xml, '__group');
  const t = Date.parse(attr(ev, 'time'));
  return {
    uid, type, lat, lon, hae: hae != null && hae < 9e6 ? Math.round(hae) : null,
    speed: num(attr(tr, 'speed')), course: num(attr(tr, 'course')),
    callsign: unesc(attr(tag(xml, 'contact'), 'callsign')) || uid, team: unesc(attr(grp, 'name')), role: unesc(attr(grp, 'role')),
    time: Number.isFinite(t) ? t : Date.now(),
  };
}

function distance(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// objects drawn on the map (markers, spots, drawings, routes, range & bearing) and deletions – kept with every change
const OBJ = /^(a-|b-m-p-|b-m-r|u-d-|u-rb-a|b-a-o|t-x-d-d)/;
const OBJ_MAX = 20000; // larger events (e.g. huge drawings) are left out

// a map object from a CoT event: { uid, type, creator } – null for positions of users, pings, chat …
function parseObject(xml) {
  const ev = tag(xml, 'event');
  const type = attr(ev, 'type'), uid = attr(ev, 'uid');
  if (!uid || !OBJ.test(type) || /^TAKWEB-/.test(uid) || xml.length > OBJ_MAX) return null;
  if (type.startsWith('a-') && parsePli(xml)) return null; // a user's device: that is the track
  // creator: the device that placed it (<link relation="p-p">); a deletion names the object it removes
  const links = xml.match(/<link\b[^>]*>/g) || [];
  const parent = links.find(l => attr(l, 'relation') === 'p-p');
  const creator = parent ? attr(parent, 'uid') : '';
  const target = type === 't-x-d-d' && links.length ? attr(links[0], 'uid') : '';
  return { uid, type, creator, target };
}

const STATES = ['planned', 'recording', 'done'];
const stateOf = m => (m.end ? 'done' : m.start ? 'recording' : 'planned');

class Tracks {
  // data() -> store.data.tracks ({ missions: [...] }), save() -> persist the store,
  // accept(mission, uid) -> whether to record this device (who: all / groups / users – decided by the server),
  // onChange() -> a recording started or stopped by the schedule
  constructor({ dir, data, save, log, accept, onChange }) {
    this.dir = dir;
    this.data = data;
    this.save = save;
    this.log = log || (() => {});
    this.accept = accept || (() => true);
    this.onChange = onChange || (() => {});
    this.last = new Map();    // uid -> last kept point (current mission)
    this.lastObj = new Map(); // object uid -> hash of its last kept version
    this.fd = null;           // files of the recording mission (written at once – nothing lost on a crash)
    this.fdObj = null;
    this.saveTimer = null;
    fs.mkdirSync(dir, { recursive: true });
    const a = this.active();
    if (a) this.open(a); // recording goes on after a restart
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref?.();
    setTimeout(() => this.tick(), 0);
  }

  missions() { const d = this.data(); return (d.missions = d.missions || []); }
  active() { return this.missions().find(m => stateOf(m) === 'recording') || null; }
  get(id) { return this.missions().find(m => m.id === id) || null; }
  file(id, kind = '') { return path.join(this.dir, id.replace(/[^\w-]/g, '') + (kind ? '.' + kind : '') + '.jsonl'); }

  open(m) {
    this.close();
    try {
      this.fd = fs.openSync(this.file(m.id), 'a');
      if (m.objects !== false) this.fdObj = fs.openSync(this.file(m.id, 'objects'), 'a');
    } catch (e) { this.log('Tracks: ' + e.message); }
    this.last.clear();
    this.lastObj.clear();
  }

  close() {
    for (const k of ['fd', 'fdObj']) {
      if (this[k] != null) try { fs.closeSync(this[k]); } catch (e) { /* already closed */ }
      this[k] = null;
    }
  }

  // the window [from, to) of a mission; to = Infinity while open-ended
  span(m) { return [m.start || m.from || Date.now(), m.end || m.to || Infinity]; }
  overlaps(from, to, except) {
    return this.missions().some(m => m.id !== except && stateOf(m) !== 'done' && (() => { const [a, b] = this.span(m); return from < b && a < to; })());
  }

  // new mission: from/to in ms (from missing or in the past = start now, to missing = until stopped by hand)
  create({ name, from, to, who, objects = true, otsMission = '' } = {}) {
    const now = Date.now();
    from = Number(from) || 0;
    to = Number(to) || 0;
    const planned = from > now + 30000;
    const start = planned ? from : now;
    if (to && to <= start) throw new Error('The end must be after the start.');
    if (this.overlaps(start, to || Infinity)) throw new Error('Another mission is planned or recording at that time – only one recording at a time.');
    const w = who || {};
    const m = {
      id: crypto.randomBytes(6).toString('hex'),
      name: String(name || otsMission || '').trim().slice(0, 80) || 'Mission',
      otsMission: String(otsMission || '').slice(0, 120),
      from: planned ? from : null, to: to || null, start: null, end: null,
      who: { mode: ['groups', 'users'].includes(w.mode) ? w.mode : 'all', groups: (w.groups || []).map(String).slice(0, 200), users: (w.users || []).map(String).slice(0, 500) },
      objects: objects !== false, points: 0, objectCount: 0, users: {},
    };
    this.missions().unshift(m);
    if (!planned) this.begin(m, now);
    else { this.save(); this.log('Mission planned:', m.name, new Date(from).toISOString(), '–', to ? new Date(to).toISOString() : 'open end'); }
    return m;
  }

  begin(m, at = Date.now()) {
    if (this.active()) throw new Error('A mission is being recorded already – stop it first.');
    m.start = at;
    this.open(m);
    this.save();
    this.log('Mission recording started:', m.name);
    this.onChange();
    return m;
  }

  // start a planned mission right now
  startNow(id) {
    const m = this.get(id);
    if (!m || stateOf(m) !== 'planned') throw new Error('Only a planned mission can be started.');
    m.from = null;
    return this.begin(m);
  }

  stop(at = Date.now()) {
    const m = this.active();
    if (!m) return null;
    m.end = at;
    this.close();
    this.last.clear();
    this.lastObj.clear();
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
    this.log('Mission recording stopped:', m.name, `(${m.points} points, ${Object.keys(m.users).length} users, ${m.objectCount || 0} map objects)`);
    this.onChange();
    return m;
  }

  // the schedule: start planned missions, stop at the planned end
  tick(now = Date.now()) {
    const a = this.active();
    if (a && a.to && now >= a.to) this.stop(a.to);
    for (const m of this.missions().slice().reverse()) {
      if (stateOf(m) !== 'planned' || m.from > now) continue;
      if (m.to && m.to <= now) { m.start = m.from; m.end = m.to; m.missed = true; this.save(); continue; } // server was off the whole time
      if (!this.active()) this.begin(m, now);
    }
  }

  remove(id) {
    const list = this.missions();
    const i = list.findIndex(m => m.id === id);
    if (i < 0) return false;
    if (stateOf(list[i]) === 'recording') this.stop();
    list.splice(i, 1);
    fs.rmSync(this.file(id), { force: true });
    fs.rmSync(this.file(id, 'objects'), { force: true });
    this.save();
    return true;
  }

  // name, planned times (only before the start) and the planned end of a running recording
  edit(id, { name, from, to } = {}) {
    const m = this.get(id);
    if (!m) return null;
    if (name !== undefined) m.name = String(name || '').trim().slice(0, 80) || m.name;
    const st = stateOf(m);
    if (st !== 'done' && to !== undefined) {
      const t = Number(to) || null;
      if (t && t <= (m.start || Number(from) || m.from)) throw new Error('The end must be after the start.');
      m.to = t;
    }
    if (st === 'planned' && from !== undefined && Number(from)) m.from = Number(from);
    this.save();
    this.tick();
    return m;
  }

  // every CoT event from the TAK server
  cot(xml) {
    const m = this.active();
    if (!m || this.fd == null) return;
    const p = parsePli(xml);
    if (p) return this.point(m, p);
    if (this.fdObj != null) this.object(m, xml);
  }

  point(m, p) {
    const now = Date.now();
    // what the server sends right after connecting is its stored picture: only positions from during the mission
    if (p.time < m.start - 60000) return;
    if (!this.accept(m, p.uid, p.callsign)) return;
    const prev = this.last.get(p.uid);
    if (prev) {
      const dt = now - prev.at;
      if (dt < MIN_GAP_MS) return;
      if (dt < KEEP_MS && distance(prev, p) < MIN_MOVE_M) return;
    }
    const u = m.users[p.uid] || (m.users[p.uid] = { callsign: p.callsign, team: p.team, role: p.role, type: p.type, first: now, last: now, points: 0, meters: 0 });
    Object.assign(u, { callsign: p.callsign, team: p.team || u.team, role: p.role || u.role, last: now });
    if (prev) u.meters = Math.round(u.meters + distance(prev, p));
    u.points++;
    m.points++;
    this.last.set(p.uid, { lat: p.lat, lon: p.lon, at: now });
    try { fs.writeSync(this.fd, JSON.stringify([now, p.uid, p.lat, p.lon, p.hae, p.speed, p.course]) + '\n'); } catch (e) { this.log('Tracks: ' + e.message); }
    this.later();
  }

  object(m, xml) {
    const o = parseObject(xml);
    if (!o) return;
    // with a choice of users/groups: only what they placed (a deletion of something already kept always counts)
    if (m.who && m.who.mode !== 'all') {
      const known = o.type === 't-x-d-d' && this.lastObj.has(o.target);
      if (!known && !(o.creator && this.accept(m, o.creator, ''))) return;
    }
    // the same version again (the server repeats objects): kept once
    const body = xml.replace(/\s(time|start|stale)="[^"]*"/g, '');
    const hash = crypto.createHash('sha1').update(body).digest('hex');
    if (this.lastObj.get(o.uid) === hash) return;
    this.lastObj.set(o.uid, hash);
    m.objectCount = (m.objectCount || 0) + 1;
    try { fs.writeSync(this.fdObj, JSON.stringify([Date.now(), o.uid, o.type, xml]) + '\n'); } catch (e) { this.log('Tracks: ' + e.message); }
    this.later();
  }

  later() {
    if (!this.saveTimer) { this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, SAVE_MS); this.saveTimer.unref?.(); }
  }

  readLines(file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
    const out = [];
    for (const line of text.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch (e) { /* cut line (crash) */ } }
    return out;
  }

  // all points of a mission: [[t, uid, lat, lon, hae, speed, course], …] in time order
  points(id) { return this.readLines(this.file(id)); }
  // all versions of map objects: [[t, uid, type, xml], …] in time order
  objects(id) { return this.readLines(this.file(id, 'objects')); }

  // per user, in time order
  byUser(id) {
    const m = this.get(id);
    const tracks = new Map();
    for (const p of this.points(id)) {
      if (!tracks.has(p[1])) tracks.set(p[1], []);
      tracks.get(p[1]).push(p);
    }
    return [...tracks].map(([uid, pts]) => ({ uid, ...((m && m.users[uid]) || { callsign: uid }), pts }));
  }

  gpx(id) {
    const m = this.get(id);
    const iso = t => new Date(t).toISOString();
    const trk = this.byUser(id).map(u => `  <trk><name>${esc(u.callsign)}</name><desc>${esc([u.team, u.role].filter(Boolean).join(' · '))}</desc><trkseg>\n`
      + u.pts.map(p => `    <trkpt lat="${p[2]}" lon="${p[3]}">${p[4] != null ? `<ele>${p[4]}</ele>` : ''}<time>${iso(p[0])}</time></trkpt>`).join('\n')
      + '\n  </trkseg></trk>').join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="TAKweb" xmlns="http://www.topografix.com/GPX/1/1">\n`
      + `  <metadata><name>${esc(m ? m.name : id)}</name>${m ? `<time>${iso(m.start)}</time>` : ''}</metadata>\n${trk}\n</gpx>\n`;
  }

  // KML with gx:Track – Google Earth (and ATAK) replay it with the time slider
  kml(id) {
    const m = this.get(id);
    const COLORS = { Cyan: 'ffffff00', Blue: 'ffff0000', 'Dark Blue': 'ff8b0000', Green: 'ff00ff00', 'Dark Green': 'ff006400', Red: 'ff0000ff', Maroon: 'ff000080', Orange: 'ff00a5ff', Yellow: 'ff00ffff', Magenta: 'ffff00ff', Purple: 'ff800080', Teal: 'ff808000', Brown: 'ff2a2aa5', White: 'ffffffff' };
    const iso = t => new Date(t).toISOString();
    const marks = this.byUser(id).map(u => `    <Placemark><name>${esc(u.callsign)}</name><description>${esc([u.team, u.role].filter(Boolean).join(' · '))}</description>`
      + `<Style><LineStyle><color>${COLORS[u.team] || 'ff00ffff'}</color><width>3</width></LineStyle></Style>`
      + '<gx:Track><altitudeMode>clampToGround</altitudeMode>\n'
      + u.pts.map(p => `      <when>${iso(p[0])}</when>`).join('\n') + '\n'
      + u.pts.map(p => `      <gx:coord>${p[3]} ${p[2]} ${p[4] != null ? p[4] : 0}</gx:coord>`).join('\n')
      + '\n    </gx:Track></Placemark>').join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">\n`
      + `  <Document><name>${esc(m ? m.name : id)}</name>\n${marks}\n  </Document>\n</kml>\n`;
  }
}

module.exports = { Tracks, parsePli, parseObject, distance, stateOf, STATES };
