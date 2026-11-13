// Admin: Network – how every device reaches the TAK server right now (own internet, over a phone gateway, over an HQ
// gateway radio / MQTT), the gateways with their traffic, and the coverage over time (server: lib/netmap.js)
'use strict';

(() => {
  const COLOR = { internet: '#3ddc4b', gateway: '#33b5e5', mesh: '#f6a623', offline: '#6b7380' };
  const KIND_TEXT = { internet: 'Internet (own connection)', gateway: 'Gateway', mesh: 'Mesh only', offline: 'Offline' };
  const LINK_TEXT = { internet: 'own internet', lora: 'LoRa → phone gateway', mqtt: 'LoRa → MQTT (HQ gateway)' };
  const RADIO_TEXT = { ble: 'Bluetooth', serial: 'USB', http: 'WLAN', tcp: 'WLAN (TCP)' };
  const h = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const since = t => { if (!t) return '–'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString('en-GB'); };
  let map = null, layers = null, poll = null, last = null, fitted = false;

  function ensureMap() {
    if (map) return;
    map = L.map('nwMap', { zoomControl: true, worldCopyJump: true });
    const base = {
      'OpenStreetMap': L.tileLayer('/eud/tiles/osm/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
      'Topo': L.tileLayer('/eud/tiles/topo/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' }),
      'Satellite': L.tileLayer('/eud/tiles/sat/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© Esri' }),
    };
    base.OpenStreetMap.addTo(map);
    L.control.layers(base).addTo(map);
    layers = { cover: L.layerGroup().addTo(map), lines: L.layerGroup().addTo(map), nodes: L.layerGroup().addTo(map) };
    map.setView([48, 10], 5);
  }

  // coverage cell colour: mostly internet → green, never internet but mesh → orange, mostly broken off → red
  function cellStyle(c) {
    const [, , inet, mesh, lost] = c;
    const all = inet + mesh + lost || 1;
    const color = lost / all > 0.5 ? '#ff3b30' : inet / all >= 0.5 ? '#3ddc4b' : mesh ? '#f6a623' : '#3ddc4b';
    return { stroke: false, fillColor: color, fillOpacity: 0.18 + Math.min(0.37, Math.log10(all + 1) * 0.2) };
  }

  function icon(n) {
    const mqtt = n.gatewayType === 'radio';
    return L.divIcon({
      className: 'nw-ic ' + (n.kind === 'gateway' ? 'gateway' : ''),
      html: `<div class="${mqtt ? 'gwmqtt' : ''}" style="background:${COLOR[n.kind]}"></div>`,
      iconSize: [20, 20], iconAnchor: [10, 10],
    });
  }

  function popup(n, byUid) {
    const via = n.via && byUid.get(n.via);
    const rows = [
      ['Status', KIND_TEXT[n.kind] + (n.gatewayType ? ` (${n.gatewayType === 'radio' ? 'HQ radio, MQTT' : 'phone with radio'})` : '')],
      ['Way to the server', LINK_TEXT[n.link] || n.link],
      via ? ['Passed on by', via.callsign] : null,
      n.radio ? ['Radio', `${RADIO_TEXT[n.radio] || n.radio}${n.bridge ? ', gateway on' : ', gateway off'}`] : null,
      n.meshNode ? ['Mesh node', '!' + n.meshNode] : null,
      n.registered ? ['Set up as', `${n.registered.role === 'gateway' ? 'HQ gateway' : 'field radio'}${n.registered.ssid ? ', WLAN ' + n.registered.ssid : ''}`] : null,
      n.traffic != null ? ['Passed on (15 min)', String(n.traffic)] : null,
      ['Platform', n.platform || '–'],
      n.battery ? ['Battery', n.battery + ' %'] : null,
      ['Last heard', since(n.time)],
    ].filter(Boolean);
    return `<b>${h(n.callsign || n.uid)}</b><table class="small">${rows.map(([k, v]) => `<tr><td class="mut">${h(k)}</td><td>${h(v)}</td></tr>`).join('')}</table>`;
  }

  function draw(d) {
    ensureMap();
    const showOff = $('nwOffline').checked;
    const nodes = d.nodes.filter(n => Number.isFinite(n.lat) && (showOff || n.online));
    const byUid = new Map(d.nodes.map(n => [n.uid, n]));
    for (const l of Object.values(layers)) l.clearLayers();
    if ($('nwCover').checked) {
      for (const c of d.cells) {
        L.rectangle([[c[0], c[1]], [c[0] + d.cell, c[1] + d.cell]], cellStyle(c))
          .bindTooltip(`Internet ${c[2]} · mesh only ${c[3]} · broke off ${c[4]}<br>${since(c[5])}`, { sticky: true })
          .addTo(layers.cover);
      }
    }
    if ($('nwLines').checked) {
      for (const e of d.edges) {
        const a = byUid.get(e.from), b = byUid.get(e.to);
        if (!a || !b) continue;
        L.polyline([[a.lat, a.lon], [b.lat, b.lon]], e.kind === 'mqtt'
          ? { color: '#c58cff', weight: 2, dashArray: '6 6', opacity: 0.9 }
          : { color: '#f6a623', weight: 3, opacity: 0.9 })
          .bindTooltip(e.kind === 'mqtt' ? `${a.callsign} → MQTT gateway ${b.callsign} (assumed: the nearest)` : `${a.callsign} → over LoRa → ${b.callsign}`, { sticky: true })
          .addTo(layers.lines);
      }
    }
    for (const n of nodes) {
      L.marker([n.lat, n.lon], { icon: icon(n), zIndexOffset: n.kind === 'gateway' ? 1000 : 0 })
        .bindTooltip(h(n.callsign || n.uid), { direction: 'top', offset: [0, -10] })
        .bindPopup(popup(n, byUid))
        .addTo(layers.nodes);
    }
    if (!fitted) fit(d);
  }

  function fit(d = last) {
    if (!d || !map) return;
    const pts = d.nodes.filter(n => n.online && Number.isFinite(n.lat)).map(n => [n.lat, n.lon]);
    if (!pts.length) for (const c of d.cells) pts.push([c[0], c[1]]);
    if (!pts.length) return;
    fitted = true;
    map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15 });
  }

  function stats(d) {
    const on = d.nodes.filter(n => n.online);
    const k = kind => on.filter(n => n.kind === kind).length;
    const box = (num, text, color) => `<span class="st"><b style="color:${color}">${num}</b>${h(text)}</span>`;
    $('nwStats').innerHTML = box(k('internet'), 'internet', COLOR.internet) + box(k('gateway'), 'gateways', COLOR.gateway)
      + box(k('mesh'), 'mesh only', COLOR.mesh) + box(d.nodes.length - on.length, 'offline', COLOR.offline)
      + box(d.mqtt, 'from MQTT (15 min)', '#c58cff');
  }

  function tables(d) {
    const gws = d.nodes.filter(n => n.kind === 'gateway' || (n.gatewayType && !n.online));
    $('nwGws').innerHTML = gws.length ? gws.map(n => `<tr><td data-label="Gateway"><b>${h(n.callsign)}</b>${n.registered && n.registered.name ? ` <span class="mut small">${h(n.registered.name)}${n.registered.ssid ? ' · ' + h(n.registered.ssid) : ''}</span>` : ''}${n.online ? '' : ' <span class="mut small">(offline)</span>'}</td>`
      + `<td data-label="Type">${n.gatewayType === 'radio' ? 'HQ radio (MQTT)' : `phone + radio (${h(RADIO_TEXT[n.radio] || n.radio || '?')})`}</td>`
      + `<td data-label="Passes on">${n.gatewayType === 'radio' ? `${d.mqtt} over MQTT (all HQ gateways)` : n.traffic}</td>`
      + `<td data-label="Last heard">${since(n.time)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="mut">No gateway online. A TAKweb phone becomes one with a radio connected and "gateway" on (Meshtastic menu); a radio with the role "HQ gateway" (Meshtastic → Set up a radio).</td></tr>';
    $('nwRadios').innerHTML = d.radios.length ? d.radios.map(r => `<tr><td data-label="Radio">${h(r.name || '–')}</td><td data-label="Node"><code>!${h(r.node)}</code></td>`
      + `<td data-label="Role">${r.role === 'gateway' ? 'HQ gateway' : 'field radio'}${r.mqtt ? ' · MQTT' : ''}</td><td data-label="WLAN">${h(r.ssid || '–')}</td>`
      + `<td data-label="Status">${r.online ? '<span style="color:var(--ok)">online</span>' : r.seen ? 'last heard ' + since(r.seen) : 'not heard yet'}</td>`
      + `<td><button type="button" class="danger" data-forget="${h(r.node)}" title="Forget this radio">✕</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="mut">None yet – radios set up under Meshtastic → "Set up a radio" appear here with their role.</td></tr>';
  }

  async function load() {
    clearTimeout(poll);
    try {
      const d = await api('network');
      last = d;
      const s = d.source || {};
      setMsg($('nwMsg'), !s.available ? 'Connect OpenTAKServer first (Settings → OpenTAKServer) – the picture comes from the TAK server.'
        : !s.enabled ? 'The HQ connection is switched off – switch HQ on to see the network.'
          : s.state !== 'connected' ? `TAK server connection: ${s.message || s.state}` : '', false);
      stats(d);
      tables(d);
      draw(d);
    } catch (e) { setMsg($('nwMsg'), e.message); }
    if (document.querySelector('[data-nav="network"].on')) poll = setTimeout(load, 10000);
  }

  for (const id of ['nwCover', 'nwLines', 'nwOffline']) $(id).addEventListener('change', () => last && draw(last));
  $('nwFit').addEventListener('click', () => fit());
  $('nwReload').addEventListener('click', load);
  $('nwClear').addEventListener('click', async () => {
    if (!confirm('Clear the coverage history (where internet / mesh worked)? Live devices stay.')) return;
    try { await api('network/clear', { method: 'POST', body: {} }); load(); } catch (e) { setMsg($('nwMsg'), e.message); }
  });
  $('nwRadios').addEventListener('click', async e => {
    const b = e.target.closest('[data-forget]');
    if (!b || !confirm('Forget this radio? (Only the entry here – the radio itself is not changed.)')) return;
    try { await api('mesh-radios/' + b.dataset.forget, { method: 'DELETE' }); load(); } catch (err) { setMsg($('nwMsg'), err.message); }
  });
  document.addEventListener('admin-view', e => {
    if (e.detail === 'network') { ensureMap(); setTimeout(() => map.invalidateSize(), 50); load(); } else clearTimeout(poll);
  });
  if (document.querySelector('[data-nav="network"].on')) { ensureMap(); load(); }
})();
