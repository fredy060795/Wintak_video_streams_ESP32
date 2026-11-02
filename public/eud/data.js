// Data from the TAK server: data packages, Data Sync (missions), video feeds and map overlays (KML/KMZ).
// Fetched through the relay (/api/eud/marti) with this device's client certificate.
// Packages and mission invitations sent by the server are taken over automatically, like in ATAK.
'use strict';

(() => {
  const { $, store, profile, toast, setMsg, esc, map, handleCot, askTrust, postJson, getServers, saveServers } = window.eud;
  const msg = (text, ok) => setMsg($('dataMsg'), text, ok);

  // ---------------- Storage for overlays (IndexedDB, stays offline) ----------------

  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('eud', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('overlays', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('overlays', mode);
        const req = fn(t.objectStore('overlays'));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
      });
    };
    return { all: () => tx('readonly', s => s.getAll()), put: o => tx('readwrite', s => s.put(o)), del: id => tx('readwrite', s => s.delete(id)) };
  })();

  // ---------------- KML/KMZ -> Leaflet ----------------

  // Own pane for overlays: above the tiles, below drawings and markers. With a rotatable map it
  // must be in the rotating pane – otherwise it lies below the map and does not rotate.
  const kmlPane = map.createPane('kml', map.getPane('rotatePane') || map.getPane('mapPane'));
  kmlPane.style.zIndex = 390;
  const layers = new Map(); // overlay id -> Leaflet-Layer
  let overlays = [];

  function kmlColor(c, fallback) {
    c = String(c || '').trim();
    if (!/^[0-9a-f]{8}$/i.test(c)) return fallback;
    return { color: '#' + c.slice(6, 8) + c.slice(4, 6) + c.slice(2, 4), opacity: parseInt(c.slice(0, 2), 16) / 255 };
  }
  const textOf = html => new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.trim();

  // read KML; on errors (e.g. "gx:" without namespace, bare "&") retry after cleaning
  function parseXml(text) {
    const parse = t => new DOMParser().parseFromString(t, 'application/xml');
    let doc = parse(text);
    if (!doc.getElementsByTagName('parsererror').length) return doc;
    const clean = String(text)
      .replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1')
      .replace(/\s[A-Za-z_][\w.-]*:[\w.-]+\s*=\s*("[^"]*"|'[^']*')/g, '')
      .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
    doc = parse(clean);
    if (doc.getElementsByTagName('parsererror').length) throw new Error('KML cannot be read.');
    return doc;
  }

  // path of a file relative to the KML (e.g. "../1/0.png" in "0/0/0.kml")
  function resolvePath(base, href) {
    const parts = String(base || '').split('/').slice(0, -1);
    for (const p of String(href).split('/')) {
      if (p === '..') parts.pop();
      else if (p && p !== '.') parts.push(p);
    }
    return parts.join('/');
  }

  function kmlLayer(ov) {
    const imgs = ov.images || {};
    const names = Object.keys(imgs);
    const image = (href, docPath) => {
      if (!href) return '';
      href = href.trim();
      if (/^data:image\//.test(href)) return href;
      if (imgs[href]) return imgs[href];
      if (/^http:\/\//i.test(href)) href = 'https://' + href.slice(7); // http images are blocked on an https page
      const rel = resolvePath(docPath, href);
      if (imgs[rel]) return imgs[rel];
      const base = href.split('/').pop();
      const hits = names.filter(n => n.split('/').pop() === base);
      if (hits.length === 1) return imgs[hits[0]];
      return /^https?:\/\//i.test(href) ? href : '';
    };
    const group = L.featureGroup();
    const grounds = []; // { bounds, url, span }
    const docs = [[ov.path || 'doc.kml', ov.kml], ...Object.entries(ov.extra || {})];

    for (const [docPath, text] of docs) {
      let doc;
      try { doc = parseXml(text); } catch (e) { if (docPath === (ov.path || 'doc.kml')) throw e; continue; }
      // by local name: KML from other programs may use a prefix (kml:Placemark) or none at all
      const all = (el, name) => el.getElementsByTagNameNS('*', name);
      const kids = (el, name) => [...el.children].filter(c => c.localName === name);
      const kid = (el, name) => kids(el, name)[0];
      const txt = (el, name) => { const n = el && all(el, name)[0]; return n ? n.textContent.trim() : ''; };
      const readStyle = st => {
        const ls = kid(st, 'LineStyle'), ps = kid(st, 'PolyStyle'), is = kid(st, 'IconStyle');
        return {
          line: kmlColor(ls && txt(ls, 'color'), null), width: Number(ls && txt(ls, 'width')) || 2,
          poly: kmlColor(ps && txt(ps, 'color'), null), fill: !(ps && txt(ps, 'fill') === '0'),
          icon: is ? image(txt(is, 'href'), docPath) : '', iconColor: kmlColor(is && txt(is, 'color'), null),
        };
      };
      const styles = {};
      for (const st of all(doc, 'Style')) if (st.getAttribute('id')) styles['#' + st.getAttribute('id')] = readStyle(st);
      for (const sm of all(doc, 'StyleMap')) {
        const pair = [...all(sm, 'Pair')].find(p => txt(p, 'key') === 'normal');
        if (pair && sm.getAttribute('id')) styles['#' + sm.getAttribute('id')] = styles[txt(pair, 'styleUrl').replace(/^[^#]*/, '')] || {};
      }
      const coords = el => (el ? el.textContent.trim().replace(/\s*,\s*/g, ',').split(/\s+/).map(s => s.split(',').map(Number)).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[1], p[0]]) : []);

      for (const pm of all(doc, 'Placemark')) {
        const own = kid(pm, 'Style');
        const st = Object.assign({}, styles[txt(pm, 'styleUrl').replace(/^[^#]*/, '')] || {}, own ? readStyle(own) : {});
        const name = txt(pm, 'name');
        const desc = textOf(txt(pm, 'description'));
        const line = st.line || { color: '#ffd400', opacity: 1 };
        const poly = st.poly || { color: line.color, opacity: 0.25 };
        const popup = `<div class="t">${esc(name || ov.name)}</div>${desc ? `<div>${esc(desc)}</div>` : ''}<div class="k">${esc(ov.name)}</div>`;
        const add = layer => { layer.bindPopup(popup, { maxWidth: 260 }); group.addLayer(layer); };
        const walk = g => {
          for (const el of g.children) {
            if (el.localName === 'Point') {
              const p = coords(kid(el, 'coordinates'))[0];
              if (!p) continue;
              const dot = () => L.circleMarker(p, { pane: 'kml', radius: 6, color: '#000', weight: 1.5, fillColor: (st.iconColor || line).color, fillOpacity: 1 });
              const m = st.icon ? L.marker(p, { pane: 'kml', icon: L.icon({ iconUrl: st.icon, iconSize: [24, 24], iconAnchor: [12, 12] }) }) : dot();
              // an icon from the internet that does not load (offline, blocked): a dot instead of nothing
              if (st.icon) m.on('add', () => { const img = m.getElement(); if (img) img.onerror = () => { const d = dot(); if (name) d.bindTooltip(name, { permanent: true, direction: 'right', className: 'ov-label', offset: [8, 0] }); d.bindPopup(popup, { maxWidth: 260 }); group.removeLayer(m); group.addLayer(d); }; });
              if (name) m.bindTooltip(name, { permanent: true, direction: 'right', className: 'ov-label', offset: [8, 0] });
              add(m);
            } else if (el.localName === 'LineString' || el.localName === 'LinearRing') {
              const pts = coords(kid(el, 'coordinates'));
              if (pts.length > 1) add(L.polyline(pts, { pane: 'kml', color: line.color, opacity: line.opacity, weight: st.width || 2 }));
            } else if (el.localName === 'Polygon') {
              const outer = kid(el, 'outerBoundaryIs'), inner = kids(el, 'innerBoundaryIs');
              const rings = [coords(outer && all(outer, 'coordinates')[0]), ...inner.map(i => coords(all(i, 'coordinates')[0]))].filter(r => r.length > 2);
              if (rings.length) add(L.polygon(rings, { pane: 'kml', color: line.color, opacity: line.opacity, weight: st.width || 2, fillColor: poly.color, fillOpacity: st.fill === false ? 0 : poly.opacity }));
            } else if (el.localName === 'Track') {
              // Google Earth GPS track (gx:Track): <gx:coord>lon lat alt</gx:coord>
              const pts = kids(el, 'coord').map(c => c.textContent.trim().split(/\s+/).map(Number)).filter(q => Number.isFinite(q[0]) && Number.isFinite(q[1])).map(q => [q[1], q[0]]);
              if (pts.length > 1) add(L.polyline(pts, { pane: 'kml', color: line.color, opacity: line.opacity, weight: st.width || 2 }));
            } else if (el.localName === 'MultiGeometry' || el.localName === 'MultiTrack') {
              walk(el);
            }
          }
        };
        walk(pm);
      }
      // raster maps (GroundOverlay) with LatLonBox or gx:LatLonQuad
      for (const go of all(doc, 'GroundOverlay')) {
        const icon = all(go, 'Icon')[0];
        const url = image(txt(icon, 'href'), docPath);
        if (!url) continue;
        let b = null;
        const box = all(go, 'LatLonBox')[0];
        if (box) {
          b = [[Number(txt(box, 'south')), Number(txt(box, 'west'))], [Number(txt(box, 'north')), Number(txt(box, 'east'))]];
        } else {
          const quad = all(go, 'LatLonQuad')[0];
          const pts = quad ? coords(all(quad, 'coordinates')[0] || quad) : [];
          if (pts.length >= 4) b = [[Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))], [Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))]];
        }
        // large map image reduced on import (lib/raster.js): its width in pixels for choosing the detail level
        const pxData = [...all(go, 'Data')].find(d => d.getAttribute('name') === 'takwebPx');
        const px = pxData ? Number(txt(pxData, 'value')) : 0;
        if (b && b.flat().every(Number.isFinite)) grounds.push({ bounds: b, url, px, span: Math.abs(b[1][1] - b[0][1]) || 1e-9 });
      }
    }

    // raster images: one detail level -> show all; several (super overlay) -> matching level per zoom, only visible ones
    const levels = new Map();
    for (const g of grounds) {
      // reduced map image: by resolution (all pieces are full resolution, also the narrower edge pieces)
      const k = g.px ? Math.round(Math.log2(360 * g.px / g.span)) : Math.round(Math.log2(360 / g.span));
      if (!levels.has(k)) levels.set(k, []);
      levels.get(k).push(g);
    }
    if (levels.size <= 1) {
      for (const g of grounds) group.addLayer(L.imageOverlay(g.url, g.bounds, { pane: 'kml', opacity: 0.9 }));
    } else {
      const keys = [...levels.keys()].sort((a, b) => a - b);
      const raster = L.featureGroup(); // featureGroup: the overlay's bounds (zoom to it) work with it
      const made = new Map();
      const refresh = () => {
        if (!map.hasLayer(group)) return;
        const z = map.getZoom();
        // reduced map image (overview + pieces): the coarsest level that is still sharp on screen –
        // the full-resolution pieces only when zoomed in (and only the visible ones)
        const sharp = keys.filter(lv => { const g = levels.get(lv)[0]; return g.px && g.px >= 0.8 * 256 * 2 ** z * g.span / 360; });
        // otherwise (super overlay tiles): level whose images are about 256–512 px wide on screen
        const k = levels.get(keys[0])[0].px ? (sharp.length ? sharp[0] : keys[keys.length - 1]) : keys.reduce((best, lv) => {
          const w = 256 * 2 ** z / 2 ** lv;
          const bw = 256 * 2 ** z / 2 ** best;
          return Math.abs(Math.log2(w / 384)) < Math.abs(Math.log2(bw / 384)) ? lv : best;
        }, keys[0]);
        const view = map.getBounds().pad(0.3);
        raster.clearLayers();
        for (const g of levels.get(k)) {
          if (!view.intersects(L.latLngBounds(g.bounds))) continue;
          if (!made.has(g)) made.set(g, L.imageOverlay(g.url, g.bounds, { pane: 'kml', opacity: 0.9 }));
          raster.addLayer(made.get(g));
        }
      };
      group.addLayer(raster);
      group.on('add', () => { map.on('moveend zoomend', refresh); setTimeout(refresh, 0); });
      group.on('remove', () => map.off('moveend zoomend', refresh));
      group._superBounds = L.latLngBounds(grounds.map(g => g.bounds).flat());
    }
    if (grounds.length && !group._superBounds) group._superBounds = L.latLngBounds(grounds.map(g => g.bounds).flat());
    return group;
  }

  function boundsOf(l) {
    const b = l.getBounds();
    if (l._superBounds) return b.isValid() ? b.extend(l._superBounds) : l._superBounds;
    return b;
  }

  function showOverlay(ov) {
    if (layers.has(ov.id)) { layers.get(ov.id).remove(); layers.delete(ov.id); }
    if (!ov.visible) { if (window.view3d) view3d.dirtyOverlays(); return; }
    try {
      const l = kmlLayer(ov);
      l.addTo(map);
      layers.set(ov.id, l);
    } catch (e) { toast(`Overlay "${ov.name}": ${e.message}`); }
    if (window.view3d) view3d.dirtyOverlays();
  }

  async function saveOverlays(list, source, zoomTo) {
    let first = null;
    for (const o of list) {
      const ov = { id: source + ':' + o.name, name: o.name, source, kml: o.kml, path: o.path, extra: o.extra || {}, images: o.images || {}, visible: true, date: Date.now() };
      const old = overlays.find(x => x.id === ov.id);
      if (old) ov.visible = old.visible;
      overlays = overlays.filter(x => x.id !== ov.id).concat(ov);
      try { await idb.put(ov); } catch (e) { toast('Overlay could not be stored offline (storage full?).'); }
      showOverlay(ov);
      if (!first) first = ov;
    }
    renderOverlays();
    // show a new overlay right away (otherwise it is often outside the view)
    if (zoomTo && first && layers.has(first.id)) {
      const b = boundsOf(layers.get(first.id));
      if (b && b.isValid()) map.fitBounds(b, { maxZoom: 15 });
    }
  }

  function renderOverlays() {
    const box = $('ovList');
    box.textContent = '';
    if (!overlays.length) box.innerHTML = '<div class="empty">No overlays yet.</div>';
    for (const ov of overlays) {
      const row = document.createElement('div');
      row.className = 'item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ov.visible;
      cb.onchange = () => { ov.visible = cb.checked; idb.put(ov).catch(() => {}); showOverlay(ov); };
      const t = document.createElement('span');
      t.textContent = ov.name;
      const s = document.createElement('small');
      const [kind, ...rest] = ov.source.split(':');
      s.textContent = kind === 'file' ? 'from device' : (kind === 'pkg' ? 'package ' : 'mission ') + rest.join(':');
      t.append(s);
      t.style.cursor = 'pointer';
      t.onclick = () => {
        const l = layers.get(ov.id);
        const b = l && boundsOf(l);
        if (b && b.isValid()) { window.eud.closePopup(); map.fitBounds(b, { maxZoom: 16 }); }
      };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete');
      del.onclick = async () => {
        if (!confirm(`Delete overlay "${ov.name}"?`)) return;
        overlays = overlays.filter(x => x !== ov);
        ov.visible = false;
        showOverlay(ov);
        await idb.del(ov.id).catch(() => {});
        renderOverlays();
      };
      row.append(cb, t, del);
      box.append(row);
    }
  }

  // ---------------- Server selection and fetching ----------------

  const NEED_CERT = 'This needs a TAK server with SSL and a certificate (Menu → Servers).';
  const dataServers = () => getServers().filter(s => s.proto === 'ssl' && s.certPem && s.keyPem);
  function currentServer() {
    const list = dataServers();
    return list.find(s => s.id === $('dataSrv').value) || list[0] || null;
  }
  function fillServers() {
    const list = dataServers();
    const keep = $('dataSrv').value || store.get('eud.dataSrv', '');
    $('dataSrv').replaceChildren(...list.map(s => new Option(s.name || s.host, s.id)));
    if (list.some(s => s.id === keep)) $('dataSrv').value = keep;
    $('dataSrvRow').classList.toggle('hidden', list.length < 2);
  }
  $('dataSrv').addEventListener('change', () => store.set('eud.dataSrv', $('dataSrv').value));

  async function marti(action, args, srv = currentServer()) {
    if (!srv || !srv.certPem) throw new Error(NEED_CERT);
    for (let i = 0; i < 2; i++) {
      try {
        return await postJson('/api/eud/marti', {
          server: { host: srv.host, apiPort: srv.apiPort || 8443, caPems: srv.caPems, fingerprint: srv.apiFingerprint || srv.fingerprint, certPem: srv.certPem, keyPem: srv.keyPem },
          action, args,
        });
      } catch (e) {
        if (e.code !== 'UNTRUSTED' || i) throw e;
        const ok = await askTrust(`${srv.host}:${srv.apiPort || 8443}`, e.fingerprint, e.subject);
        if (!ok) throw new Error('Cancelled.');
        srv.apiFingerprint = e.fingerprint;
        saveServers();
      }
    }
    return null;
  }

  // apply the result: CoT onto the map, store overlays
  async function apply(result, source, zoomTo) {
    for (const xml of result.cot || []) handleCot(xml);
    if ((result.overlays || []).length) await saveOverlays(result.overlays, source, zoomTo);
    let text = `${(result.cot || []).length} item(s), ${(result.overlays || []).length} overlay(s)`;
    if ((result.errors || []).length) text += ` – ${result.errors.length} part(s) failed: ${result.errors[0]}`;
    if ((result.warnings || []).length) text += ` – ${result.warnings[0]}`;
    return text;
  }

  const busy = (btn, on) => { if (btn) btn.disabled = on; };
  const fmtTime = t => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }); };

  // ---------------- Datenpakete ----------------

  $('pkgLoad').addEventListener('click', async () => {
    const btn = $('pkgLoad');
    busy(btn, true);
    msg('Loading list …', true);
    try {
      const { packages } = await marti('packages');
      const box = $('pkgList');
      box.textContent = '';
      if (!packages.length) box.innerHTML = '<div class="empty">No data packages on the server.</div>';
      for (const p of packages) {
        const row = document.createElement('div');
        row.className = 'item';
        const t = document.createElement('span');
        t.textContent = p.name;
        const s = document.createElement('small');
        s.textContent = [p.user, fmtTime(p.time), p.size ? Math.max(1, Math.round(p.size / 1024)) + ' KB' : ''].filter(Boolean).join(' · ');
        t.append(s);
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'LOAD';
        b.onclick = async () => {
          b.disabled = true;
          msg('Loading ' + p.name + ' …', true);
          try {
            const summary = await apply(await marti('package', { hash: p.hash, name: p.name }), 'pkg:' + p.name, true);
            msg(`${p.name}: ${summary}.`, true);
            b.textContent = '✓';
            b.className = 'on';
          } catch (e) { msg(e.message); } finally { b.disabled = false; }
        };
        row.append(t, b);
        box.append(row);
      }
      if (packages.length) msg('');
    } catch (e) { msg(e.message); } finally { busy(btn, false); }
  });

  // ---------------- Data Sync (missions) ----------------

  let subs = store.get('eud.missions', []); // [{ srv, name, password }]
  const isSub = (srv, name) => subs.some(s => s.srv === srv.id && s.name === name);

  async function syncMission(srv, name, quiet) {
    const sub = subs.find(s => s.srv === srv.id && s.name === name);
    const summary = await apply(await marti('mission', { name, uid: profile.uid, password: sub ? sub.password : undefined }, srv), 'mission:' + name, !quiet);
    if (!quiet) msg(`${name}: ${summary}.`, true);
  }

  async function subscribe(srv, name, password) {
    subs = subs.filter(x => !(x.srv === srv.id && x.name === name)).concat({ srv: srv.id, name, password: password || undefined });
    store.set('eud.missions', subs);
    try {
      await syncMission(srv, name);
    } catch (e) {
      subs = subs.filter(x => !(x.srv === srv.id && x.name === name));
      store.set('eud.missions', subs);
      throw e;
    }
  }

  $('misLoad').addEventListener('click', async () => {
    const btn = $('misLoad');
    const srv = currentServer();
    busy(btn, true);
    msg('Loading missions …', true);
    try {
      const { missions } = await marti('missions', {}, srv);
      const box = $('misList');
      box.textContent = '';
      if (!missions.length) box.innerHTML = '<div class="empty">No missions visible – the server has none, or none for your groups.</div>';
      for (const m of missions) {
        const row = document.createElement('div');
        row.className = 'item';
        const t = document.createElement('span');
        t.textContent = m.name + (m.password ? ' 🔒' : '');
        const s = document.createElement('small');
        s.textContent = [m.description, `${m.items} items`, `${m.files} files`, m.groups && m.groups.length ? m.groups.join(', ') : ''].filter(Boolean).join(' · ');
        t.append(s);
        // reload the subscribed mission right away
        const re = document.createElement('button');
        re.type = 'button';
        re.className = 'sm';
        re.textContent = '⟳';
        re.title = 'Sync now';
        re.onclick = async () => {
          re.disabled = true;
          msg('Syncing ' + m.name + ' …', true);
          try { await syncMission(srv, m.name); } catch (e) { msg(e.message); } finally { re.disabled = false; }
        };
        const b = document.createElement('button');
        b.type = 'button';
        const label = () => { const on = isSub(srv, m.name); b.textContent = on ? '✓ SUBSCRIBED' : 'SUBSCRIBE'; b.className = on ? 'on' : ''; re.classList.toggle('hidden', !on); };
        label();
        b.onclick = async () => {
          b.disabled = true;
          try {
            if (isSub(srv, m.name)) {
              await marti('unsubscribe', { name: m.name, uid: profile.uid }, srv).catch(() => {});
              subs = subs.filter(x => !(x.srv === srv.id && x.name === m.name));
              store.set('eud.missions', subs);
              msg(`${m.name}: unsubscribed.`, true);
            } else {
              let password;
              if (m.password) {
                password = prompt(`Password for mission "${m.name}":`);
                if (password == null) return;
              }
              msg('Loading ' + m.name + ' …', true);
              await subscribe(srv, m.name, password);
            }
            label();
          } catch (e) { msg(e.message); } finally { b.disabled = false; }
        };
        row.append(t, re, b);
        box.append(row);
      }
      if (missions.length) msg(`${missions.length} mission(s).`, true);
    } catch (e) { msg(e.message); } finally { busy(btn, false); }
  });

  // keep subscribed missions up to date: on change messages from the server and every 5 minutes
  async function syncAll() {
    if (!navigator.onLine) return;
    for (const sub of subs) {
      const srv = getServers().find(s => s.id === sub.srv && s.auto);
      if (srv) await syncMission(srv, sub.name, true).catch(() => {});
    }
  }
  setInterval(syncAll, 5 * 60 * 1000);
  setTimeout(syncAll, 8000);

  // ---------------- Sent by the server (auto push like ATAK) ----------------

  const detailAttr = (xml, tag, attr) => {
    const m = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`).exec(xml);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : '';
  };
  const pushSrv = d => (d && d.srv && d.srv.certPem ? d.srv : dataServers()[0] || null);
  const seenPush = new Set();

  // data package sent to this device (b-f-t-r with <fileshare senderUrl=… sha256=…>)
  document.addEventListener('eud-file-push', async e => {
    const xml = e.detail.xml;
    const url = detailAttr(xml, 'fileshare', 'senderUrl');
    let hash = detailAttr(xml, 'fileshare', 'sha256');
    try { hash = new URL(url).searchParams.get('hash') || hash; } catch (err) { /* not a URL */ }
    const name = detailAttr(xml, 'fileshare', 'filename') || detailAttr(xml, 'fileshare', 'name') || 'package.zip';
    const from = detailAttr(xml, 'fileshare', 'senderCallsign');
    if (!hash || seenPush.has(hash)) return;
    seenPush.add(hash);
    const srv = pushSrv(e.detail);
    if (!srv) return toast(`Data package "${name}" received, but ${NEED_CERT}`, 6000);
    toast(`Receiving data package "${name}"${from ? ' from ' + from : ''} …`);
    try {
      const summary = await apply(await marti('package', { hash, name }, srv), 'pkg:' + name, true);
      toast(`Data package "${name}": ${summary}.`, 6000);
    } catch (err) {
      seenPush.delete(hash);
      toast(`Data package "${name}" failed: ${err.message}`, 6000);
    }
  });

  // invitation to a mission (t-x-m-i): subscribe directly like ATAK
  document.addEventListener('eud-mission-invite', async e => {
    const name = detailAttr(e.detail.xml, 'mission', 'name');
    const srv = pushSrv(e.detail);
    if (!name || !srv || isSub(srv, name)) return;
    toast(`Invited to mission "${name}" – subscribing …`);
    try { await subscribe(srv, name); toast(`Mission "${name}" subscribed.`); } catch (err) { toast(`Mission "${name}": ${err.message}`, 6000); }
  });

  // mission changed (t-x-m-c): reload this mission (briefly batched)
  const changeTimers = new Map();
  document.addEventListener('eud-mission-change', e => {
    const name = e.detail ? detailAttr(e.detail.xml, 'mission', 'name') : '';
    const targets = name ? subs.filter(s => s.name === name) : subs;
    for (const sub of targets) {
      const key = sub.srv + ':' + sub.name;
      clearTimeout(changeTimers.get(key));
      changeTimers.set(key, setTimeout(() => {
        const srv = getServers().find(s => s.id === sub.srv);
        if (srv) syncMission(srv, sub.name, true).catch(() => {});
      }, 2000));
    }
  });

  // ---------------- Device profile of the TAK server (like ATAK) ----------------
  // After enrolling: the enrollment profile once (map sources, data packages "on enrollment"); on every connection
  // the connection profile with only what is new since the last sync ("on connection" in OpenTAKServer).
  const profileBusy = new Set();
  async function syncProfile(srv) {
    if (!srv || !srv.certPem || profileBusy.has(srv.id)) return;
    profileBusy.add(srv.id);
    const parts = [];
    try {
      const steps = srv.enrollProfile ? ['enrollment', 'connection'] : ['connection'];
      for (const kind of steps) {
        const secago = kind === 'connection' && srv.profileSync ? Math.ceil((Date.now() - srv.profileSync) / 1000) : -1;
        const r = await marti('profile', { kind, uid: profile.uid, secago }, srv);
        if (kind === 'enrollment') srv.enrollProfile = false;
        else srv.profileSync = Date.now();
        saveServers();
        if (r.empty) continue;
        for (const xml of r.cot || []) handleCot(xml);
        if ((r.overlays || []).length) await saveOverlays(r.overlays, 'profile:' + srv.host, false);
        const maps = window.eud.addTakMaps(r.maps);
        window.eud.applyProfilePrefs(r.prefs);
        if ((r.overlays || []).length) parts.push(`${r.overlays.length} overlay(s)`);
        if ((r.cot || []).length) parts.push(`${r.cot.length} item(s)`);
        if (maps) parts.push(`${maps} map source(s) – Menu → Maps`);
        if ((r.errors || []).length) parts.push(`${r.errors.length} part(s) failed`);
      }
      if (parts.length) toast(`From ${srv.name || srv.host}: ${parts.join(', ')}.`, 6000);
    } catch (err) {
      if (srv.enrollProfile) toast(`Device profile of ${srv.name || srv.host}: ${err.message}`, 6000);
    } finally {
      profileBusy.delete(srv.id);
    }
  }
  document.addEventListener('eud-connected', e => syncProfile(e.detail.srv));

  // ---------------- Overlays from the device ----------------

  $('ovFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    msg('Loading ' + f.name + ' …', true);
    try {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
        r.onerror = () => reject(new Error('Cannot read file.'));
        r.readAsDataURL(f);
      });
      const summary = await apply(await postJson('/api/eud/extract', { name: f.name, data }), 'file:' + f.name, true);
      msg(`${f.name}: ${summary}.`, true);
    } catch (err) { msg(err.message); }
  });

  // ---------------- Video feeds from the TAK server ----------------

  $('feedLoad').addEventListener('click', async () => {
    const btn = $('feedLoad');
    const box = $('feedList');
    busy(btn, true);
    try {
      const { feeds } = await marti('videos');
      box.textContent = '';
      if (!feeds.length) box.innerHTML = '<div class="empty">No video feeds on the server.</div>';
      for (const f of feeds) {
        const row = document.createElement('div');
        row.className = 'item';
        const t = document.createElement('span');
        t.textContent = f.alias;
        const s = document.createElement('small');
        s.textContent = f.url;
        t.append(s);
        const b = document.createElement('button');
        b.type = 'button';
        if (/^https?:\/\//i.test(f.url)) {
          b.textContent = '▶';
          b.onclick = () => { window.eud.closePopup(); window.eudPlay(f.alias, f.url); };
        } else {
          b.textContent = 'COPY';
          b.onclick = () => navigator.clipboard.writeText(f.url).then(() => toast('Address copied – open it e.g. in VLC.'), () => toast(f.url, 8000));
        }
        row.append(t, b);
        box.append(row);
      }
      setMsg($('vidMsg'), '');
    } catch (e) { setMsg($('vidMsg'), e.message); } finally { busy(btn, false); }
  });

  // ---------------- Tabs, Start ----------------

  for (const b of document.querySelectorAll('#dataTabs button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('#dataTabs button')) x.classList.toggle('on', x === b);
      for (const p of document.querySelectorAll('[data-pane]')) p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab);
      if (b.dataset.tab === 'overlays') renderOverlays();
    });
  }
  document.addEventListener('eud-popup', e => {
    if (e.detail === 'data') { fillServers(); renderOverlays(); msg(dataServers().length ? '' : NEED_CERT); }
  });

  // for "Clear Content" in eud.js
  // for the 3D map: visible overlays as lines/areas, points and raster images
  function for3d() {
    const out = { features: [], points: [], images: [] };
    const walk = l => {
      if (l instanceof L.ImageOverlay) {
        const b = l.getBounds();
        out.images.push({ url: l._url, bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]] });
      } else if (l instanceof L.Polyline) {
        const o = l.options;
        out.features.push({ type: 'Feature', geometry: l.toGeoJSON().geometry, properties: {
          stroke: o.color || '#ffd400', width: Number(o.weight) || 2, opacity: o.opacity == null ? 1 : o.opacity,
          fill: o.fillColor || o.color || '#ffd400', fillOpacity: l instanceof L.Polygon ? (o.fillOpacity == null ? 0.2 : o.fillOpacity) : 0,
        } });
      } else if (l instanceof L.Marker || l instanceof L.CircleMarker) {
        const p = l.getLatLng();
        const tip = l.getTooltip && l.getTooltip();
        const icon = l.options.icon && l.options.icon.options && l.options.icon.options.iconUrl;
        out.points.push({ lat: p.lat, lon: p.lng, name: tip ? String(tip.getContent() || '') : '', icon: icon || '', color: l.options.fillColor || '' });
      } else if (l.eachLayer) {
        l.eachLayer(walk);
      }
    };
    for (const l of layers.values()) walk(l);
    return out;
  }

  window.eud.overlayApi = {
    for3d,
    list: () => overlays,
    clear: async () => {
      const n = overlays.length;
      for (const ov of overlays) { ov.visible = false; showOverlay(ov); await idb.del(ov.id).catch(() => {}); }
      overlays = [];
      renderOverlays();
      return n;
    },
  };

  idb.all().then(list => {
    overlays = (list || []).sort((a, b) => a.date - b.date);
    for (const ov of overlays) showOverlay(ov);
  }).catch(() => {});
})();
