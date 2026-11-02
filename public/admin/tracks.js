// Admin: mission tracks – record now or at set times, everybody / chosen groups / chosen users, positions and map objects;
// list of missions, replay on a map with a time slider, export GPX/KML (server: lib/tracks.js)
'use strict';

(() => {
  const api2 = (p, opts) => api('tracks' + (p ? '/' + p : ''), opts);
  const COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00', '#ff2d92', '#00e5ff', '#ff9500', '#af52de', '#a2d729', '#ffffff', '#5ac8fa', '#d4a373'];
  const fmt = t => new Date(t).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
  const fmtTime = t => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dur = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
  const km = m => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
  const localInput = t => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  let poll = null, opts = { missions: [], groups: [], euds: [] };
  const picked = new Set();

  // ---------------- New mission ----------------

  function syncForm() {
    const at = $('trStartMode').value === 'at';
    $('trFromBox').classList.toggle('hidden', !at);
    $('trToBox').classList.toggle('hidden', $('trEndMode').value !== 'at');
    $('trGroupsBox').classList.toggle('hidden', $('trWho').value !== 'groups');
    $('trUsersBox').classList.toggle('hidden', $('trWho').value !== 'users');
    $('trStart').textContent = at ? '◷ Plan recording' : '● Start recording';
  }
  for (const id of ['trStartMode', 'trEndMode', 'trWho']) $(id).addEventListener('change', syncForm);
  $('trStartMode').addEventListener('change', () => { if (!$('trFrom').value) $('trFrom').value = localInput(Date.now() + 3600000); });
  $('trEndMode').addEventListener('change', () => {
    if ($('trTo').value) return;
    const from = $('trStartMode').value === 'at' && $('trFrom').value ? new Date($('trFrom').value).getTime() : Date.now();
    $('trTo').value = localInput(from + 2 * 3600000);
  });

  function renderUsers() {
    const q = $('trUserSearch').value.trim().toLowerCase();
    const list = opts.euds.filter(e => !q || [e.callsign, e.username, e.uid].some(v => String(v || '').toLowerCase().includes(q)));
    $('trUserList').replaceChildren(...list.slice(0, 300).map(e => {
      const box = el('input', { type: 'checkbox' });
      box.checked = picked.has(e.uid);
      box.addEventListener('change', () => { if (box.checked) picked.add(e.uid); else picked.delete(e.uid); $('trPicked').textContent = picked.size ? `(${picked.size} chosen)` : ''; });
      return el('label', { class: 'check' }, box, ' ', el('b', { text: e.callsign || e.uid }),
        el('span', { class: 'mut small', text: ` ${e.username ? '· ' + e.username + ' ' : ''}${e.lastSeen ? '· last seen ' + fmt(e.lastSeen) : ''}` }));
    }));
    if (!list.length) $('trUserList').append(el('p', { class: 'mut small', text: opts.euds.length ? 'Nobody matches.' : 'No devices known in OTS yet.' }));
  }
  $('trUserSearch').addEventListener('input', renderUsers);

  async function loadOptions() {
    try { opts = await api2('options'); } catch (e) { return; }
    $('trOtsList').replaceChildren(...opts.missions.map(n => el('option', { value: n })));
    $('trGroups').replaceChildren(...opts.groups.map(g => {
      const c = el('input', { type: 'checkbox', value: g });
      return el('label', { class: 'check' }, c, ' ' + g);
    }));
    if (!opts.groups.length) $('trGroups').append(el('p', { class: 'mut small', text: 'No groups in OTS.' }));
    renderUsers();
  }

  $('trStart').addEventListener('click', async () => {
    const name = $('trName').value.trim();
    const body = {
      name, otsMission: opts.missions.includes(name) ? name : '',
      from: $('trStartMode').value === 'at' ? new Date($('trFrom').value).getTime() : 0,
      to: $('trEndMode').value === 'at' ? new Date($('trTo').value).getTime() : 0,
      who: { mode: $('trWho').value, groups: [...$('trGroups').querySelectorAll('input:checked')].map(c => c.value), users: [...picked] },
      objects: $('trObjects').checked,
    };
    if ($('trStartMode').value === 'at' && !body.from) return setMsg($('trMsg'), 'Set the start time.');
    if ($('trEndMode').value === 'at' && !body.to) return setMsg($('trMsg'), 'Set the end time.');
    if (body.who.mode === 'groups' && !body.who.groups.length) return setMsg($('trMsg'), 'Choose at least one group.');
    if (body.who.mode === 'users' && !body.who.users.length) return setMsg($('trMsg'), 'Choose at least one user.');
    try {
      const r = await api2('', { method: 'POST', body });
      $('trName').value = '';
      const planned = body.from > Date.now();
      setMsg($('trMsg'), r.warning || (planned ? `Planned – recording starts on ${fmt(body.from)} by itself.` : 'Recording – until you stop it' + (body.to ? ` or until ${fmt(body.to)}.` : '.')), !r.warning);
      show(r);
    } catch (e) { setMsg($('trMsg'), e.message); }
  });

  // ---------------- List ----------------

  const whoText = w => (w.mode === 'groups' ? `Groups: ${w.groups.join(', ')}` : w.mode === 'users' ? `${w.users.length} chosen user(s)` : 'Everybody');
  const STATE = { planned: ['◷ planned', 'tr-plan'], recording: ['● REC', 'tr-rec'], done: ['done', 'mut'] };

  function show(r) {
    const active = r.missions.find(m => m.state === 'recording');
    $('trLive').classList.toggle('hidden', !active);
    $('navRec').textContent = active ? 'REC' : '';
    if (active) {
      $('trLiveName').textContent = active.name;
      $('trLiveInfo').textContent = `since ${fmt(active.start)} (${dur(Date.now() - active.start)})${active.to ? ' · ends ' + fmt(active.to) : ''} · ${whoText(active.who)} · ${active.users} users · ${active.points} points · ${active.objectCount} objects`;
      $('trStop').dataset.id = active.id;
    }
    const src = r.source || {};
    $('trSource').textContent = !r.available
      ? 'OpenTAKServer is not set up yet (OpenTAKServer & registration) – the positions come from there.'
      : active ? `TAK server: ${src.message || src.state}` : '';
    const rows = r.missions.map(m => {
      const [label, cls] = STATE[m.state];
      const start = m.start || m.from, end = m.end || m.to;
      return el('tr', {},
        el('td', {}, el('b', { text: m.name }), m.otsMission ? el('div', { class: 'mut small', text: 'OTS mission' }) : ''),
        el('td', {}, el('span', { class: cls, text: m.missed ? 'missed (server off)' : label })),
        el('td', { text: start ? fmt(start) : '–' }),
        el('td', { text: end ? fmt(end) + (m.state !== 'done' ? ' (planned)' : '') : m.state === 'done' ? '–' : 'manual' }),
        el('td', { class: 'small', text: whoText(m.who) + (m.objects ? ' + map objects' : '') }),
        el('td', { text: String(m.users) }),
        el('td', { text: String(m.points) }),
        el('td', { text: String(m.objectCount) }),
        el('td', { class: 'actions' },
          m.state === 'planned' ? el('button', { type: 'button', class: 'pri', text: '▶ Start now', onclick: () => startNow(m) }) : '',
          m.state === 'recording' ? el('button', { type: 'button', class: 'danger', text: '■ Stop', onclick: () => stop(m.id) }) : '',
          m.state !== 'planned' ? el('button', { type: 'button', class: m.state === 'done' ? 'pri' : '', text: '▶ Replay', onclick: () => replay(m.id) }) : '',
          m.state !== 'planned' ? el('button', { type: 'button', text: 'GPX', title: 'Download the tracks as GPX', onclick: () => download(m, 'gpx') }) : '',
          m.state !== 'planned' ? el('button', { type: 'button', text: 'KML', title: 'Download as KML (Google Earth time slider)', onclick: () => download(m, 'kml') }) : '',
          m.state !== 'done' ? el('button', { type: 'button', text: '◷', title: 'Change the planned end', onclick: () => editEnd(m) }) : '',
          el('button', { type: 'button', text: '✎', title: 'Rename', onclick: () => rename(m) }),
          el('button', { type: 'button', class: 'danger', text: '🗑', title: m.state === 'planned' ? 'Cancel' : 'Delete', onclick: () => remove(m) })));
    });
    $('trTable').tBodies[0].replaceChildren(...rows);
    $('trEmpty').classList.toggle('hidden', r.missions.length > 0);
    clearTimeout(poll);
    const planned = r.missions.some(m => m.state === 'planned');
    if ((active || planned) && !document.querySelector('[data-view="tracks"]').classList.contains('hidden')) poll = setTimeout(load, active ? 10000 : 30000);
  }

  async function load() {
    try { show(await api2()); } catch (e) { setMsg($('trMsg'), e.message); }
  }

  async function download(m, kind) {
    try {
      const res = await fetch(`/api/admin/tracks/${m.id}/export.${kind}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'helm' } });
      if (!res.ok) throw new Error('Download failed (' + res.status + ')');
      const a = el('a', { href: URL.createObjectURL(await res.blob()), download: (m.name.replace(/[^\w.-]+/g, '_') || 'mission') + '.' + kind });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) { setMsg($('trMsg'), e.message); }
  }

  async function rename(m) {
    const name = prompt('Mission name', m.name);
    if (!name || name === m.name) return;
    try { show(await api2(m.id, { method: 'POST', body: { name } })); } catch (e) { setMsg($('trMsg'), e.message); }
  }

  async function editEnd(m) {
    const cur = m.to ? localInput(m.to) : localInput(Date.now() + 3600000);
    const v = prompt('Planned end (YYYY-MM-DDTHH:MM, empty = until stopped by hand)', cur);
    if (v === null) return;
    try { show(await api2(m.id, { method: 'POST', body: { to: v.trim() ? new Date(v.trim()).getTime() : 0 } })); } catch (e) { setMsg($('trMsg'), e.message); }
  }

  async function startNow(m) {
    try { const r = await api2(m.id + '/start', { method: 'POST' }); setMsg($('trMsg'), r.warning || 'Recording started.', !r.warning); show(r); } catch (e) { setMsg($('trMsg'), e.message); }
  }

  async function stop(id) {
    if (!confirm('Stop recording this mission?')) return;
    try { show(await api2(id + '/stop', { method: 'POST' })); setMsg($('trMsg'), 'Recording stopped.', true); } catch (e) { setMsg($('trMsg'), e.message); }
  }

  async function remove(m) {
    if (!confirm(m.state === 'planned' ? `Cancel the planned mission "${m.name}"?` : `Delete the mission "${m.name}" with all its tracks?`)) return;
    try { show(await api2(m.id, { method: 'DELETE' })); if (R && R.id === m.id) closeReplay(); } catch (e) { setMsg($('trMsg'), e.message); }
  }

  $('trStop').addEventListener('click', () => stop($('trStop').dataset.id));
  $('trReload').addEventListener('click', () => { load(); loadOptions(); });
  document.addEventListener('admin-view', e => { if (e.detail === 'tracks') { load(); loadOptions(); } else clearTimeout(poll); });
  syncForm();

  // ---------------- Replay ----------------

  let map = null, R = null, timer = null;

  function ensureMap() {
    if (map) return;
    map = L.map('trMap', { zoomControl: true });
    const base = {
      'OpenStreetMap': L.tileLayer('/eud/tiles/osm/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
      'Topo': L.tileLayer('/eud/tiles/topo/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' }),
      'Satellite': L.tileLayer('/eud/tiles/sat/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© Esri' }),
    };
    base.OpenStreetMap.addTo(map);
    L.control.layers(base).addTo(map);
  }

  // position of a user at time t (between two points: interpolated) – null before the first point
  function posAt(pts, t) {
    if (!pts.length || t < pts[0][0]) return null;
    let lo = 0, hi = pts.length - 1;
    if (t >= pts[hi][0]) return { lat: pts[hi][2], lon: pts[hi][3], i: hi, old: t - pts[hi][0] > 10 * 60000 };
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[hi], k = (t - a[0]) / (b[0] - a[0] || 1);
    return { lat: a[2] + (b[2] - a[2]) * k, lon: a[3] + (b[3] - a[3]) * k, i: lo, old: b[0] - a[0] > 10 * 60000 };
  }

  // ---- map objects (markers, spots, drawings, routes, range & bearing) from their CoT ----
  const argb = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n) || v === '' || v == null) return fallback;
    const u = n >>> 0;
    return { color: '#' + (u & 0xffffff).toString(16).padStart(6, '0'), opacity: ((u >>> 24) & 255) / 255 };
  };
  function sidcFor(type) {
    const p = type.split('-');
    if (p[0] !== 'a' || p.length < 3) return null;
    const aff = ({ f: 'F', h: 'H', n: 'N', u: 'U', a: 'A', s: 'S', j: 'J', k: 'K', p: 'P' })[p[1]] || 'U';
    const dim = ({ P: 'P', A: 'A', G: 'G', S: 'S', U: 'U', F: 'F', X: 'X' })[p[2]] || 'G';
    return 'S' + aff + dim + 'P' + p.slice(3).join('').slice(0, 6).padEnd(6, '-') + '-----';
  }
  const iconCache = new Map();
  function symbolIcon(type) {
    if (!iconCache.has(type)) {
      let icon = null;
      try {
        let s = new ms.Symbol(sidcFor(type), { size: 22 });
        if (!s.isValid()) s = new ms.Symbol(sidcFor(type).slice(0, 4) + '-----------', { size: 22 });
        const a = s.getAnchor(), z = s.getSize();
        icon = L.divIcon({ className: 'tr-sym', html: s.asSVG(), iconSize: [z.width, z.height], iconAnchor: [a.x, a.y] });
      } catch (e) { icon = null; }
      iconCache.set(type, icon);
    }
    return iconCache.get(type);
  }
  function objectLayer(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const ev = doc.documentElement;
    if (!ev || ev.nodeName !== 'event') return null;
    const type = ev.getAttribute('type') || '';
    const q = s => ev.querySelector(s);
    const pt = q('point');
    const lat = pt ? Number(pt.getAttribute('lat')) : NaN, lon = pt ? Number(pt.getAttribute('lon')) : NaN;
    const name = (q('contact') && q('contact').getAttribute('callsign')) || '';
    const remarks = q('remarks') ? q('remarks').textContent : '';
    const tip = [name, remarks].filter(Boolean).join(' – ');
    const stroke = argb(q('strokeColor') && q('strokeColor').getAttribute('value'), { color: '#ffcc00', opacity: 1 });
    const fill = argb(q('fillColor') && q('fillColor').getAttribute('value'), null);
    const style = { color: stroke.color, opacity: stroke.opacity || 1, weight: Number(q('strokeWeight') && q('strokeWeight').getAttribute('value')) || 3,
      fill: !!fill, fillColor: fill ? fill.color : undefined, fillOpacity: fill ? Math.min(0.5, fill.opacity) : 0 };
    const pts = [...ev.querySelectorAll('link[point]')].map(l => l.getAttribute('point').split(',').map(Number)).filter(p => p.length >= 2 && p.every(Number.isFinite)).map(p => [p[0], p[1]]);
    let layer = null;
    if (type.startsWith('u-d-c-c') || type === 'u-d-c-e') {
      const e = q('shape ellipse');
      if (e && Number.isFinite(lat)) layer = L.circle([lat, lon], { radius: Number(e.getAttribute('major')) || 50, ...style });
    } else if (type.startsWith('u-d-') || type.startsWith('b-m-r')) {
      if (pts.length >= 2) {
        const closed = type === 'u-d-r' || type === 'u-d-f' && q('closed') && q('closed').getAttribute('value') === 'true' || pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
        layer = closed ? L.polygon(pts, style) : L.polyline(pts, { ...style, fill: false });
      }
    } else if (type === 'u-rb-a') {
      const r = Number(q('range') && q('range').getAttribute('value')), b = Number(q('bearing') && q('bearing').getAttribute('value'));
      if (Number.isFinite(lat) && Number.isFinite(r) && Number.isFinite(b)) {
        const R = 6371000, d = r / R, br = b * Math.PI / 180, la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
        const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
        const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
        layer = L.polyline([[lat, lon], [la2 * 180 / Math.PI, lo2 * 180 / Math.PI]], { ...style, dashArray: '6 6', fill: false });
      }
    } else if (Number.isFinite(lat) && !(lat === 0 && lon === 0)) {
      const icon = type.startsWith('a-') ? symbolIcon(type) : null;
      layer = icon ? L.marker([lat, lon], { icon })
        : L.circleMarker([lat, lon], { radius: 6, color: '#000', weight: 1.5, fillColor: (argb(q('color') && q('color').getAttribute('argb'), stroke) || stroke).color, fillOpacity: 1 });
    }
    if (layer && tip) layer.bindTooltip(tip, { direction: 'top', className: 'tr-label' });
    return layer;
  }

  async function replay(id) {
    let d, o;
    try { [d, o] = await Promise.all([api2(id + '/points'), api2(id + '/objects')]); } catch (e) { return setMsg($('trMsg'), e.message); }
    closeReplay();
    $('trReplay').classList.remove('hidden');
    ensureMap();
    map.invalidateSize();
    const byUid = new Map();
    for (const p of d.points) { if (!byUid.has(p[1])) byUid.set(p[1], []); byUid.get(p[1]).push(p); }
    const users = [...byUid].map(([uid, pts], i) => ({ uid, pts, color: COLORS[i % COLORS.length], ...(d.users[uid] || { callsign: uid }), on: true }))
      .sort((a, b) => String(a.callsign).localeCompare(String(b.callsign)));
    // object versions: per uid in time order; layers made once per version
    const objs = new Map();
    for (const [t, uid, type, xml] of o.objects) {
      if (type === 't-x-d-d') {
        const m = /<link\b[^>]*\buid="([^"]+)"/.exec(xml);
        if (m) { if (!objs.has(m[1])) objs.set(m[1], []); objs.get(m[1]).push({ t, del: true }); }
        continue;
      }
      if (!objs.has(uid)) objs.set(uid, []);
      objs.get(uid).push({ t, xml, layer: undefined });
    }
    // both lists are in time order: the replay runs from the first to the last recorded moment
    const first = [d.points[0], o.objects[0]].filter(Boolean).map(x => x[0]);
    const last = [d.points[d.points.length - 1], o.objects[o.objects.length - 1]].filter(Boolean).map(x => x[0]);
    const t0 = first.length ? Math.min(...first) : d.mission.start;
    const t1 = last.length ? Math.max(...last) : (d.mission.end || Date.now());
    R = { id, users, objs, t0, t1, t: t0, layer: L.layerGroup().addTo(map) };
    $('trRTitle').textContent = 'Replay: ' + d.mission.name;
    $('trRInfo').textContent = `${fmt(d.mission.start)} – ${d.mission.end ? fmt(d.mission.end) : 'recording'} · ${users.length} users · ${d.points.length} points · ${objs.size} map objects`;
    for (const u of users) {
      u.full = L.polyline(u.pts.map(p => [p[2], p[3]]), { color: u.color, weight: 3, opacity: 0.85 });
      u.part = L.polyline([], { color: u.color, weight: 3, opacity: 0.85 });
      u.dot = L.circleMarker([0, 0], { radius: 7, color: '#000', weight: 2, fillColor: u.color, fillOpacity: 1 })
        .bindTooltip(u.callsign, { permanent: true, direction: 'right', offset: [8, 0], className: 'tr-label' });
    }
    $('trUsers').replaceChildren(...users.map(u => {
      const box = el('input', { type: 'checkbox' });
      box.checked = true;
      box.addEventListener('change', () => { u.on = box.checked; draw(); });
      return el('div', { class: 'tr-user' },
        el('label', { class: 'check' }, box, el('span', { class: 'tr-sw', style: `background:${u.color}` }), ' ', el('b', { text: u.callsign })),
        el('div', { class: 'mut small', text: [u.team, u.role].filter(Boolean).join(' · ') }),
        el('div', { class: 'mut small', text: u.first ? `${fmtTime(u.first)} – ${fmtTime(u.last)} · ${km(u.meters || 0)} · ${u.points} points` : '' }),
        el('button', { type: 'button', class: 'small', text: 'Show', onclick: () => { if (u.pts.length) map.fitBounds(u.full.getBounds(), { maxZoom: 17, padding: [30, 30] }); } }));
    }));
    if (!users.length) $('trUsers').append(el('p', { class: 'mut small', text: 'No positions recorded.' }));
    const all = users.flatMap(u => u.pts.map(p => [p[2], p[3]]));
    for (const list of objs.values()) for (const v of list) if (v.xml) { const m = /<point\b[^>]*\blat="([-\d.]+)"[^>]*\blon="([-\d.]+)"/.exec(v.xml); if (m && !(+m[1] === 0 && +m[2] === 0)) all.push([+m[1], +m[2]]); }
    if (all.length) map.fitBounds(L.latLngBounds(all), { maxZoom: 16, padding: [30, 30] });
    else map.setView([48, 11], 5);
    draw();
    $('trReplay').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function draw() {
    if (!R) return;
    const whole = $('trTrail').checked;
    R.layer.clearLayers();
    if ($('trObj').checked) {
      for (const list of R.objs.values()) {
        let cur = null;
        for (const v of list) { if (v.t > R.t) break; cur = v; }
        if (!cur || cur.del) continue;
        if (cur.layer === undefined) cur.layer = objectLayer(cur.xml);
        if (cur.layer) R.layer.addLayer(cur.layer);
      }
    }
    for (const u of R.users) {
      if (!u.on) continue;
      const p = posAt(u.pts, R.t);
      if (whole) R.layer.addLayer(u.full);
      if (!p) continue;
      if (!whole) { u.part.setLatLngs(u.pts.slice(0, p.i + 1).map(q => [q[2], q[3]]).concat([[p.lat, p.lon]])); R.layer.addLayer(u.part); }
      u.dot.setLatLng([p.lat, p.lon]);
      u.dot.setStyle({ fillOpacity: p.old ? 0.35 : 1 });
      R.layer.addLayer(u.dot);
    }
    $('trClock').textContent = fmtTime(R.t);
    $('trTime').value = Math.round((R.t - R.t0) / Math.max(1, R.t1 - R.t0) * 1000);
  }

  function stopPlay() { clearInterval(timer); timer = null; $('trPlay').textContent = '▶'; }
  $('trPlay').addEventListener('click', () => {
    if (!R) return;
    if (timer) return stopPlay();
    if (R.t >= R.t1) R.t = R.t0;
    $('trPlay').textContent = '❚❚';
    let last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      R.t = Math.min(R.t1, R.t + (now - last) * Number($('trSpeed').value));
      last = now;
      draw();
      if (R.t >= R.t1) stopPlay();
    }, 100);
  });
  $('trTime').addEventListener('input', () => { if (!R) return; R.t = R.t0 + (R.t1 - R.t0) * Number($('trTime').value) / 1000; draw(); });
  $('trTrail').addEventListener('change', draw);
  $('trObj').addEventListener('change', draw);

  function closeReplay() {
    stopPlay();
    if (R) R.layer.remove();
    R = null;
    $('trReplay').classList.add('hidden');
  }
  $('trClose').addEventListener('click', closeReplay);
})();
