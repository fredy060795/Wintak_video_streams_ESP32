// TAKweb admin
// All texts from streams/phones are only inserted via textContent (no HTML).

const $ = id => document.getElementById(id);
const POLL_MS = 2000;
// Rotation: any clockwise angle, 0 to 359.5°
const normDeg = v => {
  const r = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(r)) return 0;
  return (Math.round((((r % 360) + 360) % 360) * 2) / 2) % 360;
};
const fmtDeg = v => String(v || 0) + '°';

function angleInput(value, cls = 'rot') {
  const i = el('input', { class: cls, type: 'number', min: '0', max: '359.5', step: '0.5', title: 'Rotation in degrees (clockwise)' });
  i.value = String(value || 0);
  return i;
}

const SIZES = [[1, '160x120 – very fast'], [5, '320x240'], [8, '640x480 – slow'], [11, '1280x720 – phone camera only']];
function sizeSelect(value, cls = '') {
  const sel = el('select', { class: cls, title: 'Image size (applies immediately on the phone)' });
  for (const [v, t] of SIZES) sel.append(el('option', { value: String(v), text: t }));
  sel.value = String(value || 1);
  return sel;
}

function fitSelect(value) {
  const sel = el('select', { title: 'For oblique angles' });
  sel.append(el('option', { value: 'fill', text: 'Fill (crop the edges)' }), el('option', { value: 'fit', text: 'Whole image (black corners)' }));
  sel.value = value === 'fit' ? 'fit' : 'fill';
  return sel;
}

// send changes batched while dragging (not on every pixel)
const pendingOpts = new Map();
function sendOptionsSoon(id, opts) {
  const p = pendingOpts.get(id) || { opts: {} };
  clearTimeout(p.timer);
  Object.assign(p.opts, opts);
  p.timer = setTimeout(() => {
    pendingOpts.delete(id);
    setOptions(id, p.opts);
  }, 250);
  pendingOpts.set(id, p);
}

let me = null;
let lastLoginPassword = '';
let streams = [];
let pollTimer = null;
const rows = new Map();     // id -> { tr, cells }
const windows = new Map();  // id -> window
let zTop = 500;
let winOffset = 0;

// ======================================================================
// API
// ======================================================================

class ApiError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/admin/' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'helm', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (res.status === 401 && path !== 'login') {
    showAuth('login');
    throw new ApiError(data.error || 'Please log in.');
  }
  if (res.status === 403 && data.mustChange) {
    showFirst();
    throw new ApiError(data.error);
  }
  if (!res.ok) throw Object.assign(new ApiError(data.error || 'Error ' + res.status), { code: data.code, fingerprint: data.fingerprint, subject: data.subject });
  return data;
}

function setMsg(el, text, ok) {
  el.textContent = text || '';
  el.className = 'msg' + (text ? (ok ? ' ok' : ' err') : '');
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const t = el('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }
}

function copyField(value) {
  const input = el('input', { readonly: '', value });
  input.addEventListener('focus', () => input.select());
  const btn = el('button', { class: 'sm', type: 'button', text: 'Copy' });
  btn.addEventListener('click', () => copy(input.value, btn));
  return { input, btn };
}

// ======================================================================
// Login
// ======================================================================

function showAuth(which) {
  stopPolling();
  $('appView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  for (const f of ['loginForm', 'forgotForm', 'resetForm', 'firstForm']) $(f).classList.toggle('hidden', f !== which + 'Form');
  const first = $(which + 'Form').querySelector('input:not([type=hidden])');
  if (first) first.focus();
}

function showFirst() {
  showAuth('first');
  $('xUser').value = me ? me.username : 'admin';
  $('xMail').value = me ? me.email || '' : '';
  $('xCurWrap').classList.toggle('hidden', !!lastLoginPassword);
  $('xCur').required = !lastLoginPassword;
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  setMsg($('loginMsg'), '');
  try {
    const r = await api('login', { method: 'POST', body: { username: $('lUser').value, password: $('lPass').value } });
    lastLoginPassword = $('lPass').value;
    $('lPass').value = '';
    me = await api('me');
    if (r.mustChange) showFirst(); else showApp();
  } catch (err) {
    setMsg($('loginMsg'), err.message);
  }
});

$('forgotLink').addEventListener('click', e => { e.preventDefault(); showAuth('forgot'); });
for (const a of document.querySelectorAll('.backLink')) {
  a.addEventListener('click', e => { e.preventDefault(); history.replaceState(null, '', location.pathname); showAuth('login'); });
}

$('forgotForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('forgot', { method: 'POST', body: { username: $('fUser').value } });
    setMsg($('forgotMsg'), 'If the details are correct and SMTP is set up, an e-mail with the link will arrive shortly.', true);
  } catch (err) {
    setMsg($('forgotMsg'), err.message);
  }
});

$('resetForm').addEventListener('submit', async e => {
  e.preventDefault();
  if ($('rPass').value !== $('rPass2').value) return setMsg($('resetMsg'), 'The passwords do not match.');
  const token = new URLSearchParams(location.hash.slice(1)).get('reset');
  try {
    await api('reset', { method: 'POST', body: { token, password: $('rPass').value } });
    history.replaceState(null, '', location.pathname);
    showAuth('login');
    setMsg($('loginMsg'), 'Password changed. Please log in again.', true);
  } catch (err) {
    setMsg($('resetMsg'), err.message);
  }
});

