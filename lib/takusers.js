// TAK access: registration -> (confirm e-mail) -> approval by the admin -> real OTS account.
// The admin sets callsign, team (color) and role; OTS gets device profiles for this (ATAK applies
// them when connecting). Teams control who sees whom: every team is an OTS group, blocked pairs
// do not read each other's group.

const crypto = require('crypto');
const { Ots } = require('./ots');

const TEAM_COLORS = ['White', 'Yellow', 'Orange', 'Magenta', 'Red', 'Maroon', 'Purple', 'Dark Blue', 'Blue', 'Cyan', 'Teal', 'Green', 'Dark Green', 'Brown'];
const ROLES = ['Team Member', 'Team Lead', 'HQ', 'Sniper', 'Medic', 'Forward Observer', 'RTO', 'K9'];
const GROUP_PREFIX = 'TEAM_';
const ANON = '__ANON__';
const ACCESS = ['both', 'receive', 'send']; // group direction per user: send+receive, only receive, only send // OTS's default group for devices without a group
const STATUSES = ['unconfirmed', 'pending', 'active', 'blocked', 'rejected'];

const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const clean = (v, max = 60) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

// password without confusable characters; OTS forbids @ and :
function makePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

class TakUsers {
  constructor(store, { log = () => {}, mail = null } = {}) {
    this.store = store;
    this.log = log;
    this.mail = mail; // async ({ to, subject, text }) => …
    const d = store.data;
    d.tak = d.tak || {};
    const t = d.tak;
    t.ots = t.ots || { url: '', username: '', password: '', insecure: false, host: '', streamPort: 8089, enrollPort: 8446, apiPort: 8443 };
    // Password for new TAK accounts (empty = random) and exchange with unmanaged devices (__ANON__).
    // New accounts get a random password. Reset the former default "atakatak" once.
    if (t.ots.userPassword === undefined || (t.ots.userPassword === 'atakatak' && !t.ots.pwRandomDefault)) t.ots.userPassword = '';
    t.ots.pwRandomDefault = true;
    if (t.ots.anon === undefined) t.ots.anon = true;
    if (t.ots.truststorePassword === undefined) t.ots.truststorePassword = 'atakatak';
    t.registration = t.registration || { open: true, codeword: '', emailConfirm: true };
    t.teams = t.teams || [{ id: 'default', name: 'Default', color: 'Cyan' }];
    t.blocks = t.blocks || []; // [teamId, teamId]: the first team may not see the second
    t.users = t.users || {};
    this._ots = null;
    this._otsKey = '';
  }

  get t() { return this.store.data.tak; }
  save() { this.store.save(); }

  // ---------------- OTS ----------------
  ots() {
    const o = this.t.ots;
    const key = JSON.stringify([o.url, o.username, o.password, o.insecure, o.host]);
    if (!this._ots || this._otsKey !== key) {
      this._ots = new Ots({ url: o.url, username: o.username, password: o.password, insecure: o.insecure, publicHost: o.host });
      this._otsKey = key;
    }
    return this._ots;
  }
  otsConfigured() { const o = this.t.ots; return !!(o.url && o.username && o.password); }
  takHost() {
    const o = this.t.ots;
    if (o.host) return o.host;
    try { return new URL(o.url).hostname; } catch (e) { return ''; }
  }

  // OTS inserts the address we use to reach OTS (possibly internal or the TAKweb domain) – always put the
  // public TAK address in, also into QR codes saved earlier (called when the code is delivered)
  fixQr(qr) {
    const o = this.t.ots;
    const host = this.takHost();
    if (!qr || !host) return qr;
    return qr.replace(/([?&]host=)([^&]*)/, (m, pre, old) => {
      const hadPort = /:\d+$/.test(decodeURIComponent(old));
      return pre + encodeURIComponent(host) + (hadPort ? ':' + (o.streamPort || 8089) : '');
    });
  }

