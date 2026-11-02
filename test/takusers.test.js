// TAK access against a mock OpenTAKServer: registration, approval, teams/visibility,
// callsign/team in device profiles, blocking, deleting.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { TakUsers } = require('../lib/takusers');
const { Ots } = require('../lib/ots');
const { createMockOts } = require('./ots-mock');

let mock, url, dir, store, tu;

before(async () => {
  mock = createMockOts();
  url = await mock.listen();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takusers-'));
  store = new Store(dir);
  tu = new TakUsers(store);
});

after(() => {
  mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('old default password "atakatak" is switched to random once at startup', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tu-pw-'));
  const st = new Store(d);
  st.data.tak = { ots: { url: '', userPassword: 'atakatak' } };
  assert.equal(new TakUsers(st).t.ots.userPassword, '');
  // set deliberately afterwards: kept
  st.data.tak.ots.userPassword = 'atakatak';
  assert.equal(new TakUsers(st).t.ots.userPassword, 'atakatak');
  fs.rmSync(d, { recursive: true, force: true });
});

test('OTS client: login with wrong and correct password', async () => {
  await assert.rejects(new Ots({ url, username: 'otsadmin', password: 'wrong' }).test(), /login failed/);
  const r = await new Ots({ url, username: 'otsadmin', password: 'otspass' }).test();
  assert.equal(r.ok, true);
});

test('registration: code word, required fields, duplicate e-mail, without SMTP directly "pending"', () => {
  tu.setRegistration({ open: true, codeword: 'Eagle', emailConfirm: true });
  assert.throws(() => tu.register({ name: 'Horst', email: 'h@example.com', codeword: 'wrong' }, { smtpReady: false }), /code word/);
  assert.throws(() => tu.register({ name: 'Horst', email: 'broken', codeword: 'eagle' }, { smtpReady: false }), /e-mail/);
  const u = tu.register({ name: 'Horst', unit: 'Platoon 1', email: 'H@Example.com', callsign: 'Horst', codeword: 'eagle' }, { smtpReady: false });
  assert.equal(u.status, 'pending');
  assert.equal(u.email, 'h@example.com');
  assert.equal(u.token.length, 48);
  assert.throws(() => tu.register({ name: 'X', email: 'h@example.com', codeword: 'eagle' }, { smtpReady: false }), /already registered/);
  // with SMTP: confirm the e-mail first
  const v = tu.register({ name: 'Vera', email: 'v@example.com', codeword: 'Eagle' }, { smtpReady: true });
  assert.equal(v.status, 'unconfirmed');
  assert.equal(tu.confirmEmail('wrong'), null);
  assert.equal(tu.confirmEmail(v.emailToken).status, 'pending');
  tu.setRegistration({ open: false, codeword: '', emailConfirm: true });
  assert.throws(() => tu.register({ name: 'Y', email: 'y@example.com' }, { smtpReady: false }), /closed/);
  tu.setRegistration({ open: true, codeword: '', emailConfirm: true });
});

test('approval only with OTS; creates account, groups and QR; overriding the callsign', async () => {
  const horst = tu.list().find(u => u.name === 'Horst');
  await assert.rejects(tu.approve(horst.id), /OpenTAKServer/);
  tu.setOts({ url, username: 'otsadmin', password: 'otspass', host: 'tak.example.com' });
  assert.equal(tu.fixQr('tak://com.atakmap.app/enroll?host=127.0.0.1:8089&username=a&token=b'), 'tak://com.atakmap.app/enroll?host=tak.example.com:8089&username=a&token=b');
  assert.equal(tu.fixQr('tak://com.atakmap.app/enroll?host=takweb.example.org&username=a&token=b'), 'tak://com.atakmap.app/enroll?host=tak.example.com&username=a&token=b');
  await tu.setTeams([{ name: 'Blue', color: 'Blue' }, { name: 'Red', color: 'Red' }], []);
  const blue = tu.t.teams[0], red = tu.t.teams[1];
  const u = await tu.approve(horst.id, { callsign: 'Alpha 10', team: blue.id, role: 'Team Lead' });
  assert.equal(u.status, 'active');
  assert.equal(u.callsign, 'Alpha 10');
  assert.equal(u.username, 'alpha_10');
  assert.match(u.password, /^[A-Za-z0-9]{14}$/, 'new accounts: random password');
  assert.equal(mock.state.users.alpha_10.password, u.password);
  assert.equal(mock.state.users.alpha_10.password, u.password);
  assert.match(u.atakQr, /^tak:\/\/com\.atakmap\.app\/enroll\?host=tak\.example\.com:8089&username=alpha_10&token=/);
  // Without blocks: own team group send + receive (IN + OUT), reads the other teams, exchanges with __ANON__
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_BLUE.IN', 'TEAM_BLUE.OUT', 'TEAM_RED.OUT', '__ANON__.IN', '__ANON__.OUT']);
  // access page shows the data only after approval
  const pv = tu.publicView(u);
  assert.equal(pv.username, 'alpha_10');
  assert.equal(pv.host, 'tak.example.com');
  const vera = tu.list().find(x => x.name === 'Vera');
  assert.equal(tu.publicView(vera).password, undefined);
  await tu.approve(vera.id, { callsign: 'Red 1', team: red.id });
  assert.deepEqual(mock.groupsOf('red_1'), ['TEAM_BLUE.OUT', 'TEAM_RED.IN', 'TEAM_RED.OUT', '__ANON__.IN', '__ANON__.OUT']);
});

test('visibility: Red may not see Blue -> Red no longer reads Blue', async () => {
  const [blue, red] = tu.t.teams;
  const errors = await tu.setTeams(tu.t.teams, [[red.id, blue.id]]);
  assert.deepEqual(errors, []);
  // Red does not read Blue; Red still exchanges with devices without a group (__ANON__). Blue is hidden
  // from Red and therefore does not send to __ANON__ (otherwise Red would see it there).
  assert.deepEqual(mock.groupsOf('red_1'), ['TEAM_RED.IN', 'TEAM_RED.OUT', '__ANON__.IN', '__ANON__.OUT']);
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_BLUE.IN', 'TEAM_BLUE.OUT', 'TEAM_RED.OUT', '__ANON__.OUT']);
  assert.equal(tu.canSee(blue.id, red.id), true);
  assert.equal(tu.canSee(red.id, blue.id), false);
  // new team with a block in one step (draft id)
  await tu.setTeams([...tu.t.teams, { id: 'new1', name: 'Yellow', color: 'Yellow' }], [[red.id, blue.id], ['new1', red.id]]);
  const yellow = tu.t.teams.find(t => t.name === 'Yellow');
  assert.notEqual(yellow.id, 'new1');
  assert.equal(tu.canSee(yellow.id, red.id), false);
  assert.equal(tu.canSee(yellow.id, blue.id), true);
  // Yellow is new: Blue and Red (unless blocked) read it too
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_BLUE.IN', 'TEAM_BLUE.OUT', 'TEAM_RED.OUT', 'TEAM_YELLOW.OUT', '__ANON__.OUT']);
  // blocks removed again: everyone reads everyone, own team IN + OUT
  await tu.setTeams(tu.t.teams.filter(t => t.name !== 'Yellow'), []);
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_BLUE.IN', 'TEAM_BLUE.OUT', 'TEAM_RED.OUT', '__ANON__.IN', '__ANON__.OUT']);
  assert.deepEqual(mock.groupsOf('red_1'), ['TEAM_BLUE.OUT', 'TEAM_RED.IN', 'TEAM_RED.OUT', '__ANON__.IN', '__ANON__.OUT']);
  // single user only receives / only sends
  const vera = tu.list().find(x => x.username === 'red_1');
  await tu.update(vera.id, { access: 'receive' });
  assert.deepEqual(mock.groupsOf('red_1'), ['TEAM_BLUE.OUT', 'TEAM_RED.OUT', '__ANON__.OUT']);
  await tu.update(vera.id, { access: 'send' });
  assert.deepEqual(mock.groupsOf('red_1'), ['TEAM_RED.IN', '__ANON__.IN']);
  await tu.update(vera.id, { access: 'both' });
  // without __ANON__ exchange only the team groups
  tu.setOts({ ...tu.t.ots, anon: false });
  await tu.setTeams(tu.t.teams, [[red.id, blue.id]]);
  assert.deepEqual(mock.groupsOf('red_1'), ['TEAM_RED.IN', 'TEAM_RED.OUT']);
  tu.setOts({ ...tu.t.ots, anon: true });
  await tu.syncAllGroups();
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_BLUE.IN', 'TEAM_BLUE.OUT', 'TEAM_RED.OUT', '__ANON__.OUT']);
});

test('callsign/team/role as device profile for all of the user\'s devices, team change changes groups', async () => {
  mock.state.euds.push({ uid: 'ANDROID-abc', callsign: 'Horst', username: 'alpha_10' }, { uid: 'ANDROID-def', callsign: 'Horsti', username: 'alpha_10' });
  let r = await tu.syncProfiles();
  assert.equal(r.updated, 2);
  assert.equal(mock.profileOf('ANDROID-abc', 'locationCallsign'), 'Alpha 10');
  assert.equal(mock.profileOf('ANDROID-def', 'locationTeam'), 'Blue');
  assert.equal(mock.profileOf('ANDROID-def', 'atakRoleType'), 'Team Lead');
  r = await tu.syncProfiles();
  assert.equal(r.updated, 0, 'unchanged -> send nothing again');
  const horst = tu.list().find(u => u.username === 'alpha_10');
  const red = tu.t.teams[1];
  await tu.update(horst.id, { callsign: 'Alpha 11', team: red.id });
  assert.equal(mock.profileOf('ANDROID-abc', 'locationCallsign'), 'Alpha 11');
  assert.equal(mock.profileOf('ANDROID-abc', 'locationTeam'), 'Red');
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_RED.IN', 'TEAM_RED.OUT', '__ANON__.IN', '__ANON__.OUT']);
  assert.deepEqual(tu.assignmentFor('alpha_10'), { callsign: 'Alpha 11', team: 'Red', role: 'Team Lead' });
  assert.equal(tu.assignmentFor('unknown'), null);
});

test('block, unblock, new password, delete', async () => {
  const horst = tu.list().find(u => u.username === 'alpha_10');
  await tu.block(horst.id);
  assert.equal(mock.state.users.alpha_10.active, false);
  assert.equal(tu.assignmentFor('alpha_10'), null);
  await tu.unblock(horst.id);
  assert.equal(mock.state.users.alpha_10.active, true);
  // password setting empty = random; invalid values rejected
  assert.throws(() => tu.setOts({ ...tu.t.ots, userPassword: 'short' }), /8–64/);
  assert.throws(() => tu.setOts({ ...tu.t.ots, userPassword: 'a&b<c>defgh' }), /OTS/);
  // a fixed password is still possible as an option
  tu.setOts({ ...tu.t.ots, userPassword: 'feldtest1' });
  await tu.newPassword(horst.id);
  assert.equal(horst.password, 'feldtest1');
  tu.setOts({ ...tu.t.ots, userPassword: '' });
  await tu.newPassword(horst.id);
  assert.match(horst.password, /^[A-Za-z0-9]{14}$/);
  assert.equal(mock.state.users.alpha_10.password, horst.password);
  await tu.remove(horst.id);
  assert.equal(mock.state.users.alpha_10, undefined);
  assert.equal(tu.list().some(u => u.username === 'alpha_10'), false);
});