$('firstForm').addEventListener('submit', async e => {
  e.preventDefault();
  if ($('xPass').value !== $('xPass2').value) return setMsg($('firstMsg'), 'The passwords do not match.');
  try {
    await api('credentials', {
      method: 'POST',
      body: {
        current: lastLoginPassword || $('xCur').value,
        username: $('xUser').value,
        email: $('xMail').value,
        password: $('xPass').value,
      },
    });
    lastLoginPassword = '';
    me = await api('me');
    showApp();
  } catch (err) {
    setMsg($('firstMsg'), err.message);
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api('logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
  for (const w of [...windows.values()]) w.close();
  me = null;
  showAuth('login');
});

// ======================================================================
// Overview
// ======================================================================

// ---- Sidebar (like the ATAK menu): only one section visible at a time ----
const VIEW_TITLES = { users: 'Users & requests', teams: 'Teams & visibility', ots: 'OpenTAKServer & registration' };
const TAK_TAB = { users: 'users', teams: 'teams', ots: 'settings' };
const HELPER_VIEWS = ['users', 'links', 'otsusers', 'system'];
const isHelper = () => !!(me && me.role === 'helper');
function showView(view) {
  if (view === 'feeds') view = 'video'; // former separate section, now merged
  if (isHelper() && !HELPER_VIEWS.includes(view)) view = 'users';
  if (view === 'camera') view = 'links';
  if (!document.querySelector(`[data-nav="${view}"]`)) view = 'users';
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === view);
  for (const sec of document.querySelectorAll('[data-view]')) sec.classList.toggle('hidden', !sec.dataset.view.split(' ').includes(view));
  if (TAK_TAB[view]) {
    const b = document.querySelector(`[data-takt="${TAK_TAB[view]}"]`);
    if (b) b.click();
    $('takTitle').textContent = VIEW_TITLES[view];
  }
  if (view === 'system') renderSystem();
  document.dispatchEvent(new CustomEvent('admin-view', { detail: view }));
  if (location.hash.slice(1) !== view) history.replaceState(null, '', '#' + view);
  document.body.classList.remove('navopen');
  try { localStorage.setItem('takweb.adminView', view); } catch (e) { /* private mode */ }
}
for (const a of document.querySelectorAll('[data-nav]')) {
  a.addEventListener('click', e => { e.preventDefault(); showView(a.dataset.nav); });
}
$('navToggle').addEventListener('click', () => document.body.classList.toggle('navopen'));

function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  let view = location.hash.slice(1);
  if (!view || view.startsWith('reset=')) { try { view = localStorage.getItem('takweb.adminView') || 'users'; } catch (e) { view = 'users'; } }
  document.body.classList.toggle('helper', isHelper());
  showView(view);
  $('noFfmpeg').classList.toggle('hidden', !!me.ffmpeg);
  loadRegistration();
  loadTak();
  if (!isHelper()) loadEudLinks();
  if (window.loadTakUsers) window.loadTakUsers();
  refresh();
  startPolling();
}

// ---- general QR code + self-registration -----------------------------------
async function loadRegistration() {
  try {
    const r = await api('registration');
    $('regToggle').checked = r.enabled;
    liveMode = r.liveMode;
    $('liveToggle').checked = liveMode === 'admin';
    $('userStartToggle').checked = !!r.userCanStart;
    $('userStartWrap').classList.toggle('hidden', liveMode !== 'admin');
    $('liveOffAllBtn').classList.toggle('hidden', liveMode !== 'admin');
    $('appUrl').value = r.appUrl;
    if (document.activeElement !== $('baseUrl')) $('baseUrl').value = r.publicUrl;
    $('baseUrl').placeholder = 'automatic: ' + r.autoUrl;
    $('appQr').src = '/api/admin/app-qr.svg?t=' + Date.now();
    $('appQr').closest('.appqr').classList.toggle('off', !r.enabled);
  } catch (e) { /* shown by api() */ }
}

$('userStartToggle').addEventListener('change', async () => {
  const on = $('userStartToggle').checked;
  try {
    await api('live-mode', { method: 'POST', body: { userCanStart: on } });
    setMsg($('liveMsg'), on ? 'Users can start by themselves – you get a notification.' : 'Only the admin puts streams live.', true);
  } catch (e) { setMsg($('liveMsg'), e.message); }
});

// ======================================================================
// Notifications: popup + sound + desktop notification
// ======================================================================

function beep() {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    [0, 0.18].forEach(t => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.15);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.16);
    });
  } catch (e) { /* no sound possible */ }
}

// settings per browser (sound, desktop, popup)
const notePref = (k, d) => { try { const v = localStorage.getItem('takweb.note.' + k); return v == null ? d : v === '1'; } catch (e) { return d; } };
const setNotePref = (k, on) => { try { localStorage.setItem('takweb.note.' + k, on ? '1' : '0'); } catch (e) { /* private mode */ } };
const notes = []; // { ev, read }
const NOTE_ICON = { takreg: '👤', register: '📱', camera: '🎥', live: '🔴', stop: '⏹' };

// buttons for a notification (same in popup and list)
function noteActions(ev, done) {
  const s = streams.find(x => sid(x) === ev.id);
  const btns = [];
  if (ev.kind === 'takreg') {
    btns.push(el('button', { class: 'sm pri', text: 'Open requests', onclick: () => { showView('users'); if (window.loadTakUsers) window.loadTakUsers(); done(); } }));
  }
  if (s) {
    btns.push(el('button', { class: 'sm pri', text: 'View', onclick: () => { openWindow(ev.id); done(); } }));
    if (liveMode === 'admin' && !s.onAir && ev.kind !== 'stop' && s.enabled) {
      btns.push(el('button', { class: 'sm golive', text: '▶ Live', onclick: () => { setLive(ev.id, true); done(); } }));
    }
  }
  return btns;
}

