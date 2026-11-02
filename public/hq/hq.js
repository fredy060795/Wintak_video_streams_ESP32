// TAKweb HQ: live situation from the own TAK server (server: lib/hq.js), several pages – each can run on its own monitor
// (open it in a new window). Data every 2 s from /api/admin/hq/state; warnings for new hostile markers on every page.
'use strict';

const $ = id => document.getElementById(id);
const TEAMS = {
  White: '#FFFFFF', Yellow: '#FFFF00', Orange: '#FF7700', Magenta: '#FF00FF', Red: '#FF0000', Maroon: '#7F0000',
  Purple: '#7F007F', 'Dark Blue': '#00007F', Blue: '#0000FF', Cyan: '#00FFFF', Teal: '#007F7F', Green: '#00FF00',
  'Dark Green': '#007F00', Brown: '#A0714F',
};
const ROLE_FILTERS = ['Team Lead', 'Team Member', 'HQ', 'Medic', 'Sniper', 'RTO', 'Forward Observer', 'K9'];
const fmtTime = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = t => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round(s % 3600 / 60)} min`; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== '') e.append(c);
  return e;
}
function setMsg(e, text, ok) { e.textContent = text || ''; e.className = 'msg' + (text ? (ok ? ' ok' : ' err') : ''); }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/admin/hq/' + path, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'helm', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (res.status === 401) { location.href = '/admin/'; throw new Error('Please log in to the admin.'); }
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

// ======================================================================
// Pages
// ======================================================================

let page = 'overview';
function showPage(p) {
  if (!document.querySelector(`.page[data-page="${p}"]`)) p = 'overview';
  page = p;
  for (const s of document.querySelectorAll('.page')) s.classList.toggle('hidden', s.dataset.page !== p);
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.page === p);
  document.title = `TAKweb HQ – ${document.querySelector(`#nav a[data-page="${p}"]`).textContent}`;
  if (location.hash.slice(1) !== p) history.replaceState(null, '', '#' + p);
  setTimeout(() => { for (const m of Object.values(maps)) m.invalidateSize(); }, 50);
  if (p === 'video') loadFeeds();
  render();
}
for (const a of document.querySelectorAll('#nav a')) a.addEventListener('click', e => { e.preventDefault(); showPage(a.dataset.page); });
window.addEventListener('hashchange', () => showPage(location.hash.slice(1)));
$('btnWin').addEventListener('click', () => window.open('/hq/#' + page, 'hq-' + page + '-' + Date.now(), 'width=1400,height=900'));
$('btnFull').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}));
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);

// ======================================================================
// Data
// ======================================================================

let S = { devices: [], objects: [], fences: [], units: [], log: [], events: [], kinds: [], unitStates: [] };
let seq = -1;           // last event seen
let firstLoad = true;
const allEvents = [];

async function poll() {
  try {
    const r = await api('state?since=' + Math.max(0, seq));
    const fresh = seq >= 0 ? r.events.filter(e => e.seq > seq) : [];
    for (const e of (seq < 0 ? r.events : fresh)) allEvents.push(e);
    if (allEvents.length > 1000) allEvents.splice(0, allEvents.length - 1000);
    seq = r.seq;
    S = r;
    const src = r.source || {};
    $('srcState').textContent = !src.available ? 'OTS not set up' : !r.enabled ? 'Live picture off' : src.state === 'connected' ? 'TAK server live' : (src.message || src.state || '…');
    $('srcState').className = 'pill ' + (src.state === 'connected' ? 'ok' : 'err');
    $('srcState').title = src.message || '';
    $('recState').classList.toggle('hidden', !r.recording);
    if (r.recording) $('recState').title = 'Mission recording: ' + r.recording.name;
    if (!firstLoad) for (const e of fresh) notify(e);
    firstLoad = false;
    render();
  } catch (e) {
    $('srcState').textContent = 'HQ server not reachable';
    $('srcState').className = 'pill err';
  }
  setTimeout(poll, 2000);
}

// ======================================================================
// Warnings
// ======================================================================

let audio = null;
function beep() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < 3; i++) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.25, audio.currentTime + i * 0.35);
      g.gain.setValueAtTime(0, audio.currentTime + i * 0.35 + 0.2);
      o.start(audio.currentTime + i * 0.35); o.stop(audio.currentTime + i * 0.35 + 0.22);
    }
  } catch (e) { /* no sound */ }
}
document.addEventListener('click', () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) { /* no sound */ } }, { once: true });

let alertEv = null;
function notify(e) {
  if (e.kind === 'hostile') {
    alertEv = e;
    $('alertText').textContent = e.text;
    $('alertTime').textContent = fmtDate(e.t);
    $('alert').classList.remove('hidden');
    beep();
  } else if (e.alert && /^fence/.test(e.kind)) {
    toast(e.text, e.kind);
  }
}
$('alertOk').addEventListener('click', () => $('alert').classList.add('hidden'));
$('alertShow').addEventListener('click', () => {
  $('alert').classList.add('hidden');
  showPage('overview');
  if (alertEv && Number.isFinite(alertEv.lat)) maps.overview.setView([alertEv.lat, alertEv.lon], Math.max(maps.overview.getZoom(), 15));
});
function toast(text, cls = '') {
  const t = el('div', { class: 'toast ' + cls, text });
  $('toasts').append(t);
  setTimeout(() => t.remove(), 8000);
}

// ======================================================================
// Filters (role / team / mesh), shared by the situation map and the troop list
// ======================================================================

const filter = { roles: new Set(), mesh: false, offline: true };
function roleOf(d) { return d.role || 'Team Member'; }
function passes(d) {
  if (filter.mesh && !d.mesh) return false;
  if (filter.roles.size && !filter.roles.has(roleOf(d))) return false;
  return true;
}
function renderFilters(box) {
  const counts = {};
  for (const d of S.devices) counts[roleOf(d)] = (counts[roleOf(d)] || 0) + 1;
  const roles = [...new Set(ROLE_FILTERS.concat(Object.keys(counts)))];
  const chip = (label, on, n, click) => el('span', { class: 'chip' + (on ? ' on' : ''), onclick: click }, label, n != null ? el('b', { text: String(n) }) : '');
  box.replaceChildren(
    chip('All', !filter.roles.size && !filter.mesh, S.devices.length, () => { filter.roles.clear(); filter.mesh = false; render(); }),
    ...roles.filter(r => counts[r] || ROLE_FILTERS.includes(r)).map(r => chip(r, filter.roles.has(r), counts[r] || 0, () => { if (filter.roles.has(r)) filter.roles.delete(r); else filter.roles.add(r); render(); })),
    chip('📡 Mesh', filter.mesh, S.devices.filter(d => d.mesh).length, () => { filter.mesh = !filter.mesh; render(); }),
  );
}

// ======================================================================
// Maps
// ======================================================================

const maps = {};
function makeMap(id) {
  const m = L.map(id, { zoomControl: true, worldCopyJump: true });
  const base = {
    'OpenStreetMap': L.tileLayer('/eud/tiles/osm/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
    'Topo': L.tileLayer('/eud/tiles/topo/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' }),
    'Satellite': L.tileLayer('/eud/tiles/sat/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© Esri' }),
  };
  let pick = 'OpenStreetMap';
  try { pick = localStorage.getItem('hq.base') || pick; } catch (e) { /* private mode */ }
  (base[pick] || base.OpenStreetMap).addTo(m);
  L.control.layers(base).addTo(m);
  m.on('baselayerchange', e => { try { localStorage.setItem('hq.base', e.name); } catch (err) { /* private mode */ } });
  m.setView([48, 11], 5);
  return m;
}

function sidcFor(type) {
  const p = type.split('-');
  if (p[0] !== 'a' || p.length < 3) return null;
  const aff = ({ f: 'F', h: 'H', n: 'N', u: 'U', a: 'A', s: 'S', j: 'J', k: 'K', p: 'P' })[p[1]] || 'U';
  const dim = ({ P: 'P', A: 'A', G: 'G', S: 'S', U: 'U', F: 'F', X: 'X' })[p[2]] || 'G';
  return 'S' + aff + dim + 'P' + p.slice(3).join('').slice(0, 6).padEnd(6, '-') + '-----';
}
const symCache = new Map();
function symbolIcon(type) {
  if (!symCache.has(type)) {
    let icon = null;
    try {
      let s = new ms.Symbol(sidcFor(type), { size: 24 });
      if (!s.isValid()) s = new ms.Symbol(sidcFor(type).slice(0, 4) + '-----------', { size: 24 });
      const a = s.getAnchor(), z = s.getSize();
      icon = L.divIcon({ className: 'sym', html: s.asSVG(), iconSize: [z.width, z.height], iconAnchor: [a.x, a.y] });
    } catch (e) { icon = null; }
    symCache.set(type, icon);
  }
  return symCache.get(type);
}
function deviceIcon(d) {
  const c = TEAMS[d.team] || '#00FFFF';
  const arrow = Number.isFinite(d.course) && d.speed > 0.5
    ? `<path d="M12 1 L16 9 L12 7 L8 9 Z" fill="#fff" stroke="#000" stroke-width="1" transform="rotate(${d.course} 12 12)"/>` : '';
  const html = `<svg width="24" height="24" viewBox="0 0 24 24" style="opacity:${d.online ? 1 : 0.4}"><circle cx="12" cy="12" r="7" fill="${c}" stroke="#000" stroke-width="2"/>${arrow}${d.mesh ? '<circle cx="19" cy="5" r="3.5" fill="#67ea94" stroke="#000"/>' : ''}</svg>`;
  return L.divIcon({ className: 'sym', html, iconSize: [24, 24], iconAnchor: [12, 12] });
}

// map objects drawn by users (markers, spots, drawings, routes) from their CoT
const argb = v => { const n = Number(v); if (v == null || v === '' || !Number.isFinite(n)) return null; const u = n >>> 0; return { color: '#' + (u & 0xffffff).toString(16).padStart(6, '0'), opacity: ((u >>> 24) & 255) / 255 }; };
function objectLayer(o) {
  if (o.type.startsWith('a-') && Number.isFinite(o.lat)) {
    const icon = symbolIcon(o.type);
    const mk = icon ? L.marker([o.lat, o.lon], { icon }) : L.circleMarker([o.lat, o.lon], { radius: 6 });
    return mk.bindTooltip(esc([o.callsign, o.remarks].filter(Boolean).join(' – ')) || o.type, { className: 'lbl', direction: 'top' });
  }
  if (!o.xml) return Number.isFinite(o.lat) && !(o.lat === 0 && o.lon === 0) ? L.circleMarker([o.lat, o.lon], { radius: 5, color: '#000', weight: 1, fillColor: '#ffcc00', fillOpacity: 1 }) : null;
  const doc = new DOMParser().parseFromString(o.xml, 'application/xml');
  const ev = doc.documentElement;
  const q = s => ev.querySelector(s);
  const stroke = argb(q('strokeColor') && q('strokeColor').getAttribute('value')) || { color: '#ffcc00', opacity: 1 };
  const fill = argb(q('fillColor') && q('fillColor').getAttribute('value'));
  const style = { color: stroke.color, weight: Number(q('strokeWeight') && q('strokeWeight').getAttribute('value')) || 3, fill: !!fill, fillColor: fill ? fill.color : undefined, fillOpacity: fill ? Math.min(0.4, fill.opacity) : 0 };
  const pts = [...ev.querySelectorAll('link[point]')].map(l => l.getAttribute('point').split(',').map(Number)).filter(p => p.length >= 2 && p.every(Number.isFinite)).map(p => [p[0], p[1]]);
  let layer = null;
  if (/^u-d-c-[ce]/.test(o.type)) {
    const e = q('shape ellipse');
    if (e) layer = L.circle([o.lat, o.lon], { radius: Number(e.getAttribute('major')) || 50, ...style });
  } else if (/^(u-d-|b-m-r)/.test(o.type) && pts.length >= 2) {
    const closed = o.type === 'u-d-r' || (q('closed') && q('closed').getAttribute('value') === 'true');
    layer = closed ? L.polygon(pts, style) : L.polyline(pts, { ...style, fill: false });
  } else if (Number.isFinite(o.lat) && !(o.lat === 0 && o.lon === 0)) {
    const c = argb(q('color') && q('color').getAttribute('argb')) || stroke;
    layer = L.circleMarker([o.lat, o.lon], { radius: 6, color: '#000', weight: 1.5, fillColor: c.color, fillOpacity: 1 });
  }
  if (layer && (o.callsign || o.remarks)) layer.bindTooltip(esc([o.callsign, o.remarks].filter(Boolean).join(' – ')), { className: 'lbl', direction: 'top' });
  return layer;
}

function fenceLayer(f) {
  const style = { color: f.color, weight: f.base ? 3 : 2, dashArray: f.base ? null : '6 4', fillOpacity: 0.08 };
  const l = f.kind === 'circle' ? L.circle([f.lat, f.lon], { radius: f.radius, ...style }) : L.polygon(f.points, style);
  return l.bindTooltip(esc(f.name) + (f.base ? ' (base)' : ''), { className: 'lbl' });
}

// ---------------- situation map ----------------
const ov = { devs: L.layerGroup(), objs: L.layerGroup(), fences: L.layerGroup(), trails: L.layerGroup(), fitted: false, objKey: '' };
function renderOverview() {
  if (!maps.overview) {
    maps.overview = makeMap('mapOverview');
    for (const k of ['fences', 'trails', 'objs', 'devs']) ov[k].addTo(maps.overview);
    L.control.layers(null, { 'Tracks (last 20 min)': ov.trails, 'Markers & drawings': ov.objs, 'Areas': ov.fences }, { position: 'topleft' }).addTo(maps.overview);
  }
  renderFilters($('ovFilters'));
  const shown = S.devices.filter(passes);
  ov.devs.clearLayers();
  ov.trails.clearLayers();
  const since = Date.now() - 20 * 60000;
  for (const d of shown) {
    const t = d.trail.filter(p => p[0] >= since).map(p => [p[1], p[2]]);
    if (t.length > 1) ov.trails.addLayer(L.polyline(t, { color: TEAMS[d.team] || '#0ff', weight: 2, opacity: 0.6 }));
    ov.devs.addLayer(L.marker([d.lat, d.lon], { icon: deviceIcon(d), zIndexOffset: 1000 })
      .bindTooltip(`${esc(d.callsign)}${d.role && d.role !== 'Team Member' ? ' · ' + esc(d.role) : ''}`, { permanent: true, direction: 'right', offset: [10, 0], className: 'lbl' })
      .bindPopup(`<b>${esc(d.callsign)}</b><br>${esc(d.team || '')} · ${esc(roleOf(d))}<br>${d.online ? 'online' : 'offline'} · last ${ago(d.time)} ago${d.battery ? '<br>battery ' + d.battery + ' %' : ''}${d.speed > 0.5 ? '<br>' + (d.speed * 3.6).toFixed(0) + ' km/h' : ''}`));
  }
  const key = S.objects.map(o => o.uid + o.time).join() + S.fences.map(f => f.id).join();
  if (key !== ov.objKey) {
    ov.objKey = key;
    ov.objs.clearLayers();
    for (const o of S.objects) { const l = objectLayer(o); if (l) ov.objs.addLayer(l); }
    ov.fences.clearLayers();
    for (const f of S.fences) ov.fences.addLayer(fenceLayer(f));
  }
  if (!ov.fitted && shown.length) { ov.fitted = true; maps.overview.fitBounds(L.latLngBounds(shown.map(d => [d.lat, d.lon])), { maxZoom: 15, padding: [40, 40] }); }
  const online = S.devices.filter(d => d.online);
  const hostile = S.objects.filter(o => /^a-h-/.test(o.type)).length;
  const base = S.fences.filter(f => f.base).map(f => f.id);
  const atBase = online.filter(d => d.fences.some(id => base.includes(id))).length;
  const count = (n, label, cls = '') => el('div', { class: 'count ' + cls }, el('b', { text: String(n) }), el('span', { text: label }));
  $('ovCounts').replaceChildren(count(online.length, 'online'), count(S.devices.length - online.length, 'offline'), count(hostile, 'hostile', 'hostile'),
    count(base.length ? atBase : '–', 'at base'), count(base.length ? online.length - atBase : '–', 'out'), count(S.devices.filter(d => d.mesh).length, 'mesh'));
  renderEvents($('ovEvents'), allEvents.filter(e => !(e.kind === 'log' && e.auto)).slice(-30).reverse());
}

function renderEvents(box, list) {
  box.replaceChildren(...list.map(e => el('li', { class: e.kind }, el('time', { text: fmtTime(e.t) }), e.text)));
  if (!list.length) box.append(el('li', { class: 'mut', text: 'Nothing yet.' }));
}

// ---------------- troops ----------------
function renderTroops() {
  renderFilters($('trFilters'));
  const teams = [...new Set(S.devices.map(d => d.team).filter(Boolean))].sort();
  const sel = $('trTeam');
  const cur = sel.value;
  if (sel.options.length - 1 !== teams.length) sel.replaceChildren(el('option', { value: '', text: 'All teams' }), ...teams.map(t => el('option', { value: t, text: t })));
  sel.value = teams.includes(cur) ? cur : '';
  const q = $('trSearch').value.trim().toLowerCase();
  const list = S.devices.filter(passes)
    .filter(d => (!sel.value || d.team === sel.value) && (!$('trOnline').checked || d.online) && (!q || d.callsign.toLowerCase().includes(q)))
    .sort((a, b) => (b.online - a.online) || a.callsign.localeCompare(b.callsign));
  const fname = id => (S.fences.find(f => f.id === id) || {}).name || '';
  $('trCount').textContent = `${list.length} shown · ${S.devices.filter(d => d.online).length} online`;
  $('trTable').tBodies[0].replaceChildren(...list.map(d => el('tr', { class: d.online ? '' : 'off' },
    el('td', {}, el('span', { class: 'dot', style: `background:${TEAMS[d.team] || '#0ff'}` }), el('b', { text: d.callsign })),
    el('td', { text: d.team || '–' }),
    el('td', { text: roleOf(d) }),
    el('td', { text: d.online ? '● online' : '○ offline', style: `color:${d.online ? 'var(--ok)' : 'var(--mut)'}` }),
    el('td', { text: ago(d.time) + ' ago' }),
    el('td', { text: d.fences.map(fname).join(', ') || '–' }),
    el('td', { text: d.speed > 0.5 ? (d.speed * 3.6).toFixed(0) + ' km/h' : '–' }),
    el('td', { text: d.battery ? d.battery + ' %' : '–' }),
    el('td', { class: 'small mut', text: (d.mesh ? '📡 Mesh ' : '') + (d.platform || '') }),
    el('td', {}, el('button', { type: 'button', text: '⌖', title: 'Show on the map', onclick: () => { showPage('overview'); maps.overview.setView([d.lat, d.lon], 16); } })))));
}
for (const id of ['trSearch', 'trTeam', 'trOnline']) $(id).addEventListener('input', renderTroops);

// ---------------- geofences ----------------
let fences = null; // working copy while editing
let drawing = null;
const fc = { layer: L.layerGroup(), temp: L.layerGroup() };
function renderFences() {
  if (!maps.fences) {
    maps.fences = makeMap('mapFences');
    fc.layer.addTo(maps.fences); fc.temp.addTo(maps.fences);
    maps.fences.on('click', fenceClick);
    maps.fences.on('dblclick', e => { if (drawing && drawing.kind === 'polygon') { L.DomEvent.stop(e); finishPolygon(); } });
  }
  if (!fences) {
    fences = JSON.parse(JSON.stringify(S.fences || []));
    const all = fences.flatMap(f => (f.kind === 'circle' ? [[f.lat, f.lon]] : f.points));
    if (all.length) maps.fences.fitBounds(L.latLngBounds(all), { maxZoom: 16, padding: [40, 40] });
    else if (S.devices.length) maps.fences.fitBounds(L.latLngBounds(S.devices.map(d => [d.lat, d.lon])), { maxZoom: 15 });
    drawFenceList();
  }
  fc.layer.clearLayers();
  for (const f of fences) fc.layer.addLayer(fenceLayer(f));
  for (const d of S.devices.filter(x => x.online)) fc.layer.addLayer(L.marker([d.lat, d.lon], { icon: deviceIcon(d) }).bindTooltip(esc(d.callsign), { className: 'lbl', direction: 'right' }));
  renderEvents($('fcEvents'), allEvents.filter(e => /^fence/.test(e.kind)).slice(-50).reverse());
}
function drawFenceList() {
  $('fcList').replaceChildren(...fences.map((f, i) => {
    const name = el('input', { type: 'text', value: f.name }); name.addEventListener('input', () => { f.name = name.value; });
    const color = el('input', { type: 'color', value: f.color }); color.addEventListener('input', () => { f.color = color.value; renderFences(); });
    const base = el('input', { type: 'checkbox' }); base.checked = !!f.base; base.addEventListener('change', () => { f.base = base.checked; renderFences(); });
    const alertBox = el('input', { type: 'checkbox' }); alertBox.checked = f.alert !== false; alertBox.addEventListener('change', () => { f.alert = alertBox.checked; });
    const inside = S.devices.filter(d => d.fences.includes(f.id)).map(d => d.callsign);
    return el('div', { class: 'fence' },
      el('div', { class: 'row' }, color, name, el('button', { type: 'button', class: 'danger', text: '🗑', onclick: () => { fences.splice(i, 1); drawFenceList(); renderFences(); } })),
      el('div', { class: 'row' }, el('label', { class: 'check small' }, base, ' base (departure/arrival)'), el('label', { class: 'check small' }, alertBox, ' notify')),
      el('div', { class: 'mut small', text: (f.kind === 'circle' ? `Circle ${Math.round(f.radius)} m` : `Polygon, ${f.points.length} corners`) + (inside.length ? ` · inside: ${inside.join(', ')}` : '') }));
  }));
  if (!fences.length) $('fcList').append(el('p', { class: 'mut small', text: 'No areas yet.' }));
}
function startDraw(kind) {
  drawing = { kind, pts: [] };
  maps.fences.doubleClickZoom.disable();
  $('fcCancel').classList.remove('hidden');
  setMsg($('fcMsg'), kind === 'circle' ? 'Click the centre of the circle.' : 'Click the corners, double click to finish.', true);
}
function stopDraw() {
  drawing = null;
  fc.temp.clearLayers();
  maps.fences.doubleClickZoom.enable();
  $('fcCancel').classList.add('hidden');
}
function fenceClick(e) {
  if (!drawing) return;
  drawing.pts.push([e.latlng.lat, e.latlng.lng]);
  fc.temp.clearLayers();
  if (drawing.kind === 'circle') {
    if (drawing.pts.length === 1) { fc.temp.addLayer(L.circleMarker(e.latlng, { radius: 4 })); setMsg($('fcMsg'), 'Now click the edge.', true); return; }
    const c = L.latLng(drawing.pts[0]);
    fences.push({ name: 'Area ' + (fences.length + 1), kind: 'circle', lat: c.lat, lon: c.lng, radius: Math.round(c.distanceTo(e.latlng)), color: '#ffcc00', base: !fences.some(f => f.base), alert: true });
    stopDraw(); drawFenceList(); renderFences(); setMsg($('fcMsg'), 'Area added – name it and save.', true);
  } else {
    fc.temp.addLayer(L.polyline(drawing.pts, { color: '#ffcc00', dashArray: '4 4' }));
  }
}
function finishPolygon() {
  const pts = drawing.pts.filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
  if (pts.length < 3) return setMsg($('fcMsg'), 'A polygon needs at least 3 corners.');
  fences.push({ name: 'Area ' + (fences.length + 1), kind: 'polygon', points: pts, color: '#ffcc00', base: !fences.some(f => f.base), alert: true });
  stopDraw(); drawFenceList(); renderFences(); setMsg($('fcMsg'), 'Area added – name it and save.', true);
}
$('fcCircle').addEventListener('click', () => startDraw('circle'));
$('fcPoly').addEventListener('click', () => startDraw('polygon'));
$('fcCancel').addEventListener('click', () => { stopDraw(); setMsg($('fcMsg'), ''); });
$('fcSave').addEventListener('click', async () => {
  try { const r = await api('fences', { method: 'POST', body: { fences } }); fences = r.fences; S.fences = r.fences; drawFenceList(); renderFences(); setMsg($('fcMsg'), 'Areas saved.', true); } catch (e) { setMsg($('fcMsg'), e.message); }
});

// ---------------- situation log ----------------
let unitsDrawn = '';
function renderLog() {
  const key = JSON.stringify(S.units);
  if (key !== unitsDrawn) {
    unitsDrawn = key;
    $('unitList').replaceChildren(...S.units.map(u => {
      const st = el('select', {}, ...S.unitStates.map(s => el('option', { value: s, text: s })));
      st.value = u.status;
      st.addEventListener('change', async () => { try { await api(`units/${u.id}/status`, { method: 'POST', body: { status: st.value } }); } catch (e) { setMsg($('lgMsg'), e.message); } });
      const online = S.devices.filter(d => d.online && u.callsigns.some(c => c.toLowerCase() === d.callsign.toLowerCase())).length;
      return el('div', { class: 'unit' },
        el('b', { text: u.name }), el('span', { class: 'mut small', text: ` ${u.kind || ''}${u.strength ? ' · ' + u.strength + ' pers.' : ''}` }),
        el('div', { class: 'row' }, st, el('span', { class: 'small state-' + u.status.replace(/\s+/g, '-'), text: u.callsigns.length ? `${online}/${u.callsigns.length} online` : '' })));
    }));
    if (!S.units.length) $('unitList').append(el('p', { class: 'mut small', text: 'No units yet – add them below.' }));
    if (document.activeElement !== $('unitText')) $('unitText').value = S.units.map(u => [u.name, u.kind, u.strength || '', u.callsigns.join(', ')].join('; ')).join('\n');
    const names = S.units.map(u => u.name).concat(S.devices.map(d => d.callsign)).filter((v, i, a) => a.indexOf(v) === i);
    for (const [id, first] of [['lgFrom', '– From –'], ['lgTo', '– To –']]) {
      const s = $(id), v = s.value;
      s.replaceChildren(el('option', { value: '', text: first }), el('option', { value: 'HQ', text: 'HQ' }), ...names.map(n => el('option', { value: n, text: n })));
      s.value = v;
    }
  }
  if ($('lgKind').options.length !== S.kinds.length) $('lgKind').replaceChildren(...S.kinds.map(k => el('option', { value: k, text: k })));
  const rows = S.log.slice().reverse();
  const start = S.log.length;
  $('logTable').tBodies[0].replaceChildren(...rows.map((e, i) => el('tr', {},
    el('td', { class: 'mut', text: String(start - i) }),
    el('td', { text: fmtDate(e.t) }),
    el('td', { text: e.from || '–' }), el('td', { text: e.to || '–' }),
    el('td', {}, el('span', { class: 'kind k-' + e.kind.split(' ')[0], text: e.kind })),
    el('td', { text: e.text }),
    el('td', {}, el('button', { type: 'button', class: 'danger', text: '✕', title: 'Delete entry', onclick: async () => { if (!confirm('Delete this entry?')) return; try { await api('log/' + e.id, { method: 'DELETE' }); } catch (err) { setMsg($('lgMsg'), err.message); } } })))));
}
$('logForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('lgText').value.trim();
  if (!text) return;
  try {
    await api('log', { method: 'POST', body: { from: $('lgFrom').value, to: $('lgTo').value, kind: $('lgKind').value, text } });
    $('lgText').value = '';
    setMsg($('lgMsg'), '');
  } catch (err) { setMsg($('lgMsg'), err.message); }
});
$('lgMed').addEventListener('click', () => $('medForm').classList.toggle('hidden'));
$('medForm').addEventListener('submit', async e => {
  e.preventDefault();
  const parts = [['Priority', $('mdPrio').value], ['M', $('mdM').value], ['I', $('mdI').value], ['S', $('mdS').value], ['T', $('mdT').value]].filter(p => p[1].trim());
  if (!parts.length) return;
  try {
    await api('log', { method: 'POST', body: { from: $('lgFrom').value, to: $('lgTo').value, kind: 'Medical', text: parts.map(p => `${p[0]}: ${p[1].trim()}`).join(' | ') } });
    for (const id of ['mdM', 'mdI', 'mdS', 'mdT']) $(id).value = '';
    $('mdPrio').value = '';
    $('medForm').classList.add('hidden');
  } catch (err) { setMsg($('lgMsg'), err.message); }
});
$('unitSave').addEventListener('click', async () => {
  const units = $('unitText').value.split('\n').map(l => l.split(';').map(s => s.trim())).filter(p => p[0])
    .map(([name, kind, strength, callsigns]) => ({ ...(S.units.find(u => u.name === name) || {}), name, kind: kind || '', strength: Number(strength) || 0, callsigns: (callsigns || '').split(',').map(s => s.trim()).filter(Boolean) }));
  try { const r = await api('units', { method: 'POST', body: { units } }); S.units = r.units; unitsDrawn = ''; renderLog(); setMsg($('lgMsg'), 'Units saved.', true); } catch (e) { setMsg($('lgMsg'), e.message); }
});

// ---------------- video wall ----------------
let feeds = [];
const tiles = [];
async function loadFeeds() {
  try { feeds = (await api('feeds')).feeds; } catch (e) { feeds = []; }
  layoutWall();
}
function layoutWall() {
  const n = Number($('vwLayout').value);
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('hq.wall') || '[]'); } catch (e) { /* private mode */ }
  $('wall').className = 'wall n' + n;
  while (tiles.length > n) { const t = tiles.pop(); stopTile(t); t.box.remove(); }
  while (tiles.length < n) {
    const box = el('div', { class: 'tile' });
    const sel = el('select');
    const t = { box, sel, media: null, hls: null };
    sel.addEventListener('change', () => { playTile(t); saveWall(); });
    box.append(sel, el('div', { class: 'empty', text: 'Choose a source' }));
    $('wall').append(box);
    tiles.push(t);
  }
  tiles.forEach((t, i) => {
    const v = t.sel.value || saved[i] || '';
    t.sel.replaceChildren(el('option', { value: '', text: '– source –' }), ...feeds.map(f => el('option', { value: f.url, text: `${f.kind}: ${f.name}` })));
    t.sel.value = feeds.some(f => f.url === v) ? v : '';
    if ((t.playing || '') !== t.sel.value) playTile(t);
  });
}
function saveWall() { try { localStorage.setItem('hq.wall', JSON.stringify(tiles.map(t => t.sel.value))); } catch (e) { /* private mode */ } }
function stopTile(t) {
  if (t.hls) { t.hls.destroy(); t.hls = null; }
  if (t.media) { t.media.remove(); t.media = null; }
}
function playTile(t) {
  stopTile(t);
  const url = t.sel.value;
  t.playing = url;
  const empty = t.box.querySelector('.empty');
  if (empty) empty.classList.toggle('hidden', !!url);
  if (!url) return;
  const f = feeds.find(x => x.url === url) || {};
  if (f.mjpeg) {
    t.media = el('img', { src: url.replace(/\/stream\.ts$/, '') + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), alt: '' });
  } else {
    const v = el('video', { muted: '', autoplay: '', playsinline: '', controls: '' });
    v.muted = true;
    const src = /^https?:/.test(url) && new URL(url).origin !== location.origin ? '/api/eud/media?u=' + encodeURIComponent(url) : url;
    if (/\.m3u8/i.test(url) && window.Hls && Hls.isSupported()) { t.hls = new Hls({ liveSyncDurationCount: 2 }); t.hls.loadSource(src); t.hls.attachMedia(v); } else v.src = src;
    t.media = v;
  }
  t.box.append(t.media);
}
$('vwLayout').addEventListener('change', layoutWall);
$('vwReload').addEventListener('click', loadFeeds);

// ---------------- events ----------------
function renderEventPage() {
  const k = $('evKind').value;
  // automatic log entries (departure, hostile …) are already there as their own event
  renderEvents($('evList'), allEvents.filter(e => (k ? e.kind.startsWith(k) : !(e.kind === 'log' && e.auto))).slice().reverse());
}
$('evKind').addEventListener('change', renderEventPage);

function render() {
  if (page === 'overview') renderOverview();
  else if (page === 'troops') renderTroops();
  else if (page === 'fences') renderFences();
  else if (page === 'log') renderLog();
  else if (page === 'events') renderEventPage();
}

showPage(location.hash.slice(1) || 'overview');
poll();
