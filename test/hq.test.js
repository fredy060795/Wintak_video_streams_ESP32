// HQ (lib/hq.js): live picture from the TAK server, geofence departure/arrival, hostile warnings, situation log.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Hq, inFence } = require('../lib/hq');

const iso = t => new Date(t).toISOString();
const pli = (uid, lat, lon, { cs = uid, role = 'Team Member', team = 'Cyan', mesh = false } = {}) => {
  const t = Date.now();
  return `<event version="2.0" uid="${uid}" type="a-f-G-U-C" how="m-g" time="${iso(t)}" start="${iso(t)}" stale="${iso(t + 120000)}">`
    + `<point lat="${lat}" lon="${lon}" hae="200" ce="9" le="9"/><detail><contact callsign="${cs}" endpoint="*:-1:stcp"/>`
    + `<__group name="${team}" role="${role}"/>${mesh ? '<takv platform="Meshtastic"/>' : '<takv platform="ATAK-CIV"/>'}<status battery="77"/></detail></event>`;
};
const marker = (uid, type, by, text = '') => {
  const t = iso(Date.now());
  return `<event version="2.0" uid="${uid}" type="${type}" how="h-g-i-g-o" time="${t}" start="${t}" stale="${t}"><point lat="47.5" lon="11.5" hae="0" ce="9" le="9"/>`
    + `<detail><contact callsign="Enemy group"/><remarks>${text}</remarks><link uid="${by}" relation="p-p" type="a-f-G-U-C"/></detail></event>`;
};
const make = () => { const store = {}; return { hq: new Hq({ data: () => store, save: () => {} }), store }; };

test('hq: devices with role, team, mesh, battery and trail; lost connection greys, deletion removes', () => {
  const { hq } = make();
  hq.cot(pli('A', 47, 11, { cs: 'ALPHA 1', role: 'Team Lead' }));
  hq.cot(pli('M', 47.1, 11.1, { cs: 'MESHY', mesh: true }));
  const st = hq.state();
  assert.equal(st.devices.length, 2);
  const a = st.devices.find(d => d.uid === 'A');
  assert.equal(a.callsign, 'ALPHA 1');
  assert.equal(a.role, 'Team Lead');
  assert.equal(a.battery, 77);
  assert.equal(a.online, true);
  assert.equal(st.devices.find(d => d.uid === 'M').mesh, true);
  const t = iso(Date.now());
  hq.cot(`<event uid="x" type="t-x-d-d" time="${t}" start="${t}" stale="${t}"><point lat="0" lon="0"/><detail><link uid="A" relation="p-p"/></detail></event>`);
  assert.equal(hq.state().devices.find(d => d.uid === 'A').online, false, 'greyed');
  hq.cot(`<event uid="y" type="t-x-d-d" time="${t}" start="${t}" stale="${t}"><point lat="0" lon="0"/><detail><link uid="A" relation="p-p"/><__forcedelete/></detail></event>`);
  assert.equal(hq.state().devices.some(d => d.uid === 'A'), false, 'removed');
});

test('hq: geofence – leaving the base is a departure, coming back an arrival (log entries)', () => {
  const { hq } = make();
  hq.setFences([{ name: 'Base', kind: 'circle', lat: 47, lon: 11, radius: 300, base: true }, { name: 'Objective', kind: 'polygon', points: [[47.1, 11.1], [47.1, 11.2], [47.2, 11.2], [47.2, 11.1]] }]);
  hq.cot(pli('A', 47.0001, 11.0001, { cs: 'ALPHA 1' })); // starts inside: no event
  assert.equal(hq.state().events.length, 0);
  hq.cot(pli('A', 47.05, 11.05, { cs: 'ALPHA 1' }));
  hq.cot(pli('A', 47.15, 11.15, { cs: 'ALPHA 1' }));
  hq.cot(pli('A', 47.0001, 11.0001, { cs: 'ALPHA 1' }));
  const st = hq.state();
  assert.deepEqual(st.events.filter(e => e.kind !== 'log').map(e => e.text), ['ALPHA 1 departed from Base', 'ALPHA 1 entered Objective', 'ALPHA 1 left Objective', 'ALPHA 1 arrived at Base']);
  assert.deepEqual(st.log.map(e => [e.kind, e.text]), [['Departure', 'ALPHA 1 departed from Base'], ['Arrival', 'ALPHA 1 arrived at Base']]);
  assert.deepEqual(st.devices[0].fences, [st.fences[0].id]);
  assert.ok(inFence(st.fences[1], { lat: 47.15, lon: 11.15 }));
});

test('hq: a new hostile marker warns once (not the stored picture right after connecting)', () => {
  const { hq } = make();
  hq.cot(pli('A', 47, 11, { cs: 'ALPHA 1' }));
  hq.connected(60000);
  hq.cot(marker('OLD', 'a-h-G', 'A'));
  assert.equal(hq.state().events.length, 0, 'stored picture: no warning');
  hq.quietUntil = 0;
  hq.cot(marker('H1', 'a-h-G-U-C', 'A', '5 pax moving north'));
  hq.cot(marker('H1', 'a-h-G-U-C', 'A', '5 pax moving north')); // repeated: no second warning
  hq.cot(marker('F1', 'a-f-G', 'A')); // friendly: no warning
  const st = hq.state();
  const warn = st.events.filter(e => e.kind === 'hostile');
  assert.equal(warn.length, 1);
  assert.match(warn[0].text, /Hostile: Enemy group – 5 pax moving north \(by ALPHA 1\)/);
  assert.equal(st.log[0].kind, 'Enemy report');
  assert.equal(st.objects.length, 3);
});

test('hq: situation log, units with status, CSV, events since', () => {
  const { hq } = make();
  hq.addLog({ from: 'ALPHA', to: 'HQ', kind: 'Request', text: 'Need water' });
  assert.throws(() => hq.addLog({ text: '' }), /content/);
  const [u] = hq.setUnits([{ name: 'Alpha', kind: 'Squad', strength: 8, callsigns: 'ALPHA 1, ALPHA 2' }, { name: '' }]);
  assert.deepEqual(u.callsigns, ['ALPHA 1', 'ALPHA 2']);
  hq.setUnitStatus(u.id, 'Moving');
  const st = hq.state();
  assert.equal(st.log.length, 2);
  assert.equal(st.log[1].text, 'Status: Moving');
  const csv = hq.csv();
  assert.match(csv, /^No;Time;From;To;Kind;Content\r\n"1";"[^"]+";"ALPHA";"HQ";"Request";"Need water"/);
  assert.equal(hq.state(st.seq).events.length, 0);
  assert.ok(hq.removeLog(st.log[0].id));
});

test('hq: clean up – earlier events hidden, offline users and map objects out of the view, the log stays', () => {
  const { hq } = make();
  hq.cot(pli('A', 47, 11, { cs: 'ALPHA 1' }));
  hq.cot(pli('B', 47, 11, { cs: 'BRAVO 1' }));
  hq.live.get('B').offline = true;
  hq.cot(marker('F1', 'a-f-G', 'A'));
  hq.addLog({ text: 'Mission start' });
  const before = Date.now();
  hq.clear(['events', 'offline', 'objects']);
  const st = hq.state();
  assert.ok(st.clearedAt >= before);
  assert.deepEqual(st.devices.map(d => d.uid), ['A']);
  assert.equal(st.objects.length, 0);
  assert.equal(st.log.length, 1, 'the situation log stays');
});