function noteTime(at) {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString('en-GB', today ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderNotes() {
  const unread = notes.filter(n => !n.read).length;
  $('notifyCount').textContent = unread > 99 ? '99+' : String(unread);
  $('notifyCount').classList.toggle('hidden', !unread);
  $('noteRead').disabled = !unread;
  $('noteClear').disabled = !notes.length;
  $('noteRead').textContent = unread ? 'Mark all read' : 'All read';
  if ($('notePanel').classList.contains('hidden')) return;
  const list = $('noteList');
  list.replaceChildren(...(notes.length ? notes.map(n => {
    const row = el('div', { class: 'note ' + n.ev.kind + (n.read ? '' : ' unread'), title: n.read ? '' : 'Click to mark as read' },
      el('span', { class: 'note-ic', text: NOTE_ICON[n.ev.kind] || '•' }),
      el('div', { class: 'grow' },
        el('div', { class: 'note-head' }, el('span', { text: n.ev.text }), el('span', { class: 'mut small', text: noteTime(n.ev.at) }),
          el('button', { class: 'note-del', type: 'button', title: 'Delete', 'aria-label': 'Delete notification', text: '✕', onclick: e => { e.stopPropagation(); deleteNotes([n.ev.seq]); } })),
        el('div', { class: 'row' }, ...noteActions(n.ev, () => { n.read = true; closeNotes(); }))));
    // a click on the notification marks it as read
    row.addEventListener('click', () => { if (!n.read) { n.read = true; renderNotes(); } });
    return row;
  }) : [el('p', { class: 'mut small', style: 'padding:12px', text: 'No notifications yet. New requests, registered cameras and live starts appear here.' })]));
}

function addNote(ev, read) {
  if (notes.some(n => n.ev.seq === ev.seq)) return;
  notes.unshift({ ev, read });
  notes.sort((a, b) => b.ev.seq - a.ev.seq);
  notes.length = Math.min(notes.length, 60);
  renderNotes();
}

function openNotes() {
  $('notePanel').classList.remove('hidden');
  renderNotes();
}
function closeNotes() {
  $('notePanel').classList.add('hidden');
  renderNotes();
}
$('notifyBtn').addEventListener('click', e => {
  e.stopPropagation();
  unlockAudio();
  if ($('notePanel').classList.contains('hidden')) openNotes(); else closeNotes();
});
$('noteClose').addEventListener('click', closeNotes);
$('noteRead').addEventListener('click', () => { for (const n of notes) n.read = true; renderNotes(); });
// delete on the server too, so they do not come back after reloading (seqs = null: all)
async function deleteNotes(seqs) {
  try {
    await api('events/delete', { method: 'POST', body: seqs ? { seqs } : { all: true } });
  } catch (e) { return alert(e.message); }
  for (let i = notes.length - 1; i >= 0; i--) if (!seqs || seqs.includes(notes[i].ev.seq)) notes.splice(i, 1);
  renderNotes();
}
$('noteClear').addEventListener('click', () => { if (confirm('Delete all notifications?')) deleteNotes(null); });
renderNotes();
// composedPath: the clicked element may already have been replaced by renderNotes (then it is no longer inside the panel)
document.addEventListener('click', e => {
  const path = e.composedPath();
  if (!$('notePanel').classList.contains('hidden') && !path.includes($('notePanel')) && !path.includes($('notifyBtn'))) closeNotes();
});

function showToast(ev) {
  addNote(ev, false);
  if (notePref('popup', true)) {
    // for information only: disappears by itself, no confirmation needed (actions are in the notification list)
    const time = new Date(ev.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const t = el('div', { class: 'toast info ' + ev.kind, title: 'Click for all notifications' },
      el('div', { class: 'toast-head' }, el('span', { text: (NOTE_ICON[ev.kind] || '•') + ' ' + ev.text }), el('span', { class: 'mut small', text: time })));
    const close = () => { t.classList.add('gone'); setTimeout(() => t.remove(), 300); };
    t.addEventListener('click', e => { e.stopPropagation(); close(); openNotes(); });
    $('toasts').prepend(t);
    for (const old of [...$('toasts').children].slice(3)) old.remove(); // with many streams at most 3 at a time
    setTimeout(close, 6000);
  }
  if (ev.kind === 'takreg' && window.loadTakUsers) window.loadTakUsers();
  if (ev.kind !== 'stop' && notePref('sound', true)) beep();
  if (document.hidden && notePref('desk', false) && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('TAKweb', { body: ev.text, tag: String(ev.seq), icon: '/assets/brand/favicon-32.png' }); } catch (e) { /* not supported */ }
  }
}

// browsers only play sound after user interaction: unlock on the first click
function unlockAudio() {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { /* no sound */ }
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

function initNotePrefs() {
  $('noteSound').checked = notePref('sound', true);
  $('notePopup').checked = notePref('popup', true);
  const deskOk = 'Notification' in window && window.isSecureContext;
  $('noteDeskWrap').classList.toggle('hidden', !deskOk);
  $('noteDesk').checked = deskOk && notePref('desk', false) && Notification.permission === 'granted';
}
$('noteSound').addEventListener('change', () => { setNotePref('sound', $('noteSound').checked); if ($('noteSound').checked) beep(); });
$('notePopup').addEventListener('change', () => setNotePref('popup', $('notePopup').checked));
$('noteDesk').addEventListener('change', async () => {
  let on = $('noteDesk').checked;
  if (on && Notification.permission !== 'granted') on = (await Notification.requestPermission()) === 'granted';
  $('noteDesk').checked = on;
  setNotePref('desk', on);
});
initNotePrefs();

$('liveToggle').addEventListener('change', async () => {
  const admin = $('liveToggle').checked;
  try {
    await api('live-mode', { method: 'POST', body: { mode: admin ? 'admin' : 'user' } });
    setMsg($('liveMsg'), admin ? 'Admin puts streams live: users wait for "▶ Live".' : 'Users start the stream themselves.', true);
    await loadRegistration();
    await refresh();
  } catch (e) { setMsg($('liveMsg'), e.message); }
});

$('regToggle').addEventListener('change', async () => {
  const enabled = $('regToggle').checked;
  try {
    await api('registration', { method: 'POST', body: { enabled } });
    setMsg($('liveMsg'), enabled ? 'Video from TAKweb/camera app allowed.' : 'Blocked – nobody can start a new video in TAKweb or the camera app any more.', enabled);
    loadRegistration();
  } catch (e) { setMsg($('liveMsg'), e.message); }
});
$('appUrlCopy').addEventListener('click', () => copy($('appUrl').value, $('appUrlCopy')));

async function saveBase(url) {
  try {
    const r = await api('public-url', { method: 'POST', body: { url } });
    setMsg($('regMsg'), r.publicUrl ? 'Address saved: ' + r.publicUrl + ' – all links and QR codes are updated.'
      : 'Address automatic again – all links and QR codes are updated.', true);
    await loadRegistration();
    await loadTak();
    if (window.loadTakUsers) window.loadTakUsers();
    await refresh();
    me = await api('me');
  } catch (e) { setMsg($('regMsg'), e.message); }
}
$('baseForm').addEventListener('submit', e => { e.preventDefault(); saveBase($('baseUrl').value); });
$('baseAuto').addEventListener('click', () => { $('baseUrl').value = ''; saveBase(''); });
$('appQrBig').addEventListener('click', () => {
  const img = el('img', { class: 'qr', alt: 'QR code for the phone page', src: '/api/admin/app-qr.svg?t=' + Date.now() });
  const print = el('button', { type: 'button', text: 'Print', onclick: () => {
    const w = window.open('', '_blank', 'width=480,height=640');
    if (!w) return;
    const d = w.document;
    d.title = 'TAKweb camera';
    d.body.style.fontFamily = 'system-ui, sans-serif';
    d.body.style.textAlign = 'center';
    const h = d.createElement('h1'); h.textContent = 'Helmet camera';
    const i = d.createElement('img'); i.src = img.src; i.style.width = '340px';
    const t = d.createElement('p'); t.textContent = '1. Scan  2. Enter name and unit  3. Connect the camera  4. Start the stream';
    const t2 = d.createElement('p'); t2.textContent = 'Android: Chrome · iPhone: "Bluefy" app';
    d.body.append(h, i, t, t2);
    i.onload = () => w.print();
  } });
  openModal('QR code for all users', img, el('p', { class: 'mut small', text: $('appUrl').value }), el('div', { class: 'row' }, print));
});

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

let eventSeq = -1; // last seen notification number (-1 = not queried yet)

async function refresh() {
  try {
    const data = await api('streams' + (eventSeq >= 0 ? '?since=' + eventSeq : '?history=1'));
    for (const ev of data.history || []) addNote(ev, true); // older notifications into the list, without popup/sound
    streams = data.streams;
    if (data.takVideo) { takVideo = data.takVideo; renderTakVideo(); }
    render();
    for (const ev of data.events || []) showToast(ev);
    eventSeq = data.eventSeq;
  } catch (e) {
    if (!(e instanceof ApiError)) console.warn(e);
  }
}

const sid = s => s.user + '/' + s.streamId;

// ---------- Streams into the TAK server automatically (OpenTAKServer/MediaMTX) ----------
let takVideo = { ready: false, auto: true, when: 'all', prefix: 'cam' };

function renderTakVideo() {
  $('tvAuto').checked = !!takVideo.auto;
  if (document.activeElement !== $('tvWhen')) $('tvWhen').value = takVideo.when;
  if (document.activeElement !== $('tvPrefix')) $('tvPrefix').value = takVideo.prefix || '';
  const inTak = streams.filter(s => s.tak && s.tak.inTak).length;
  const errs = streams.filter(s => s.tak && s.tak.error).length;
  $('tvStatus').textContent = !takVideo.ready ? 'OpenTAKServer is not connected – set it up under "Settings → OpenTAKServer & registration".'
    : `${inTak} of ${streams.length} stream${streams.length === 1 ? '' : 's'} in the TAK server` + (errs ? ` · ${errs} error${errs === 1 ? '' : 's'} (tap the dot)` : '');
  $('tvStatus').className = 'small ' + (!takVideo.ready || errs ? 'warn' : 'mut');
}

async function setTak(id, body) {
  try {
    await api(streamPath(id) + '/tak', { method: 'POST', body });
  } catch (e) { alert(e.message); }
  await refresh();
}

async function saveTakVideo(body) {
  try {
    takVideo = { ...takVideo, ...await api('takvideo/settings', { method: 'POST', body }) };
    renderTakVideo();
  } catch (e) { alert(e.message); }
}
$('tvAuto').addEventListener('change', () => saveTakVideo({ auto: $('tvAuto').checked }));
$('tvWhen').addEventListener('change', () => saveTakVideo({ when: $('tvWhen').value }));
$('tvPrefix').addEventListener('change', () => saveTakVideo({ prefix: $('tvPrefix').value }));
$('tvSync').addEventListener('click', async () => {
  $('tvSync').disabled = true;
  try {
    const r = await api('takvideo/sync', { method: 'POST', body: {} });
    if (r.errors && r.errors.length) alert('Sync finished with errors:\n\n' + r.errors.join('\n'));
    else if (r.error) alert(r.error);
  } catch (e) { alert(e.message); }
  $('tvSync').disabled = false;
  await refresh();
});

let liveMode = 'admin'; // "admin" = admin puts live, "user" = user starts by themselves

function state(s) {
  if (!s.enabled) return ['Blocked', 'stop'];
  if (s.receiving) return ['Live', 'live'];
  if (liveMode === 'admin' && s.onAir && s.phoneConnected) return ['Live requested', 'wait'];
  if (s.ready) return ['Ready', 'ready'];
  if (s.phoneConnected) return ['Connected', 'wait'];
  return ['Offline', 'off'];
}

async function setLive(id, on) {
  try {
    await api(streamPath(id) + '/live', { method: 'POST', body: { on } });
    await refresh();
  } catch (e) { alert(e.message); }
}

function ago(iso) {
  if (!iso) return '–';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return sec + ' s ago';
  if (sec < 3600) return Math.round(sec / 60) + ' min ago';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

function buildRow(s) {
  const id = sid(s);
  const c = {};
  const td = (label, cls) => el('td', { 'data-label': label, class: cls || '' });
  c.status = td('Status');
  c.badge = el('span', { class: 'badge' });
  c.status.append(c.badge);
  c.name = td('Stream', 'name');
  c.label = el('b');
  c.path = el('code', { text: id });
  c.name.append(c.label, c.path);
  c.camera = td('Camera');
  c.fps = td('FPS', 'num');
  c.viewers = td('Viewers', 'num');
  c.last = td('Last image');
  c.rotTd = td('Rotation');
  c.rot = angleInput(s.rotate);
  c.rot.addEventListener('change', () => setOptions(id, { rotate: normDeg(c.rot.value) }));
  c.rotTd.append(el('span', { class: 'deg' }, c.rot, '°'));
  c.sizeTd = td('Image size');
  c.size = sizeSelect(s.framesize, 'rot-size');
  c.size.addEventListener('change', () => setOptions(id, { framesize: +c.size.value }));
  c.sizeTd.append(c.size);
  // TAK path: the stream is a video feed in the TAK server automatically; only the path is maintained here
  c.link = td('TAK path');
  c.takOn = el('input', { type: 'checkbox', title: 'Register as a video feed in the TAK server', onchange: () => setTak(id, { enabled: c.takOn.checked }) });
  c.takPath = el('input', { class: 'tak-path', placeholder: 'automatic', autocomplete: 'off', spellcheck: 'false' });
  const savePath = () => { if (c.takPath.value.trim() !== (c.takPathOld || '')) setTak(id, { path: c.takPath.value }); };
  c.takPath.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); c.takPath.blur(); } });
  c.takPath.addEventListener('change', savePath);
  c.takDot = el('span', { class: 'tak-dot' });
  c.link.append(el('div', { class: 'link' }, c.takOn, c.takDot, c.takPath));
  c.actions = td('', '');
  c.onair = el('button', { class: 'sm', onclick: () => {
    const cur = streams.find(x => sid(x) === id);
    if (cur) setLive(id, !cur.onAir);
  } });
  c.view = el('button', { class: 'sm pri', text: 'View', onclick: () => openWindow(id) });
  c.qr = el('button', { class: 'sm', text: 'QR / Links', onclick: () => showQr(id) });
  c.toggle = el('button', { class: 'sm', onclick: () => toggleStream(id) });
  c.revoke = el('button', { class: 'sm danger', text: 'Kick', onclick: () => revokeStream(id) });
  c.remove = el('button', { class: 'sm danger', text: 'Delete', onclick: () => removeStream(id) });
  c.actions.append(el('div', { class: 'btns' }, c.onair, c.view, c.qr, c.toggle, c.revoke, c.remove));
  const tr = el('tr', {}, c.status, c.name, c.camera, c.fps, c.viewers, c.last, c.rotTd, c.sizeTd, c.link, c.actions);
  return { tr, c };
}

