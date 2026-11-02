// TAKweb EUD – tools like ATAK: drawing (line, rectangle, polygon, circle), Bloodhound (line to a target
// with distance) and a top bar the user puts together himself.
// Settings are stored in the profile (localStorage), like the map tiles they survive every update.
'use strict';

(() => {
  const { $, map, profile, toast, rnd, esc } = window.eud;
  const E = window.eud;

  // ======================================================================
  // Drawing: like ATAK's shape tool – the result is a CoT shape every TAK client shows
  // (u-d-f line/polygon, u-d-r rectangle, u-d-c-c circle), sent to the servers and over the mesh
  // ======================================================================

  const SHAPES = {
    line: { label: 'Line', hint: 'Tap the points of the line – then DONE' },
    rect: { label: 'Rectangle', hint: 'Tap two opposite corners' },
    poly: { label: 'Polygon', hint: 'Tap the corners – then DONE' },
    circle: { label: 'Circle', hint: 'Tap the center, then a point on the edge' },
  };
  const SHAPE_ICONS = {
    line: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><path d="M3 18 9 8l6 7 6-10"/><circle cx="3" cy="18" r="1.6" fill="#fff"/><circle cx="21" cy="5" r="1.6" fill="#fff"/></svg>',
    rect: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><rect x="3" y="6" width="18" height="12"/></svg>',
    poly: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"><path d="M4 9 11 3l9 5-2 11H6z"/></svg>',
    circle: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="1.2" fill="#fff"/></svg>',
  };
  const COLORS = [0xff0000, 0xffff00, 0xff8c00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x000000];
  const argbInt = (alpha, rgb) => ((alpha << 24) | rgb) | 0; // ATAK: signed 32 bit ARGB
  const css = rgb => '#' + rgb.toString(16).padStart(6, '0');
  const kmlColor = (alpha, rgb) => [alpha, rgb & 255, (rgb >> 8) & 255, (rgb >> 16) & 255].map(n => n.toString(16).padStart(2, '0')).join(''); // aabbggrr

  let shape = null; // { kind, pts: [L.LatLng] }
  const preview = L.layerGroup().addTo(map);
  const color = () => (COLORS.includes(profile.drawColor) ? profile.drawColor : COLORS[1]);

  function renderDrawMenu() {
    $('drawShapes').replaceChildren(...Object.entries(SHAPES).map(([k, s]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dm-btn' + (shape && shape.kind === k ? ' active' : '');
      b.innerHTML = SHAPE_ICONS[k] + `<span>${s.label}</span>`;
      b.addEventListener('click', () => startShape(k));
      return b;
    }));
    $('drawColors').replaceChildren(...COLORS.map(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dm-color' + (c === color() ? ' active' : '');
      b.style.background = css(c);
      b.title = css(c);
      b.addEventListener('click', () => { profile.drawColor = c; E.saveProfile(); renderDrawMenu(); drawPreview(); });
      return b;
    }));
  }
  function toggleDrawMenu(on) {
    on = on == null ? $('drawMenu').classList.contains('hidden') : on;
    if (on) { E.closeSheets(); closeMenus(); renderDrawMenu(); }
    $('drawMenu').classList.toggle('hidden', !on);
    markActive();
  }

  function startShape(kind) {
    E.closeSheets();
    closeMenus();
    stopPick();
    E.stopMeasure();
    E.setTool(null);
    E.setPitch(0);
    shape = { kind, pts: [] };
    map.doubleClickZoom.disable(); // fast taps are points, not zoom
    map.getContainer().classList.add('drawing');
    $('shapeBar').classList.remove('hidden');
    $('shapeDone').classList.toggle('hidden', kind === 'rect' || kind === 'circle');
    shapeHint();
    drawPreview();
    markActive();
  }
  function endShape() {
    shape = null;
    preview.clearLayers();
    map.doubleClickZoom.enable();
    map.getContainer().classList.remove('drawing');
    $('shapeBar').classList.add('hidden');
    markActive();
  }
  function shapeHint() {
    const n = shape.pts.length;
    $('shapeHint').textContent = `${SHAPES[shape.kind].label}: ` + (n ? `${n} point(s) – ` : '') + SHAPES[shape.kind].hint;
  }
  function drawPreview() {
    preview.clearLayers();
    if (!shape) return;
    const col = css(color()), pts = shape.pts;
    const style = { color: col, weight: 3, dashArray: '6 6', fillColor: col, fillOpacity: 0.15, interactive: false };
    if (shape.kind === 'line' && pts.length > 1) L.polyline(pts, style).addTo(preview);
    if (shape.kind === 'poly' && pts.length > 1) L.polygon(pts, style).addTo(preview);
    for (const p of pts) L.circleMarker(p, { radius: 5, color: '#000', weight: 1.5, fillColor: col, fillOpacity: 1, interactive: false }).addTo(preview);
  }
  function addShapePoint(ll) {
    shape.pts.push(ll);
    if ((shape.kind === 'rect' || shape.kind === 'circle') && shape.pts.length === 2) return finishShape();
    shapeHint();
    drawPreview();
  }

  function finishShape() {
    const { kind, pts } = shape;
    if (kind === 'line' && pts.length < 2) return toast('Tap at least two points.');
    if (kind === 'poly' && pts.length < 3) return toast('Tap at least three corners.');
    const xml = shapeXml(kind, pts.map(p => ({ lat: p.lat, lon: p.lng })), color());
    endShape();
    E.handleCot(xml, { own: true });
    const name = new DOMParser().parseFromString(xml, 'application/xml').querySelector('contact').getAttribute('callsign');
    toast(E.sendCot(xml, true) ? `${name} sent.` : `${name} saved – will be sent once connected.`);
  }

  // CoT like ATAK writes it
  function shapeXml(kind, pts, rgb) {
    const now = new Date();
    const t = E.cotTime(now), stale = E.cotTime(new Date(+now + 30 * 86400000));
    const counters = profile.drawIndex && typeof profile.drawIndex === 'object' ? profile.drawIndex : {};
    const idx = Math.max(1, Number(counters[kind]) || 1);
    profile.drawIndex = { ...counters, [kind]: idx + 1 }; // own number per shape, like ATAK
    E.saveProfile();
    const name = `${SHAPES[kind].label} ${idx}`;
    const uid = crypto.randomUUID ? crypto.randomUUID() : `${profile.uid}-${kind}-${rnd(6)}`;
    const closed = kind !== 'line';
    const fillAlpha = 0x40;
    let center, type, geo = '', extra = '';
    const pt = p => `<link point="${p.lat.toFixed(7)},${p.lon.toFixed(7)}"/>`;
    if (kind === 'circle') {
      type = 'u-d-c-c';
      center = pts[0];
      const r = E.distance(pts[0], pts[1]).toFixed(2);
      geo = `<shape><ellipse major="${r}" minor="${r}" angle="360"/>`
        + `<link uid="${uid}.Style" type="b-x-KmlStyle" relation="p-c"><Style><LineStyle><color>${kmlColor(255, rgb)}</color><width>3.0</width></LineStyle>`
        + `<PolyStyle><color>${kmlColor(fillAlpha, rgb)}</color></PolyStyle></Style></link></shape>`;
    } else if (kind === 'rect') {
      type = 'u-d-r';
      const [a, b] = pts;
      const corners = [{ lat: a.lat, lon: a.lon }, { lat: a.lat, lon: b.lon }, { lat: b.lat, lon: b.lon }, { lat: b.lat, lon: a.lon }];
      center = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
      geo = corners.map(pt).join('');
      extra = '<tog enabled="0"/>';
    } else {
      type = 'u-d-f';
      center = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length };
      geo = (closed ? pts.concat(pts[0]) : pts).map(pt).join(''); // closed: back to the first point, like ATAK
    }
    return `<event version="2.0" uid="${uid}" type="${type}" how="h-e" time="${t}" start="${t}" stale="${stale}">`
      + `<point lat="${center.lat.toFixed(7)}" lon="${center.lon.toFixed(7)}" hae="9999999" ce="9999999" le="9999999"/>`
      + `<detail>${geo}<contact callsign="${esc(name)}"/>`
      + `<strokeColor value="${argbInt(255, rgb)}"/><strokeWeight value="3.0"/>${closed ? `<fillColor value="${argbInt(fillAlpha, rgb)}"/>` : ''}`
      + `${extra}<remarks/><archive/><labels_on value="false"/><color value="${argbInt(255, rgb)}"/>`
      + `<link uid="${esc(profile.uid)}" production_time="${t}" type="a-f-G-U-C" parent_callsign="${esc(profile.callsign || profile.uid)}" relation="p-p"/></detail></event>`;
  }

  $('shapeUndo').addEventListener('click', () => { if (shape) { shape.pts.pop(); shapeHint(); drawPreview(); } });
  $('shapeCancel').addEventListener('click', endShape);
  $('shapeDone').addEventListener('click', () => shape && finishShape());

  // ======================================================================
  // Bloodhound: a line from the own position to a target (marker, user, point on the map)
  // with distance, bearing and time of arrival – updated while you move
  // ======================================================================

  let hound = null; // { uid | pt, name, line, tip, dot, timer }
  let picking = false;

  function startPick() {
    E.closeSheets();
    closeMenus();
    if (shape) endShape();
    picking = true;
    $('houndHint').classList.remove('hidden');
    markActive();
  }
  function stopPick() {
    picking = false;
    $('houndHint').classList.add('hidden');
    markActive();
  }

  function startHound(target) {
    stopHound(true);
    stopPick();
    hound = { ...target };
    hound.line = L.polyline([], { color: '#ff3b30', weight: 3, dashArray: '10 6', interactive: false }).addTo(map);
    hound.tip = L.tooltip({ permanent: true, direction: 'center', className: 'measure-label hound-label', interactive: false });
    if (hound.pt) hound.dot = L.circleMarker([hound.pt.lat, hound.pt.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#ff3b30', fillOpacity: 1, interactive: false }).addTo(map);
    hound.timer = setInterval(updateHound, 1000);
    $('houndBar').classList.remove('hidden');
    updateHound();
    const t = houndTarget(), me = E.getMe();
    if (t && me) map.fitBounds([[t.lat, t.lon], [me.lat, me.lon]], { padding: [70, 70], maxZoom: 17 });
    markActive();
  }
  function stopHound(quiet) {
    if (!hound) return;
    clearInterval(hound.timer);
    hound.line.remove();
    hound.tip.remove();
    if (hound.dot) hound.dot.remove();
    hound = null;
    $('houndBar').classList.add('hidden');
    if (!quiet) markActive();
  }
  function houndTarget() {
    if (hound.pt) return { ...hound.pt, name: hound.name };
    const it = E.items.get(hound.uid);
    if (!it || !Number.isFinite(it.c.lat)) return null;
    return { lat: it.c.lat, lon: it.c.lon, name: it.c.callsign || hound.name };
  }
  const fmtTime = s => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

  function updateHound() {
    const t = houndTarget();
    if (!t) { stopHound(); return toast('Target gone – Bloodhound off.'); }
    const me = E.getMe();
    $('houndName').textContent = t.name;
    if (!me) {
      hound.line.setLatLngs([]);
      hound.tip.remove();
      $('houndInfo').textContent = 'waiting for your position …';
      return;
    }
    const d = E.distance(me, t), b = Math.round(E.bearing(me, t)) % 360;
    const eta = me.speed > 0.5 ? ' · ' + fmtTime(d / me.speed) : '';
    const text = d < 15 ? 'at the target' : `${E.fmtDist(d)} · ${String(b).padStart(3, '0')}°${eta}`;
    hound.line.setLatLngs([[me.lat, me.lon], [t.lat, t.lon]]);
    hound.line.setStyle({ color: d < 100 ? '#34c759' : d < 500 ? '#ffcc00' : '#ff3b30' }); // closer: yellow, then green
    hound.tip.setLatLng([(me.lat + t.lat) / 2, (me.lon + t.lon) / 2]).setContent(text);
    if (!map.hasLayer(hound.tip)) hound.tip.addTo(map);
    $('houndInfo').textContent = text;
  }

  $('houndStop').addEventListener('click', () => stopHound());
  $('houndPickCancel').addEventListener('click', stopPick);
  document.addEventListener('eud-hound', e => {
    const it = E.items.get(e.detail.uid);
    if (it) startHound({ uid: it.uid, name: it.c.callsign || it.uid });
  });
  // picking: a tapped marker / user is the target (instead of opening its window)
  map.on('popupopen', e => {
    if (!picking) return;
    for (const it of E.items.values()) {
      if (it.layer !== e.popup._source) continue;
      map.closePopup();
      if (Number.isFinite(it.c.lat)) startHound({ uid: it.uid, name: it.c.callsign || it.uid });
      return;
    }
  });

  // taps on the map while a tool is active (called first by eud.js)
  window.eudMapTap = ll => {
    if (shape) { addShapePoint(ll); return true; }
    if (picking) { startHound({ pt: { lat: ll.lat, lon: ll.lng }, name: 'Map point' }); return true; }
    return false;
  };
  window.eudTools = { capturing: () => !!shape };

  delete profile.rotation; // the rotation tool was removed again (every phone does it itself)

  function closeMenus() {
    $('drawMenu').classList.add('hidden');
    markActive();
  }
  // a tap on the map closes the drop-down menus
  map.on('mousedown touchstart', () => { if (!$('drawMenu').classList.contains('hidden')) closeMenus(); });

  // ======================================================================
  // Top bar like ATAK: the user chooses which tools sit on top (sidebar → ✎); stored in the profile
  // ======================================================================

  const DEFAULT_BAR = ['map', 'markers', 'draw', 'chat', 'video'];
  const MAX_BAR = 5; // + menu: more do not fit on a phone in portrait
  const FIXED = { map: 'btnLayers', markers: 'btnPin', chat: 'btnChat', video: 'btnVideo' }; // already in the top bar
  const ACTIONS = {
    draw: () => { E.closeSheets(); toggleDrawMenu(); },
    hound: () => { if (hound) stopHound(); else if (picking) stopPick(); else startPick(); },
    markers: () => $('btnPin').click(),
  };
  const tiles = () => [...document.querySelectorAll('.sb-grid .tile[data-tb]')];
  const tileOf = id => document.querySelector(`.sb-grid .tile[data-tb="${id}"]`);
  let editing = false;

  function barTools() {
    const valid = new Set(tiles().map(t => t.dataset.tb));
    const list = Array.isArray(profile.topBar) ? profile.topBar : DEFAULT_BAR;
    return list.filter((id, i) => valid.has(id) && list.indexOf(id) === i).slice(0, MAX_BAR);
  }

  function renderBar() {
    const bar = barTools();
    const head = $('tsb'), menu = $('btnMenu');
    for (const b of head.querySelectorAll('[data-tbtool]')) b.remove();
    for (const [id, btnId] of Object.entries(FIXED)) $(btnId).classList.toggle('hidden', !bar.includes(id));
    for (const id of bar) {
      let b = FIXED[id] && $(FIXED[id]);
      if (!b) {
        const tile = tileOf(id);
        b = document.createElement('button');
        b.type = 'button';
        b.className = 'tsb-btn';
        b.dataset.tbtool = id;
        b.title = tile.querySelector('span').textContent;
        b.setAttribute('aria-label', b.title);
        b.append(tile.querySelector('svg').cloneNode(true));
        b.addEventListener('click', () => tile.click());
      }
      head.insertBefore(b, menu);
    }
    for (const t of tiles()) t.classList.toggle('on-bar', bar.includes(t.dataset.tb));
    $('tbCount').textContent = `${bar.length} / ${MAX_BAR} on top`;
    markActive();
  }

  // active tools are highlighted on the tile and in the top bar
  function markActive() {
    const act = {
      draw: !!shape || !$('drawMenu').classList.contains('hidden'),
      hound: !!hound || picking,
      rb: $('btnMeasure').classList.contains('active'),
    };
    for (const [id, on] of Object.entries(act)) {
      const t = tileOf(id);
      if (t && id !== 'rb') t.classList.toggle('active', !!on);
      const b = document.querySelector(`#tsb [data-tbtool="${id}"]`);
      if (b) b.classList.toggle('active', !!on);
    }
  }
  new MutationObserver(markActive).observe($('btnMeasure'), { attributes: true, attributeFilter: ['class'] });

  function setEditing(on) {
    editing = on;
    $('sidebar').classList.toggle('tb-editing', on);
    $('tbEdit').textContent = on ? 'DONE' : '✎';
    $('tbEdit').title = on ? 'Done' : 'Customize the top bar';
    $('sbTitle').textContent = on ? 'Tap tools for the top bar' : 'Tools';
    $('tbCount').classList.toggle('hidden', !on);
  }
  $('tbEdit').addEventListener('click', () => setEditing(!editing));
  new MutationObserver(() => { if (editing && $('sidebar').classList.contains('hidden')) setEditing(false); })
    .observe($('sidebar'), { attributes: true, attributeFilter: ['class'] });
  // in edit mode a tap on a tile puts it on the top bar or takes it off (instead of opening it)
  document.querySelector('.sb-grid').addEventListener('click', e => {
    if (!editing) return;
    const t = e.target.closest('.tile[data-tb]');
    if (!t) return;
    e.stopPropagation();
    e.preventDefault();
    const bar = barTools(), id = t.dataset.tb;
    if (bar.includes(id)) bar.splice(bar.indexOf(id), 1);
    else if (bar.length >= MAX_BAR) return toast(`At most ${MAX_BAR} tools fit on top – take one off first.`);
    else bar.push(id);
    profile.topBar = bar;
    E.saveProfile();
    renderBar();
  }, true);
  $('tbReset').addEventListener('click', () => { profile.topBar = DEFAULT_BAR.slice(); E.saveProfile(); renderBar(); });

  // tiles of the new tools
  for (const [id, fn] of Object.entries(ACTIONS)) {
    const t = tileOf(id);
    if (t) t.addEventListener('click', () => { if (!editing) fn(); });
  }

  renderBar();

  window.eudToolsApi = { startShape, finishShape, startHound, stopHound, renderBar, shapeXml };
})();
