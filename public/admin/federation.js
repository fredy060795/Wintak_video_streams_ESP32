// Admin: federation – TAK servers exchange live data and data packages through TAKweb (lib/federation.js).
'use strict';

(() => {
  const fapi = (path, opts) => api('federation' + (path ? '/' + path : ''), opts);
  const btn = (text, cls, onclick) => el('button', { class: 'sm ' + (cls || ''), type: 'button', text, onclick });
  const td = (label, ...kids) => el('td', { 'data-label': label }, ...kids);
  let state = null;
  let timer = null;

  async function load() {
    try { state = await fapi(''); } catch (e) { setMsg($('fdMsg'), e.message); return; }
    render();
  }

  function liveCell(live, enabled) {
    if (!enabled) return el('span', { class: 'mut small', text: 'off' });
    if (!live) return el('span', { class: 'mut small', text: 'no certificate' });
    const kind = live.state === 'connected' ? 'ok' : ['error', 'untrusted'].includes(live.state) ? 'err' : 'wait';
    return el('span', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, el('span', { class: 'tak-dot ' + kind }),
      el('span', { class: 'small', text: live.state === 'connected' ? 'connected' : (live.message || live.state) }));
  }
  const stats = live => (live ? el('span', { class: 'small', text: `live ↓${live.stats.cotIn} ↑${live.stats.cotOut} · packages ↓${live.stats.pkgIn} ↑${live.stats.pkgOut}${live.pkgError ? ' · ⚠ ' + live.pkgError : ''}` }) : '');
  const yes = v => el('span', { text: v ? '✓' : '–' });

  function render() {
    const s = state;
    $('fdOn').checked = s.enabled;
    $('fdInterval').value = s.intervalMin;
    $('fdLast').textContent = s.lastSync ? `Last package sync: ${new Date(s.lastSync.time).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' })} – ${s.lastSync.copied} copied` : '';
    const tb = $('fdTable').querySelector('tbody');
    tb.replaceChildren();
    // the own TAK server (OpenTAKServer from the settings)
    const l = s.local;
    const lcheck = (key, title) => {
      const c = el('input', { type: 'checkbox', title, onchange: async e => {
        const body = { enabled: l.enabled, cot: l.cot, packages: l.packages, [key]: e.target.checked };
        try { state = await fapi('local', { method: 'POST', body }); if (state.warning) setMsg($('fdMsg'), state.warning); render(); } catch (err) { setMsg($('fdMsg'), err.message); }
      } });
      c.checked = !!l[key]; // a "checked" attribute would always tick it
      return c;
    };
    tb.append(el('tr', {},
      td('Server', el('b', { text: 'This TAK server' }), el('div', { class: 'mut small', text: l.available ? `${l.host} – OpenTAKServer from the settings` : 'Connect OpenTAKServer under Settings first.' })),
      td('Status', !s.enabled || !l.available ? el('span', { class: 'mut small', text: '–' })
        : l.error && !l.live ? el('span', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, el('span', { class: 'tak-dot err' }), el('span', { class: 'small', text: l.error })) : liveCell(l.live, l.enabled)),
      td('Live data', lcheck('cot', 'Live data')), td('Data packages', lcheck('packages', 'Data packages')),
      td('Exchanged', stats(l.live)),
      td('', el('label', { class: 'check small' }, lcheck('enabled', 'Take part'), ' takes part'))));
    if (!s.peers.length) tb.append(el('tr', {}, el('td', { colspan: '6', class: 'mut', text: 'No other servers yet – add one below.' })));
    for (const p of s.peers) {
      tb.append(el('tr', {},
        td('Server', el('b', { text: p.name }), el('div', { class: 'mut small', text: `${p.host}:${p.port}${p.cert ? ' – certificate ' + p.cert.subject : ''}` })),
        td('Status', s.enabled ? liveCell(p.live, p.enabled) : el('span', { class: 'mut small', text: 'federation off' })),
        td('Live data', yes(p.cot)), td('Data packages', yes(p.packages)),
        td('Exchanged', stats(p.live)),
        td('', btn('Edit', '', () => edit(p)), ' ', btn('Delete', 'danger', async () => {
          if (!confirm(`Remove "${p.name}" from the federation?`)) return;
          try { state = await fapi('peers/' + p.id, { method: 'DELETE' }); render(); } catch (e) { setMsg($('fdMsg'), e.message); }
        }))));
    }
  }

  function edit(p) {
    const f = $('fdForm');
    f.reset();
    for (const k of ['id', 'name', 'host', 'port', 'apiPort', 'enrollPort', 'username']) f.elements.namedItem(k).value = p[k] || '';
    for (const k of ['cot', 'packages', 'enabled']) f.elements.namedItem(k).checked = p[k];
    $('fdFormTitle').textContent = `Edit "${p.name}" – user/password or .p12 only to renew the certificate`;
    $('fdCancel').classList.remove('hidden');
    f.scrollIntoView({ behavior: 'smooth' });
  }
  function resetForm() {
    $('fdForm').reset();
    $('fdForm').elements.namedItem('id').value = '';
    $('fdFormTitle').textContent = 'Add server';
    $('fdCancel').classList.add('hidden');
  }
  $('fdCancel').addEventListener('click', resetForm);

  const fileBase64 = file => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Cannot read the file.'));
    r.readAsDataURL(file);
  });

  $('fdForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, v = n => f.elements.namedItem(n);
    const body = {
      id: v('id').value || undefined, name: v('name').value.trim(), host: v('host').value.trim(), port: v('port').value, apiPort: v('apiPort').value,
      enrollPort: v('enrollPort').value, username: v('username').value.trim(), password: v('password').value,
      cot: v('cot').checked, packages: v('packages').checked, enabled: v('enabled').checked,
    };
    if (v('p12').files[0]) { body.p12 = await fileBase64(v('p12').files[0]); body.p12Password = v('p12Password').value; }
    setMsg($('fdMsg'), body.password || body.p12 ? 'Requesting the certificate …' : 'Saving …', true);
    for (let i = 0; i < 2; i++) {
      try {
        state = await fapi('peers', { method: 'POST', body });
        setMsg($('fdMsg'), 'Saved – connecting.', true);
        resetForm();
        render();
        return;
      } catch (err) {
        // unknown server certificate: like ATAK, ask once and remember the fingerprint
        if (err.code === 'UNTRUSTED' && !i && confirm(`Trust the certificate of ${body.host}?\n\n${err.subject || ''}\nSHA-256: ${err.fingerprint}`)) { body.fingerprint = err.fingerprint; continue; }
        setMsg($('fdMsg'), err.message);
        return;
      }
    }
  });

  async function saveMain() {
    setMsg($('fdMsg'), $('fdOn').checked ? 'Switching on …' : '', true);
    try {
      state = await fapi('', { method: 'POST', body: { enabled: $('fdOn').checked, intervalMin: Number($('fdInterval').value) || 5 } });
      if (state.warning) setMsg($('fdMsg'), state.warning); else setMsg($('fdMsg'), state.enabled ? 'Federation on.' : 'Federation off.', true);
      render();
    } catch (e) { setMsg($('fdMsg'), e.message); load(); }
  }
  $('fdOn').addEventListener('change', saveMain);
  $('fdInterval').addEventListener('change', saveMain);
  $('fdReload').addEventListener('click', load);
  $('fdSync').addEventListener('click', async () => {
    setMsg($('fdMsg'), 'Syncing data packages …', true);
    try { state = await fapi('sync', { method: 'POST' }); setMsg($('fdMsg'), 'Data packages synced.', true); render(); } catch (e) { setMsg($('fdMsg'), e.message); }
  });

  document.addEventListener('admin-view', e => {
    clearInterval(timer);
    if (e.detail !== 'federation') return;
    load();
    timer = setInterval(() => { if (!document.hidden && $('fdTable').offsetParent) load(); else clearInterval(timer); }, 5000);
  });
})();