function updateRow(r, s) {
  const c = r.c;
  const [text, cls] = state(s);
  c.badge.textContent = text;
  c.badge.className = 'badge ' + cls;
  c.label.textContent = s.label || s.user;
  c.camera.textContent = s.camera || '–';
  c.fps.textContent = s.receiving ? s.fps.toFixed(1) : '–';
  c.viewers.textContent = String(s.viewers);
  c.last.textContent = ago(s.lastFrameAt);
  if (document.activeElement !== c.rot && !pendingOpts.has(sid(s))) c.rot.value = String(s.rotate || 0);
  c.rotTd.title = (s.mirror ? 'mirrored, ' : '') + (s.fit === 'fit' ? 'whole image' : 'fill');
  if (document.activeElement !== c.size) c.size.value = String(s.framesize || 1);
  const t = s.tak || {};
  c.takOn.checked = !!t.enabled;
  c.takOn.disabled = !takVideo.ready;
  if (document.activeElement !== c.takPath) { c.takPath.value = t.path || ''; c.takPathOld = t.path || ''; }
  c.takPath.disabled = !takVideo.ready;
  const takState = !takVideo.ready ? ['off', 'OpenTAKServer not connected (Settings → OpenTAKServer & registration)']
    : t.error ? ['err', 'Error: ' + t.error]
      : t.inTak ? ['ok', 'In the TAK server: ' + (t.rtsp || t.path)]
        : t.enabled ? ['wait', takVideo.when === 'live' ? 'Registered as soon as the camera sends' : 'Registering …'] : ['off', 'Not in the TAK server'];
  c.takDot.className = 'tak-dot ' + takState[0];
  c.takDot.title = takState[1];
  c.link.title = takState[1];
  c.toggle.textContent = s.enabled ? 'Block' : 'Enable';
  c.onair.textContent = s.onAir ? '■ Live off' : '▶ Live';
  c.onair.className = 'sm ' + (s.onAir ? 'danger' : 'golive');
  c.onair.classList.toggle('hidden', liveMode !== 'admin' || !s.enabled);
}

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const visible = streams.filter(s => !q || [s.user, s.streamId, s.label, s.camera].join(' ').toLowerCase().includes(q));
  const ids = new Set(streams.map(sid));
  for (const [id, r] of rows) if (!ids.has(id)) { r.tr.remove(); rows.delete(id); }
  const tbody = $('rows');
  for (const s of visible) {
    const id = sid(s);
    let r = rows.get(id);
    if (!r) { r = buildRow(s); rows.set(id, r); }
    updateRow(r, s);
    tbody.append(r.tr); // appends in sorted order
  }
  for (const [id, r] of rows) if (!visible.some(s => sid(s) === id)) r.tr.remove();
  $('empty').classList.toggle('hidden', streams.length > 0);
  const live = streams.filter(s => s.enabled && s.receiving).length;
  $('summary').textContent = `${live} live · ${streams.length} stream${streams.length === 1 ? '' : 's'}`;
  $('navLive').textContent = live ? String(live) : '';
  for (const [id, w] of windows) {
    const s = streams.find(x => sid(x) === id);
    if (!s) w.close(); else w.update(s);
  }
}

