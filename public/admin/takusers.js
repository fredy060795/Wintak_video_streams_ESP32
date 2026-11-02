// Admin: TAK access (OpenTAKServer) – approve requests, manage users, override callsign/team/role,
// teams and visibility, OTS and registration settings.
'use strict';

(() => {
  const COLORS = { White: '#FFFFFF', Yellow: '#FFFF00', Orange: '#FF7700', Magenta: '#FF00FF', Red: '#FF0000', Maroon: '#7F0000', Purple: '#7F007F',
    'Dark Blue': '#00007F', Blue: '#0000FF', Cyan: '#00FFFF', Teal: '#007F7F', Green: '#00FF00', 'Dark Green': '#007F00', Brown: '#A0714F' };
  const STATUS = { unconfirmed: 'E-mail unconfirmed', pending: 'Open', active: 'Active', blocked: 'Blocked', rejected: 'Declined' };
  let state = null;
  let teamsDraft = [];
  let blocksDraft = [];

  const tapi = (path, opts) => api('takusers/' + path, opts);
  const msg = (t, ok) => setMsg($('takMsg'), t, ok);
  const chip = color => el('span', { class: 'chip', style: `display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid #000;margin-right:6px;vertical-align:-1px;background:${COLORS[color] || '#0ff'}` });
  const fmt = iso => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '–');

  async function load() {
    try {
      state = await tapi('state');
    } catch (e) { return; }
    const pending = state.users.filter(u => u.status === 'pending').length;
    $('takPending').textContent = pending ? String(pending) : '';
    $('navPending').textContent = pending ? String(pending) : '';
    renderUsers();
    if (!$('takTeams').dataset.dirty) { teamsDraft = state.teams.map(t => ({ ...t })); blocksDraft = state.blocks.map(b => [...b]); renderTeams(); }
    fillSettings();
    if (!state.otsReady) msg('OpenTAKServer is not connected yet – set it up under "Settings → OpenTAKServer & registration". Requests cannot be approved without OTS.');
  }
  window.loadTakUsers = load;

  // registration QR for daily use right next to the users (its settings are under "Settings")
  $('takJoinBtn').addEventListener('click', () => {
    const url = (state && state.joinUrl) || location.origin + '/join/';
    const img = el('img', { class: 'qr', alt: 'Registration QR code', src: '/api/admin/takusers/join-qr.svg?t=' + Date.now() });
    const print = el('button', { type: 'button', text: 'Print', onclick: () => {
      const w = window.open('', '_blank', 'width=420,height=560');
      if (!w) return;
      const d = w.document;
      d.title = 'TAKweb Access';
      d.body.style.cssText = 'font-family:system-ui,sans-serif;text-align:center';
      const h = d.createElement('h1'); h.textContent = 'TAKweb Access';
      const i = d.createElement('img'); i.src = img.src; i.style.width = '320px';
      const t = d.createElement('p'); t.textContent = 'Scan to request your TAKweb access – ' + url;
      d.body.append(h, i, t);
      i.onload = () => w.print();
    } });
    const reg = state && state.registration;
    openModal('Registration',
      el('p', { class: 'mut small', text: reg && !reg.open ? 'Note: registration is currently closed (Settings → OpenTAKServer & registration).'
        : 'New users scan this code and send a request – you approve it under "Users & requests".' }),
      img, el('div', { class: 'link' }, ...Object.values(copyField(url))), el('div', { class: 'row', style: 'margin-top:10px' }, print));
  });

  // ---------------- Tabs ----------------
  for (const b of document.querySelectorAll('[data-takt]')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('[data-takt]')) x.classList.toggle('pri', x === b);
      for (const p of document.querySelectorAll('[data-takp]')) p.classList.toggle('hidden', p.dataset.takp !== b.dataset.takt);
    });
  }
  $('takTabUsers').classList.add('pri');

  // ---------------- Users ----------------
  function renderUsers() {
    const tb = $('takTable').querySelector('tbody');
    const q = $('takFilter').value.trim().toLowerCase();
    const st = $('takStatus').value;
    // open requests first, then active, blocked … (approved users stay visible)
    const ORDER = { pending: 0, unconfirmed: 1, active: 2, blocked: 3, rejected: 4 };
    const list = state.users.filter(u => (!st || u.status === st)
      && (!q || [u.name, u.unit, u.callsign, u.requestedCallsign, u.email, u.username].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || String(a.callsign).localeCompare(String(b.callsign)));
    tb.replaceChildren();
    if (!list.length) tb.append(el('tr', {}, el('td', { colspan: '8', class: 'mut', text: st === 'pending' ? 'No open requests.' : 'No entries.' })));
    for (const u of list) {
      const actions = el('div', { class: 'btns' });
      if (['pending', 'unconfirmed', 'rejected'].includes(u.status)) actions.append(el('button', { class: 'sm pri', text: 'Approve …', onclick: () => edit(u, true) }));
      actions.append(el('button', { class: 'sm', text: 'Edit', onclick: () => edit(u, false) }));
      tb.append(el('tr', {},
        el('td', { 'data-label': 'Status' }, el('span', { class: 'badge ' + (u.status === 'active' ? 'live' : u.status === 'pending' ? 'wait' : 'off'), text: STATUS[u.status] || u.status })),
        el('td', { 'data-label': 'Name', class: 'name' }, el('b', { text: u.name }), el('span', { class: 'mut small', text: [u.unit, u.email].filter(Boolean).join(' · ') })),
        el('td', { 'data-label': 'Callsign' }, el('b', { text: u.callsign }),
          u.requestedCallsign && u.requestedCallsign !== u.callsign ? el('div', { class: 'mut small', text: 'Requested: ' + u.requestedCallsign }) : null),
        el('td', { 'data-label': 'Team' }, chip(u.teamColor), document.createTextNode(`${u.teamName} · ${u.role}`),
          u.access && u.access !== 'both' ? el('div', { class: 'mut small', text: ACCESS[u.access] }) : null),
        el('td', { 'data-label': 'OTS' }, el('code', { text: u.username || '–' })),
        el('td', { 'data-label': 'Devices', class: 'num', text: u.devices ? String(u.devices.length) : '–' }),
        el('td', { 'data-label': 'Requested', text: fmt(u.created) }),
        el('td', {}, actions)));
    }
  }
  $('takFilter').addEventListener('input', () => state && renderUsers());
  $('takStatus').addEventListener('change', () => state && renderUsers());
  $('takSync').addEventListener('click', async () => {
    msg('Syncing with OTS …', true);
    try {
      const r = await tapi('sync', { method: 'POST', body: {} });
      msg(`Synced: ${r.updated} device(s) with a new callsign/team.` + (r.errors.length ? ' Errors: ' + r.errors.join('; ') : ''), !r.errors.length);
      load();
    } catch (e) { msg(e.message); }
  });

  const ACCESS = { both: 'Send and receive (default)', receive: 'Receive only (IN off)', send: 'Send only (OUT off)' };

  // edit / approve in one dialog
  function edit(u, approve) {
    const f = el('form', {});
    const field = (label, input) => el('div', {}, el('label', { text: label }), input);
    const callsign = el('input', { value: u.callsign || '', maxlength: '30', required: '' });
    const team = el('select', {}, ...state.teams.map(t => el('option', { value: t.id, text: `${t.name} (${t.color})` })));
    team.value = u.team;
    const role = el('select', {}, ...state.roles.map(r => el('option', { value: r, text: r })));
    role.value = u.role;
    // group direction in OTS: by default the user sends and receives in his team
    const access = el('select', {}, ...Object.entries(ACCESS).map(([v, t]) => el('option', { value: v, text: t })));
    access.value = u.access || 'both';
    const name = el('input', { value: u.name || '', maxlength: '60' });
    const unit = el('input', { value: u.unit || '', maxlength: '60' });
    const notes = el('input', { value: u.notes || '', maxlength: '500', placeholder: 'visible to admins only' });
    const out = el('p', { class: 'msg' });
    const info = el('div', { class: 'mut small' },
      el('div', { text: `E-mail: ${u.email}${u.phone ? ' · Phone ' + u.phone : ''}` }),
      el('div', { text: `Requested: ${fmt(u.created)}${u.requestedCallsign ? ' · requested callsign: ' + u.requestedCallsign : ''}` }),
      u.username ? el('div', { text: `OTS user: ${u.username} · approved ${fmt(u.approvedAt)}` }) : null,
      u.devices && u.devices.length ? el('div', { text: 'Devices: ' + u.devices.map(d => `${d.callsign || d.uid} (${d.platform || d.device || 'TAK'})`).join(', ') }) : null);
    f.append(info,
      field('Callsign (overrides the user\'s name in ATAK and for everyone else)', callsign),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, field('Team (color)', team)), el('div', { class: 'grow' }, field('Role', role))),
      field('Communication (OTS groups)', access),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, field('Name', name)), el('div', { class: 'grow' }, field('Unit', unit))),
      field('Note', notes));
    const body = () => ({ callsign: callsign.value, team: team.value, role: role.value, access: access.value, name: name.value, unit: unit.value, notes: notes.value });
    const run = async (path, opts, done) => {
      setMsg(out, 'Please wait …', true);
      try {
        const r = await tapi(`user/${u.id}` + (path ? '/' + path : ''), opts);
        await load();
        if (done) done(r); else closeModal();
      } catch (e) { setMsg(out, e.message); }
    };
    const btns = el('div', { class: 'row', style: 'margin-top:12px' });
    if (approve) {
      btns.append(el('button', { class: 'pri', type: 'submit', text: '✓ Approve & create OTS account' }));
      btns.append(el('button', { type: 'button', text: 'Decline', onclick: () => run('reject', { method: 'POST', body: {} }) }));
      f.addEventListener('submit', e => {
        e.preventDefault();
        run('approve', { method: 'POST', body: body() }, r => {
          const link = r.link;
          const { input, btn } = copyField(link);
          $('modalBody').replaceChildren(
            el('p', { class: 'msg ok', text: `Approved: ${r.user.callsign} (OTS user ${r.user.username}).` }),
            el('p', { class: 'small', text: r.mailed ? 'The user received an e-mail with their access link.' : 'No e-mail sent (SMTP not set up) – please give this link to the user:' }),
            el('div', { class: 'link' }, input, btn));
        });
      });
    } else {
      btns.append(el('button', { class: 'pri', type: 'submit', text: 'Save' }));
      f.addEventListener('submit', e => { e.preventDefault(); run('update', { method: 'POST', body: body() }); });
      if (u.status === 'active') btns.append(el('button', { type: 'button', text: 'Block', onclick: () => { if (confirm(`Block ${u.callsign}? The OTS account will be deactivated.`)) run('block', { method: 'POST', body: {} }); } }));
      if (u.status === 'blocked') btns.append(el('button', { type: 'button', text: 'Unblock', onclick: () => run('unblock', { method: 'POST', body: {} }) }));
      if (['pending', 'unconfirmed'].includes(u.status)) btns.append(el('button', { type: 'button', text: 'Decline', onclick: () => run('reject', { method: 'POST', body: {} }) }));
    }
    const more = el('div', { class: 'row', style: 'margin-top:8px' });
    if (u.username) {
      more.append(el('button', { class: 'sm', type: 'button', text: 'New password', onclick: () => { if (confirm('Generate a new password? The old one stops working.')) run('password', { method: 'POST', body: {} }, () => setMsg(out, 'New password set – the user sees it on their access page.', true)); } }));
      if (u.atakQr) more.append(el('button', { class: 'sm', type: 'button', text: 'Show ATAK QR', onclick: () => showAtakQr(u, false) }));
      more.append(el('button', { class: 'sm', type: 'button', text: 'New ATAK QR', onclick: () => run('qr', { method: 'POST', body: {} }, r => showAtakQr(r.user, true)) }));
    }
    more.append(el('button', { class: 'sm', type: 'button', text: 'Copy access link', onclick: async ev => { const r = await tapi(`user/${u.id}/link`); copy(r.link, ev.target); } }));
    more.append(el('button', { class: 'sm admin-only', type: 'button', text: 'Delete', onclick: () => {
      if (confirm(`Delete ${u.callsign}?${u.username ? ' The OTS account will be deleted as well.' : ''}`)) run('', { method: 'DELETE' });
    } }));
    f.append(btns, more, out);
    openModal(approve ? `Approve: ${u.name}` : `Edit ${u.callsign}`, f);
  }

  // ATAK enrollment QR as a popup: scan right away, save as PNG or print
  function showAtakQr(u, fresh) {
    const src = `/api/admin/takusers/user/${u.id}/atak-qr.svg?t=${Date.now()}`;
    const name = 'atak-qr-' + String(u.callsign || u.username || 'user').replace(/[^\w.-]+/g, '_');
    const img = el('img', { class: 'qr', alt: 'ATAK QR code', src });
    const out = el('p', { class: 'msg' });
    const savePng = async () => {
      try {
        const svg = await (await fetch(src, { credentials: 'same-origin' })).text();
        const pic = new Image();
        pic.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        await pic.decode();
        const c = document.createElement('canvas');
        c.width = c.height = 1024;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(pic, 0, 0, c.width, c.height);
        const a = el('a', { href: c.toDataURL('image/png'), download: name + '.png' });
        document.body.append(a);
        a.click();
        a.remove();
      } catch (e) { setMsg(out, 'Could not save the QR code: ' + e.message); }
    };
    const print = () => {
      const w = window.open('', '_blank');
      if (!w) return setMsg(out, 'Popup blocked – please allow popups for printing.');
      const d = w.document;
      d.title = 'ATAK QR – ' + (u.callsign || u.username);
      const page = d.createElement('div');
      page.style.cssText = 'font-family:sans-serif;text-align:center;padding:24px';
      const h = d.createElement('h2');
      h.textContent = 'ATAK access: ' + (u.callsign || '') + (u.username ? ' (' + u.username + ')' : '');
      const p = d.createElement('p');
      p.textContent = 'ATAK: Network Preferences → Manage Server Connections → ⋮ → Scan QR Code';
      const pic = d.createElement('img');
      pic.style.cssText = 'width:90mm;height:90mm';
      pic.onload = () => { w.focus(); w.print(); };
      pic.src = location.origin + src;
      page.append(h, pic, p);
      d.body.append(page);
    };
    openModal('ATAK QR: ' + (u.callsign || u.username),
      el('p', { class: 'small ' + (fresh ? 'msg ok' : 'mut'), text: fresh ? 'New QR code generated.' : 'Scan in ATAK: Network Preferences → Manage Server Connections → ⋮ → Scan QR Code.' }),
      img,
      el('div', { class: 'row', style: 'justify-content:center' },
        el('button', { class: 'sm', type: 'button', text: '💾 Save as PNG', onclick: savePng }),
        el('button', { class: 'sm', type: 'button', text: '🖨 Print', onclick: print }),
        el('button', { class: 'sm', type: 'button', text: 'Close', onclick: closeModal })),
      out);
  }

  // ---------------- Teams and visibility ----------------
  const blocked = (a, b) => blocksDraft.some(([x, y]) => x === a && y === b);
  function renderTeams() {
    const box = $('takTeams');
    box.replaceChildren();
    teamsDraft.forEach((t, i) => {
      const name = el('input', { value: t.name, maxlength: '40', style: 'max-width:220px' });
      name.addEventListener('input', () => { t.name = name.value; box.dataset.dirty = '1'; renderMatrix(); });
      const color = el('select', { style: 'width:auto' }, ...state.colors.map(c => el('option', { value: c, text: c })));
      color.value = t.color;
      color.addEventListener('change', () => { t.color = color.value; box.dataset.dirty = '1'; renderTeams(); });
      const del = el('button', { class: 'sm', type: 'button', text: 'Remove', onclick: () => {
        if (teamsDraft.length < 2) return;
        teamsDraft.splice(i, 1);
        blocksDraft = blocksDraft.filter(b => b[0] !== t.id && b[1] !== t.id);
        box.dataset.dirty = '1';
        renderTeams();
      } });
      const count = state.users.filter(u => u.team === t.id && u.status === 'active').length;
      box.append(el('div', { class: 'row', style: 'margin-top:6px' }, chip(t.color), name, color, el('span', { class: 'mut small', text: `${count} active` }), del));
    });
    renderMatrix();
  }
  function renderMatrix() {
    const tbl = $('takMatrix');
    tbl.replaceChildren();
    tbl.append(el('thead', {}, el('tr', {}, el('th', { text: 'Team … sees →' }), ...teamsDraft.map(t => el('th', {}, chip(t.color), document.createTextNode(t.name || '?'))))));
    const tb = el('tbody');
    for (const a of teamsDraft) {
      const row = el('tr', {}, el('td', {}, chip(a.color), el('b', { text: a.name || '?' })));
      for (const b of teamsDraft) {
        const cb = el('input', { type: 'checkbox', style: 'width:auto' });
        cb.checked = !blocked(a.id, b.id);
        if (a.id === b.id) cb.disabled = true;
        cb.addEventListener('change', () => {
          blocksDraft = blocksDraft.filter(([x, y]) => !(x === a.id && y === b.id));
          if (!cb.checked) blocksDraft.push([a.id, b.id]);
          $('takTeams').dataset.dirty = '1';
        });
        row.append(el('td', { style: 'text-align:center' }, cb));
      }
      tb.append(row);
    }
    tbl.append(tb);
  }
  $('takAddTeam').addEventListener('click', () => {
    teamsDraft.push({ id: 'new' + Date.now(), name: `Team ${teamsDraft.length + 1}`, color: state.colors[teamsDraft.length % state.colors.length] });
    $('takTeams').dataset.dirty = '1';
    renderTeams();
  });
  $('takSaveTeams').addEventListener('click', async () => {
    msg('Saving teams and applying them to OTS …', true);
    try {
      // new teams get their id from the server; blocks on new teams are matched by name
      const r = await tapi('teams', { method: 'POST', body: { teams: teamsDraft, blocks: blocksDraft } });
      delete $('takTeams').dataset.dirty;
      msg(r.errors.length ? 'Saved, but OTS reports: ' + r.errors.join('; ') : 'Teams saved and applied to OTS.', !r.errors.length);
      await load();
    } catch (e) { msg(e.message); }
  });

  // ---------------- Settings ----------------
  function fillSettings() {
    const f = $('otsForm');
    if (document.activeElement && f.contains(document.activeElement)) return;
    f.url.value = state.ots.url || '';
    f.username.value = state.ots.username || '';
    f.insecure.checked = !!state.ots.insecure;
    f.host.value = state.ots.host || '';
    f.streamPort.value = state.ots.streamPort || '';
    f.enrollPort.value = state.ots.enrollPort || '';
    f.apiPort.value = state.ots.apiPort || '';
    f.userPassword.value = state.ots.userPassword || '';
    f.anon.checked = state.ots.anon !== false;
    f.truststorePassword.value = state.ots.truststorePassword || 'atakatak';
    $('otsHasPass').textContent = state.ots.hasPassword ? '(saved)' : '';
    // which address the QR codes, the setup package and iTAK get – must be the TAK server, not this TAKweb server
    const eff = state.ots.effectiveHost || '';
    const same = eff && eff.toLowerCase() === location.hostname.toLowerCase();
    $('otsHostInfo').textContent = !eff ? ''
      : same ? `Devices currently get "${eff}" – that is the address of this TAKweb server. If the TAK server has its own domain, enter it above.`
      : `Devices (QR codes, setup package, iTAK) connect to: ${eff}${state.ots.host ? '' : ' (taken from the OTS address)'}`;
    $('otsHostInfo').className = 'small ' + (same ? 'warn' : 'mut');
    const r = $('regForm2');
    r.open.checked = !!state.registration.open;
    r.emailConfirm.checked = !!state.registration.emailConfirm;
    r.codeword.value = state.registration.codeword || '';
    $('joinUrl').value = state.joinUrl;
    $('joinQr').src = '/api/admin/takusers/join-qr.svg?t=' + Date.now();
  }
  const otsBody = () => {
    const f = $('otsForm');
    return { url: f.url.value, username: f.username.value, password: f.password.value, insecure: f.insecure.checked, host: f.host.value,
      streamPort: f.streamPort.value, enrollPort: f.enrollPort.value, apiPort: f.apiPort.value,
      userPassword: f.userPassword.value, anon: f.anon.checked, truststorePassword: f.truststorePassword.value };
  };
  $('otsForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await tapi('ots', { method: 'POST', body: otsBody() });
      $('otsForm').password.value = '';
      msg('OTS settings saved.', true);
      load();
    } catch (err) { msg(err.message); }
  });
  $('otsTest').addEventListener('click', async () => {
    msg('Testing connection …', true);
    try {
      await tapi('ots', { method: 'POST', body: otsBody() });
      $('otsForm').password.value = '';
      const r = await tapi('ots/test', { method: 'POST', body: {} });
      msg(`Connected to OpenTAKServer. Groups: ${r.groups.length ? r.groups.join(', ') : 'none'}.`, true);
      load();
    } catch (err) { msg(err.message); }
  });
  $('regForm2').addEventListener('submit', async e => {
    e.preventDefault();
    const r = $('regForm2');
    try {
      await tapi('registration', { method: 'POST', body: { open: r.open.checked, emailConfirm: r.emailConfirm.checked, codeword: r.codeword.value } });
      msg('Registration saved.' + (r.emailConfirm.checked && !state.mail ? ' Note: without SMTP no confirmation e-mail is sent.' : ''), true);
      load();
    } catch (err) { msg(err.message); }
  });
  $('joinCopy').addEventListener('click', () => copy($('joinUrl').value, $('joinCopy')));
  $('joinQr').addEventListener('click', () => {
    const img = el('img', { class: 'qr', alt: 'Registration QR code', src: '/api/admin/takusers/join-qr.svg?t=' + Date.now() });
    const print = el('button', { type: 'button', text: 'Print', onclick: () => {
      const w = window.open('', '_blank', 'width=480,height=640');
      if (!w) return;
      const d = w.document;
      d.title = 'TAKweb Access';
      d.body.style.fontFamily = 'system-ui, sans-serif';
      d.body.style.textAlign = 'center';
      const h = d.createElement('h1'); h.textContent = 'TAKweb Access';
      const i = d.createElement('img'); i.src = img.src; i.style.width = '340px';
      const t = d.createElement('p'); t.textContent = 'Scan to request your TAKweb access';
      d.body.append(h, i, t);
      i.onload = () => w.print();
    } });
    openModal('Registration QR code', img, el('p', { class: 'mut small', text: $('joinUrl').value }), el('div', { class: 'row' }, print));
  });

  // new requests: refresh the list regularly (the notification comes via the normal admin notifications)
  setInterval(() => { if (!document.hidden && $('modal').classList.contains('hidden')) load(); }, 20000);
})();