  setOts(input) {
    const o = this.t.ots;
    o.url = clean(input.url, 300).replace(/\/+$/, '');
    o.username = clean(input.username, 100);
    if (input.password) o.password = String(input.password).slice(0, 200);
    o.insecure = !!input.insecure;
    o.host = clean(input.host, 200).replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '');
    o.streamPort = Number(input.streamPort) || 8089;
    o.enrollPort = Number(input.enrollPort) || 8446;
    o.apiPort = Number(input.apiPort) || 8443;
    if (input.userPassword !== undefined) {
      const pw = String(input.userPassword).trim();
      if (pw && (pw.length < 8 || pw.length > 64 || /[<>&"'\s]/.test(pw))) {
        throw new Error('Password for new accounts: 8–64 characters, no spaces and no < > & " \' (OTS alters these characters).');
      }
      o.userPassword = pw;
    }
    if (input.anon !== undefined) o.anon = !!input.anon;
    if (input.truststorePassword !== undefined) o.truststorePassword = String(input.truststorePassword).trim().slice(0, 64) || 'atakatak';
    this.save();
  }

  // fixed password (e.g. "atakatak") or random
  newUserPassword() { return this.t.ots.userPassword || makePassword(); }

  setRegistration(input) {
    const r = this.t.registration;
    r.open = !!input.open;
    r.codeword = clean(input.codeword, 60);
    r.emailConfirm = !!input.emailConfirm;
    this.save();
  }

  // ---------------- Teams and visibility ----------------
  team(id) { return this.t.teams.find(x => x.id === id) || this.t.teams[0]; }
  groupName(team) { return GROUP_PREFIX + team.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40); }
  canSee(a, b) { return a === b || !this.t.blocks.some(([x, y]) => x === a && y === b); }

  // a team's wanted groups (OTS: IN = send/write, OUT = receive/read): its own group IN + OUT, so the team
  // communicates, read all teams that are not blocked. access: 'both' (default), 'receive' (only OUT) or
  // 'send' (only IN) – for single users who should only listen or only report.
  wantedGroups(teamId, access = 'both') {
    const own = this.team(teamId);
    const wanted = [{ group: this.groupName(own), direction: 'IN' }];
    for (const other of this.t.teams) if (this.canSee(own.id, other.id)) wanted.push({ group: this.groupName(other), direction: 'OUT' });
    // exchange with unmanaged devices (__ANON__): always receive, send only if no team should hide this team
    // (otherwise it would be seen through __ANON__ after all)
    if (this.t.ots.anon !== false) {
      wanted.push({ group: ANON, direction: 'OUT' });
      if (!this.t.blocks.some(([, hidden]) => hidden === own.id)) wanted.push({ group: ANON, direction: 'IN' });
    }
    if (access === 'receive') return wanted.filter(w => w.direction === 'OUT');
    if (access === 'send') return wanted.filter(w => w.direction === 'IN');
    return wanted;
  }
  groupsFor(u) { return this.wantedGroups(u.team, u.access); }