$('filter').addEventListener('input', render);

$('createForm').addEventListener('submit', async e => {
  e.preventDefault();
  setMsg($('createMsg'), '');
  try {
    const r = await api('streams', { method: 'POST', body: { user: $('cUser').value, label: $('cLabel').value } });
    $('cUser').value = '';
    $('cLabel').value = '';
    await refresh();
    showQr(sid(r.stream));
  } catch (err) {
    setMsg($('createMsg'), err.message);
  }
});

const streamPath = id => 'streams/' + id.split('/').map(encodeURIComponent).join('/');

async function setOptions(id, opts) {
  try {
    await api(streamPath(id) + '/options', { method: 'POST', body: opts });
    await refresh();
  } catch (e) { alert(e.message); }
}

async function toggleStream(id) {
  const s = streams.find(x => sid(x) === id);
  if (!s) return;
  try {
    await api(streamPath(id) + (s.enabled ? '/stop' : '/start'), { method: 'POST', body: {} });
    await refresh();
  } catch (e) { alert(e.message); }
}

async function revokeStream(id) {
  if (!confirm(`Kick the phone of "${id}"?\n\nThe phone is disconnected immediately and the old QR code is no longer valid. The stream link for ATAK stays the same. A new QR code is shown afterwards.`)) return;
  try {
    await api(streamPath(id) + '/revoke', { method: 'POST', body: {} });
    await refresh();
    showQr(id);
  } catch (e) { alert(e.message); }
}

async function removeStream(id) {
  if (!confirm(`Delete stream "${id}" permanently?\n\nThe phone is disconnected, link and QR code stop working.`)) return;
  try {
    await api(streamPath(id), { method: 'DELETE', body: {} });
    if (windows.has(id)) windows.get(id).close();
    await refresh();
  } catch (e) { alert(e.message); }
}

$('liveOffAllBtn').addEventListener('click', async () => {
  try {
    await api('streams/live-off-all', { method: 'POST', body: {} });
    await refresh();
  } catch (e) { alert(e.message); }
});

$('stopAllBtn').addEventListener('click', async () => {
  if (!confirm('Block ALL streams?\n\nAll phones are disconnected. Single streams can be allowed again afterwards with "Enable".')) return;
  try {
    await api('streams/stop-all', { method: 'POST', body: {} });
    await refresh();
  } catch (e) { alert(e.message); }
});

// ======================================================================
// Dialogs
// ======================================================================

function openModal(title, ...content) {
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren(...content.filter(Boolean));
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  $('modalBody').replaceChildren();
}

$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) closeModal(); });

function showQr(id) {
  const s = streams.find(x => sid(x) === id);
  if (!s) return;
  const img = el('img', { class: 'qr', alt: 'QR code for the phone app', src: '/api/admin/' + streamPath(id) + '/qr.svg?t=' + Date.now() });
  const dl = el('dl', { class: 'links' });
  const add = (label, value) => {
    const f = copyField(value);
    dl.append(el('dt', { text: label }), el('dd', {}, f.input, f.btn));
  };
  add('Stream link for ATAK/WinTAK (MJPEG)', s.links.stream);
  if (me.ffmpeg) {
    add('HLS – enter as "source" in OpenTAKServer/MediaMTX', s.links.hls);
    add('Alternative: MPEG-TS', s.links.ts);
  }
  add('Snapshot', s.links.snapshot);
  add('Phone app (contains the access key – give only to the user)', s.links.app);
  const hint = el('p', { class: 'mut small', text: !me.ffmpeg
    ? 'OpenTAKServer (MediaMTX) needs the HLS link – install ffmpeg on the server for it.'
    : s.tak && s.tak.inTak ? `Registered in the TAK server as "${s.tak.path}" – ATAK: ${s.tak.rtsp}`
      : 'The stream is registered in OpenTAKServer automatically (column "TAK path") once it is connected.' });
  const caBox = me.testCa ? el('div', { class: 'card', style: 'margin-top:12px' },
    el('b', { text: 'Test mode: certificate for the phone' }),
    el('p', { class: 'mut small', text: 'Once per phone: scan the QR code, download the file. Android: Settings → Security → '
      + 'Encryption & credentials → Install a certificate → CA certificate → choose the file. '
      + 'iPhone: download the profile, install it under Settings → General → VPN & Device Management and enable '
      + '"full trust" under About → Certificate Trust Settings. '
      + 'Confirm the warning on first opening with "Advanced → Proceed".' }),
    el('img', { class: 'qr', alt: 'Certificate QR code', src: '/api/admin/ca-qr.svg', style: 'max-width:200px' }),
    el('a', { href: me.publicBase + '/ca.crt', text: me.publicBase + '/ca.crt' })) : null;
  const print = el('button', { text: 'Print QR code', type: 'button', onclick: () => printQr(s, img.src) });
  openModal('QR code: ' + (s.label || s.user),
    el('p', { class: 'mut small', text: `Give this QR code to the user "${s.user}". It opens the phone app, connects the helmet camera via Bluetooth and sends the images to this stream.` }),
    img, dl, hint, el('div', { class: 'row', style: 'margin-top:12px' }, print), caBox);
}

