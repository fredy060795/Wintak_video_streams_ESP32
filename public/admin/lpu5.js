// Admin: LPU5 field devices (server: lib/lpu5.js, lib/meshgw.js) – every device that comes online, what it does
// (BLE: Meshtastic radio or helmet camera, mesh <-> TAK gateway, SDR, hotspot, open Wi-Fi), commands, and full remote
// management of its Meshtastic radio (like Meshtastic Desktop: forms built from the protobuf definitions).
'use strict';

(() => {
  const api2 = (p, opts) => api('lpu5' + (p ? '/' + p : ''), opts);
  const OPT = {
    ble: [['mesh', 'Meshtastic radio'], ['bodycam', 'Helmet camera'], ['off', 'Off']],
    gateway: [['rxtx', 'Send + receive'], ['rx', 'Receive only'], ['off', 'Off']],
    sdr: [['off', 'Off'], ['rtl_tcp', 'rtl_tcp (listen from HQ)'], ['adsb', 'ADS-B (aircraft)']],
    hotspot: [['auto', 'Auto (when no uplink)'], ['on', 'Always on'], ['off', 'Off (rescue only)']],
  };
  let data = null, poll = null;

  const ago = t => { if (!t) return '–'; const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h'; };
  const sel = (name, value, onchange, extra = {}) => {
    const s = el('select', { class: 'sm-select', ...extra }, ...OPT[name].map(([v, t]) => { const o = el('option', { value: v, text: t }); if (v === value) o.selected = true; return o; }));
    if (onchange) s.addEventListener('change', () => onchange(s.value));
    return s;
  };

  // ---------------- list ----------------

  async function load() {
    try { data = await api2(''); } catch (e) { setMsg($('l5Msg'), e.message); return; }
    render();
  }

  function render() {
    const c = data.connection || {};
    $('l5Conn').textContent = c.state === 'connected' ? 'connected' : c.state === 'off' ? 'off' : c.state;
    $('l5Conn').className = 'badge ' + (c.state === 'connected' ? 'live' : c.state === 'off' ? 'off' : c.state === 'error' ? 'stop' : 'wait');
    $('l5ConnMsg').textContent = c.message || '';
    const t = data.tak || {};
    $('l5Tak').textContent = t.state === 'connected' ? 'TAK server: connected – devices, mesh and aircraft appear in ATAK/WinTAK/TAKweb.'
      : t.message || (data.otsConfigured ? 'TAK server: not connected.' : 'TAK server: set up OpenTAKServer first – until then LPU5 data shows on the HQ pages only.');
    const gs = data.gatewayStats;
    $('l5Gw').textContent = gs ? `Gateway: ${gs.radios} radio(s) sending · ${gs.up} up to TAK · ${gs.down} down to LoRa · ${gs.meshNodes} mesh nodes known` : '';
    renderSettings();
    const tb = $('l5Table').tBodies[0];
    tb.replaceChildren(...data.nodes.map(row));
    if (!data.nodes.length) tb.append(el('tr', {}, el('td', { colspan: 7, class: 'mut', text: 'No device has reported yet. Devices appear here as soon as they are online (VPN + MQTT).' })));
  }

  function row(n) {
    const st = n.status || {};
    const p = n.profile || {};
    const set = patch => saveNode(n.name, { profile: patch });
    const name = el('td', {},
      el('b', { text: n.label || n.name }), n.label ? el('div', { class: 'mut small', text: n.name }) : null,
      el('div', {}, el('span', { class: 'badge ' + (n.online ? 'live' : 'off'), text: n.online ? 'online' : 'offline' }),
        !n.adopted ? el('span', { class: 'badge wait', text: 'new' }) : null));
    const status = el('td', { class: 'small' },
      el('div', { text: `Uplink: ${st.uplink || '–'}${st.uplinkDev ? ' (' + st.uplinkDev + ')' : ''}` }),
      el('div', { text: `VPN: ${st.vpn != null && st.vpn < 180 ? 'ok' : '–'} · Mesh: ${st.mesh ? 'ok' : '–'} · ${st.temp != null ? st.temp + ' °C' : ''}` }),
      el('div', { class: 'mut', text: `${n.position ? n.position.lat.toFixed(5) + ', ' + n.position.lon.toFixed(5) : 'no position'} · seen ${ago(n.seen)}${st.version ? ' · v' + st.version : ''}` }),
      n.bodycam && p.ble === 'bodycam' ? el('div', { text: `Camera: ${n.bodycam.cam ? 'connected' : 'not found'} · ${n.bodycam.live ? 'live ' + (n.bodycam.fps || 0) + ' fps' : 'ready'}${n.bodycam.error ? ' · ' + n.bodycam.error : ''}` }) : null,
      n.bodycamError ? el('div', { class: 'msg err', text: n.bodycamError }) : null,
      n.adsb && p.sdr === 'adsb' ? el('div', { text: `ADS-B: ${n.adsb.count} aircraft` }) : null,
      n.running && JSON.stringify(n.running) !== JSON.stringify(p) && n.adopted ? el('div', { class: 'mut', text: n.online ? '⟳ applying settings …' : 'settings apply when online' }) : null);
    if (!n.adopted) {
      const take = el('button', { class: 'pri sm', type: 'button', text: '✓ Approve (defaults)' });
      take.addEventListener('click', () => saveNode(n.name, { adopted: true }));
      return el('tr', {}, name, status, el('td', { colspan: 4, class: 'mut small', text: 'New device – approve it to give it the defaults, then adjust.' }), el('td', {}, take, forgetBtn(n)));
    }
    const wifi = el('td', {}, sel('hotspot', p.hotspot, v => set({ hotspot: v })),
      el('label', { class: 'check small' }, (() => { const c = el('input', { type: 'checkbox' }); c.checked = p.open_wifi; c.addEventListener('change', () => set({ open_wifi: c.checked })); return c; })(), ' open Wi-Fi'));
    const acts = el('td', { class: 'row' });
    const b = (text, fn, attrs = {}) => { const x = el('button', { class: 'sm', type: 'button', text, ...attrs }); x.addEventListener('click', fn); acts.append(x); return x; };
    b('⚙ Meshtastic', () => openMesh(n), n.online && st.mesh ? {} : { disabled: '', title: 'Radio not connected' });
    b('✎', () => editNode(n), { title: 'Name, team, camera, position interval' });
    b('⌘', () => command(n), { title: 'Command (status, wifi scan, update, reboot …)' });
    if (p.sdr === 'rtl_tcp') b('📻', () => sdrInfo(n), { title: 'SDR address for GQRX / SDR++' });
    acts.append(forgetBtn(n));
    return el('tr', {}, name, status,
      el('td', {}, sel('ble', p.ble, v => set({ ble: v }))),
      el('td', {}, sel('gateway', p.gateway, v => set({ gateway: v }))),
      el('td', {}, sel('sdr', p.sdr, v => set({ sdr: v }))), wifi, acts);
  }

  function forgetBtn(n) {
    const x = el('button', { class: 'sm', type: 'button', text: '🗑', title: 'Forget the device (it appears again as new when it reports)' });
    x.addEventListener('click', async () => {
      if (!confirm(`Forget ${n.name}? Its settings are deleted.`)) return;
      try { data = await api2(`nodes/${n.name}/forget`, { method: 'POST', body: {} }); render(); } catch (e) { setMsg($('l5Msg'), e.message); }
    });
    return x;
  }

  async function saveNode(name, body) {
    try { data = await api2(`nodes/${name}/profile`, { method: 'POST', body }); render(); setMsg($('l5Msg'), 'Saved – the device applies it within seconds.', true); } catch (e) { setMsg($('l5Msg'), e.message); }
  }

  function editNode(n) {
    const p = n.profile;
    const f = el('form', {},
      el('label', { text: 'Name in TAK (callsign)' }), el('input', { name: 'label', value: n.label || '', placeholder: n.name, maxlength: 40 }),
      el('label', { text: 'Team colour in TAK (empty = default)' }), el('input', { name: 'team', value: n.team || '', placeholder: data.settings.team || 'Cyan', maxlength: 20 }),
      el('label', { text: 'Own GPS position into the mesh every … s (0 = off)' }), el('input', { name: 'pos', type: 'number', min: 0, value: p.position_interval || 0 }),
      el('h3', { text: 'Helmet camera (when BLE = helmet camera)' }),
      el('label', { text: 'Bluetooth address (empty = the first camera found)' }), el('input', { name: 'addr', value: p.bodycam.address || '', placeholder: 'AA:BB:CC:DD:EE:FF' }),
      el('label', { text: 'Image size' }), el('select', { name: 'fs' }, ...[[1, '160x120'], [5, '320x240'], [8, '640x480'], [11, '1280x720']].map(([v, t]) => { const o = el('option', { value: v, text: t }); if (v === p.bodycam.framesize) o.selected = true; return o; })),
      el('p', { class: 'mut small', text: 'The camera stream is created automatically and appears under Video feeds / the HQ video wall like a phone camera.' }),
      el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'pri', type: 'submit', text: 'Save' })));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      await saveNode(n.name, { label: f.label.value, team: f.team.value, profile: { position_interval: Number(f.pos.value) || 0, bodycam: { address: f.addr.value.trim(), framesize: Number(f.fs.value) } } });
      closeModal();
    });
    openModal(`${n.name}`, f);
  }

  function sdrInfo(n) {
    const ip = n.status && n.status.vpnIp;
    const v = ip ? `rtl_tcp=${ip}:1234` : 'rtl_tcp=<VPN address of the device>:1234';
    const f = copyField(v);
    openModal('SDR – ' + n.name, el('p', { class: 'small', text: 'In GQRX / SDR++ on a computer in the VPN: device string' }), el('div', { class: 'row' }, f.input, f.btn),
      el('p', { class: 'mut small', text: 'Only reachable through the VPN. ADS-B and rtl_tcp share the one stick – switch the SDR mode in the list.' }));
  }

  function command(n) {
    const inp = el('input', { placeholder: 'status · wifi scan · wifi hotspot on · sdr status · gps · mesh <text> · update · reboot', list: 'l5Cmds' });
    const out = el('pre', { class: 'small', style: 'white-space:pre-wrap;max-height:300px;overflow:auto' });
    const go = el('button', { class: 'pri', type: 'submit', text: 'Send' });
    const f = el('form', { class: 'row' }, el('div', { class: 'grow' }, inp), go);
    f.addEventListener('submit', async e => {
      e.preventDefault();
      if (/^(reboot|update)\b/.test(inp.value.trim()) && !confirm(`${inp.value.trim()} on ${n.name}?`)) return;
      out.textContent = '…';
      go.disabled = true;
      try { const r = await api2(`nodes/${n.name}/cmd`, { method: 'POST', body: { cmd: inp.value } }); out.textContent = pretty(r.result); } catch (x) { out.textContent = x.message; }
      go.disabled = false;
    });
    openModal('Command – ' + n.name, f, out);
    inp.focus();
  }
  const pretty = s => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return s; } };

  // ---------------- settings ----------------

  let settingsShown = false;
  function renderSettings() {
    if (settingsShown) return; // do not overwrite while editing
    settingsShown = true;
    const s = data.settings, f = $('l5Settings');
    f.enabled.checked = s.enabled;
    f.url.value = s.url;
    f.username.value = s.username;
    f.password.value = s.password;
    f.autoAdopt.checked = s.autoAdopt;
    f.team.value = s.team;
    for (const k of ['ble', 'gateway', 'sdr', 'hotspot']) f['d_' + k].replaceChildren(...OPT[k].map(([v, t]) => { const o = el('option', { value: v, text: t }); if (v === s.defaults[k]) o.selected = true; return o; }));
    f.d_open_wifi.checked = s.defaults.open_wifi;
    f.channel.value = s.gateway.channel;
    f.nodesToTak.checked = s.gateway.nodesToTak;
    f.adsbToTak.checked = s.gateway.adsbToTak;
    f.textsToLog.checked = s.gateway.textsToLog;
    f.adsbMaxKm.value = s.gateway.adsbMaxKm;
  }
  $('l5Settings').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const body = {
      enabled: f.enabled.checked, url: f.url.value.trim(), username: f.username.value.trim(), password: f.password.value, autoAdopt: f.autoAdopt.checked, team: f.team.value.trim(),
      defaults: { ble: f.d_ble.value, gateway: f.d_gateway.value, sdr: f.d_sdr.value, hotspot: f.d_hotspot.value, open_wifi: f.d_open_wifi.checked },
      gateway: { channel: Number(f.channel.value) || 0, nodesToTak: f.nodesToTak.checked, adsbToTak: f.adsbToTak.checked, textsToLog: f.textsToLog.checked, adsbMaxKm: Number(f.adsbMaxKm.value) || 150 },
    };
    try { data = await api2('settings', { method: 'POST', body }); settingsShown = false; render(); setMsg($('l5SetMsg'), 'Saved.', true); } catch (x) { setMsg($('l5SetMsg'), x.message); }
  });

  // one channel (e.g. a new key after a device got lost) on every online device
  $('l5ChPsk').addEventListener('click', () => { $('l5ChForm').psk.value = b64(crypto.getRandomValues(new Uint8Array(32))); });
  $('l5ChForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    if (!confirm('Set this channel on ALL online LPU5 radios? Devices that are offline keep the old one.')) return;
    $('l5ChOut').textContent = '…';
    try {
      const r = await api2('channel-all', { method: 'POST', body: { index: Number(f.index.value), name: f.name.value.trim(), psk: f.psk.value.trim() || undefined } });
      $('l5ChOut').textContent = r.results.length ? r.results.map(x => `${x.ok ? '✓' : '✗'} ${x.name}: ${x.text}`).join('\n') : 'No device online.';
    } catch (x) { $('l5ChOut').textContent = x.message; }
  });
  const b64 = u8 => btoa(String.fromCharCode(...u8));

  // ---------------- Meshtastic management of one device ----------------

  async function op(name, opName, args = {}) {
    const r = await api2(`nodes/${name}/op`, { method: 'POST', body: { op: opName, args } });
    return r.data;
  }

  async function openMesh(n) {
    const box = el('div', {}, el('p', { class: 'mut', text: 'Reading the radio …' }));
    openModal(`Meshtastic – ${n.label || n.name}`, box);
    $('modal').querySelector('.modal-box').classList.add('wide');
    let info;
    try { info = await op(n.name, 'mesh.info'); } catch (e) { box.replaceChildren(el('p', { class: 'msg err', text: e.message })); return; }
    const target = el('input', { placeholder: 'empty = this radio · or !a1b2c3d4 for a remote node (needs its admin key)', class: 'grow' });
    const msg = el('p', { class: 'msg' });
    const ctx = { n, info, target: () => target.value.trim() || undefined, msg, reload: async () => { info = ctx.info = await op(n.name, 'mesh.info'); } };
    const tabs = [['Device', tabDevice], ['Channels', tabChannels], ['Settings', (t, c) => renderConfig(t, 'config', c)], ['Modules', (t, c) => renderConfig(t, 'module', c)], ['Nodes', tabNodes], ['Backup', tabBackup]];
    const body = el('div');
    const bar = el('div', { class: 'row', style: 'margin-bottom:10px' });
    const show = i => {
      for (const [j, btn] of [...bar.children].entries()) btn.classList.toggle('pri', i === j);
      setMsg(msg, '');
      body.replaceChildren();
      tabs[i][1](body, ctx);
    };
    tabs.forEach(([t], i) => { const x = el('button', { class: 'sm', type: 'button', text: t }); x.addEventListener('click', () => show(i)); bar.append(x); });
    const my = info.my || {};
    box.replaceChildren(
      el('p', { class: 'small', text: `${my.long_name || ''} (${my.short_name || ''}) · ${my.id || ''} · ${my.hw || ''} · firmware ${my.firmware || '?'}` }),
      el('div', { class: 'row small' }, el('span', { text: 'Apply changes to:' }), target), bar, msg, body);
    show(0);
  }

  const run = async (ctx, fn, ok) => {
    setMsg(ctx.msg, '…', true);
    try { const r = await fn(); setMsg(ctx.msg, ok || (typeof r === 'string' ? r : 'Done.'), true); return r; } catch (e) { setMsg(ctx.msg, e.message); return null; }
  };

  function tabDevice(t, ctx) {
    const my = ctx.info.my || {};
    const f = el('form', {}, el('div', { class: 'row' },
      el('div', { class: 'grow' }, el('label', { text: 'Long name' }), el('input', { name: 'long', value: my.long_name || '', maxlength: 39 })),
      el('div', {}, el('label', { text: 'Short name' }), el('input', { name: 'short', value: my.short_name || '', maxlength: 4, style: 'width:80px' })),
      el('div', { class: 'actions-end' }, el('button', { class: 'pri', type: 'submit', text: 'Save name' }))));
    f.addEventListener('submit', e => { e.preventDefault(); run(ctx, () => op(ctx.n.name, 'mesh.set_owner', { long_name: f.long.value, short_name: f.short.value, target: ctx.target() })); });
    const lat = el('input', { placeholder: 'lat', style: 'width:120px' }), lon = el('input', { placeholder: 'lon', style: 'width:120px' });
    if (ctx.n.position) { lat.value = ctx.n.position.lat.toFixed(6); lon.value = ctx.n.position.lon.toFixed(6); }
    const act = (text, action, confirmText, extra = {}) => {
      const b = el('button', { class: 'sm', type: 'button', text });
      b.addEventListener('click', () => { if (confirmText && !confirm(confirmText)) return; run(ctx, () => op(ctx.n.name, 'mesh.action', { action, target: ctx.target(), ...extra() })); });
      return b;
    };
    t.append(f,
      el('h3', { text: 'Fixed position (radio without GPS, e.g. a relay on a hill)' }),
      el('div', { class: 'row' }, lat, lon, act('Set', 'fixed_position', null, () => ({ lat: Number(lat.value), lon: Number(lon.value) })), act('Remove', 'remove_fixed_position', null, () => ({}))),
      el('h3', { text: 'Device' }),
      el('div', { class: 'row' }, act('⟳ Reboot', 'reboot', 'Reboot the radio?', () => ({})), act('⏻ Shut down', 'shutdown', 'Shut the radio down? It stays off until powered again.', () => ({})),
        act('Reset node list', 'reset_nodedb', 'Delete the node list of the radio?', () => ({})), act('⚠ Factory reset', 'factory_reset', 'FACTORY RESET – all settings and channels of the radio are deleted. Sure?', () => ({}))));
  }

  function tabChannels(t, ctx) {
    const list = ctx.info.channels || [];
    const tb = el('tbody', {}, ...list.filter(c => c.role !== 'DISABLED').map(c => {
      const e = el('button', { class: 'sm', type: 'button', text: '✎' });
      e.addEventListener('click', () => fill(c));
      return el('tr', {}, el('td', { text: c.index }), el('td', { text: c.name || (c.index === 0 ? '(primary, preset name)' : '') }), el('td', { text: c.role }),
        el('td', { text: c.psk_kind }), el('td', { text: `${c.uplink ? 'up ' : ''}${c.downlink ? 'down' : ''}` || '–' }), el('td', {}, e));
    }));
    const f = el('form', {},
      el('div', { class: 'row' },
        el('div', {}, el('label', { text: 'Index' }), el('select', { name: 'index' }, ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => el('option', { value: i, text: i })))),
        el('div', { class: 'grow' }, el('label', { text: 'Name (max. 11)' }), el('input', { name: 'name', maxlength: 11 })),
        el('div', {}, el('label', { text: 'Role' }), el('select', { name: 'role' }, ...['SECONDARY', 'PRIMARY', 'DISABLED'].map(r => el('option', { value: r, text: r === 'DISABLED' ? 'DISABLED (delete)' : r }))))),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, el('label', { text: 'Key (Base64; empty = unchanged)' }), el('input', { name: 'psk', autocomplete: 'off' })),
        el('div', { class: 'actions-end row' }, ...[['AES-256', 'random'], ['AES-128', 'random128'], ['Default', 'default'], ['None', 'none']].map(([txt, v]) => {
          const b = el('button', { class: 'sm', type: 'button', text: txt });
          b.addEventListener('click', () => { f.psk.value = v === 'random' ? b64(crypto.getRandomValues(new Uint8Array(32))) : v === 'random128' ? b64(crypto.getRandomValues(new Uint8Array(16))) : v === 'default' ? 'AQ==' : ''; f.pskNone.checked = v === 'none'; });
          return b;
        }))),
      el('label', { class: 'check small' }, el('input', { type: 'checkbox', name: 'pskNone' }), ' no encryption'),
      el('label', { class: 'check small' }, el('input', { type: 'checkbox', name: 'uplink' }), ' MQTT uplink'),
      el('label', { class: 'check small' }, el('input', { type: 'checkbox', name: 'downlink' }), ' MQTT downlink'),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'pri', type: 'submit', text: 'Save channel' })));
    function fill(c) { f.index.value = c.index; f.name.value = c.name; f.role.value = c.role; f.psk.value = c.psk; f.pskNone.checked = !c.psk; f.uplink.checked = c.uplink; f.downlink.checked = c.downlink; }
    f.addEventListener('submit', async e => {
      e.preventDefault();
      if (f.role.value === 'DISABLED' && !confirm(`Delete channel ${f.index.value}?`)) return;
      const r = await run(ctx, () => op(ctx.n.name, 'mesh.set_channel', {
        index: Number(f.index.value), name: f.name.value, role: f.role.value, psk: f.pskNone.checked ? 'none' : f.psk.value.trim() || undefined,
        uplink: f.uplink.checked, downlink: f.downlink.checked, target: ctx.target(),
      }));
      if (r) { await ctx.reload().catch(() => {}); t.replaceChildren(); tabChannels(t, ctx); }
    });
    const url = copyField(ctx.info.url || '');
    const imp = el('input', { placeholder: 'https://meshtastic.org/e/#…' });
    const impBtn = (text, add) => { const b = el('button', { class: 'sm', type: 'button', text }); b.addEventListener('click', () => { if (imp.value.trim() && confirm(add ? 'Add these channels?' : 'REPLACE all channels with these?')) run(ctx, () => op(ctx.n.name, 'mesh.set_url', { url: imp.value.trim(), add_only: add, target: ctx.target() })); }); return b; };
    t.append(el('div', { class: 'table-wrap' }, el('table', { class: 'streams' }, el('thead', {}, el('tr', {}, ...['#', 'Name', 'Role', 'Key', 'MQTT', ''].map(h => el('th', { text: h })))), tb)),
      el('h3', { text: 'Add / change' }), f,
      el('h3', { text: 'Channel link (all channels – contains the keys)' }), el('div', { class: 'row' }, url.input, url.btn),
      el('h3', { text: 'Import a channel link' }), el('div', { class: 'row' }, el('div', { class: 'grow' }, imp), impBtn('Add', true), impBtn('Replace', false)));
  }

  // form from the protobuf schema of the radio (like Meshtastic Desktop)
  function renderConfig(t, kind, ctx) {
    const schema = (ctx.info.schema || {})[kind] || [];
    const values = ctx.info[kind] || {};
    const sections = schema.filter(s => s.type === 'msg' && !s.repeated && s.name !== 'version');
    const pickSec = el('select', {}, ...sections.map(s => el('option', { value: s.name, text: label(s.name) })));
    const holder = el('div');
    const draw = () => {
      const s = sections.find(x => x.name === pickSec.value);
      const getters = [];
      const form = el('form', {}, ...fields(s.fields, values[s.name] || {}, getters));
      form.append(el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'pri', type: 'submit', text: `Save ${label(s.name)}` })));
      form.addEventListener('submit', async e => {
        e.preventDefault();
        let vals;
        try { vals = collect(getters); } catch (x) { setMsg(ctx.msg, x.message); return; }
        // only what was changed – for a remote node the form shows the values of this radio, they must not overwrite it
        const changed = diff(vals, values[s.name] || {});
        if (!changed) { setMsg(ctx.msg, 'Nothing changed.'); return; }
        if (!confirm(`Write ${Object.keys(changed).join(', ')} (${label(s.name)}) to ${ctx.target() || 'the radio'}? Some settings reboot it.`)) return;
        const r = await run(ctx, () => op(ctx.n.name, 'mesh.set_config', { kind, section: s.name, values: changed, target: ctx.target() }));
        if (r && !ctx.target()) values[s.name] = vals;
      });
      holder.replaceChildren(form);
    };
    pickSec.addEventListener('change', draw);
    t.append(el('div', { class: 'row' }, el('span', { text: 'Section:' }), pickSec), holder);
    if (sections.length) draw();
  }
  const label = s => s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

  function fields(schema, vals, getters, path = []) {
    const out = [];
    for (const f of schema) {
      const v = vals[f.name];
      const p = [...path, f.name];
      if (f.type === 'msg' && !f.repeated) {
        out.push(el('fieldset', { class: 'card', style: 'padding:8px 12px' }, el('legend', { class: 'small', text: label(f.name) }), ...fields(f.fields || [], v || {}, getters, p)));
        continue;
      }
      let input, get;
      if (f.repeated) {
        if (f.type === 'msg') { out.push(el('div', { class: 'mut small', text: `${label(f.name)}: ${(v || []).length} entries (read only)` })); continue; }
        input = el('input', { value: (v || []).join(', ') });
        get = () => input.value.split(',').map(x => x.trim()).filter(Boolean);
      } else if (f.type === 'bool') {
        input = el('input', { type: 'checkbox' });
        input.checked = !!v;
        get = () => input.checked;
        out.push(el('label', { class: 'check small' }, input, ' ' + label(f.name)));
        getters.push([p, get]);
        continue;
      } else if (f.type === 'enum') {
        input = el('select', {}, ...(f.values || []).map(x => { const o = el('option', { value: x, text: x }); if (x === v) o.selected = true; return o; }));
        get = () => input.value;
      } else if (f.type === 'int' || f.type === 'float') {
        input = el('input', { type: 'number', step: f.type === 'float' ? 'any' : '1', value: v == null ? 0 : v });
        get = () => { const x = Number(input.value); if (!Number.isFinite(x)) throw new Error(label(f.name) + ': not a number'); return x; };
      } else {
        input = el('input', { value: v == null ? '' : v, type: f.secret ? 'password' : 'text', autocomplete: 'off' });
        get = () => input.value;
      }
      out.push(el('div', {}, el('label', { class: 'small', text: label(f.name) + (f.type === 'bytes' ? ' (Base64)' : f.repeated ? ' (comma-separated)' : '') }), input));
      getters.push([p, get]);
    }
    return out;
  }
  // changed fields only (nested sections recursively); null = nothing changed
  function diff(now, before) {
    const out = {};
    for (const [k, v] of Object.entries(now)) {
      const b = before[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) { const d = diff(v, b || {}); if (d) out[k] = d; } else if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  }
  function collect(getters) {
    const obj = {};
    for (const [p, get] of getters) {
      let o = obj;
      for (const k of p.slice(0, -1)) o = o[k] = o[k] || {};
      o[p[p.length - 1]] = get();
    }
    return obj;
  }

  async function tabNodes(t, ctx) {
    t.append(el('p', { class: 'mut', text: 'Loading …' }));
    let list;
    try { list = await op(ctx.n.name, 'mesh.nodes'); } catch (e) { t.replaceChildren(el('p', { class: 'msg err', text: e.message })); return; }
    list.sort((a, b) => (b.last_heard || 0) - (a.last_heard || 0));
    const out = el('pre', { class: 'small', style: 'white-space:pre-wrap' });
    const rows = list.map(x => {
      const tr = el('button', { class: 'sm', type: 'button', text: '⇢ Route' });
      tr.addEventListener('click', async () => { out.textContent = `Traceroute to ${x.long_name || x.id} … (up to 90 s)`; const r = await run(ctx, () => op(ctx.n.name, 'mesh.traceroute', { dest: x.id })); if (r) out.textContent = `→ ${[ctx.info.my.long_name, ...r.towards, x.long_name || x.id].join(' → ')}\n← ${r.back.join(' ← ') || '(direct)'}\nSNR: ${r.snr_towards.join(' / ')} dB`; });
      const pos = el('button', { class: 'sm', type: 'button', text: '⌖ Position' });
      pos.addEventListener('click', async () => { const r = await run(ctx, () => op(ctx.n.name, 'mesh.request_position', { dest: x.id })); if (r) out.textContent = `${x.long_name || x.id}: ${r.lat}, ${r.lon} (alt ${r.alt})`; });
      const heard = x.last_heard ? ago(x.last_heard * 1000) : '–';
      return el('tr', {}, el('td', {}, el('b', { text: x.long_name || x.id }), el('div', { class: 'mut small', text: `${x.short_name || ''} ${x.id || ''}` })),
        el('td', { class: 'small', text: `${x.hw || ''} ${x.role || ''}` }), el('td', { class: 'small', text: `${x.snr != null ? x.snr + ' dB' : ''} ${x.hops != null ? '· ' + x.hops + ' hop' : ''}` }),
        el('td', { class: 'small', text: `${x.battery != null ? x.battery + ' %' : ''}` }), el('td', { class: 'small', text: heard }),
        el('td', { class: 'small', text: x.lat != null ? `${x.lat.toFixed(4)}, ${x.lon.toFixed(4)}` : '' }), el('td', { class: 'row' }, tr, pos));
    });
    t.replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'streams' }, el('thead', {}, el('tr', {}, ...['Node', 'Hardware', 'Signal', 'Battery', 'Heard', 'Position', ''].map(h => el('th', { text: h })))), el('tbody', {}, ...rows))), out);
  }

  function tabBackup(t, ctx) {
    const dl = el('button', { class: 'pri', type: 'button', text: '⇩ Download backup (JSON)' });
    dl.addEventListener('click', async () => {
      const r = await run(ctx, () => op(ctx.n.name, 'mesh.backup'), 'Backup ready – contains the keys, keep it safe.');
      if (!r) return;
      const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })), download: `meshtastic_${ctx.n.name}.json` });
      document.body.append(a); a.click(); a.remove();
    });
    const file = el('input', { type: 'file', accept: '.json,application/json' });
    const up = el('button', { class: 'sm', type: 'button', text: '⇧ Restore to this radio' });
    up.addEventListener('click', async () => {
      if (!file.files[0]) return setMsg(ctx.msg, 'Choose a backup file first.');
      let d;
      try { d = JSON.parse(await file.files[0].text()); } catch (e) { return setMsg(ctx.msg, 'Not a backup file.'); }
      if (!confirm('Write the whole backup to the radio? It reboots afterwards.')) return;
      run(ctx, () => op(ctx.n.name, 'mesh.restore', { data: { owner: d.owner, channel_url: d.channel_url, config: d.config, module: d.module || d.module_config } }));
    });
    t.append(el('p', { class: 'small', text: 'Owner, channels, all settings and modules. Backups from Meshtastic Desktop can be restored too.' }), dl,
      el('h3', { text: 'Restore' }), el('div', { class: 'row' }, file, up));
  }

  document.addEventListener('admin-view', e => {
    clearInterval(poll);
    if (e.detail !== 'lpu5') return;
    settingsShown = false;
    load();
    poll = setInterval(() => { if ($('modal').classList.contains('hidden')) load(); }, 5000);
  });
  // the wide dialog goes back to normal size for the other dialogs
  new MutationObserver(() => { if ($('modal').classList.contains('hidden')) $('modal').querySelector('.modal-box').classList.remove('wide'); })
    .observe($('modal'), { attributes: true, attributeFilter: ['class'] });
})();
