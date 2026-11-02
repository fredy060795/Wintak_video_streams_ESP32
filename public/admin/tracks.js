// Admin: mission tracks – start/stop a recording of every user's position, list of missions, replay on a map with a
// time slider, export GPX/KML (server: lib/tracks.js)
'use strict';

(() => {
  const api2 = (p, opts) => api('tracks' + (p ? '/' + p : ''), opts);
  const COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00', '#ff2d92', '#00e5ff', '#ff9500', '#af52de', '#a2d729', '#ffffff', '#5ac8fa', '#d4a373'];
  const fmt = t => new Date(t).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
  const fmtTime = t => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dur = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
  const km = m => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
  let poll = null;

  function show(r) {
    const active = r.missions.find(m => !m.end);
    $('trStartRow').classList.toggle('hidden', !!active);
    $('trLive').classList.toggle('hidden', !active);
    $('navRec').textContent = active ? 'REC' : '';
    if (active) {
      $('trLiveName').textContent = active.name;
      $('trLiveInfo').textContent = `since ${fmt(active.start)} (${dur(Date.now() - active.start)}) · ${active.users} users · ${active.points} points`;
      $('trStop').dataset.id = active.id;
    }
    const src = r.source || {};
    $('trSource').textContent = !r.available
      ? 'OpenTAKServer is not set up yet (OpenTAKServer & registration) – the positions come from there.'
      : active ? `TAK server: ${src.message || src.state}` : '';
    const rows = r.missions.map(m => el('tr', {},
      el('td', {}, el('b', { text: m.name }), m.end ? '' : el('span', { class: 'tr-rec', text: ' ● REC' })),
      el('td', { text: fmt(m.start) }),
      el('td', { text: m.end ? fmt(m.end) : '–' }),
      el('td', { text: dur((m.end || Date.now()) - m.start) }),
      el('td', { text: String(m.users) }),
      el('td', { text: String(m.points) }),
      el('td', { class: 'actions' },
        el('button', { type: 'button', class: 'pri', text: '▶ Replay', onclick: () => replay(m.id) }),
        el('button', { type: 'button', text: 'GPX', title: 'Download as GPX', onclick: () => download(m, 'gpx') }),
        el('button', { type: 'button', text: 'KML', title: 'Download as KML (Google Earth time slider)', onclick: () => download(m, 'kml') }),
        el('button', { type: 'button', text: '✎', title: 'Rename', onclick: () => rename(m) }),
        el('button', { type: 'button', class: 'danger', text: '🗑', title: 'Delete', onclick: () => remove(m) }))));
    $('trTable').tBodies[0].replaceChildren(...rows);
    $('trEmpty').classList.toggle('hidden', r.missions.length > 0);
    clearTimeout(poll);
    if (active && !document.querySelector('[data-view="tracks"]').classList.contains('hidden')) poll = setTimeout(load, 10000);
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

  async function remove(m) {
    if (!confirm(`Delete the mission "${m.name}" with all its tracks?`)) return;
    try { show(await api2(m.id, { method: 'DELETE' })); if (R && R.id === m.id) closeReplay(); } catch (e) { setMsg($('trMsg'), e.message); }
  }

  $('trStart').addEventListener('click', async () => {
    try {
      const r = await api2('', { method: 'POST', body: { name: $('trName').value.trim() } });
      $('trName').value = '';
      setMsg($('trMsg'), r.warning || 'Recording – every position from the TAK server is kept until you stop.', !r.warning);
      show(r);
    } catch (e) { setMsg($('trMsg'), e.message); }
  });
  $('trStop').addEventListener('click', async () => {
    if (!confirm('Stop recording this mission?')) return;
    try { show(await api2($('trStop').dataset.id + '/stop', { method: 'POST' })); setMsg($('trMsg'), 'Recording stopped.', true); } catch (e) { setMsg($('trMsg'), e.message); }
  });
  $('trReload').addEventListener('click', load);
  document.addEventListener('admin-view', e => { if (e.detail === 'tracks') load(); else clearTimeout(poll); });

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

  // position of a user at time t (between two points: interpolated) – null before the first / long after the last point
  function posAt(pts, t) {
    if (!pts.length || t < pts[0][0]) return null;
    let lo = 0, hi = pts.length - 1;
    if (t >= pts[hi][0]) return { lat: pts[hi][2], lon: pts[hi][3], i: hi, old: t - pts[hi][0] > 10 * 60000 };
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[hi], k = (t - a[0]) / (b[0] - a[0] || 1);
    return { lat: a[2] + (b[2] - a[2]) * k, lon: a[3] + (b[3] - a[3]) * k, i: lo, old: b[0] - a[0] > 10 * 60000 };
  }

  async function replay(id) {
    let d;
    try { d = await api2(id + '/points'); } catch (e) { return setMsg($('trMsg'), e.message); }
    closeReplay();
    $('trReplay').classList.remove('hidden');
    ensureMap();
    map.invalidateSize();
    const byUid = new Map();
    for (const p of d.points) { if (!byUid.has(p[1])) byUid.set(p[1], []); byUid.get(p[1]).push(p); }
    const users = [...byUid].map(([uid, pts], i) => ({ uid, pts, color: COLORS[i % COLORS.length], ...(d.users[uid] || { callsign: uid }), on: true }))
      .sort((a, b) => String(a.callsign).localeCompare(String(b.callsign)));
    const t0 = d.points.length ? d.points[0][0] : d.mission.start;
    const t1 = d.points.length ? d.points[d.points.length - 1][0] : (d.mission.end || Date.now());
    R = { id, users, t0, t1, t: t0, layer: L.layerGroup().addTo(map) };
    $('trRTitle').textContent = 'Replay: ' + d.mission.name;
    $('trRInfo').textContent = `${fmt(d.mission.start)} – ${d.mission.end ? fmt(d.mission.end) : 'recording'} · ${users.length} users · ${d.points.length} points`;
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
    const all = users.flatMap(u => u.pts.map(p => [p[2], p[3]]));
    if (all.length) map.fitBounds(L.latLngBounds(all), { maxZoom: 16, padding: [30, 30] });
    else map.setView([48, 11], 5);
    $('trTime').value = 0;
    draw();
    $('trReplay').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function draw() {
    if (!R) return;
    const whole = $('trTrail').checked;
    R.layer.clearLayers();
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

  function closeReplay() {
    stopPlay();
    if (R) R.layer.remove();
    R = null;
    $('trReplay').classList.add('hidden');
  }
  $('trClose').addEventListener('click', closeReplay);
})();