function printQr(s, src) {
  const w = window.open('', '_blank', 'width=420,height=560');
  if (!w) return;
  const d = w.document;
  d.title = 'QR ' + s.user;
  const h = d.createElement('h2'); h.textContent = s.label || s.user;
  const p = d.createElement('p'); p.textContent = s.user + '/' + s.streamId;
  const img = d.createElement('img'); img.src = src; img.style.width = '320px';
  const t = d.createElement('p'); t.textContent = 'Scan, connect the camera, start the stream.';
  d.body.style.fontFamily = 'system-ui, sans-serif';
  d.body.style.textAlign = 'center';
  d.body.append(h, p, img, t);
  img.onload = () => w.print();
}

// System: defaults for new streams, admin login, SMTP
// Helpers: only their own password
function renderOwnPassword() {
  const f = el('form', {},
    el('p', { class: 'mut small', text: `Logged in as helper "${me.username}". You can approve/decline requests, edit users and create new TAK users. Settings are changed by the admin.` }),
    el('label', { text: 'Current password' }), el('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: '' }),
    el('label', { text: 'New password (min. 8 characters)' }), el('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: '8', required: '' }),
    el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'pri', type: 'submit', text: 'Change password' })),
    el('p', { class: 'msg', 'data-msg': '' }));
  f.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('own-password', { method: 'POST', body: { current: f.current.value, password: f.password.value } });
      f.reset();
      setMsg(f.querySelector('[data-msg]'), 'Password changed.', true);
    } catch (err) { setMsg(f.querySelector('[data-msg]'), err.message); }
  });
  $('systemCard').replaceChildren(el('h2', { text: 'My password' }), f);
}

// main admin: create helpers, set passwords, delete
async function helpersCard() {
  const box = el('div');
  const m = el('p', { class: 'msg' });
  const list = el('div', { class: 'table-wrap' });
  const load = async () => {
    let r;
    try { r = await api('helpers'); } catch (e) { setMsg(m, e.message); return; }
    const rows = r.helpers.map(h => el('tr', {},
      el('td', {}, el('b', { text: h.username }), h.name ? el('div', { class: 'mut small', text: h.name }) : null),
      el('td', { class: 'small', text: h.email || '–' }),
      el('td', { class: 'small', text: h.lastLogin ? new Date(h.lastLogin).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : 'never' }),
      el('td', {}, el('div', { class: 'btns' },
        el('button', { class: 'sm', type: 'button', text: 'Password …', onclick: async () => {
          const pw = prompt(`New password for "${h.username}" (min. 8 characters):`);
          if (!pw) return;
          try { await api(`helpers/${h.id}/password`, { method: 'POST', body: { password: pw } }); setMsg(m, 'Password set – the helper has been logged out.', true); } catch (e) { setMsg(m, e.message); }
        } }),
        el('button', { class: 'sm danger', type: 'button', text: 'Delete', onclick: async () => {
          if (!confirm(`Delete helper "${h.username}"?`)) return;
          try { await api(`helpers/${h.id}`, { method: 'DELETE' }); load(); } catch (e) { setMsg(m, e.message); }
        } })))));
    list.replaceChildren(el('table', { class: 'streams' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Helper' }), el('th', { text: 'E-mail' }), el('th', { text: 'Last login' }), el('th'))),
      el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '4', class: 'mut', text: 'No helpers yet.' }))]))));
  };
  const f = el('form', { class: 'row' },
    el('div', { class: 'grow' }, el('label', { text: 'Username' }), el('input', { name: 'username', required: '', autocomplete: 'off' })),
    el('div', { class: 'grow' }, el('label', { text: 'Password (min. 8)' }), el('input', { name: 'password', type: 'password', required: '', minlength: '8', autocomplete: 'new-password' })),
    el('div', { class: 'grow' }, el('label', { text: 'Name (optional)' }), el('input', { name: 'name' })),
    el('div', { class: 'grow' }, el('label', { text: 'E-mail (optional)' }), el('input', { name: 'email', type: 'email' })),
    el('div', { class: 'actions-end' }, el('button', { class: 'pri', type: 'submit', text: '+ Helper' })));
  f.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('helpers', { method: 'POST', body: Object.fromEntries(new FormData(f)) });
      f.reset();
      setMsg(m, 'Helper created – they log in here in the admin with username and password.', true);
      load();
    } catch (err) { setMsg(m, err.message); }
  });
  box.append(el('h3', { text: 'Helpers' }),
    el('p', { class: 'mut small', text: 'Helpers log in here in the admin and may only: approve/decline requests, edit users (callsign, team, role, block, new password/QR), create new TAK users and show links/QR codes. No settings, no deletions, no OTS admin.' }),
    f, m, list);
  load();
  return box;
}