  async setTeams(teams, blocks) {
    const list = [];
    const idMap = {}; // draft id of new teams -> real id
    for (const t of teams || []) {
      const name = clean(t.name, 40);
      if (!name) continue;
      const id = t.id && this.t.teams.some(x => x.id === t.id) ? t.id : rid(4);
      if (t.id) idMap[t.id] = id;
      if (list.some(x => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`Team "${name}" exists twice.`);
      list.push({ id, name, color: TEAM_COLORS.includes(t.color) ? t.color : 'Cyan' });
    }
    if (!list.length) throw new Error('At least one team is needed.');
    const ids = new Set(list.map(x => x.id));
    this.t.teams = list;
    this.t.blocks = (blocks || []).map(([a, b]) => [idMap[a] || a, idMap[b] || b]).filter(([a, b]) => ids.has(a) && ids.has(b) && a !== b);
    for (const u of Object.values(this.t.users)) if (!ids.has(u.team)) u.team = list[0].id;
    this.save();
    return this.syncAllGroups();
  }

  async syncAllGroups() {
    const errors = [];
    if (!this.otsConfigured()) return errors;
    for (const u of Object.values(this.t.users)) {
      if (u.status !== 'active' || !u.username) continue;
      try { await this.ots().syncGroups(u.username, this.groupsFor(u), GROUP_PREFIX, [ANON]); } catch (e) { errors.push(`${u.callsign}: ${e.message}`); }
    }
    return errors;
  }

  // ---------------- Registration ----------------
  register(input, { smtpReady }) {
    const r = this.t.registration;
    if (!r.open) throw Object.assign(new Error('Registration is currently closed.'), { status: 403 });
    if (r.codeword && clean(input.codeword).toLowerCase() !== r.codeword.toLowerCase()) throw Object.assign(new Error('Wrong code word.'), { status: 403 });
    const name = clean(input.name, 60);
    const unit = clean(input.unit, 60);
    const email = clean(input.email, 120).toLowerCase();
    const callsign = clean(input.callsign, 30);
    if (!name) throw new Error('Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid e-mail address.');
    if (Object.values(this.t.users).some(u => u.email === email && !['rejected'].includes(u.status))) {
      throw Object.assign(new Error('This e-mail address is already registered. Please use the status link from your e-mail.'), { status: 409 });
    }
    const confirm = r.emailConfirm && smtpReady;
    const u = {
      id: rid(6), token: rid(24), emailToken: confirm ? rid(16) : '', status: confirm ? 'unconfirmed' : 'pending',
      name, unit, email, phone: clean(input.phone, 30), requestedCallsign: callsign, callsign: callsign || name,
      team: this.t.teams[0].id, role: 'Team Member', username: '', password: '', atakQr: '',
      created: new Date().toISOString(), confirmedAt: confirm ? '' : new Date().toISOString(), approvedAt: '', notes: '', profiles: {},
    };
    this.t.users[u.id] = u;
    this.save();
    this.log('TAK registration', u.name, u.email, u.status);
    return u;
  }

  confirmEmail(emailToken) {
    const u = Object.values(this.t.users).find(x => x.emailToken && x.emailToken === emailToken);
    if (!u) return null;
    if (u.status === 'unconfirmed') {
      u.status = 'pending';
      u.confirmedAt = new Date().toISOString();
    }
    u.emailToken = '';
    this.save();
    return u;
  }

  byToken(token) { return token && token.length >= 32 ? Object.values(this.t.users).find(u => u.token === token) || null : null; }
  get(id) { const u = this.t.users[id]; if (!u) throw Object.assign(new Error('User not found.'), { status: 404 }); return u; }
  list() { return Object.values(this.t.users).sort((a, b) => b.created.localeCompare(a.created)); }

  // OTS username from callsign/name: only letters, digits, _ and .
  makeUsername(u) {
    const base = (u.callsign || u.name || 'user').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9_.]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 24) || 'user';
    let name = base;
    let n = 1;
    const used = new Set(Object.values(this.t.users).filter(x => x !== u).map(x => x.username));
    while (used.has(name)) name = `${base}${++n}`;
    return name;
  }

  applyEdits(u, input) {
    if (input.callsign !== undefined) { const c = clean(input.callsign, 30); if (c) u.callsign = c; }
    if (input.team !== undefined && this.t.teams.some(x => x.id === input.team)) u.team = input.team;
    if (input.role !== undefined && ROLES.includes(input.role)) u.role = input.role;
    if (input.access !== undefined && ACCESS.includes(input.access)) u.access = input.access;
    if (input.name !== undefined) { const v = clean(input.name, 60); if (v) u.name = v; }
    if (input.unit !== undefined) u.unit = clean(input.unit, 60);
    if (input.notes !== undefined) u.notes = clean(input.notes, 500);
  }

  // log in with the new credentials: checks that OTS really set the password
  async checkLogin(username, password) {
    const o = this.t.ots;
    try {
      await new Ots({ url: o.url, username, password, insecure: o.insecure }).login();
    } catch (e) {
      if (/two-factor/i.test(e.message)) return;
      throw new Error(`OTS created the account "${username}", but logging in with the password fails (${e.message}).`);
    }
  }

  async approve(id, input = {}) {
    const u = this.get(id);
    if (!['pending', 'unconfirmed', 'rejected'].includes(u.status)) throw new Error('Only open requests can be approved.');
    if (!this.otsConfigured()) throw new Error('Connect OpenTAKServer first under "Settings → OpenTAKServer & registration".');
    this.applyEdits(u, input);
    const ots = this.ots();
    const username = u.username || this.makeUsername(u);
    const password = this.newUserPassword();
    if (await ots.userExists(username)) await ots.resetPassword(username, password);
    else await ots.addUser(username, password, ['user']);
    await ots.activateUser(username).catch(() => {}); // in case it was blocked before
    await this.checkLogin(username, password);
    await ots.syncGroups(username, this.groupsFor(u), GROUP_PREFIX, [ANON]);
    u.username = username;
    u.password = password;
    u.atakQr = this.fixQr(await ots.atakQr(username).catch(() => ''));
    u.status = 'active';
    u.approvedAt = new Date().toISOString();
    u.profiles = {};
    this.save();
    this.log('TAK access approved', u.callsign, username);
    this.syncProfiles().catch(() => {});
    return u;
  }

  async update(id, input) {
    const u = this.get(id);
    const before = JSON.stringify([u.callsign, u.team, u.role, u.access]);
    this.applyEdits(u, input);
    this.save();
    const changed = before !== JSON.stringify([u.callsign, u.team, u.role, u.access]);
    if (u.status === 'active' && changed && this.otsConfigured()) {
      await this.ots().syncGroups(u.username, this.groupsFor(u), GROUP_PREFIX, [ANON]);
      await this.syncProfiles();
    }
    return u;
  }

  async reject(id) {
    const u = this.get(id);
    if (u.status === 'active') throw new Error('Please block or delete active access instead.');
    u.status = 'rejected';
    this.save();
    return u;
  }

  async block(id) {
    const u = this.get(id);
    if (u.username && this.otsConfigured()) await this.ots().deactivateUser(u.username).catch(e => { if (!/already/i.test(e.message)) throw e; });
    u.status = 'blocked';
    this.save();
    this.log('TAK access blocked', u.callsign, u.username);
    return u;
  }

  async unblock(id) {
    const u = this.get(id);
    if (u.status !== 'blocked') throw new Error('Access is not blocked.');
    if (u.username && this.otsConfigured()) await this.ots().activateUser(u.username).catch(e => { if (!/already/i.test(e.message)) throw e; });
    u.status = u.username ? 'active' : 'pending';
    this.save();
    return u;
  }

  async newPassword(id) {
    const u = this.get(id);
    if (!u.username) throw new Error('No TAK account yet.');
    const password = this.newUserPassword();
    await this.ots().resetPassword(u.username, password);
    await this.checkLogin(u.username, password);
    u.password = password;
    u.atakQr = this.fixQr(await this.ots().atakQr(u.username).catch(() => u.atakQr));
    this.save();
    return u;
  }

  async newQr(id) {
    const u = this.get(id);
    if (!u.username) throw new Error('No TAK account yet.');
    u.atakQr = this.fixQr(await this.ots().atakQr(u.username));
    this.save();
    return u;
  }

  async remove(id) {
    const u = this.get(id);
    if (u.username && this.otsConfigured()) await this.ots().deleteUser(u.username).catch(e => { if (!/not|exist/i.test(e.message)) throw e; });
    delete this.t.users[id];
    this.save();
    this.log('TAK access deleted', u.callsign, u.username);
  }

  // ---------------- Create directly / import from OTS ----------------
  byUsername(username) { return Object.values(this.t.users).find(u => u.username === username) || null; }

  checkPassword(pw) {
    if (pw.length < 8 || pw.length > 64 || /[<>&"'\s@:]/.test(pw)) {
      throw new Error('Password: 8–64 characters, no spaces and no < > & " \' @ :');
    }
  }

  // admin creates a user without registration: OTS account, groups, ATAK QR, access page
  async createDirect(input = {}) {
    if (!this.otsConfigured()) throw new Error('Connect OpenTAKServer first under "Settings → OpenTAKServer & registration".');
    const callsign = clean(input.callsign, 30);
    if (!callsign) throw new Error('Please enter a callsign.');
    const email = clean(input.email, 120).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail address is invalid.');
    const u = {
      id: rid(6), token: rid(24), emailToken: '', status: 'active', name: clean(input.name, 60) || callsign, unit: clean(input.unit, 60),
      email, phone: '', requestedCallsign: callsign, callsign, team: this.team(input.team).id, role: ROLES.includes(input.role) ? input.role : 'Team Member',
      access: ACCESS.includes(input.access) ? input.access : 'both',
      username: '', password: '', atakQr: '', created: new Date().toISOString(), confirmedAt: new Date().toISOString(), approvedAt: '', notes: 'created by the admin', profiles: {},
    };
    const wanted = clean(input.username, 40).toLowerCase();
    if (wanted && !/^[a-z0-9_.]{2,40}$/.test(wanted)) throw new Error('Username: 2–40 characters, only a–z, 0–9, _ and .');
    u.username = wanted || this.makeUsername(u);
    if (this.byUsername(u.username)) throw new Error(`User "${u.username}" is already managed here.`);
    const ots = this.ots();
    if (await ots.userExists(u.username)) throw new Error(`User "${u.username}" already exists in OTS – please import it under "OTS users".`);
    const password = String(input.password || '').trim() || this.newUserPassword();
    this.checkPassword(password);
    await ots.addUser(u.username, password, input.admin ? ['administrator'] : ['user']);
    await this.checkLogin(u.username, password);
    await ots.syncGroups(u.username, this.groupsFor(u), GROUP_PREFIX, [ANON]);
    u.password = password;
    u.atakQr = this.fixQr(await ots.atakQr(u.username).catch(() => ''));
    u.approvedAt = new Date().toISOString();
    this.t.users[u.id] = u;
    this.save();
    this.log('TAK access created directly', u.callsign, u.username);
    this.syncProfiles().catch(() => {});
    return u;
  }

  // Manage an existing OTS user (e.g. created by hand in OTS) in TAKweb. TAKweb does not know the
  // password – optionally set a new one right away so the access page is complete.
  async importOts(username, input = {}) {
    if (!this.otsConfigured()) throw new Error('OpenTAKServer is not connected.');
    username = clean(username, 100);
    if (this.byUsername(username)) throw new Error(`"${username}" is already managed.`);
    const ots = this.ots();
    if (!(await ots.userExists(username))) throw new Error(`"${username}" does not exist in OTS.`);
    const callsign = clean(input.callsign, 30) || username;
    const u = {
      id: rid(6), token: rid(24), emailToken: '', status: 'active', name: clean(input.name, 60) || callsign, unit: '', email: clean(input.email, 120).toLowerCase(),
      phone: '', requestedCallsign: callsign, callsign, team: this.team(input.team).id, role: ROLES.includes(input.role) ? input.role : 'Team Member',
      username, password: '', atakQr: '', created: new Date().toISOString(), confirmedAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
      notes: 'imported from OTS', profiles: {},
    };
    if (input.newPassword) {
      const pw = String(input.password || '').trim() || this.newUserPassword();
      this.checkPassword(pw);
      await ots.resetPassword(username, pw);
      await this.checkLogin(username, pw);
      u.password = pw;
    }
    u.atakQr = this.fixQr(await ots.atakQr(username).catch(() => ''));
    this.t.users[u.id] = u;
    this.save();
    if (input.syncGroups) await ots.syncGroups(username, this.groupsFor(u), GROUP_PREFIX, [ANON]);
    this.log('OTS user imported', username);
    return u;
  }

  // ---------------- Callsign/team/role in ATAK (device profiles) ----------------
  async syncProfiles() {
    if (!this.otsConfigured()) return { updated: 0, errors: [] };
    const ots = this.ots();
    let updated = 0;
    const errors = [];
    for (const u of Object.values(this.t.users)) {
      if (u.status !== 'active' || !u.username) continue;
      const color = this.team(u.team).color;
      const sig = `${u.callsign}|${color}|${u.role}`;
      let euds;
      try { euds = await ots.euds(u.username); } catch (e) { errors.push(`${u.callsign}: ${e.message}`); continue; }
      u.devices = euds.map(e => ({ uid: e.uid, callsign: e.callsign, device: e.device, platform: e.platform, last: e.last_event_time }));
      u.profiles = u.profiles || {};
      for (const e of euds) {
        if (!e.uid || u.profiles[e.uid] === sig) continue;
        try {
          await ots.setProfile(e.uid, 'locationCallsign', u.callsign);
          await ots.setProfile(e.uid, 'locationTeam', color);
          await ots.setProfile(e.uid, 'atakRoleType', u.role);
          u.profiles[e.uid] = sig;
          updated++;
        } catch (err) { errors.push(`${u.callsign}/${e.uid}: ${err.message}`); }
      }
    }
    this.save();
    return { updated, errors };
  }

  // for the EUD relay: assignment by OTS username (CN of the client certificate)
  assignmentFor(username) {
    if (!username) return null;
    const u = Object.values(this.t.users).find(x => x.username === username && x.status === 'active');
    if (!u) return null;
    return { callsign: u.callsign, team: this.team(u.team).color, role: u.role };
  }

  // login of an active user (drone/camera address: MediaMTX in OTS checks user + password)
  loginFor(username) {
    if (!username) return null;
    const u = Object.values(this.t.users).find(x => x.username === username && x.status === 'active');
    return u && u.password ? { username: u.username, password: u.password } : null;
  }

  // what the user sees on their access page (own data only)
  publicView(u) {
    const o = this.t.ots;
    const base = {
      status: u.status, name: u.name, callsign: u.callsign, unit: u.unit, email: maskEmail(u.email),
      created: u.created, confirmedAt: u.confirmedAt || '', approvedAt: u.approvedAt || '',
    };
    if (u.status !== 'active') return base;
    return {
      ...base,
      team: this.team(u.team).name, teamColor: this.team(u.team).color, role: u.role,
      username: u.username, password: u.password, host: this.takHost(),
      streamPort: o.streamPort, enrollPort: o.enrollPort, apiPort: o.apiPort, hasAtakQr: !!u.atakQr,
      truststorePassword: o.truststorePassword || 'atakatak',
    };
  }

  adminView(u) {
    const { token, emailToken, ...rest } = u;
    return { ...rest, teamName: this.team(u.team).name, teamColor: this.team(u.team).color, hasAccessLink: !!token };
  }
}

// "horst.huber@example.com" -> "ho***@example.com" (on the status page, in case the link is passed on)
function maskEmail(email) {
  const [a, d] = String(email || '').split('@');
  return d ? `${a.slice(0, 2)}***@${d}` : '';
}

module.exports = { ACCESS, ANON, maskEmail, TakUsers, TEAM_COLORS, ROLES, STATUSES, GROUP_PREFIX, makePassword };
