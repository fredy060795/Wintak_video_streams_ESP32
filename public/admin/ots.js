// Admin: manage the TAK server like in the OTS UI – all users (create, import, role, active,
// password, groups, delete), groups, missions (Data Sync), video feeds (MediaMTX) and Meshtastic channels.
'use strict';

(() => {
  const oapi = (path, opts) => api('ots/' + path, opts);
  const fmt = iso => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '–');
  const enc = s => encodeURIComponent(s);
  const btn = (text, cls, onclick) => el('button', { class: 'sm ' + (cls || ''), type: 'button', text, onclick });
  const td = (label, ...kids) => el('td', { 'data-label': label }, ...kids);
  const empty = (tb, cols, text) => tb.append(el('tr', {}, el('td', { colspan: String(cols), class: 'mut', text })));
  let users = [];
  let groups = [];
  let teams = null; // { teams, roles } from the TAKweb management

  async function guard(msgEl, fn, okText) {
    try {
      const r = await fn();
      if (okText) setMsg(msgEl, okText, true);
      return r;
    } catch (e) { setMsg(msgEl, e.message); return null; }
  }

  // ---------------- OTS users ----------------
  async function loadUsers() {
    const r = await guard($('ouMsg'), () => oapi('users'));
    if (!r) return;
    users = r.users;
    groups = r.groups;
    if (!$('ouMsg').classList.contains('ok')) setMsg($('ouMsg'), '');
    renderUsers();
  }

  function renderUsers() {
    const tb = $('ouTable').querySelector('tbody');
    const q = $('ouFilter').value.trim().toLowerCase();
    tb.replaceChildren();
    const list = users.filter(u => !q || [u.username, ...(u.euds || []).map(e => e.callsign), u.managed && u.managed.callsign].join(' ').toLowerCase().includes(q));
    if (!list.length) empty(tb, 8, 'No users.');
    for (const u of list) {
      const admin = u.roles.includes('administrator');
      const role = el('select', { class: 'sm-select' }, el('option', { value: 'user', text: 'User' }), el('option', { value: 'admin', text: 'Administrator' }));
      role.value = admin ? 'admin' : 'user';
      role.onchange = async () => {
        if (!confirm(`Set the role of "${u.username}" to ${role.value === 'admin' ? 'Administrator' : 'User'}?`)) { role.value = admin ? 'admin' : 'user'; return; }
        await guard($('ouMsg'), () => oapi(`users/${enc(u.username)}/role`, { method: 'POST', body: { admin: role.value === 'admin' } }), 'Role set.');
        loadUsers();
      };
      const active = el('input', { type: 'checkbox' });
      active.checked = u.active;
      active.onchange = async () => {
        await guard($('ouMsg'), () => oapi(`users/${enc(u.username)}/active`, { method: 'POST', body: { on: active.checked } }), active.checked ? 'Activated.' : 'Blocked.');
        loadUsers();
      };
      const grp = u.memberships.length
        ? el('div', { class: 'tags' }, ...u.memberships.map(m => el('span', { class: 'tag' + (m.enabled ? '' : ' off'), text: `${m.group} ${m.direction}` })))
        : el('span', { class: 'mut small', text: '__ANON__ (none)' });
      const devs = u.euds.length ? el('div', { class: 'small' }, ...u.euds.map(e => el('div', { text: `${e.callsign || e.uid}${e.lastStatus ? ' · ' + e.lastStatus : ''}` }))) : el('span', { class: 'mut small', text: '–' });
      const managed = u.managed
        ? el('span', { class: 'badge live', text: u.managed.callsign })
        : (typeof isHelper === 'function' && isHelper() ? el('span', { class: 'mut small', text: '–' }) : btn('Import …', '', () => importUser(u)));
      const helperView = typeof isHelper === 'function' && isHelper();
      if (helperView) { // helpers see the accounts but change nothing
        role.disabled = true;
        active.disabled = true;
      }
      const actions = helperView ? el('span') : el('div', { class: 'btns' },
        btn('Groups …', '', () => editGroups(u)),
        btn('Password …', '', () => setPassword(u)),
        admin ? null : btn('Delete', 'danger', async () => {
          if (!confirm(`Delete user "${u.username}" in OTS?${u.managed ? '\n\nThe TAKweb management is removed as well.' : ''}`)) return;
          await guard($('ouMsg'), () => oapi(`users/${enc(u.username)}`, { method: 'DELETE' }), 'Deleted.');
          loadUsers();
          if (window.loadTakUsers) window.loadTakUsers();
        }));
      tb.append(el('tr', {}, td('User', el('b', { text: u.username })), td('Role', role), td('Active', active), td('Groups', grp),
        td('Devices', devs), td('Last login', el('span', { class: 'small', text: fmt(u.lastLogin) })), td('TAKweb', managed), td('', actions)));
    }
  }

  async function teamOptions() {
    if (!teams) teams = await api('takusers/state').catch(() => ({ teams: [], roles: [] }));
    return teams;
  }

  function form(fields) {
    const f = el('form');
    for (const [name, label, attrs = {}] of fields) {
      if (attrs.type === 'checkbox') { f.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', name }), ' ' + label)); continue; }
      f.append(el('label', { text: label }));
      if (attrs.options) f.append(el('select', { name }, ...attrs.options.map(([v, t]) => el('option', { value: v, text: t }))));
      else f.append(el('input', { name, autocomplete: 'off', ...attrs }));
    }
    return f;
  }

  async function newUser() {
    const t = await teamOptions();
    const f = form([
      ['callsign', 'Callsign *', { required: '', maxlength: '30', placeholder: 'e.g. ALPHA 10' }],
      ['username', 'Username (empty = from the callsign)', { maxlength: '40' }],
      ['password', 'Password (empty = randomly generated)', { maxlength: '64' }],
      ['name', 'Name', { maxlength: '60' }],
      ['email', 'E-mail (optional, for the access link)', { type: 'email', maxlength: '120' }],
      ['team', 'Team', { options: (t.teams || []).map(x => [x.id, `${x.name} (${x.color})`]) }],
      ['role', 'Role in ATAK', { options: (t.roles || ['Team Member']).map(r => [r, r]) }],
      ...(typeof isHelper === 'function' && isHelper() ? [] : [['admin', 'OTS administrator (may manage the server)', { type: 'checkbox' }]]),
    ]);
    const m = el('p', { class: 'msg' });
    f.append(el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'pri', type: 'submit', text: 'Create' })), m);
    f.onsubmit = async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.admin = !!(f.admin && f.admin.checked);
      const r = await guard(m, () => oapi('users', { method: 'POST', body }));
      if (!r) return;
      openModal('User created',
        el('p', {}, 'User ', el('b', { text: r.user.username }), ' · Password ', el('b', { class: 'secret', text: r.password })),
        el('p', { class: 'mut small', text: 'Access page with QR codes, ATAK setup package and guide (give only to the user):' }),
        el('div', { class: 'link' }, ...Object.values(copyField(r.link))));
      loadUsers();
      if (window.loadTakUsers) window.loadTakUsers();
    };
    openModal('New TAK user', el('p', { class: 'mut small', text: 'Without registration: the account is created in OTS right away and is active.' }), f);
  }

  async function importUser(u) {
    const t = await teamOptions();
    const f = form([
      ['callsign', 'Callsign', { value: (u.euds[0] && u.euds[0].callsign) || u.username, maxlength: '30' }],
      ['team', 'Team', { options: (t.teams || []).map(x => [x.id, `${x.name} (${x.color})`]) }],
      ['role', 'Role in ATAK', { options: (t.roles || ['Team Member']).map(r => [r, r]) }],
      ['email', 'E-mail (optional)', { type: 'email' }],
      ['newPassword', 'Set a new password (otherwise TAKweb does not know it and the access page shows none)', { type: 'checkbox' }],
      ['password', 'New password (empty = randomly generated)', { maxlength: '64' }],
      ['syncGroups', 'Set groups from TAKweb teams (otherwise the OTS groups stay as they are)', { type: 'checkbox' }],
    ]);
    const m = el('p', { class: 'msg' });
    f.append(el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'pri', type: 'submit', text: 'Import' })), m);
    f.onsubmit = async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.newPassword = f.newPassword.checked;
      body.syncGroups = f.syncGroups.checked;
      const r = await guard(m, () => oapi(`users/${enc(u.username)}/import`, { method: 'POST', body }));
      if (!r) return;
      closeModal();
      setMsg($('ouMsg'), `"${u.username}" is now managed in TAKweb (Users & requests).`, true);
      loadUsers();
      if (window.loadTakUsers) window.loadTakUsers();
    };
    openModal('Import into TAKweb: ' + u.username, f);
  }

  function setPassword(u) {
    const f = form([['password', 'New password (empty = randomly generated)', { maxlength: '64' }]]);
    const m = el('p', { class: 'msg' });
    f.append(el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'pri', type: 'submit', text: 'Set' })), m);
    f.onsubmit = async e => {
      e.preventDefault();
      const r = await guard(m, () => oapi(`users/${enc(u.username)}/password`, { method: 'POST', body: { password: f.password.value } }));
      if (r) setMsg(m, `Set: ${r.password} – the device may need to log in again.`, true);
    };
    openModal('Password: ' + u.username, f);
  }

  function editGroups(u) {
    const box = el('div');
    const m = el('p', { class: 'msg' });
    const render = () => {
      const cur = users.find(x => x.username === u.username) || u;
      const rows = cur.memberships.map(g => el('tr', {}, el('td', { text: g.group }), el('td', { text: g.direction }),
        el('td', {}, btn('Remove', 'danger', async () => {
          await guard(m, () => oapi(`users/${enc(u.username)}/groups`, { method: 'POST', body: { group: g.group, direction: g.direction, remove: true } }), 'Removed.');
          await loadUsers();
          render();
        }))));
      const sel = el('select', {}, ...groups.map(g => el('option', { value: g.name, text: g.name })));
      const dir = el('select', {}, el('option', { value: 'IN', text: 'IN (send)' }), el('option', { value: 'OUT', text: 'OUT (receive)' }));
      const both = btn('IN + OUT', '', () => add(['IN', 'OUT']));
      const add = async dirs => {
        for (const d of dirs) await guard(m, () => oapi(`users/${enc(u.username)}/groups`, { method: 'POST', body: { group: sel.value, direction: d } }), 'Added.');
        await loadUsers();
        render();
      };
      box.replaceChildren(
        el('table', { class: 'streams' }, el('thead', {}, el('tr', {}, el('th', { text: 'Group' }), el('th', { text: 'Direction' }), el('th'))),
          el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '3', class: 'mut', text: 'No group – the user is in __ANON__ (sees everyone without a group).' }))]))),
        el('div', { class: 'row', style: 'margin-top:10px' }, sel, dir, btn('Add', 'pri', () => add([dir.value])), both),
        el('p', { class: 'mut small', text: 'Note: once a user is in any group, they only send/receive there. Changes apply after the device connects again.' }),
        m);
    };
    render();
    openModal('Groups: ' + u.username, box);
  }

  $('ouNew').addEventListener('click', newUser);
  $('ouReload').addEventListener('click', loadUsers);
  $('ouFilter').addEventListener('input', renderUsers);

  // ---------------- Groups ----------------
  async function loadGroups() {
    const r = await guard($('ogMsg'), () => oapi('groups'));
    if (!r) return;
    groups = r.groups;
    const tb = $('ogTable').querySelector('tbody');
    tb.replaceChildren();
    if (!groups.length) empty(tb, 3, 'No groups.');
    for (const g of groups) {
      tb.append(el('tr', {}, td('Group', el('b', { text: g.name })), td('Description', el('span', { class: 'small', text: g.description || '' })),
        td('', g.name === '__ANON__' ? el('span', { class: 'mut small', text: 'Default' }) : btn('Delete', 'danger', async () => {
          if (!confirm(`Delete group "${g.name}"? Members lose this group.`)) return;
          await guard($('ogMsg'), () => oapi('groups/' + enc(g.name), { method: 'DELETE' }), 'Deleted.');
          loadGroups();
        }))));
    }
  }
  $('ogForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const ok = await guard($('ogMsg'), () => oapi('groups', { method: 'POST', body: { name: f.elements.namedItem('name').value.trim(), description: f.description.value } }), 'Group created.');
    if (ok) { f.reset(); loadGroups(); }
  });
  $('ogReload').addEventListener('click', loadGroups);

  // ---------------- Missions ----------------
  async function loadMissions() {
    const [r, g, eu] = await Promise.all([guard($('omMsg'), () => oapi('missions')), oapi('groups').catch(() => null), oapi('euds').catch(() => null)]);
    if (g) {
      groups = g.groups;
      $('omGroups').replaceChildren(...groups.map(x => el('label', { class: 'check' }, el('input', { type: 'checkbox', value: x.name }), ' ' + x.name)));
    }
    if (eu) {
      const keep = $('omCreator').value;
      $('omCreator').replaceChildren(...(eu.euds.length ? eu.euds.map(e => el('option', { value: e.uid, text: `${e.callsign || e.uid}${e.username ? ' (' + e.username + ')' : ''}` }))
        : [el('option', { value: '', text: 'No device known yet' })]));
      if (keep) $('omCreator').value = keep;
    }
    if (!r) return;
    const tb = $('omTable').querySelector('tbody');
    tb.replaceChildren();
    if (!r.missions.length) empty(tb, 6, 'No missions.');
    for (const m of r.missions) {
      // OTS: users with groups only see missions of their IN groups – without a group the mission is invisible to them
      const grp = m.groups && m.groups.length
        ? el('span', { class: 'small', text: m.groups.length >= groups.length && groups.length > 1 ? 'all' : m.groups.join(', ') })
        : el('span', { class: 'small', style: 'color:var(--warn,#e0a020)', text: '⚠ none – invisible in ATAK/TAKweb' });
      tb.append(el('tr', {}, td('Mission', el('b', { text: m.name + (m.password ? ' 🔒' : '') })), td('Description', el('span', { class: 'small', text: m.description })),
        td('Groups', grp),
        td('Content', el('span', { class: 'small', text: `${m.items} points · ${m.files} files` })), td('Created', el('span', { class: 'small', text: fmt(m.created) })),
        td('', el('div', { class: 'row' }, btn(m.groups && m.groups.length ? 'Groups' : 'Share with all', m.groups && m.groups.length ? '' : 'pri', () => missionGroups(m)), btn('Delete', 'danger', async () => {
          if (!confirm(`Delete mission "${m.name}" with all its content?`)) return;
          await guard($('omMsg'), () => oapi('missions/' + enc(m.name), { method: 'DELETE' }), 'Deleted.');
          loadMissions();
        })))));
    }
  }
  // set a mission's groups (no selection = all groups)
  function missionGroups(m) {
    const box = el('div', { class: 'row' }, ...groups.map(x => el('label', { class: 'check' },
      el('input', { type: 'checkbox', value: x.name, ...((m.groups || []).includes(x.name) ? { checked: '' } : {}) }), ' ' + x.name)));
    const out = el('p', { class: 'msg' });
    const save = el('button', { class: 'pri', type: 'button', text: 'Save', onclick: async () => {
      const sel = [...box.querySelectorAll('input:checked')].map(x => x.value);
      const ok = await guard(out, () => oapi('missions/' + enc(m.name) + '/groups', { method: 'PUT', body: { groups: sel } }), 'Saved.');
      if (ok) { closeModal(); loadMissions(); }
    } });
    openModal('Groups: ' + m.name,
      el('p', { class: 'mut small', text: 'Only users with one of these groups (IN) see the mission in ATAK/TAKweb. No selection = all groups.' }),
      box, el('div', { class: 'row', style: 'margin-top:10px' }, save), out);
  }
  $('omForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.elements.namedItem('name').value.trim(), description: f.description.value, password: f.password.value, creatorUid: f.creatorUid.value,
      groups: [...$('omGroups').querySelectorAll('input:checked')].map(x => x.value) };
    const ok = await guard($('omMsg'), () => oapi('missions', { method: 'POST', body }), 'Mission created – visible in ATAK/TAKweb under Data Sync.');
    if (ok) { f.reset(); loadMissions(); }
  });
  $('omReload').addEventListener('click', loadMissions);

  // ---------------- Video feeds (MediaMTX) ----------------
  async function loadFeeds() {
    const r = await oapi('feeds').catch(e => { setMsg($('ofMsg'), e.message); return null; });
    if (!r) return;
    const tb = $('ofTable').querySelector('tbody');
    tb.replaceChildren();
    if (!r.feeds.length) empty(tb, 5, 'No feeds.');
    // templates for pushing directly (MediaMTX in OTS checks the TAK user/password and creates the feed)
    const h = r.rtspHost || '<TAK server>';
    $('ofRtmp').textContent = `rtmp://${h}:1935/<path>?user=<user>&pass=<password>`;
    $('ofRtspPush').textContent = `rtsp://<user>:<password>@${h}:8554/<path>`;
    $('ofSrt').textContent = `srt://${h}:8890?streamid=publish:<path>:<user>:<password>`;
    // recognise feeds of TAKweb cameras (path from the "TAK path" column above)
    const cams = new Map((window.streams || (typeof streams !== 'undefined' ? streams : [])).filter(x => x.tak && x.tak.pushed).map(x => [x.tak.pushed, x]));
    r.feeds.sort((a, b) => (cams.has(b.path) - cams.has(a.path)) || a.path.localeCompare(b.path));
    for (const f of r.feeds) {
      const rtsp = r.rtspHost ? `rtsp://${r.rtspHost}:8554/${f.path}` : '';
      const cam = cams.get(f.path);
      const origin = cam
        ? el('span', { class: 'badge ' + (cam.receiving ? 'live' : 'off'), text: 'TAKweb: ' + (cam.label || cam.user) + (cam.receiving ? ' · live' : '') })
        : el('span', { class: 'small', text: 'external' });
      tb.append(el('tr', {}, td('Path', el('b', { text: f.path })), td('Origin', origin), td('Source', el('span', { class: 'small', text: cam ? 'TAKweb camera (HLS)' : (f.source || '(camera pushes itself)') })),
        td('For ATAK', rtsp ? el('div', { class: 'link' }, ...Object.values(copyField(rtsp))) : el('span', { class: 'mut', text: '–' })),
        td('', cam ? el('span', { class: 'mut small', text: 'control above' }) : btn('Delete', 'danger', async () => {
          if (!confirm(`Delete feed "${f.path}"?`)) return;
          await guard($('ofMsg'), () => oapi('feeds/' + f.path.split('/').map(enc).join('/'), { method: 'DELETE' }), 'Deleted.');
          loadFeeds();
        }))));
    }
  }
  $('ofForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const ok = await guard($('ofMsg'), () => oapi('feeds', { method: 'POST', body: { path: f.path.value, source: f.source.value } }), 'Feed created.');
    if (ok) { f.reset(); loadFeeds(); }
  });
  $('ofReload').addEventListener('click', loadFeeds);

  // ---------------- Meshtastic ----------------
  async function loadMesh() {
    const r = await guard($('omeMsg'), () => oapi('mesh'));
    if (!r) return;
    const tb = $('omeTable').querySelector('tbody');
    tb.replaceChildren();
    if (!r.channels.length) empty(tb, 5, 'No channels.');
    for (const c of r.channels) {
      tb.append(el('tr', {}, td('Channel', el('b', { text: c.name || '(no name)' })), td('Radio', el('span', { class: 'small', text: [c.modem_preset, c.lora_region].filter(x => x != null && x !== '').join(' · ') })),
        td('Up/Down', el('span', { class: 'small', text: `${c.uplink_enabled ? '↑' : '–'} ${c.downlink_enabled ? '↓' : '–'}` })),
        td('Link', c.url ? el('div', { class: 'link' }, ...Object.values(copyField(c.url))) : el('span', { text: '–' })),
        td('', btn('Delete', 'danger', async () => {
          if (!confirm(`Delete channel "${c.name}"?`)) return;
          await guard($('omeMsg'), () => oapi('mesh?url=' + enc(c.url), { method: 'DELETE' }), 'Deleted.');
          loadMesh();
        }))));
    }
  }
  $('omePsk').addEventListener('click', async () => {
    const r = await guard($('omeMsg'), () => oapi('mesh/psk'));
    if (r) $('omeForm').psk.value = r.psk;
  });
  $('omeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const body = f.url.value.trim() ? { url: f.url.value.trim() }
      : { name: f.elements.namedItem('name').value.trim(), modemPreset: f.modemPreset.value, region: f.region.value, psk: f.psk.value.trim(), uplink: f.uplink.checked, downlink: f.downlink.checked };
    const ok = await guard($('omeMsg'), () => oapi('mesh', { method: 'POST', body }), 'Channel created.');
    if (ok) { f.reset(); loadMesh(); }
  });
  $('omeReload').addEventListener('click', loadMesh);

  let feedTimer = null;
  // section opened: load fresh
  document.addEventListener('admin-view', e => {
    if (e.detail === 'otsusers') { teams = null; loadUsers(); }
    if (e.detail === 'otsgroups') loadGroups();
    if (e.detail === 'missions') loadMissions();
    if (e.detail === 'video') { loadFeeds(); clearInterval(feedTimer); feedTimer = setInterval(() => { if (!document.hidden && $('ofTable').offsetParent) loadFeeds(); else clearInterval(feedTimer); }, 15000); }
    if (e.detail === 'mesh') loadMesh();
  });
})();