async function renderSystem() {
  if (isHelper()) return renderOwnPassword();
  const frag = $('settingsTpl').content.cloneNode(true);
  const cred = frag.querySelector('#credForm');
  const smtp = frag.querySelector('#smtpForm');
  const defs = frag.querySelector('#defaultsForm');
  cred.username.value = me.username;
  cred.email.value = me.email || '';
  const defFit = fitSelect('fill');
  defFit.name = 'fit';
  defs.querySelector('[data-fit]').replaceWith(defFit);
  const defSize = sizeSelect(1);
  defs.querySelector('[data-size]').replaceWith(defSize);
  $('systemCard').replaceChildren(el('h2', { text: 'System' }), await helpersCard(), defs, cred, smtp);

  try {
    const d = await api('defaults');
    defs.rotate.value = String(d.rotate);
    defs.mirror.checked = d.mirror;
    defFit.value = d.fit;
    defSize.value = String(d.framesize);
  } catch (e) { /* shown by api() */ }
  defs.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = defs.querySelector('[data-msg]');
    try {
      await api('defaults', { method: 'POST', body: { rotate: normDeg(defs.rotate.value), mirror: defs.mirror.checked, fit: defFit.value, framesize: +defSize.value, applyAll: defs.applyAll.checked } });
      defs.applyAll.checked = false;
      await refresh();
      setMsg(msg, 'Saved.', true);
    } catch (err) { setMsg(msg, err.message); }
  });

  cred.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = cred.querySelector('[data-msg]');
    try {
      await api('credentials', { method: 'POST', body: {
        current: cred.current.value, username: cred.username.value, email: cred.email.value,
        password: cred.password.value || undefined,
      } });
      me = await api('me');
      cred.current.value = '';
      cred.password.value = '';
      setMsg(msg, 'Saved.', true);
    } catch (err) { setMsg(msg, err.message); }
  });

  try {
    const s = await api('smtp');
    smtp.host.value = s.host; smtp.port.value = s.port; smtp.secure.checked = s.secure;
    smtp.user.value = s.user; smtp.from.value = s.from;
    smtp.querySelector('[data-haspass]').textContent = s.hasPass ? '(saved)' : '';
  } catch (e) { /* shown by api() */ }

  const smtpBody = () => ({
    host: smtp.host.value, port: smtp.port.value, secure: smtp.secure.checked,
    user: smtp.user.value, from: smtp.from.value, pass: smtp.pass.value || undefined,
  });
  smtp.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = smtp.querySelector('[data-msg]');
    try {
      await api('smtp', { method: 'POST', body: smtpBody() });
      if (smtp.pass.value) smtp.querySelector('[data-haspass]').textContent = '(saved)';
      smtp.pass.value = '';
      setMsg(msg, 'Saved.', true);
    } catch (err) { setMsg(msg, err.message); }
  });
  smtp.querySelector('[data-test]').addEventListener('click', async () => {
    const msg = smtp.querySelector('[data-msg]');
    setMsg(msg, 'Sending …', true);
    try {
      await api('smtp', { method: 'POST', body: smtpBody() });
      smtp.pass.value = '';
      await api('smtp/test', { method: 'POST', body: {} });
      setMsg(msg, 'Test mail sent to ' + me.email + '.', true);
    } catch (err) { setMsg(msg, err.message); }
  });
}

// ======================================================================
// Video windows: move, resize, maximize, minimize, close
// ======================================================================

function openWindow(id) {
  if (windows.has(id)) { windows.get(id).focus(); return; }
  const s = streams.find(x => sid(x) === id);
  if (!s) return;

  const title = el('span', { class: 'win-title' });
  const btnAlign = el('button', { title: 'Align the image (rotate, mirror)', text: '∠ Align' });
  const btnLive = el('button', { title: 'Put live / end live' });
  btnLive.addEventListener('click', () => {
    const cur = streams.find(x => sid(x) === id);
    if (cur) setLive(id, !cur.onAir);
  });
  const btnFull = el('button', { title: 'Fullscreen', text: '⛶' });
  const btnMin = el('button', { title: 'Minimize', text: '–' });
  const btnMax = el('button', { title: 'Maximize', text: '□' });
  const btnClose = el('button', { title: 'Close', text: '✕' });
  const bar = el('div', { class: 'win-bar' }, title, btnLive, btnAlign, btnFull, btnMin, btnMax, btnClose);

  // align: slider 0–359.5°, fine steps, mirror, fill/whole image
  const range = el('input', { type: 'range', min: '0', max: '359.5', step: '0.5', class: 'grow', 'aria-label': 'Rotation' });
  const num = angleInput(s.rotate, 'rot');
  const mirrorBox = el('input', { type: 'checkbox' });
  const fitSel = fitSelect(s.fit);
  const sizeSel = sizeSelect(s.framesize);
  const setAngle = (v, now) => {
    const a = normDeg(v);
    range.value = String(a);
    num.value = String(a);
    if (now) setOptions(id, { rotate: a }); else sendOptionsSoon(id, { rotate: a });
  };
  range.addEventListener('input', () => setAngle(range.value));
  num.addEventListener('change', () => setAngle(num.value, true));
  const step = d => el('button', { class: 'sm', type: 'button', text: (d > 0 ? '+' : '−') + Math.abs(d) + '°',
    onclick: () => setAngle(normDeg(num.value) + d) });
  const align = el('div', { class: 'win-align hidden' },
    el('div', { class: 'row' }, range, el('span', { class: 'deg' }, num, '°')),
    el('div', { class: 'row' }, step(-90), step(-5), step(-1), step(1), step(5), step(90),
      el('button', { class: 'sm', type: 'button', text: '0°', onclick: () => setAngle(0, true) })),
    el('div', { class: 'row' },
      el('label', { class: 'check' }, mirrorBox, 'Mirror'), fitSel),
    el('div', { class: 'row' }, el('span', { class: 'mut', text: 'Image size' }), sizeSel),
  );
  mirrorBox.addEventListener('change', () => setOptions(id, { mirror: mirrorBox.checked }));
  fitSel.addEventListener('change', () => setOptions(id, { fit: fitSel.value }));
  sizeSel.addEventListener('change', () => setOptions(id, { framesize: +sizeSel.value }));
  btnAlign.addEventListener('click', () => {
    align.classList.toggle('hidden');
    btnAlign.classList.toggle('pri', !align.classList.contains('hidden'));
  });
  const img = el('img', { alt: 'Live image' });
  const off = el('div', { class: 'win-off' });
  const info = el('div', { class: 'win-info' });
  const body = el('div', { class: 'win-body' }, img, off, info);
  const win = el('div', { class: 'win' }, bar, align, body);

  // fit the window to the aspect ratio of the image -> no black border
  let lastDims = '';
  const fitAspect = () => {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    const dims = iw + 'x' + ih;
    if (dims === lastDims) return;
    lastDims = dims;
    if (win.classList.contains('max') || win.classList.contains('min')) return;
    const chrome = win.offsetHeight - body.offsetHeight; // title bar + align area
    let width = win.offsetWidth;
    let height = chrome + width * ih / iw;
    const maxH = window.innerHeight - 16;
    if (height > maxH) {
      height = maxH;
      width = Math.max(220, (maxH - chrome) * iw / ih);
    }
    win.style.width = Math.round(width) + 'px';
    win.style.height = Math.round(height) + 'px';
    const r = win.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) win.style.top = Math.max(8, window.innerHeight - 8 - r.height) + 'px';
  };
  img.addEventListener('load', fitAspect);
  btnFull.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (body.requestFullscreen) body.requestFullscreen().catch(() => {});
  });

  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(480, vw - 16), h = Math.min(400, vh - 80);
  winOffset = (winOffset + 32) % 256;
  win.style.width = w + 'px';
  win.style.height = h + 'px';
  win.style.left = Math.max(8, Math.min(vw - w - 8, 80 + winOffset)) + 'px';
  win.style.top = Math.max(60, Math.min(vh - h - 8, 90 + winOffset)) + 'px';
  if (vw < 600) win.classList.add('max');
  $('windows').append(win);

  // fetch the image directly from the admin server (relative path): independent of the configured
  // public address and without a persistent connection (browsers allow only ~6 per server)
  const snapUrl = '/' + encodeURIComponent(s.user) + '/' + encodeURIComponent(s.streamId) + '/snapshot.jpg';
  let alive = true, shownUrl = null, lastFrameAt = null;
  (async function pull() {
    while (alive) {
      const st = streams.find(x => sid(x) === id);
      // only fetch a new image if there is one
      if (!shownUrl || (st && st.lastFrameAt !== lastFrameAt) || (st && st.receiving)) {
        try {
          const r = await fetch(snapUrl + '?t=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' });
          if (r.ok && alive) {
            const url = URL.createObjectURL(await r.blob());
            img.src = url;
            if (shownUrl) URL.revokeObjectURL(shownUrl);
            shownUrl = url;
            lastFrameAt = st ? st.lastFrameAt : null;
          }
        } catch (e) { /* server briefly gone: keep trying */ }
      }
      await new Promise(r => setTimeout(r, 250));
    }
  })();

  const api_ = {
    focus() { win.style.zIndex = ++zTop; },
    update(st) {
      title.textContent = (st.label || st.user) + ' – ' + sid(st);
      const [text] = state(st);
      info.textContent = st.receiving ? `${st.fps.toFixed(1)} fps · ${st.camera || ''}` : text;
      off.textContent = st.receiving ? '' : (!st.enabled ? 'Stream blocked'
        : !st.phoneConnected ? 'No live image (phone offline)'
        : liveMode === 'admin' && !st.onAir ? (st.ready ? 'Ready – press "▶ Live"' : 'Phone connected, camera not ready yet')
        : 'Waiting for images from the phone …');
      btnLive.textContent = st.onAir ? '■ Live off' : '▶ Live';
      btnLive.className = st.onAir ? 'danger' : 'golive';
      btnLive.classList.toggle('hidden', liveMode !== 'admin' || !st.enabled);
      off.classList.toggle('hidden', st.receiving);
      // only update the slider when nobody is turning it
      const busy = pendingOpts.has(id) || [range, num, fitSel].includes(document.activeElement);
      if (!busy) {
        range.value = String(st.rotate || 0);
        num.value = String(st.rotate || 0);
        fitSel.value = st.fit === 'fit' ? 'fit' : 'fill';
        if (document.activeElement !== sizeSel) sizeSel.value = String(st.framesize || 1);
      }
      mirrorBox.checked = !!st.mirror;
      btnAlign.textContent = '∠ ' + (st.rotate ? fmtDeg(st.rotate) : 'Align');
    },
    close() {
      alive = false; // stop fetching images
      if (shownUrl) URL.revokeObjectURL(shownUrl);
      img.removeAttribute('src');
      win.remove();
      windows.delete(id);
    },
  };
  windows.set(id, api_);
  api_.update(s);
  api_.focus();

  win.addEventListener('pointerdown', () => api_.focus());
  btnClose.addEventListener('click', () => api_.close());
  btnMin.addEventListener('click', () => {
    win.classList.toggle('min');
    win.classList.remove('max');
  });
  const toggleMax = () => {
    win.classList.toggle('max');
    win.classList.remove('min');
    btnMax.textContent = win.classList.contains('max') ? '❐' : '□';
  };
  btnMax.addEventListener('click', toggleMax);
  bar.addEventListener('dblclick', e => { if (e.target.tagName !== 'BUTTON') toggleMax(); });

  // move by the title bar
  let drag = null;
  bar.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON' || win.classList.contains('max')) return;
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = win.getBoundingClientRect();
    const x = Math.max(-r.width + 80, Math.min(window.innerWidth - 80, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
    win.style.left = x + 'px';
    win.style.top = y + 'px';
  });
  const endDrag = () => { drag = null; };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
}

// ======================================================================
// Start
// ======================================================================

(async function init() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('reset')) return showAuth('reset');
  try {
    me = await api('me');
    if (me.mustChange) showFirst(); else showApp();
  } catch (e) {
    if (!(e instanceof ApiError)) showAuth('login');
  }
})();

// ======================================================================
// TAK-EUD
// ======================================================================

async function loadTak() {
  try {
    const t = await api('tak');
    $('eudUrl').value = t.eudUrl;
    $('eudQr').src = '/api/admin/eud-qr.svg?t=' + Date.now();
    const f = $('takForm');
    f.allowedHosts.value = t.allowedHosts || '';
    f.host.value = t.preset ? t.preset.host : '';
    f.port.value = t.preset ? t.preset.port : '';
    f.proto.value = t.preset ? t.preset.proto : 'ssl';
    f.enrollPort.value = t.preset ? t.preset.enrollPort : '';
  } catch (e) { /* not logged in */ }
}

async function loadEudLinks() {
  try {
    const { links } = await api('eud-links');
    const box = $('eudLinks');
    box.textContent = links.length ? 'Connected TAKweb devices:' : 'No TAKweb device connected right now.';
    for (const l of links) {
      box.append(el('div', { text: `${l.callsign || '–'} → ${l.host || '–'} (${l.state})` }));
    }
  } catch (e) { /* ignore */ }
}

$('takForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const host = f.host.value.trim();
  try {
    await api('tak', { method: 'POST', body: {
      allowedHosts: f.allowedHosts.value,
      preset: host ? { host, port: Number(f.port.value) || 8089, proto: f.proto.value, enrollPort: Number(f.enrollPort.value) || 8446 } : null,
    } });
    setMsg($('eudMsg'), 'Saved – the QR code is updated.', true);
    loadTak();
  } catch (err) { setMsg($('eudMsg'), err.message); }
});
function showEudQr() {
  const img = el('img', { class: 'qr', alt: 'TAKweb QR code', src: '/api/admin/eud-qr.svg?t=' + Date.now() });
  const print = el('button', { type: 'button', text: 'Print', onclick: () => {
    const w = window.open('', '_blank', 'width=480,height=640');
    if (!w) return;
    const d = w.document;
    d.title = 'TAKweb';
    d.body.style.fontFamily = 'system-ui, sans-serif';
    d.body.style.textAlign = 'center';
    const h = d.createElement('h1'); h.textContent = 'TAKweb';
    const i = d.createElement('img'); i.src = img.src; i.style.width = '340px';
    const t = d.createElement('p'); t.textContent = '1. Scan  2. Enter callsign  3. Connect to the TAK server';
    const t2 = d.createElement('p'); t2.textContent = 'iPhone: Safari → Share → Add to Home Screen';
    d.body.append(h, i, t, t2);
    i.onload = () => w.print();
  } });
  openModal('TAKweb QR code', img, el('p', { class: 'mut small', text: $('eudUrl').value }), el('div', { class: 'row' }, print));
}
$('eudQr').addEventListener('click', showEudQr);
$('eudQr').style.cursor = 'pointer';
$('eudUrlCopy').addEventListener('click', () => copy($('eudUrl').value, $('eudUrlCopy')));
setInterval(() => { if (!document.hidden && $('eudLinks').offsetParent) loadEudLinks(); }, 10000);
